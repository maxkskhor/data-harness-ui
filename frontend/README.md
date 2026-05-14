# data-harness-ui frontend

Next.js frontend for the local Data Harness workbench.

The frontend is a browser surface for the FastAPI backend. It creates sessions,
uploads CSV files, displays source previews, sends chat requests, and renders
streamed agent events from the backend.

## Local Development

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

By default the frontend calls the backend at `http://localhost:8000`. To point
it at another backend URL, set:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

## Checks

```bash
npm run lint
npm run build
```

## Main Files

```text
src/app/page.tsx   # Workbench UI and streamed-message rendering
src/lib/api.ts     # Backend API and NDJSON stream client
```
