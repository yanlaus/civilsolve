# CivilSolve

CivilSolve solves civil engineering assignments. Users upload question images or PDFs, optionally add instructions, choose a thinking-effort level, and receive worked solutions from three providers in parallel:

- ChatGPT (via Poe)
- Claude Sonnet (via Poe)
- Gemini Pro (via Poe)

Each result includes an interpreted problem statement, assumptions, a step-by-step solution, and a final answer, with in-browser KaTeX math rendering. Solutions can be exported as PDF (browser print), LaTeX source (`.tex`), or opened directly in Overleaf.

## Architecture

A single **Cloudflare Worker** (free tier) serves everything:

- **Static assets** — the Vite-built React SPA, served by Workers Static Assets with SPA fallback.
- **API** — a [Hono](https://hono.dev) app (`worker/index.ts`) handles `/api/*` via `run_worker_first`.

The solve flow is **stateless streaming** — no database, no object storage, no job queue:

1. The browser converts uploads to JPEG data URLs client-side (`src/lib/attachments.ts`): images are downscaled on a canvas (max 2048px), PDFs are rasterized page-by-page with pdf.js (max 8 pages).
2. It fires one `POST /api/solve/:provider` request per selected provider, in parallel.
3. Each Worker invocation calls Poe's Responses API with **native vision input** (no OCR) and a strict JSON schema, and streams progress back over Server-Sent Events.
4. Provider tabs render progressively — each one flips from spinner to live progress to finished solution independently.

Nothing is stored server-side. Closing the tab abandons an in-flight solve (accepted trade-off for a fully free, zero-storage deployment).

### Stack

| Layer | Tech |
|---|---|
| Hosting | Cloudflare Workers free tier (static assets + API) |
| Server | Hono on workerd |
| Frontend | React 19 + Vite 7 + Tailwind CSS 4 |
| Math | KaTeX (lazy-loaded chunk) |
| Markdown | marked (lazy-loaded chunk) |
| PDF input | pdfjs-dist (lazy-loaded, browser-side rasterization) |
| PDF export | Browser print stylesheet (`Save as PDF`) |
| LLM access | Poe Responses API (`https://api.poe.com/v1/responses`) |

### File structure

```
├── worker/
│   ├── index.ts            # Hono app: /api/health, /api/solve/:provider
│   └── poe.ts              # Poe call, SSE translation, retries, heartbeats
├── shared/                 # Pure logic shared by worker and client
│   ├── solution.ts         # Schema, parsing, repair pipeline, LaTeX helpers
│   ├── prompt.ts           # Tutor prompt (image-attachment variant)
│   └── stream-protocol.ts  # SSE event types + request limits
├── src/
│   ├── pages/civil-answer-app.tsx      # Page composition (~110 lines)
│   ├── components/solve/
│   │   ├── upload-form.tsx             # Dropzone, notes, providers, effort
│   │   ├── solution-panel.tsx          # Tabs, streaming states, exports (lazy)
│   │   └── solution-article.tsx        # Markdown + KaTeX rendering
│   ├── hooks/use-solve.ts              # Per-provider SSE state machine
│   └── lib/
│       ├── math-markdown.ts            # Math normalization + renderMarkdown
│       ├── attachments.ts              # File -> JPEG data URL conversion
│       ├── pdf-to-images.ts            # pdf.js rasterization (dynamic import)
│       └── exports.ts                  # Print PDF, .tex download, Overleaf
├── wrangler.jsonc          # Worker config (assets, vars, run_worker_first)
└── vite.config.ts          # @cloudflare/vite-plugin + manualChunks
```

## API

### `GET /api/health`

Returns `{ "poeConfigured": true | false }` without exposing secret values.

### `POST /api/solve/:provider` (`codex` | `claude` | `gemini`)

Request JSON:

```json
{
  "images": ["data:image/jpeg;base64,..."],
  "notes": "optional user instructions",
  "effort": "none | low | medium | high | max"
}
```

Limits: 1–16 images (JPEG/PNG/WebP/GIF data URLs), ~20 MB body, 4000-char notes.

Response is `text/event-stream`:

```
event: status   data: {"message":"Asking Claude Sonnet..."}   ← sent immediately
event: delta    data: {"text":"<raw model fragment>"}          ← liveness/progress
event: done     data: {"solution":{...}}                       ← parsed + normalized
event: error    data: {"message":"..."}
: heartbeat                                                    ← comment every 15s
```

The Worker requests `stream: true` with a strict `json_schema` response format, forwards raw deltas for progress, then parses and repairs the concatenated text at stream end (`shared/solution.ts`) before emitting `done`. If a Poe bot rejects streaming with structured output, set the `POE_NO_STREAM` var (e.g. `"codex,gemini"`) — the Worker falls back to a non-streamed upstream fetch over the same SSE response, with heartbeats; the client is agnostic.

## Configuration

**Secret** (the only one): `POE_API_KEY`

- Local: put it in `.dev.vars` (gitignored).
- Production: `wrangler secret put POE_API_KEY`.

**Vars** (in `wrangler.jsonc`):

- `POE_CODEX_MODEL` (default `GPT-5.2`)
- `POE_CLAUDE_MODEL` (default `Claude-Sonnet-4.6`)
- `POE_GEMINI_MODEL` (default `Gemini-3.1-Pro`)
- `POE_NO_STREAM` (default empty)

## Development

```bash
npm install
npm run dev        # Vite dev server + Worker in workerd, with HMR
npm run check      # tsc --noEmit for both the SPA and the worker
npm run build      # production build (dist/client + worker bundle)
npm run preview    # serve the production build locally
```

Test the API directly:

```bash
curl http://localhost:5173/api/health
curl -N -X POST http://localhost:5173/api/solve/claude \
  -H "content-type: application/json" \
  -d '{"images":["data:image/jpeg;base64,..."],"notes":"","effort":"low"}'
```

## Deployment

```bash
npx wrangler login
npx wrangler secret put POE_API_KEY
npm run deploy     # vite build && wrangler deploy
```

The app deploys to `https://civilsolve.<account>.workers.dev`. Free-tier fit: a solve is at most 3 requests (100k/day limit), SSE piping is I/O-wait (10ms CPU limit untouched), static assets are unlimited, and the immediate SSE headers + heartbeats keep long solves alive.

## Upload support

Accepted: JPEG, PNG, WebP, GIF, PDF. HEIC/HEIF/TIFF are no longer accepted (the old server normalized them with ImageMagick; browsers cannot decode them on a canvas). iOS converts HEIC to JPEG automatically when picking photos, so iPhone uploads still work.

## Provider output safety

Provider responses can be messy despite `strict: true`. The pipeline in `shared/solution.ts` (kept from the original app) handles: control-character stripping, alternate JSON field names, `problems[]`-array shapes, JSON-blob-inside-a-field repair, plain-text synthesis, LaTeX fence stripping, and LaTeX-body-preferred display repair. A provider failure only fails that provider's tab.

## Maintenance rules

- Keep provider keys server-side only (`POE_API_KEY` never reaches the client).
- Keep `/api/solve/:provider` streaming — the immediate SSE response is what makes long solves survivable on Workers.
- Do not turn one provider's failure into a whole-solve failure.
- Update this README whenever architecture, provider behavior, deployment, or error handling changes.
