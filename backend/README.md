# data-harness-ui backend

FastAPI backend for the local Data Harness workbench.

This service owns session state, uploaded data handles, and AI provider
configuration. It depends on `data-harness` and imports that package as
`data_harness`.

The backend keeps uploaded datasets in the agent session cache and returns
compact handles to the frontend. Chat requests run through an
`AsyncAgentSession`, and the streaming endpoint maps SDK stream events into
newline-delimited JSON for the browser.

Using the app requires either signing in with GitHub (gets a shared monthly
budget against `DEEPSEEK_API_KEY`) or bringing your own DeepSeek key
(`X-User-Deepseek-Key` header, never persisted server-side). Identity and
monthly spend live in Postgres (`DATABASE_URL`); chat sessions stay in-memory
and don't survive a restart.

## Local development

Create `.env` in this directory:

```env
DEEPSEEK_API_KEY=...
# optional
DEEPSEEK_MODEL=deepseek-v4-flash

# Persistence (falls back to a local sqlite file if unset)
DATABASE_URL=postgresql://...

# GitHub OAuth (create an OAuth App at github.com/settings/developers;
# callback URL is <backend-origin>/auth/github/callback)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
FRONTEND_URL=http://localhost:3000

# Session cookie signing; also required in production
SESSION_SECRET_KEY=...
# Cross-site cookies (Vercel <-> Render) need Secure, which needs HTTPS.
# For local http:// dev, relax this:
SESSION_HTTPS_ONLY=false

# optional: shared-key monthly budget in cents (default 50 = $0.50)
MONTHLY_BUDGET_CENTS=50
```

Then run:

```bash
uv sync
uv run python -m uvicorn main:app --reload
```

The API will be available at [http://localhost:8000](http://localhost:8000).

## API

```text
GET  /health
GET  /auth/me
GET  /auth/github/login
GET  /auth/github/callback
POST /auth/logout
POST /sessions
GET  /sessions/{session_id}
POST /sessions/{session_id}/uploads
POST /sessions/{session_id}/messages
POST /sessions/{session_id}/messages/stream
```

`POST /sessions` accepts an optional `X-User-Deepseek-Key` header for BYOK.
Without it, the caller must be signed in and have remaining monthly budget
(`402` if exhausted, `401` if signed out).

The streaming endpoint emits newline-delimited JSON events:

```jsonl
{"type":"tool_use","data":{"name":"python_interpreter","input":{"code":"df.head()"}}}
{"type":"tool_result","data":{"content":"shape: (5, 8)","is_error":false}}
{"type":"chunk","data":"The answer is "}
{"type":"done","data":{"id":"...","messages":[...]}}
```

## Tests

```bash
uv run python -m pytest tests/ -v
```
