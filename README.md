# data-harness-ui

Local-first chatbot/workbench UI for exploring and querying datasets.

The first data source path is CSV upload, but the project is not CSV-specific.
The intended direction includes MCP, databases, files, and workspace history.

## Stack

```text
frontend/   # Next.js · TypeScript · Tailwind
backend/    # FastAPI · data-harness agent sessions
```

The browser talks to the backend over HTTP. The backend owns session state,
uploaded data handles, and AI provider configuration.

The backend depends on the migrated `data-harness` library and imports it as
`data_harness`.

## Local development

**Backend** — requires `OPENAI_API_KEY` in `backend/.env`:

```bash
cd backend
uv sync
uv run python -m uvicorn main:app --reload
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## First flow

1. Open the app — a session is created automatically.
2. Upload a CSV.
3. Ask a question about it.
4. Ask follow-up questions using the same session context.

## Later milestones

- Response streaming
- Durable session persistence
- Project / workspace / history sidebar
- Additional data sources: databases, local files, MCP, data APIs
- Deploy: Vercel frontend + hosted backend
