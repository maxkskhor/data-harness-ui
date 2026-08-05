# data-harness-ui

A hosted workbench for asking questions about data with
[`data-harness`](https://github.com/maxkskhor/data-harness).

Upload a CSV, ask a question, and a constrained data agent inspects the
dataset through the `data-harness` Python tool loop — sandboxed code
execution, no shell access, uploaded data kept behind cache handles instead
of pasted into the chat transcript.

**Live:**

- Frontend: [data-harness-ui.vercel.app](https://data-harness-ui.vercel.app)
- Backend: [data-harness-ui.onrender.com](https://data-harness-ui.onrender.com)

## Why try it

- **Ask natural-language questions about a local CSV**, then ask follow-ups
  against the same session context.
- **Keep data out of the chat transcript** — uploaded tables live in the
  backend session cache, referred to by compact handles.
- **A constrained agent runtime** — the model works through `data-harness`'s
  sandboxed Python interpreter, not arbitrary shell access.
- **Streamed runs** — the UI shows assistant text, tool calls, tool results,
  and rendered charts as they happen, not behind one blocking request. You
  can stop a run mid-stream.
- **Real charts** — the sandbox allowlists `matplotlib`/`seaborn`/`plotly`;
  a generated figure is captured and shown inline as an image.

## Architecture

```text
┌─────────────┐        HTTPS, credentials: include        ┌──────────────┐
│  Frontend    │ ─────────────────────────────────────────▶│   Backend    │
│  (Vercel)    │◀───────────────────────────────────────── │  (Render)    │
│  Next.js     │        NDJSON stream / JSON               │  FastAPI     │
└─────────────┘                                             └──────┬───────┘
                                                                     │
                          ┌──────────────────────────────────────────┼─────────────┐
                          │                                          │             │
                    ┌─────▼─────┐                            ┌──────▼──────┐ ┌────▼─────┐
                    │  GitHub    │                            │    Neon     │ │ DeepSeek │
                    │  OAuth     │                            │  Postgres   │ │   API    │
                    │ (identity) │                            │(users/spend)│ │ (shared  │
                    └────────────┘                            └─────────────┘ │ or BYOK) │
                                                                                └──────────┘
```

The browser never talks to Postgres or DeepSeek directly — only to the
FastAPI backend, which owns all provider keys, session state, and spend
accounting. The frontend holds no secrets except an optional BYOK key kept
in `sessionStorage` for the current tab.

**What's stateful and where:**

| State                          | Where it lives                     | Survives a restart? |
| ------------------------------ | ----------------------------------- | -------------------- |
| Chat messages, uploaded data   | Backend process memory              | No                    |
| User identity, monthly spend   | Neon Postgres                       | Yes                   |
| BYOK key                       | Browser `sessionStorage`            | No (tab-scoped)       |
| Session cookie (who's signed in)| Signed cookie, `SessionMiddleware`  | Yes (until it expires)|

## Tech stack

| Layer      | Choice                                                        |
| ---------- | --------------------------------------------------------------- |
| Frontend   | Next.js (App Router) · TypeScript · Tailwind CSS                |
| Backend    | FastAPI · Python 3.11 · `data-harness` agent runtime             |
| Auth       | GitHub OAuth (Authorization Code flow) · signed session cookie   |
| Database   | Postgres (Neon, free tier)                                       |
| LLM        | DeepSeek (`deepseek-v4-flash`), OpenAI-compatible endpoint       |
| Frontend host | Vercel (Hobby)                                                 |
| Backend host  | Render (Free web service, Docker)                              |
| CI         | GitHub Actions (backend pytest + frontend build, every push/PR)  |

## How auth, budget, and BYOK fit together

Every chat call spends real tokens against a real API key, so the backend
never runs a session without deciding first which key pays for it
(`resolve_session_key` in `backend/main.py`):

1. **Caller sends `X-User-Deepseek-Key`** → BYOK. The session runs on that
   key for its whole lifetime. Never persisted server-side (not written to
   disk, DB, or logs) — used in-memory for the duration of each request. No
   budget check; the caller's own key, the caller's own cost.
2. **No BYOK header** → the caller must have a valid session cookie
   (signed in via GitHub) and remaining monthly budget (`MONTHLY_BUDGET_CENTS`,
   default $0.50/user). If either is missing, the request is rejected
   (`401` signed out, `402` budget exhausted) rather than silently falling
   back to the shared key.

Cost is computed from real per-call token usage (`data_harness.result.Usage`)
against DeepSeek's published per-token pricing (`backend/pricing.py`,
overridable via env vars so a price change doesn't need a code deploy) and
recorded per user per calendar month in Postgres (`backend/budget.py`).

The budget system and rate limiter are defense in depth, not the actual
ceiling — see [Security posture](#security-posture) below for what really
bounds worst-case spend.

## Local development

**Backend** — see [`backend/README.md`](backend/README.md) for the full env
var list (DeepSeek key, GitHub OAuth app, Postgres URL, session secret):

```bash
cd backend
uv sync
uv run python -m uvicorn main:app --reload   # http://localhost:8000
```

Without `DATABASE_URL` set, the backend falls back to a local SQLite file
(`local_dev.db`, gitignored) so auth/budget code paths still work locally
without a real Postgres instance.

**Frontend** — see [`frontend/README.md`](frontend/README.md):

```bash
cd frontend
npm install
npm run dev                                   # http://localhost:3000
```

## Deployment

Both services **auto-deploy on every push to `main`** — there is no separate
release step. This is a real tradeoff: fast iteration, but nothing blocks a
broken commit from reaching production except CI running in parallel (see
below) and whatever testing happened before the push.

| Service   | Trigger                                    | How to redeploy manually |
| --------- | -------------------------------------------- | ------------------------- |
| Render    | GitHub webhook on push (repo connected, root dir `backend`) | Render dashboard → Manual Deploy, or `POST /v1/services/{id}/deploys` via their API |
| Vercel    | **Not** connected via GitHub integration — deployed via `vercel --prod` from the `frontend/` directory | Run `vercel --prod --yes` from `frontend/` |

This asymmetry matters: pushing a frontend-only change to `main` does
**not** ship it to Vercel by itself. Run `vercel --prod --yes` after.

**Environment variables** live in each platform's dashboard (Render →
service → Environment; Vercel → project → Settings → Environment Variables),
not in the repo. `backend/README.md` documents every variable the backend
reads. Notable production-only ones:

- `DATABASE_URL` — Neon connection string
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from the GitHub OAuth App at
  `github.com/settings/applications` (callback URL is
  `https://data-harness-ui.onrender.com/auth/github/callback`)
- `GITHUB_CALLBACK_URL`, `FRONTEND_URL` — set explicitly rather than relying
  on proxy-header auto-detection, to avoid OAuth redirect mismatches
- `SESSION_SECRET_KEY` — signs the session cookie; rotating it logs
  everyone out
- `ALLOWED_ORIGINS` — must include the exact Vercel production URL or CORS
  blocks the frontend

## CI

`.github/workflows/ci.yml` runs on every push and PR:

- **backend** job: `uv sync` + `uv run python -m pytest tests/ -v`
- **frontend** job: `npm ci` + `npm run build` (this also runs the
  TypeScript check as part of `next build`)

CI does not block deployment — Render and Vercel deploy independently of
GitHub Actions' pass/fail state. Treat a red CI run as "go find out why,"
not "nothing happened."

## Security posture

Ordered by how much protection each layer actually provides, strongest
first (audited 2026-08-03, re-audited same day by an independent review with
no prior context — see below):

1. **DeepSeek's own balance is the real ceiling.** It's prepaid — you top up
   a balance, calls hard-fail at $0. No bug anywhere in this app's code can
   spend more than what's topped up. Confirmed no auto-recharge is enabled.
2. **Vercel and Render both have zero payment methods on file.** Confirmed
   in both dashboards. Worst case on either platform is a pause (Vercel: the
   feature pauses until next cycle; Render: the service suspends), never a
   charge. Neon likewise has no card on file.
3. **Auth + budget metering** (above) stops a stranger from quietly running
   up spend on the shared key — using the app at all now requires GitHub
   sign-in or a self-supplied key, re-checked on every message (not just at
   session creation).
4. **Per-IP rate limiting** (`backend/main.py`, 20 requests / 10 min) and
   input size caps (2000-char messages, 5MB CSV uploads) sit in front of
   every cost-generating endpoint as a floor under the other layers.
5. **Session ownership.** A session id alone is no longer a usable bearer
   token for someone else's uploaded data and chat history — non-BYOK
   sessions check the caller's identity against the session's owner.

None of layers 3–5 are a substitute for layer 1–2. They raise the cost of
abuse; only the provider/platform account state makes a bad outcome
structurally impossible.

**Independent review (2026-08-03):** an Opus review with a fresh read of the
code (no memory of how it was built) found that layers 3–4 above were
mostly decorative at the time — budget was checked once at session
creation and never again per message, the rate limiter trusted a
client-spoofable header, and cancelling a stream (the Stop button) silently
dropped the usage record for tokens already billed by the provider. All
fixed same-day, with regression tests added for each. The rate-limit fix
also went through two iterations — the first ("trust the rightmost
`X-Forwarded-For` hop") turned out to be wrong too, verified live against
production: Render's own internal load balancer adds an unpredictable
further hop after Cloudflare's. The working fix uses `CF-Connecting-IP`,
which Cloudflare sets unconditionally and overwrites on any client-supplied
value — verified that Cloudflare itself rejects a spoofed one outright
(403, `error code: 1000`) before it ever reaches the app.

## Operational procedures

**View the Postgres data** (users, monthly spend):
Neon dashboard → your project → SQL Editor, or connect directly:

```bash
psql "$DATABASE_URL" -c "select * from users;"
psql "$DATABASE_URL" -c "select * from monthly_usage;"
```

**Check backend logs:** Render dashboard → service → Logs, or via the
`render` CLI (`render logs --resources <service-id> --tail`).

**Rotate a secret** (e.g. `DEEPSEEK_API_KEY`, `SESSION_SECRET_KEY`): update
it in Render's Environment tab, then trigger a redeploy — env var changes
alone do **not** auto-redeploy.

**Check CI status:** `gh run list --repo maxkskhor/data-harness-ui`.

## Streaming protocol

```text
POST /sessions/{session_id}/messages/stream
```

Newline-delimited JSON events:

```jsonl
{"type":"tool_use","data":{"name":"python_interpreter","input":{"code":"df.head()"}}}
{"type":"tool_result","data":{"content":"shape: (5, 8)","is_error":false}}
{"type":"chunk","data":"# Summary\n"}
{"type":"answer","data":"# Summary\n\n![Revenue by month](/sessions/{id}/charts/chart)\n\n..."}
{"type":"chart","data":{"url":"/sessions/{id}/charts/chart_2","format":"png","title":"y = x^2"}}
{"type":"done","data":{"id":"...","messages":[...]}}
```

`data-harness` stream events map to this protocol: text deltas → `chunk`,
tool-use blocks → `tool_use`, tool returns → `tool_result`. Chart artifacts
aren't part of `data-harness`'s own stream API (only its non-streaming
`RunResult.charts`); the backend diffs `SessionCache.list_charts()` before
and after each turn and treats any new ones as new messages.

Charts are served by cache handle from `GET /sessions/{session_id}/charts/{handle}`
rather than embedded as base64 — a `Message.image_url` (and the `chart`
event's `url`) is just a path into that endpoint, and `handle` is stable for
the life of the process because `_make_agent_session` builds the cache with
no `hot_limit`, so it never evicts. Earlier versions embedded full base64
PNGs in every message and re-sent them on every session fetch; for a
chart-heavy conversation that made every subsequent turn's response (and
every `GET /sessions/{id}`) grow with the *total* image bytes generated so
far, not just the new ones — a 2-chart session's per-turn payload roughly
doubled from ~63KB to ~127KB, confirmed by measuring actual responses.

Handle-based addressing also lets the model reference a chart from inside
its own answer, `![title](handle)`, exactly the handle name it got back
from the `python_interpreter` tool result. The backend rewrites any such
reference in `answer` to a real chart URL before storing/returning it (and
strips it if the handle doesn't resolve to an actual chart — a hallucinated
or stale handle shouldn't render as a permanently-broken image), then skips
the usual trailing chart message for anything already shown inline. Because
the streaming client builds its live view by appending raw `chunk` text as
it arrives — before the backend can resolve anything — the `answer` event
carries the corrected final text once the stream completes, and the client
replaces what it displayed with it (without touching the tool-call trace
bubbles shown live, which aren't part of `session.messages` at all).

## Project shape

```text
backend/
  main.py           FastAPI app: sessions, chat, streaming, rate limiting
  auth.py           GitHub OAuth flow, session-cookie identity
  budget.py         Per-user monthly spend tracking
  db.py             SQLAlchemy models (User, MonthlyUsage), Postgres/SQLite
  pricing.py        DeepSeek cost-per-token accounting
  tests/            API and streaming protocol tests
  Dockerfile        Render deploy target

frontend/
  src/app/page.tsx  Workbench UI: auth gate, chat, uploads, charts
  src/lib/api.ts    HTTP + NDJSON streaming client

.github/workflows/ci.yml   Backend tests + frontend build on every push/PR
```

## Roadmap

- Mobile layout — not yet tested/tuned, likely broken on small screens
- Durable session persistence (chat history currently doesn't survive a
  backend restart, only identity/budget does)
- Project / workspace / history sidebar
- Additional data sources: databases, local files, MCP, APIs
