# data-harness-ui backend

FastAPI backend for the local Data Harness workbench.

This service owns session state, uploaded data handles, and AI provider
configuration. It depends on `data-harness` and imports that package as
`data_harness`.

The backend keeps uploaded datasets in the agent session cache and returns
compact handles to the frontend. Chat requests run through an
`AsyncAgentSession`, and the streaming endpoint maps SDK stream events into
newline-delimited JSON for the browser.

## Local development

Create `.env` in this directory:

```env
DEEPSEEK_API_KEY=...
# optional
DEEPSEEK_MODEL=deepseek-v4-flash
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
POST /sessions
GET  /sessions/{session_id}
POST /sessions/{session_id}/uploads
POST /sessions/{session_id}/messages
POST /sessions/{session_id}/messages/stream
```

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
