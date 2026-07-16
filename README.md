# CivilSolve

CivilSolve solves civil engineering assignments. Users upload question images or PDFs, optionally add instructions and lecture notes, choose a thinking-effort level, and receive worked solutions from up to four providers in parallel:

- Kimi K3 (via Kimi Code / Moonshot — the default)
- ChatGPT (via Poe)
- Claude Sonnet (via Poe)
- Gemini Pro (via Poe)

Two optional accuracy features:

- **Diagram verification**: two user-chosen models interpret the question independently, a third cross-checks them, and the user reviews/edits the confirmed interpretation before solving starts.
- **Lecture notes**: uploaded notes/worked examples are sent as method reference so solutions follow the taught approach (text-layer PDF pages as extracted text, scans/diagrams as images).

Each result includes an interpreted problem statement, assumptions, a step-by-step solution, and a final answer, with in-browser KaTeX math rendering. Solutions can be exported as PDF (browser print), LaTeX source (`.tex`), or opened directly in Overleaf.

## Architecture

A single **Cloudflare Worker** (free tier) serves everything:

- **Static assets** — the Vite-built React SPA, served by Workers Static Assets with SPA fallback.
- **API** — a [Hono](https://hono.dev) app (`worker/index.ts`) handles `/api/*` via `run_worker_first`.

The solve flow is **stateless streaming** — no database, no object storage, no job queue:

1. The browser converts uploads to JPEG data URLs client-side (`src/lib/attachments.ts`): images are downscaled on a canvas (max 2048px), PDFs are rasterized page-by-page with pdf.js (max 8 pages). Lecture notes use hybrid extraction (`src/lib/lecture-notes.ts`): text-layer PDF pages become extracted text, sparse/scanned pages and images are rasterized (max 8 reference images, 20k chars text).
2. If diagram verification is enabled, the browser first runs the interpret pipeline: two parallel `POST /api/interpret/:provider` calls (mode `interpret`), then one more (mode `verify`) that reconciles them. The result pauses in an editable review box; the confirmed text is attached to solve requests as `interpretation`.
3. It fires one `POST /api/solve/:provider` request per selected provider, in parallel.
4. Each Worker invocation calls the provider's API with **native vision input** (no OCR) — Poe's Responses API for codex/claude/gemini, OpenAI-compatible chat completions for kimi — and streams progress back over Server-Sent Events.
5. Provider tabs render progressively — each one flips from spinner to live progress to finished solution independently.

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
| LLM access | Poe Responses API (`https://api.poe.com/v1/responses`) + Kimi OpenAI-compatible API (`KIMI_API_URL`, default `https://api.kimi.com/coding/v1`) |

### File structure

```
├── worker/
│   ├── index.ts            # Hono app: /api/health, /api/solve, /api/interpret
│   ├── run.ts              # Provider-agnostic SSE run shell (heartbeats, retries)
│   ├── upstream.ts         # Env types + provider routing (Poe vs Kimi)
│   ├── poe.ts              # Poe Responses API upstream (codex/claude/gemini)
│   └── kimi.ts             # OpenAI-compatible upstream (Kimi Code / Moonshot)
├── shared/                 # Pure logic shared by worker and client
│   ├── solution.ts         # Schema, parsing, repair pipeline, LaTeX helpers
│   ├── interpretation.ts   # Interpretation schema + parsing (verify pipeline)
│   ├── prompt.ts           # Tutor/interpret/verify prompts
│   └── stream-protocol.ts  # SSE event types + request limits
├── src/
│   ├── pages/civil-answer-app.tsx      # Page composition + pipeline orchestration
│   ├── components/solve/
│   │   ├── upload-form.tsx             # Dropzones, notes, providers, verification, effort
│   │   ├── interpretation-review.tsx   # Pause-for-review step (editable)
│   │   ├── solution-panel.tsx          # Tabs, streaming states, exports (lazy)
│   │   └── solution-article.tsx        # Markdown + KaTeX rendering
│   ├── hooks/
│   │   ├── use-solve.ts                # Per-provider SSE state machine
│   │   └── use-interpret.ts            # Interpret -> verify -> review pipeline
│   └── lib/
│       ├── math-markdown.ts            # Math normalization + renderMarkdown
│       ├── attachments.ts              # File -> JPEG data URL conversion
│       ├── lecture-notes.ts            # Hybrid notes extraction (text + images)
│       ├── pdf-to-images.ts            # pdf.js rasterization + text extraction
│       ├── sse.ts                      # Shared SSE fetch/parse helpers
│       └── exports.ts                  # Print PDF, .tex download, Overleaf
├── wrangler.jsonc          # Worker config (assets, vars, run_worker_first)
└── vite.config.ts          # @cloudflare/vite-plugin + manualChunks
```

## API

### `GET /api/health`

Returns `{ "poeConfigured": true | false, "kimiConfigured": true | false }` without exposing secret values.

### `POST /api/solve/:provider` (`kimi` | `codex` | `claude` | `gemini`)

Request JSON:

```json
{
  "images": ["data:image/jpeg;base64,..."],
  "notes": "optional user instructions",
  "effort": "none | low | medium | high | max",
  "interpretation": "optional human-confirmed problem statement",
  "referenceText": "optional lecture-notes text",
  "referenceImages": ["optional lecture-notes data URLs"]
}
```

Limits: 1–16 images (JPEG/PNG/WebP/GIF data URLs), ~20 MB body, 4000-char notes, 8 reference images, 20k-char reference text, 8k-char interpretation.

### `POST /api/interpret/:provider`

Same SSE response shape; `done` carries `{"interpretation": {...}}` instead of a solution.

```json
{
  "mode": "interpret | verify",
  "images": ["data:image/jpeg;base64,..."],
  "notes": "optional user instructions",
  "interpretations": ["A's reading", "B's reading"]
}
```

`interpretations` is required for `verify` mode only.

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

**Secrets**: `POE_API_KEY` (Poe providers) and `KIMI_API_KEY` (Kimi provider)

- Local: put them in `.dev.vars` (gitignored).
- Production: `wrangler secret put POE_API_KEY` / `wrangler secret put KIMI_API_KEY`.

**Vars** (in `wrangler.jsonc`):

- `POE_CODEX_MODEL` (default `GPT-5.2`)
- `POE_CLAUDE_MODEL` (default `Claude-Sonnet-4.6`)
- `POE_GEMINI_MODEL` (default `Gemini-3.1-Pro`)
- `POE_NO_STREAM` (default empty; also accepts `kimi`)
- `KIMI_MODEL` (default `kimi-k3`)
- `KIMI_API_URL` (default `https://api.kimi.com/coding/v1`)

**Kimi Code caveat**: the default `KIMI_API_URL` is the Kimi Code membership endpoint, which enforces a client whitelist for coding agents and may reject calls from this app. If the kimi tab fails with an authorization/whitelist error, switch to a Moonshot platform key: set `KIMI_API_URL` to `https://api.moonshot.ai/v1` and update the `KIMI_API_KEY` secret. No code change needed.

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

The app deploys to `https://civilsolve.<account>.workers.dev`. Free-tier fit: a solve is at most 7 requests (4 providers + 3 interpretation calls; 100k/day limit), SSE piping is I/O-wait (10ms CPU limit untouched), static assets are unlimited, and the immediate SSE headers + heartbeats keep long solves alive.

## Upload support

Accepted: JPEG, PNG, WebP, GIF, PDF. HEIC/HEIF/TIFF are no longer accepted (the old server normalized them with ImageMagick; browsers cannot decode them on a canvas). iOS converts HEIC to JPEG automatically when picking photos, so iPhone uploads still work.

## Provider output safety

Provider responses can be messy despite `strict: true`. The pipeline in `shared/solution.ts` (kept from the original app) handles: control-character stripping, alternate JSON field names, `problems[]`-array shapes, JSON-blob-inside-a-field repair, plain-text synthesis, LaTeX fence stripping, and LaTeX-body-preferred display repair. A provider failure only fails that provider's tab.

## Maintenance rules

- Keep provider keys server-side only (`POE_API_KEY` never reaches the client).
- Keep `/api/solve/:provider` streaming — the immediate SSE response is what makes long solves survivable on Workers.
- Do not turn one provider's failure into a whole-solve failure.
- Update this README whenever architecture, provider behavior, deployment, or error handling changes.
