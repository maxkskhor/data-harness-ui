# data-harness-ui frontend

Next.js frontend for the local Data Harness workbench.

The frontend is a browser surface for the FastAPI backend. It creates sessions,
uploads CSV files, displays source previews, sends chat requests, and renders
streamed agent events (including chart images) from the backend.

Using the app requires either GitHub sign-in (redirects to the backend's
`/auth/github/login`, which needs `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`
configured backend-side) or a self-supplied DeepSeek key entered in the UI.
The frontend holds no provider keys of its own — a BYOK key, if used, lives
only in `sessionStorage` for the current tab and is sent per-request. All
`fetch` calls use `credentials: "include"` since the session cookie is
cross-site (Vercel frontend, Render backend).

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
