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
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import duckdb
import httpx
import pandas as pd
import stripe
from fastapi import Depends, FastAPI, File, HTTPException, Header, UploadFile
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

FRONTEND_URL = os.getenv("FRONTEND_URL", "https://querymind-ten.vercel.app")

# Build allowed origins list — always include the Vercel URL and localhost
ALLOWED_ORIGINS = [
    FRONTEND_URL,
    "https://querymind-ten.vercel.app",   # hardcoded as safe fallback
    "http://localhost:3000",
    "http://localhost:5173",
]

stripe.api_key = STRIPE_SECRET_KEY

# ── Database (SQLite — zero setup, lives on Render disk) ──────────────────────
DB_PATH = os.getenv("DB_PATH", "/tmp/querymind.db")
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/tmp/querymind_uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# In-memory store of uploaded file sessions: session_id → {path, schema, table_name, row_count}
file_sessions: dict = {}

SUPPORTED_EXTENSIONS = {
    ".csv": "CSV",
    ".tsv": "TSV",
    ".parquet": "Parquet",
    ".xlsx": "Excel",
    ".xls": "Excel",
    ".json": "JSON (newline-delimited)",
}

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
    allow_origins=ALLOWED_ORIGINS,
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
    schema_ddl: Optional[str] = None   # for schema/SQL mode
    session_id: Optional[str] = None   # for file mode
    focus: Optional[str] = None
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

# ── Schema parser ─────────────────────────────────────────────────────────────
def extract_schema_summary(ddl: str) -> str:
    """Parse DDL into a strict column inventory the LLM must reference."""
    lines = []
    current_table = None
    for line in ddl.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("CREATE TABLE"):
            parts = stripped.replace("(", " ").split()
            if len(parts) >= 3:
                current_table = parts[2].strip("`\"'[]")
                lines.append(f"\nTABLE: {current_table}")
                lines.append("  COLUMNS:")
        elif current_table and stripped and not upper.startswith(
            ("PRIMARY", "FOREIGN", "UNIQUE", "INDEX", "KEY", "--", ")", "CONSTRAINT", "CHECK")
        ):
            col = stripped.split()[0].strip("`\"'[],();")
            col_def = " ".join(stripped.split()[1:3]).rstrip(",").strip()
            if col and col.upper() not in ("CONSTRAINT", "CHECK", "INDEX", "UNIQUE"):
                lines.append(f"    - {col}  [{col_def}]")
        elif stripped.startswith(")"):
            current_table = None
    return "\n".join(lines) if lines else "(use the DDL above)"


def parse_json_response(raw: str) -> dict:
    """Strip markdown fences and parse JSON. Raise HTTPException on failure."""
    clean = raw.strip()
    for fence in ("```json", "```JSON", "```"):
        clean = clean.replace(fence, "")
    clean = clean.strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", clean)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
    raise HTTPException(
        status_code=502,
        detail=f"LLM returned malformed JSON. Preview: {clean[:500]}"
    )


async def raw_llm_call(provider: str, api_key: str, model: str,
                       system: str, user_msg: str,
                       max_tokens: int = 2000) -> str:
    """Single raw LLM call. Returns text content."""
    async with httpx.AsyncClient(timeout=90.0) as client:
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
                    "max_tokens": max_tokens,
                    "temperature": 0,
                    "system": system,
                    "messages": [{"role": "user", "content": user_msg}],
                },
            )
            resp.raise_for_status()
            return "".join(b.get("text", "") for b in resp.json().get("content", []))

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
                    "max_tokens": max_tokens,
                    "temperature": 0,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user_msg},
                    ],
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]

        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")


# ── Three-pass pipeline ────────────────────────────────────────────────────────
# Pass 1: SQL generation
SQL_SYSTEM = """You are a senior SQL engineer. Your ONLY job is to write one correct SQL query.

DATABASE SCHEMA:
{schema}

VALID TABLES AND COLUMNS (use ONLY these — no others):
{schema_summary}

RULES:
- Output ONLY a JSON object with one key: "sql"
- SELECT or WITH only. Never INSERT/UPDATE/DELETE/DROP/ALTER.
- DuckDB-compatible SQL (standard SQL, supports QUALIFY, MEDIAN, PERCENTILE_CONT etc).
- Only reference tables and columns from VALID TABLES AND COLUMNS above.
- If the question cannot be answered from the schema, set sql to empty string "" and add "impossible": true.
- Always include LIMIT — maximum 500 rows.
- Aggregates (SUM/COUNT/AVG/MIN/MAX) must have matching GROUP BY.

Output format — ONLY this JSON, nothing else:
{{"sql": "SELECT ...", "impossible": false}}"""

# File-mode SQL system — enforces aggregation so result sets are always small
FILE_SQL_SYSTEM = """You are a senior SQL engineer writing DuckDB queries against a user's data file.

TABLE NAME: dataset
COLUMNS (the ONLY ones you may use):
{schema_summary}

CRITICAL RULES FOR LARGE FILES:
- The table may have billions of rows. Your query MUST return a small result set (≤500 rows).
- ALWAYS use aggregation (GROUP BY + COUNT/SUM/AVG/MIN/MAX) or LIMIT for detail queries.
- NEVER write SELECT * without a LIMIT clause.
- Use DuckDB-compatible SQL (supports QUALIFY, MEDIAN, PERCENTILE_CONT, LIST, STRUCT).
- SELECT or WITH only. Never INSERT/UPDATE/DELETE/DROP/ALTER.
- Only use column names from the list above — exactly as written.
- If the question cannot be answered from the available columns, set impossible to true.

For different question types:
- "overview / summary / statistics" → aggregate ALL numeric columns with COUNT/SUM/AVG/MIN/MAX
- "top N / bottom N" → GROUP BY the dimension, ORDER BY the metric, LIMIT N
- "trend over time" → GROUP BY date/period column, ORDER BY date
- "unique values / categories" → SELECT DISTINCT col, COUNT(*) GROUP BY col ORDER BY 2 DESC LIMIT 50
- "nulls / missing" → SELECT col_name, COUNT(*) FILTER (WHERE col IS NULL) AS null_count for each col
- "distribution" → GROUP BY ranges using CASE WHEN or integer division

Output format — ONLY this JSON, nothing else:
{{"sql": "SELECT ... (aggregated, ≤500 rows)", "impossible": false}}"""

# Pass 2: Data generation
DATA_SYSTEM = """You are a data simulation expert. Given a SQL query and the database schema, generate realistic sample data that the query WOULD return if run against a real populated database.

RULES:
- Return ONLY a JSON object with key "data" (array of row objects) and "keyMetrics" (array of {{label, value}} objects).
- Column names in data rows MUST exactly match the SELECT column aliases in the SQL.
- Numbers must be internally consistent: if you show subtotals, they must sum to totals.
- keyMetrics must be derived from the data — pick the 2-4 most important numbers.
- Format keyMetrics values for humans: "$2.4M" not "2400000", "34%" not "0.34".
- Generate 8-15 rows for lists, 1-4 rows for aggregate summaries.
- Make the data realistic for a real business — not toy numbers.

Output format — ONLY this JSON:
{{"data": [...], "keyMetrics": [{{"label": "...", "value": "..."}}]}}"""

# Pass 3: Narrative generation  
NARRATIVE_SYSTEM = """You are a senior business analyst briefing a founder. Given a business question, SQL query, and the actual data results, write an honest interpretation.

RULES:
- Base EVERY claim on the data provided. Never add information not in the data.
- headline: one direct factual sentence stating the single most important finding. No vague titles.
  Good: "Electronics drives 42% of revenue but margins are 18 points below Apparel"
  Bad: "Revenue Analysis" or "Interesting revenue trends"
- narrative: 4-6 sentences structured as:
  1. Main finding (what the data shows)
  2. Business implication (what this means for the company)
  3. Second insight or comparison from the data
  4. Risk or caveat (what this data doesn't tell us or what to watch)
  5-6. Recommended action or next question to investigate
- confidence: "high" if schema directly supports the question, "medium" if assumptions were needed, "low" if the schema lacked key data
- vizType: choose based purely on data shape:
  "area" = time-series (dates/months), "bar" = ranked list ≤20 rows, "pie" = composition ≤7 categories,
  "stat" = single number, "stats" = 2-4 numbers on one row, "table" = multi-column or >20 rows, "line" = many time points

Output format — ONLY this JSON:
{{"headline": "...", "narrative": "...", "confidence": "high|medium|low", "vizType": "..."}}"""


async def call_llm(provider: str, api_key: str, model: str, schema: str, question: str,
                   system_override: str = None) -> dict:
    """
    Three-pass pipeline for accuracy:
    1. SQL generation (focused, schema-grounded)
    2. Data simulation (consistent, realistic)
    3. Narrative (grounded in the actual data)

    Falls back to single-pass for dashboard calls (system_override set).
    """
    schema_summary = extract_schema_summary(schema)

    # Dashboard / override: single pass (dashboard prompt handles its own structure)
    if system_override:
        system = system_override.format(schema=schema, schema_summary=schema_summary)
        raw = await raw_llm_call(provider, api_key, model, system, question, max_tokens=6000)
        result = parse_json_response(raw)
        if "panels" in result:
            for p in result["panels"]:
                if not isinstance(p.get("data"), list):
                    p["data"] = []
                if not isinstance(p.get("keyMetrics"), list):
                    p["keyMetrics"] = []
        return result

    # ── Pass 1: SQL ───────────────────────────────────────────────────────────
    sql_system = SQL_SYSTEM.format(schema=schema, schema_summary=schema_summary)
    sql_raw = await raw_llm_call(provider, api_key, model, sql_system, question, max_tokens=800)
    sql_result = parse_json_response(sql_raw)
    sql = sql_result.get("sql", "").strip()
    impossible = sql_result.get("impossible", False)

    if impossible or not sql:
        return {
            "sql": "",
            "data": [],
            "keyMetrics": [],
            "headline": "This question cannot be answered from the available schema",
            "narrative": (
                "The database schema does not contain the tables or columns needed to answer this question. "
                f"The question asks about data that isn't tracked in your schema. "
                "Consider adding the relevant tables or columns, or rephrase the question "
                "to use data that is available."
            ),
            "confidence": "low",
            "vizType": "stat",
        }

    # Validate SQL safety before passing to data generation
    try:
        sql = validate_sql(sql)
    except HTTPException as e:
        raise HTTPException(status_code=400, detail=f"Generated SQL failed safety check: {e.detail}")

    # ── Pass 2: Data ──────────────────────────────────────────────────────────
    data_user_msg = f"""SQL query:
{sql}

Original question: {question}

Database schema:
{schema_summary}

Generate realistic sample data this query would return from a real populated database."""

    data_raw = await raw_llm_call(provider, api_key, model, DATA_SYSTEM, data_user_msg, max_tokens=3000)
    data_result = parse_json_response(data_raw)
    data = data_result.get("data", [])
    key_metrics = data_result.get("keyMetrics", [])
    if not isinstance(data, list):
        data = []
    if not isinstance(key_metrics, list):
        key_metrics = []

    # ── Pass 3: Narrative ─────────────────────────────────────────────────────
    narrative_user_msg = f"""Business question: {question}

SQL that was run:
{sql}

Data returned ({len(data)} rows):
{json.dumps(data[:20], default=str)}

Key metrics extracted:
{json.dumps(key_metrics, default=str)}

Write an honest, accurate business interpretation grounded entirely in this data."""

    narr_raw = await raw_llm_call(provider, api_key, model, NARRATIVE_SYSTEM, narrative_user_msg, max_tokens=2000)
    narr_result = parse_json_response(narr_raw)

    return {
        "sql": sql,
        "data": data,
        "keyMetrics": key_metrics,
        "headline": narr_result.get("headline", ""),
        "narrative": narr_result.get("narrative", ""),
        "confidence": narr_result.get("confidence", "medium"),
        "vizType": narr_result.get("vizType", "table"),
    }


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
class FileQueryRequest(BaseModel):
    session_id: str
    question: str
    provider: Optional[str] = None
    api_key:  Optional[str] = None
    model:    Optional[str] = None


@app.get("/")
def health():
    return {"status": "ok", "service": "QueryMind API", "version": "2.0.0"}


# ── File upload endpoints ──────────────────────────────────────────────────────

@app.post("/file/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Accept CSV, TSV, Parquet, Excel, or NDJSON.
    Sanitizes all column names — replaces colons, spaces, special chars with underscores.
    Stores a clean Parquet copy internally so DuckDB can always query safely.
    """
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Supported: {', '.join(SUPPORTED_EXTENSIONS.keys())}"
        )

    session_id = str(uuid.uuid4())
    save_path  = UPLOAD_DIR / f"{session_id}{suffix}"

    content = await file.read()
    save_path.write_bytes(content)
    file_size_mb = len(content) / (1024 * 1024)

    try:
        # Load into pandas so we can sanitize column names
        if suffix == ".csv":
            df = pd.read_csv(save_path, low_memory=False)
        elif suffix == ".tsv":
            df = pd.read_csv(save_path, sep="\t", low_memory=False)
        elif suffix == ".parquet":
            df = pd.read_parquet(save_path)
        elif suffix in (".xlsx", ".xls"):
            df = pd.read_excel(save_path, engine="openpyxl")
        elif suffix == ".json":
            df = pd.read_json(save_path, lines=True)
        else:
            raise HTTPException(status_code=400, detail="Unsupported format")

        # Sanitize column names — any non-alphanumeric char → underscore
        original_columns = list(df.columns)
        clean_cols = []
        seen = {}
        for col in original_columns:
            clean = re.sub(r"[^a-zA-Z0-9_]", "_", str(col))
            clean = re.sub(r"_+", "_", clean).strip("_").lower()
            if not clean or clean[0].isdigit():
                clean = "col_" + clean
            if clean in seen:
                seen[clean] += 1
                clean = f"{clean}_{seen[clean]}"
            else:
                seen[clean] = 0
            clean_cols.append(clean)

        df.columns = clean_cols
        col_mapping = {orig: clean for orig, clean in zip(original_columns, clean_cols)}

        # Save as clean Parquet — fastest format for DuckDB
        parquet_path = UPLOAD_DIR / f"{session_id}_clean.parquet"
        df.to_parquet(parquet_path, index=False)

        # Query via DuckDB
        table_name = "dataset"
        con = duckdb.connect()
        con.execute(f"CREATE VIEW {table_name} AS SELECT * FROM read_parquet('{parquet_path}')")
        cols_raw  = con.execute(f"DESCRIBE {table_name}").fetchall()
        columns   = [{"name": row[0], "type": row[1]} for row in cols_raw]
        row_count = con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        preview   = con.execute(f"SELECT * FROM {table_name} LIMIT 5").fetchdf().to_dict(orient="records")
        con.close()

        # DDL for LLM — uses clean column names
        schema_ddl  = f"CREATE TABLE {table_name} (\n"
        schema_ddl += ",\n".join(f"  {c['name']} {c['type']}" for c in columns)
        schema_ddl += "\n);"

        file_sessions[session_id] = {
            "path":        str(parquet_path),
            "suffix":      ".parquet",
            "table_name":  table_name,
            "schema_ddl":  schema_ddl,
            "columns":     columns,
            "col_mapping": col_mapping,
            "row_count":   row_count,
            "filename":    file.filename,
        }

        return {
            "session_id":   session_id,
            "filename":     file.filename,
            "file_type":    SUPPORTED_EXTENSIONS[suffix],
            "file_size_mb": round(file_size_mb, 2),
            "row_count":    row_count,
            "column_count": len(columns),
            "columns":      columns,
            "col_mapping":  col_mapping,
            "schema_ddl":   schema_ddl,
            "preview":      preview,
        }

    except HTTPException:
        raise
    except Exception as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)[:400]}")


@app.post("/file/query")
async def query_file(
    req: FileQueryRequest,
    user: Optional[dict] = Depends(get_optional_user)
):
    """
    Ask a question about an uploaded file.
    Uses the three-pass pipeline but executes REAL SQL against the actual data via DuckDB.
    Returns real results — no simulation.
    """
    session = file_sessions.get(req.session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail="File session not found. Please re-upload your file."
        )

    provider, api_key, model = resolve_llm_config(req.provider, req.api_key, req.model, user)
    schema_ddl = session["schema_ddl"]
    table_name = session["table_name"]
    file_path = session["path"]
    suffix = session["suffix"]
    row_count = session["row_count"]

    # ── Pass 1: Generate SQL ──────────────────────────────────────────────────
    schema_summary = extract_schema_summary(schema_ddl)
    context = (
        f"This is a {SUPPORTED_EXTENSIONS.get(suffix, 'data')} file named "
        f"'{session['filename']}' with {row_count:,} rows and {len(session['columns'])} columns."
    )

    # Use the file-specific SQL prompt — enforces aggregation for large result sets
    sql_system = FILE_SQL_SYSTEM.format(schema_summary=schema_summary)
    sql_user = f"{context}\n\nQuestion: {req.question}"

    sql_raw = await raw_llm_call(provider, api_key, model, sql_system, sql_user, max_tokens=800)
    sql_result = parse_json_response(sql_raw)
    sql = sql_result.get("sql", "").strip()
    impossible = sql_result.get("impossible", False)

    if impossible or not sql:
        return {
            "sql": "",
            "data": [],
            "keyMetrics": [],
            "headline": "This question cannot be answered from the available columns",
            "narrative": "The uploaded file does not contain the columns needed to answer this question. Check the column list and try rephrasing.",
            "confidence": "low",
            "vizType": "stat",
            "mode": "file",
            "row_count": row_count,
        }

    # Validate SQL safety
    try:
        sql = validate_sql(sql)
    except HTTPException as e:
        raise HTTPException(status_code=400, detail=f"Generated SQL failed safety check: {e.detail}")

    # ── Execute REAL SQL against DuckDB ──────────────────────────────────────
    try:
        con = duckdb.connect()
        con.execute(f"CREATE VIEW {table_name} AS SELECT * FROM read_parquet('{file_path}')")
        result_df = con.execute(sql).fetchdf()
        con.close()
        real_data = result_df.to_dict(orient="records")
        result_row_count = len(real_data)
    except duckdb.Error as e:
        raise HTTPException(
            status_code=400,
            detail=f"SQL execution failed: {str(e)[:300]}. Try rephrasing your question."
        )

    # ── Smart result summarisation ────────────────────────────────────────────
    # LLM never sees more than LLM_ROW_LIMIT rows — for billion-row files the
    # SQL already aggregates, so result sets are always small. For detail queries
    # with many rows we sample + summarise using DuckDB before sending to LLM.
    LLM_ROW_LIMIT = 50

    if result_row_count <= LLM_ROW_LIMIT:
        llm_data = real_data
        data_description = f"{result_row_count} rows"
    else:
        # Too many rows to send — summarise numerics, sample the rest
        numeric_cols = [c for c in result_df.columns if result_df[c].dtype in
                        ["int64","float64","int32","float32"]]
        summary_parts = []
        for col in numeric_cols[:8]:
            s = result_df[col].describe()
            summary_parts.append(
                f"{col}: min={s['min']:.2f}, mean={s['mean']:.2f}, "
                f"max={s['max']:.2f}, sum={result_df[col].sum():.2f}"
            )
        llm_data = real_data[:LLM_ROW_LIMIT]  # first N rows as sample
        data_description = (
            f"{result_row_count:,} rows (showing first {LLM_ROW_LIMIT} as sample)\n"
            f"Numeric column summaries:\n" + "\n".join(summary_parts)
        )

    # ── Combined metrics + narrative call ─────────────────────────────────────
    combined_system = """You are a senior business analyst. Given a SQL query result from a user's data file,
return a JSON object with:
- keyMetrics: 2-4 most important numbers, formatted for humans ("$2.4M", "34%", "1,234")
- headline: one direct factual sentence stating the single most important finding
- narrative: 4-6 sentences — main finding, business implication, second insight, caveat, recommended action
- confidence: "high" (data directly answers question) | "medium" | "low"
- vizType: "area" (time-series) | "bar" (ranked ≤20 rows) | "pie" (≤7 categories) | "stat" (1 number) | "stats" (2-4 numbers) | "table" (multi-col detail) | "line" (many time points)

Ground every claim in the data provided. Do not invent numbers.
Return ONLY valid JSON, no markdown."""

    combined_user = f"""Question: {req.question}

File: {session["filename"]} ({row_count:,} total rows, {len(session["columns"])} columns)
SQL executed: {sql}
Result: {data_description}
Data sample: {json.dumps(llm_data, default=str)}"""

    combined_raw = await raw_llm_call(provider, api_key, model, combined_system, combined_user, max_tokens=1500)
    combined_result = parse_json_response(combined_raw)

    return {
        "sql":         sql,
        "data":        real_data[:500],          # cap frontend display at 500 rows
        "keyMetrics":  combined_result.get("keyMetrics", []),
        "headline":    combined_result.get("headline", ""),
        "narrative":   combined_result.get("narrative", ""),
        "confidence":  "high",                   # always high — real data
        "vizType":     combined_result.get("vizType", "table"),
        "mode":        "file",
        "result_rows": result_row_count,
        "total_file_rows": row_count,
    }


@app.delete("/file/{session_id}")
async def delete_file_session(session_id: str):
    """Clean up uploaded file and session."""
    session = file_sessions.pop(session_id, None)
    if session:
        Path(session["path"]).unlink(missing_ok=True)
        parquet_path = Path(session["path"]).with_suffix(".parquet")
        parquet_path.unlink(missing_ok=True)
    return {"deleted": True}


@app.get("/file/{session_id}/sample")
async def get_file_sample(session_id: str, rows: int = 20):
    """Return a sample of the uploaded file for preview."""
    session = file_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    rows = min(rows, 100)
    try:
        con = duckdb.connect()
        file_path  = session["path"]
        table_name = session["table_name"]
        con.execute(f"CREATE VIEW {table_name} AS SELECT * FROM read_parquet('{file_path}')")
        sample = con.execute(f"SELECT * FROM {table_name} LIMIT {rows}").fetchdf()
        con.close()
        return {"data": sample.to_dict(orient="records"), "columns": session["columns"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    provider, api_key, model = resolve_llm_config(req.provider, req.api_key, req.model, user)

    # Resolve schema — either from file session or direct DDL
    is_file = bool(req.session_id)
    if is_file:
        session = file_sessions.get(req.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="File session not found. Please re-upload your file.")
        schema_ddl  = session["schema_ddl"]
        table_name  = session["table_name"]
        file_path   = session["path"]
        suffix      = session["suffix"]
        row_count   = session["row_count"]
    else:
        if not req.schema_ddl:
            raise HTTPException(status_code=400, detail="Either schema_ddl or session_id is required")
        schema_ddl = req.schema_ddl

    focus_clause = f"\n\nFocus area: {req.focus}" if req.focus else ""
    question = f"Generate a complete business dashboard for this {'dataset' if is_file else 'schema'}.{focus_clause}"

    try:
        raw = await call_llm(
            provider, api_key, model,
            schema_ddl, question,
            system_override=DASHBOARD_SYSTEM_PROMPT
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"LLM error: {e.response.text[:300]}")

    # Validate and optionally execute each panel's SQL
    if "panels" in raw:
        for panel in raw["panels"]:
            sql = panel.get("sql", "")
            if not sql:
                continue
            # Safety check
            try:
                sql = validate_sql(sql)
                panel["sql"] = sql
            except HTTPException as e:
                panel["sql"] = ""
                panel["headline"] = "Query blocked for safety"
                panel["narrative"] = f"The generated query was blocked: {e.detail}"
                panel["confidence"] = "low"
                continue

            # For file mode — execute real SQL against the actual data
            if is_file:
                try:
                    con = duckdb.connect()
                    con.execute(f"CREATE VIEW {table_name} AS SELECT * FROM read_parquet('{file_path}')")
                    result_df = con.execute(sql).fetchdf()
                    con.close()
                    panel["data"] = result_df.to_dict(orient="records")[:100]
                    panel["confidence"] = "high"  # real data
                    panel["mode"] = "file"
                except duckdb.Error as e:
                    panel["narrative"] = f"Query executed but returned an error: {str(e)[:200]}"
                    panel["confidence"] = "low"

    return {
        "mode": "dashboard",
        "is_file": is_file,
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
