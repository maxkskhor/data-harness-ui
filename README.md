# data-harness-ui

A local workbench UI for asking questions about data with
[`data-harness`](https://github.com/maxkskhor/data-harness).

Upload a CSV, ask a question, and let a constrained data agent inspect the
dataset through the `data-harness` Python tool loop. The goal is a practical
interface for data-agent workflows where state is explicit, uploaded data stays
behind handles, and the browser shows the agent's progress instead of hiding the
run behind a blocking request.

The current app is intentionally small: CSV upload, one active session, streamed
answers, and a source preview. The longer-term direction is a fuller local data
workspace with more source types, persisted sessions, and live tool trace
visibility.

## Why Try It?

- **Ask natural-language questions about a local CSV.**
  Start with ordinary spreadsheet-style questions, then ask follow-ups against
  the same session context.
- **Keep data out of the chat transcript.**
  Uploaded tables are stored in the backend session cache and referred to by
  compact handles.
- **Use a constrained agent runtime.**
  The agent works through `data-harness` rather than getting arbitrary shell
  access.
- **Stream the agent run.**
  The UI consumes streamed SDK events and displays assistant text, tool calls,
  and tool results as separate pieces of the run.

## Stack

```text
frontend/   # Next.js · TypeScript · Tailwind
backend/    # FastAPI · data-harness agent sessions
```

The browser talks to the backend over HTTP. The backend owns session state,
uploaded data handles, and AI provider configuration. The frontend is only the
workbench surface; it does not hold provider keys.

The backend depends on `data-harness` and imports it as `data_harness`.

## Quick Start

Requirements:

- Python 3.11+
- `uv`
- Node.js / npm
- `OPENAI_API_KEY`

Create `backend/.env`:

```env
OPENAI_API_KEY=your_api_key_here
# optional
OPENAI_MODEL=gpt-4o-mini
```

Start the backend:

```bash
cd backend
uv sync
uv run python -m uvicorn main:app --reload
```

Start the frontend in another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## First Flow

1. Open the app. A backend session is created automatically.
2. Upload a CSV.
3. Ask a question such as:
   - `What columns are in this?`
   - `Which numeric column has the highest average?`
   - `Summarise the most important patterns in this dataset.`
4. Watch the assistant response stream into the chat.
5. Ask follow-up questions using the same uploaded data handles and session
   context.

## What Works Today

- Session creation and in-memory session state.
- CSV upload with row count, column list, and preview table.
- Uploading a DataFrame into the `data-harness` session cache.
- Chat follow-ups against the same `AsyncAgentSession`.
- Streaming endpoint using newline-delimited JSON events mapped from
  `data-harness` stream events.
- Frontend rendering for streamed answer chunks, tool-call events, and
  tool-result events.
- Basic Markdown rendering for assistant messages.

## Streaming Protocol

The streaming endpoint is:

```text
POST /sessions/{session_id}/messages/stream
```

It returns newline-delimited JSON:

```jsonl
{"type":"tool_use","data":{"name":"python_interpreter","input":{"code":"df.head()"}}}
{"type":"tool_result","data":{"content":"shape: (5, 8)","is_error":false}}
{"type":"chunk","data":"# Summary\n"}
{"type":"chunk","data":"- The dataset has 5 preview rows.\n"}
{"type":"done","data":{"id":"...","messages":[...]}}
```

The backend maps `data-harness` stream events into a UI-friendly protocol:
text deltas become `chunk`, tool-use blocks become `tool_use`, and harness tool
returns become `tool_result`.

## Run Checks

Backend:

```bash
cd backend
uv run python -m pytest tests/ -v
```

Frontend:

```bash
cd frontend
npm run lint
npm run build
```

## Project Shape

```text
backend/main.py          # FastAPI app, session state, upload and chat endpoints
backend/tests/           # API and streaming protocol tests
frontend/src/app/        # Workbench UI
frontend/src/lib/api.ts  # HTTP and streaming client
```

## Roadmap

- Durable session persistence
- Project / workspace / history sidebar
- Additional data sources: databases, local files, MCP, APIs
- Better Markdown rendering and richer trace UI
- Deployment path: Vercel frontend + hosted backend
