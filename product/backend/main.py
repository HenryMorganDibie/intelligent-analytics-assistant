"""
QueryMind API
-------------
Free tier  : user supplies their own LLM API key (no auth needed)
Pro tier   : QueryMind supplies the key — user authenticates with JWT
             Stripe webhook flips user.is_pro = True on payment
"""

import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import stripe
from fastapi import Depends, FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError

# ── Config ────────────────────────────────────────────────────────────────────
SECRET_KEY        = os.getenv("SECRET_KEY", "change-me-in-production-use-openssl-rand-hex-32")
ALGORITHM         = "HS256"
TOKEN_EXPIRE_DAYS = 30

# Pro tier — QueryMind's own LLM key (set in Render env vars)
QM_PROVIDER  = os.getenv("QM_PROVIDER", "groq")          # claude | groq | openai
QM_API_KEY   = os.getenv("QM_API_KEY", "")               # your own key
QM_MODEL     = os.getenv("QM_MODEL", "llama-3.3-70b-versatile")

# Stripe
STRIPE_SECRET_KEY    = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID      = os.getenv("STRIPE_PRICE_ID", "")  # your $19/mo price ID

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")

stripe.api_key = STRIPE_SECRET_KEY

# ── Database (SQLite — zero setup, lives on Render disk) ──────────────────────
DB_PATH = os.getenv("DB_PATH", "/tmp/querymind.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            email       TEXT UNIQUE NOT NULL,
            hashed_pw   TEXT NOT NULL,
            is_pro      INTEGER DEFAULT 0,
            stripe_customer_id TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    conn.close()

# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="QueryMind API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth helpers ──────────────────────────────────────────────────────────────
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(pw: str) -> str:
    return pwd_ctx.hash(pw)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)

def create_token(email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": email, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if not email:
            raise HTTPException(status_code=401, detail="Invalid token")
        return email
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def get_current_user(authorization: Optional[str] = Header(None), db: sqlite3.Connection = Depends(get_db)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1]
    email = decode_token(token)
    row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="User not found")
    return dict(row)

def get_optional_user(authorization: Optional[str] = Header(None), db: sqlite3.Connection = Depends(get_db)):
    """Returns user dict if authenticated, None if not — for endpoints that support both tiers."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        token = authorization.split(" ", 1)[1]
        email = decode_token(token)
        row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None
    except Exception:
        return None

# ── Pydantic models ───────────────────────────────────────────────────────────
class SignupRequest(BaseModel):
    email: EmailStr
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class SchemaQueryRequest(BaseModel):
    question: str
    schema_ddl: str
    # Free tier fields — optional when Pro user is authenticated
    provider: Optional[str] = None
    api_key:  Optional[str] = None
    model:    Optional[str] = None

class ConnectionQueryRequest(BaseModel):
    question: str
    connection_string: str
    provider: Optional[str] = None
    api_key:  Optional[str] = None
    model:    Optional[str] = None

class SchemaIntrospectRequest(BaseModel):
    connection_string: str

class DashboardRequest(BaseModel):
    schema_ddl: str
    focus: Optional[str] = None   # e.g. "revenue", "customers", "products" — optional focus area
    provider: Optional[str] = None
    api_key:  Optional[str] = None
    model:    Optional[str] = None

# ── SQL Safety ────────────────────────────────────────────────────────────────
ALLOWED_SQL_STARTS = ("SELECT", "WITH", "EXPLAIN")
BLOCKED_KEYWORDS   = ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE",
                      "CREATE", "REPLACE", "MERGE", "CALL", "EXEC", "GRANT",
                      "REVOKE", "ATTACH", "DETACH")

def validate_sql(sql: str) -> str:
    """
    Enforces read-only SQL. Raises HTTPException if any write/DDL keyword is present.
    Returns the cleaned SQL string.
    """
    cleaned = sql.strip().rstrip(";").strip()
    upper   = cleaned.upper()

    # Must start with an allowed keyword
    if not upper.startswith(ALLOWED_SQL_STARTS):
        raise HTTPException(
            status_code=400,
            detail=f"QueryMind only permits SELECT / WITH / EXPLAIN queries. "
                   f"Got: {cleaned[:60]}..."
        )

    # Block dangerous keywords anywhere in the statement
    for kw in BLOCKED_KEYWORDS:
        # Check for keyword as a whole word (not substring of column names)
        pattern = rf"\b{kw}\b"
        if re.search(pattern, upper):
            raise HTTPException(
                status_code=400,
                detail=f"Blocked keyword detected: {kw}. Only read queries are permitted."
            )

    # Enforce row limit — prevent SELECT * FROM huge_table accidents
    if "LIMIT" not in upper:
        cleaned = f"{cleaned} LIMIT 500"

    return cleaned

# ── LLM caller ────────────────────────────────────────────────────────────────
SYSTEM_PROMPT_TEMPLATE = """You are QueryMind — a world-class business analyst and SQL expert.

DATABASE SCHEMA:
{schema}

YOUR JOB:
Translate the user's business question into an accurate SQL query, generate realistic sample data, and interpret the results like a senior analyst briefing a founder.

STRICT RULES — follow every one exactly:
1. ONLY generate SELECT or WITH (CTE) queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, or any write operation.
2. Only reference tables and columns that exist in the schema above. Never invent table or column names.
3. If the question cannot be answered from the schema, set confidence to "low" and explain clearly in the narrative what data is missing.
4. data must be realistic and internally consistent — if revenue is $500K total, individual rows must sum to that. Never contradict yourself.
5. keyMetrics values must come directly from the data array — never fabricate numbers not present in the data.
6. narrative must be 4-6 sentences written like a senior analyst briefing a founder: lead with the main finding, explain the business implication, flag any caveats or follow-up questions.
7. vizType must match the actual shape of the data: use "area" for time-series, "pie" only if ≤7 categories, "stat"/"stats" for single-row results, "bar" for ranked comparisons, "table" for multi-column detail.
8. headline must be a direct factual statement, not a question and not vague. Bad: "Revenue trends". Good: "Q3 revenue grew 18% driven by enterprise customers."

RESPOND WITH VALID JSON ONLY — no markdown, no backticks, no explanation outside the JSON:
{{
  "sql": "SELECT ... (read-only, references only real schema columns)",
  "data": [ ... up to 15 rows, internally consistent ... ],
  "keyMetrics": [ {{"label": "string", "value": "formatted string e.g. $2.4M or 34%"}} ],
  "headline": "Direct factual one-sentence finding",
  "narrative": "4-6 sentences. Lead with finding. Explain business implication. Flag caveats.",
  "confidence": "high | medium | low",
  "vizType": "bar | line | area | pie | table | stat | stats"
}}"""

DASHBOARD_SYSTEM_PROMPT = """You are QueryMind — a world-class business analyst.

DATABASE SCHEMA:
{schema}

The user wants a complete business dashboard. Generate 4-6 panels that together give a complete picture of the business.

STRICT RULES:
1. Only reference tables and columns that EXIST in the schema. Never invent table or column names.
2. Every SQL must be SELECT or WITH only. No write operations.
3. Data in each panel must be realistic and internally consistent across all panels.
4. Each panel must have a different angle: mix revenue, volume, trends, segments, outliers.
5. keyMetrics values must come from the data — never fabricate numbers.
6. Choose vizType to best communicate each panel's insight.

RESPOND WITH VALID JSON ONLY:
{{
  "title": "Dashboard title e.g. 'E-commerce Business Overview'",
  "summary": "2-3 sentence executive summary of overall business health",
  "panels": [
    {{
      "id": 1,
      "title": "Panel title",
      "sql": "SELECT ...",
      "data": [ ...up to 12 rows... ],
      "keyMetrics": [ {{"label": "...", "value": "..."}} ],
      "headline": "Direct factual finding for this panel",
      "narrative": "2-3 sentences interpreting this panel's data",
      "vizType": "bar | line | area | pie | table | stat | stats",
      "confidence": "high | medium | low"
    }}
  ]
}}\n"""

async def call_llm(provider: str, api_key: str, model: str, schema: str, question: str,
                   system_override: str = None) -> dict:
    system = (system_override or SYSTEM_PROMPT_TEMPLATE).format(schema=schema)

    async with httpx.AsyncClient(timeout=60.0) as client:
        if provider == "claude":
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "max_tokens": 1500,
                    "system": system,
                    "messages": [{"role": "user", "content": question}],
                },
            )
            resp.raise_for_status()
            raw = "".join(b.get("text", "") for b in resp.json().get("content", []))

        elif provider in ("groq", "openai"):
            url = (
                "https://api.groq.com/openai/v1/chat/completions"
                if provider == "groq"
                else "https://api.openai.com/v1/chat/completions"
            )
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "max_tokens": 1500,
                    "temperature": 0,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": question},
                    ],
                },
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"]

        else:
            raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    clean = raw.strip().replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", clean)
        if match:
            return json.loads(match.group())
        raise HTTPException(status_code=502, detail="LLM returned malformed JSON")

def resolve_llm_config(req_provider, req_api_key, req_model, user: Optional[dict]) -> tuple[str, str, str]:
    """
    Returns (provider, api_key, model) to use.
    Pro users get QueryMind's key. Free users must supply their own.
    """
    if user and user.get("is_pro") and QM_API_KEY:
        return QM_PROVIDER, QM_API_KEY, QM_MODEL

    if not req_api_key:
        raise HTTPException(
            status_code=402,
            detail="API key required. Upgrade to Pro to use QueryMind without your own key."
        )
    if not req_provider or not req_model:
        raise HTTPException(status_code=400, detail="provider and model are required for free tier")

    return req_provider, req_api_key, req_model

# ── DB helpers ────────────────────────────────────────────────────────────────
def get_sql_engine(connection_string: str):
    try:
        engine = create_engine(connection_string, pool_pre_ping=True)
        return engine
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid connection string: {e}")

def introspect_schema(engine) -> str:
    inspector = inspect(engine)
    lines = []
    for table_name in inspector.get_table_names():
        cols = inspector.get_columns(table_name)
        fks  = inspector.get_foreign_keys(table_name)
        col_defs = [f"  {c['name']} {str(c['type'])}" for c in cols]
        for fk in fks:
            col_defs.append(
                f"  -- FK: {', '.join(fk['constrained_columns'])} → "
                f"{fk['referred_table']}.{', '.join(fk['referred_columns'])}"
            )
        lines.append(f"CREATE TABLE {table_name} (\n" + ",\n".join(col_defs) + "\n);")
    return "\n\n".join(lines)

def execute_sql(engine, sql: str) -> list[dict]:
    safe_sql = validate_sql(sql)
    with engine.connect() as conn:
        result = conn.execute(text(safe_sql))
        cols = list(result.keys())
        return [dict(zip(cols, row)) for row in result.fetchall()]

# ── Auth endpoints ─────────────────────────────────────────────────────────────
@app.post("/auth/signup")
def signup(req: SignupRequest, db: sqlite3.Connection = Depends(get_db)):
    existing = db.execute("SELECT id FROM users WHERE email = ?", (req.email,)).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    if len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    db.execute(
        "INSERT INTO users (email, hashed_pw) VALUES (?, ?)",
        (req.email, hash_password(req.password))
    )
    db.commit()
    token = create_token(req.email)
    return {"token": token, "email": req.email, "is_pro": False}

@app.post("/auth/login")
def login(req: LoginRequest, db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM users WHERE email = ?", (req.email,)).fetchone()
    if not row or not verify_password(req.password, row["hashed_pw"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(req.email)
    return {"token": token, "email": req.email, "is_pro": bool(row["is_pro"])}

@app.get("/auth/me")
def me(user: dict = Depends(get_current_user)):
    return {"email": user["email"], "is_pro": bool(user["is_pro"])}

# ── Stripe endpoints ───────────────────────────────────────────────────────────
@app.post("/billing/checkout")
async def create_checkout(user: dict = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)):
    if not STRIPE_SECRET_KEY or not STRIPE_PRICE_ID:
        raise HTTPException(status_code=501, detail="Billing not configured")

    # Create or retrieve Stripe customer
    customer_id = user.get("stripe_customer_id")
    if not customer_id:
        customer = stripe.Customer.create(email=user["email"])
        customer_id = customer.id
        db.execute("UPDATE users SET stripe_customer_id = ? WHERE email = ?", (customer_id, user["email"]))
        db.commit()

    session = stripe.checkout.Session.create(
        customer=customer_id,
        payment_method_types=["card"],
        line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
        mode="subscription",
        success_url=f"{FRONTEND_URL}/pro?success=1",
        cancel_url=f"{FRONTEND_URL}/pricing",
    )
    return {"checkout_url": session.url}

@app.post("/billing/webhook")
async def stripe_webhook(
    request_body: bytes = Depends(lambda: None),
    stripe_signature: Optional[str] = Header(None),
    db: sqlite3.Connection = Depends(get_db)
):
    """Stripe sends events here. We listen for checkout.session.completed."""
    from fastapi import Request
    # Note: handled via raw request — see webhook handler below

@app.post("/billing/portal")
async def billing_portal(user: dict = Depends(get_current_user)):
    """Returns Stripe customer portal URL for managing subscription."""
    if not user.get("stripe_customer_id"):
        raise HTTPException(status_code=400, detail="No billing account found")
    session = stripe.billing_portal.Session.create(
        customer=user["stripe_customer_id"],
        return_url=f"{FRONTEND_URL}/account",
    )
    return {"portal_url": session.url}

# Stripe webhook needs raw body — separate route handler
from fastapi import Request

@app.post("/billing/stripe-webhook")
async def stripe_webhook_handler(request: Request, db: sqlite3.Connection = Depends(get_db)):
    payload   = await request.body()
    sig       = request.headers.get("stripe-signature", "")

    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=501, detail="Webhook secret not configured")

    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        customer_id = session.get("customer")
        if customer_id:
            db.execute("UPDATE users SET is_pro = 1 WHERE stripe_customer_id = ?", (customer_id,))
            db.commit()

    if event["type"] in ("customer.subscription.deleted", "customer.subscription.paused"):
        customer_id = event["data"]["object"].get("customer")
        if customer_id:
            db.execute("UPDATE users SET is_pro = 0 WHERE stripe_customer_id = ?", (customer_id,))
            db.commit()

    return {"received": True}

# ── Query endpoints ────────────────────────────────────────────────────────────
@app.get("/")
def health():
    return {"status": "ok", "service": "QueryMind API", "version": "2.0.0"}

@app.post("/query/schema")
async def query_from_schema(
    req: SchemaQueryRequest,
    user: Optional[dict] = Depends(get_optional_user)
):
    provider, api_key, model = resolve_llm_config(req.provider, req.api_key, req.model, user)
    try:
        result = await call_llm(provider, api_key, model, req.schema_ddl, req.question)
        # Validate the SQL the LLM returned — catch any write operations
        if result.get("sql"):
            try:
                result["sql"] = validate_sql(result["sql"])
            except HTTPException as e:
                raise HTTPException(status_code=400, detail=f"LLM generated an unsafe query: {e.detail}")
        return {
            "mode": "schema",
            "question": req.question,
            "tier": "pro" if (user and user.get("is_pro")) else "free",
            **result
        }
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"LLM error: {e.response.text[:300]}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/query/live")
async def query_live_db(
    req: ConnectionQueryRequest,
    user: Optional[dict] = Depends(get_optional_user)
):
    provider, api_key, model = resolve_llm_config(req.provider, req.api_key, req.model, user)
    engine = get_sql_engine(req.connection_string)

    try:
        schema_ddl = introspect_schema(engine)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Schema introspection failed: {e}")

    try:
        llm_result = await call_llm(provider, api_key, model, schema_ddl, req.question)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"LLM error: {e.response.text[:300]}")

    sql = llm_result.get("sql", "")
    if not sql:
        raise HTTPException(status_code=502, detail="LLM did not return SQL")

    try:
        real_data = execute_sql(engine, sql)
    except SQLAlchemyError as e:
        raise HTTPException(status_code=400, detail=f"SQL execution failed: {str(e)[:300]}")

    narration_prompt = f"""Real query results:
{json.dumps(real_data[:50], default=str)}

Original question: {req.question}

Return JSON with keyMetrics, headline, narrative (4-6 sentences), confidence, vizType. No SQL field. No markdown."""

    try:
        narration = await call_llm(provider, api_key, model, schema_ddl, narration_prompt)
    except Exception:
        narration = {"headline": "Query executed", "narrative": "Results returned from your database.", "confidence": "high", "vizType": "table", "keyMetrics": []}

    return {
        "mode": "live",
        "question": req.question,
        "sql": sql,
        "data": real_data,
        "row_count": len(real_data),
        "tier": "pro" if (user and user.get("is_pro")) else "free",
        **{k: v for k, v in narration.items() if k != "sql"},
    }

@app.post("/dashboard")
async def generate_dashboard(
    req: DashboardRequest,
    user: Optional[dict] = Depends(get_optional_user)
):
    """
    Generates a complete multi-panel business dashboard from a schema.
    Each panel has its own SQL, data, chart type, headline, and narrative.
    Returns 4-6 panels covering different business angles.
    """
    provider, api_key, model = resolve_llm_config(req.provider, req.api_key, req.model, user)

    focus_clause = f"\n\nFocus area: {req.focus}" if req.focus else ""
    question = f"Generate a complete business dashboard for this schema.{focus_clause}"

    try:
        raw = await call_llm(
            provider, api_key, model,
            req.schema_ddl, question,
            system_override=DASHBOARD_SYSTEM_PROMPT
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"LLM error: {e.response.text[:300]}")

    # Validate each panel's SQL
    if "panels" in raw:
        for panel in raw["panels"]:
            sql = panel.get("sql", "")
            if sql:
                try:
                    panel["sql"] = validate_sql(sql)
                except HTTPException as e:
                    # Don't fail the whole dashboard — mark the panel as unsafe
                    panel["sql"] = ""
                    panel["headline"] = "Query blocked for safety"
                    panel["narrative"] = f"The generated query was blocked: {e.detail}"
                    panel["confidence"] = "low"

    return {
        "mode": "dashboard",
        "tier": "pro" if (user and user.get("is_pro")) else "free",
        **raw
    }

@app.post("/introspect")
async def introspect_endpoint(req: SchemaIntrospectRequest, user: dict = Depends(get_current_user)):
    """Live schema introspection — requires authentication."""
    engine = get_sql_engine(req.connection_string)
    try:
        schema = introspect_schema(engine)
        tables = inspect(engine).get_table_names()
        return {"schema_ddl": schema, "tables": tables, "table_count": len(tables)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
