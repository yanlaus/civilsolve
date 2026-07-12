# CivilSolve Agent Notes

CivilSolve is a civil engineering assignment solver hosted on a single Cloudflare Worker (free tier). Read `README.md` before editing.

## Core Invariants

- **Keep API keys server-side only.** `POE_API_KEY` is the only secret; it lives in `.dev.vars` locally and in Wrangler secrets in production. Never expose it to frontend code.
- **Keep `/api/solve/:provider` streaming.** The Worker sends SSE headers immediately and heartbeats every 15s — that is what lets minutes-long provider calls survive on Workers without any job storage. Do not convert it to a buffered request/response.
- **No server-side storage.** The app is intentionally stateless: no KV, D1, R2, or Durable Objects. Uploads are converted to data URLs in the browser and never persisted.
- **Provider failures are per-provider.** A Claude failure must not hide ChatGPT or Gemini results — each tab has its own run state.
- **Keep math rendering in the web UI.** Users read formulas via KaTeX directly; PDF export is a browser-print convenience, not a requirement for reading solutions.
- **Keep katex/marked out of the initial bundle.** They are only imported by `src/lib/math-markdown.ts`, which is only reachable through the lazily loaded solution panel. Do not import them (or that module) from eagerly loaded code.
- **`shared/` is pure string logic** shared by the Worker and the client. No DOM, no Workers APIs, no imports from `src/` or `worker/`.
- Accepted uploads: JPEG, PNG, WebP, GIF, PDF only. HEIC/TIFF cannot be canvas-decoded in browsers; iOS auto-converts HEIC on the picker.

## Verification

```bash
npm run check    # tsc --noEmit for SPA + worker
npm run build    # production build
npm run dev      # Vite + workerd locally; test /api/health and the UI
```

For API testing use `curl -N` against the dev server (see README). Deployment is `npm run deploy` (requires `wrangler login` and the `POE_API_KEY` secret).

## Update Policy

Update `README.md` and this file whenever architecture, provider behavior, deployment, or error handling changes.
