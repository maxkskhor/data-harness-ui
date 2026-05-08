# data-harness-ui backend

FastAPI backend for the local Data Harness workbench.

This service owns session state, uploaded data handles, and AI provider
configuration. It depends on the migrated `data-harness` library and imports
that package as `data_harness`.

## Local development

Create `backend/.env` with:

```bash
OPENAI_API_KEY=...
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
```

## Tests

```bash
uv run python -m pytest tests/ -v
```
