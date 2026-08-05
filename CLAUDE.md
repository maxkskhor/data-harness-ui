# Development guide

Full architecture, deployment, security posture, and operational procedures
live in [`README.md`](README.md) — read that first for anything beyond local
dev. This file is the terse agent-facing quick-reference.

## Project layout

```text
frontend/   Next.js · TypeScript · Tailwind
backend/    FastAPI · Python · data-harness
```

## Local setup

**Backend** — requires `DEEPSEEK_API_KEY` in `backend/.env`; see
[`backend/README.md`](backend/README.md) for the full env var list (GitHub
OAuth, `DATABASE_URL`, session secret):

```bash
cd backend
uv sync
uv run python -m uvicorn main:app --reload   # http://localhost:8000
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev                         # http://localhost:3000
```

## Architecture

The browser calls the backend over HTTP and never imports Python code directly.
The backend owns session state, uploaded data handles, and AI provider
configuration.

Sessions are currently in-memory. Each session holds one `AgentSession` from
the `data-harness` library, imported in Python as `data_harness`, which manages
conversation history and the data cache.

Identity and monthly spend are the exception: those live in Postgres
(`db.py`/`budget.py`) so they survive a restart even though chat sessions
don't. A session runs on the shared `DEEPSEEK_API_KEY` (requires GitHub
sign-in + remaining budget) or a caller-supplied BYOK key
(`X-User-Deepseek-Key`, never persisted, bypasses the budget entirely).

### Backend API

```
GET  /health
GET  /auth/me
GET  /auth/github/login
GET  /auth/github/callback
POST /auth/logout
POST /sessions
GET  /sessions/{session_id}
GET  /sessions/{session_id}/charts/{index}
POST /sessions/{session_id}/uploads
POST /sessions/{session_id}/messages
POST /sessions/{session_id}/messages/stream
```

### Frontend API boundary

All backend calls go through `frontend/src/lib/api.ts`. Keep types there in
sync with backend response shapes (`Session`, `ChatMessage`, `UploadSummary`).

## Running tests

```bash
cd backend
uv run python -m pytest tests/ -v
```

## Deployment

Push to `main` auto-deploys the **backend** (Render, webhook-connected).
It does **not** auto-deploy the **frontend** — Vercel isn't
git-connected here, so ship frontend changes with `vercel --prod --yes`
from `frontend/` after pushing. CI (`.github/workflows/ci.yml`) runs on
every push/PR but doesn't gate either deploy — treat a red run as
something to go investigate, not something that already stopped anything.

## Key conventions

- `DEEPSEEK_API_KEY` is required. The backend returns `503` without it — no
  silent fallback.
- Using the app at all requires GitHub sign-in or a BYOK key
  (`X-User-Deepseek-Key` header) — see README's "How auth, budget, and BYOK
  fit together". Don't add a code path that calls the shared key without
  going through `resolve_session_key`'s budget check.
- Every cost-generating endpoint carries `dependencies=[Depends(rate_limit)]`.
  Add it to new ones too.
- CSV is the first data-source path; the app is not CSV-specific.
- The frontend uses Next.js App Router with `"use client"` for interactive
  components.
- Keep API types explicit; avoid `any`.
- The first screen should be the actual workbench, not a landing page.
