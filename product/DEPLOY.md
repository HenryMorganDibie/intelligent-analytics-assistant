# Deploying QueryMind

Two services. Vercel for the frontend (always free). Three options for the backend.

```
product/
├── backend/    → Render (free) · Aeroplane (self-hosted) · Railway (paid)
└── frontend/   → Vercel (free)
```

---

## Backend options — pick one

### Option A: Render (recommended free option)

Render's free web service tier works well for QueryMind's backend because the backend
is stateless — no database, no persistent storage. Users supply their own API keys
per session, so cold starts (a few seconds on first request) are acceptable.

**Steps:**

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect this GitHub repo
3. Set **Root Directory** to `product/backend`
4. Runtime: **Python 3**
5. Build command: `pip install -r requirements.txt`
6. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
7. Instance type: **Free**
8. Click **Create Web Service**

Render gives you a URL like `https://querymind-backend.onrender.com`.

**Copy this URL — you need it for the Vercel step.**

No environment variables needed. Users bring their own API keys through the UI.

---

### Option B: Aeroplane (free software, you bring a VPS)

Aeroplane is a self-hosted control plane — think Railway running on your own server.
It's 100% free software. You pay only for the VPS, not for Aeroplane itself.

**What you need first: a VPS**

Cheapest options (all support Aeroplane):
| Provider | Cheapest plan | Monthly cost |
|---|---|---|
| Hetzner | CX22 (2 vCPU, 4GB RAM) | ~€3.29 |
| Vultr | Cloud Compute 1GB | $2.50 |
| DigitalOcean | Basic Droplet 1GB | $4.00 |

Any Ubuntu 22.04 or 24.04 VPS works.

**Install Aeroplane on your VPS:**

```bash
# SSH into your VPS, then run:
curl -fsSL https://get.aeroplane.run | sh
```

That one script sets up the full control plane — apps, domains, logs, PostgreSQL, Redis, Caddy (HTTPS), everything.

**Deploy QueryMind backend on Aeroplane:**

1. Open your Aeroplane dashboard (it runs on your VPS IP)
2. **New App** → connect your GitHub repo
3. Root directory: `product/backend`
4. Build: `pip install -r requirements.txt`
5. Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. Attach a domain or use the auto-generated one
7. Deploy

**Migrating from Railway?** Aeroplane has a built-in Railway import — connect your Railway token and it pulls services, variables, and databases across automatically.

---

### Option C: Railway (original, paid after free tier)

If you get more credits or upgrade to the $5/month Hobby plan:

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Root directory: `product/backend`
3. Railway auto-detects Python and uses the `Procfile`
4. Settings → Networking → Generate Domain

---

## Frontend — Vercel (always free)

This step is the same regardless of which backend option you chose.

### Steps:

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import this GitHub repo (`intelligent-analytics-assistant`)
3. Set **Root Directory** to `product/frontend`
4. Vercel auto-detects Vite
5. Before deploying → **Environment Variables** → add:

| Name | Value |
|---|---|
| `VITE_BACKEND_URL` | Your backend URL from whichever option you chose |

6. Click **Deploy**

You'll get a URL like `https://querymind.vercel.app`.

---

## Testing end to end

1. Open your Vercel URL
2. Click **Try free**
3. Pick **Groq** — free tier, get a key at [console.groq.com](https://console.groq.com) in 30 seconds, no card needed
4. Paste your key → **Test key** → should show "Connection successful"
5. Pick a schema template or paste your own
6. Ask a question — you should get a full analysis with SQL, chart, and English narrative

---

## Running locally (no deployment needed for development)

```bash
# Terminal 1 — backend
cd product/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd product/frontend
npm install
echo "VITE_BACKEND_URL=http://localhost:8000" > .env.local
npm run dev
```

Open http://localhost:3000

---

## Architecture

```
Browser (Vercel)
    │
    │  POST /query/schema
    │  { question, schema_ddl, provider, api_key, model }
    ▼
Backend (Render / Aeroplane / Railway)
    │
    ├── Routes to LLM provider (Claude / Groq / OpenAI) using the user's own key
    │   → generates SQL + mock data + narrative
    │
    └── /query/live — executes real SQL against user's own database
    │
    ▼
Browser renders: headline + key metrics + chart + SQL + English narrative
```

User's API key travels: Browser → Backend → LLM provider.
It is never stored anywhere. Backend holds it only for the duration of the HTTP request.
