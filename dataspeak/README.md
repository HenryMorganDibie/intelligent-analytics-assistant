# DataSpeak — Production UI

A schema-agnostic, AI-powered analytics assistant built as a React component.

## What it does

1. **Paste any SQL schema** (CREATE TABLE DDL from MySQL, PostgreSQL, SQLite, etc.)
2. **Ask questions in plain English**
3. **Get back English narrative answers** — not just raw query results
4. **Auto-visualizations** — bar, line, pie charts, or tables based on result shape
5. **SQL transparency** — generated SQL is collapsible for technical users

## How it differs from the original backend

The original project was hardwired to a specific MySQL database.  
DataSpeak is schema-agnostic — any user can bring their own database schema and immediately start querying it in plain English.

## Stack

- React + Recharts (frontend)
- Anthropic Claude API (`claude-sonnet-4-6`) for Text-to-SQL + English narration
- No backend required for the UI — plug in a FastAPI/SQLAlchemy backend to execute real queries

## Integration path (real DB execution)

Replace the mock data generation in the API call with:
```python
# FastAPI endpoint
@app.post("/query")
async def query(question: str, schema: str):
    sql = await generate_sql(question, schema)       # Claude generates SQL
    data = await execute_sql(sql, db_connection)     # SQLAlchemy executes it
    narrative = await interpret_results(data, question)  # Claude narrates
    return {"sql": sql, "data": data, "narrative": narrative}
```

## Monetization angles

- **Free tier**: 1 schema, 20 questions/month
- **Pro**: multiple DB connections, query history, export to PDF/CSV
- **Enterprise**: on-prem deployment, SSO, audit logs
