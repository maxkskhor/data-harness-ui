# Development guide

## Project layout

```text
frontend/   Next.js · TypeScript · Tailwind
backend/    FastAPI · Python · data-harness
```

## Local setup

**Backend** — requires `DEEPSEEK_API_KEY` in `backend/.env`:

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

### Backend API

```
GET  /health
POST /sessions
GET  /sessions/{session_id}
POST /sessions/{session_id}/uploads
POST /sessions/{session_id}/messages
```

### Frontend API boundary

All backend calls go through `frontend/src/lib/api.ts`. Keep types there in
sync with backend response shapes (`Session`, `ChatMessage`, `UploadSummary`).

## Running tests

```bash
cd backend
uv run python -m pytest tests/ -v
```

## Key conventions

- `DEEPSEEK_API_KEY` is required. The backend returns `503` without it — no
  silent fallback.
- CSV is the first data-source path; the app is not CSV-specific.
- The frontend uses Next.js App Router with `"use client"` for interactive
  components.
- Keep API types explicit; avoid `any`.
- The first screen should be the actual workbench, not a landing page.
