# CivilSolve Agent Notes

CivilSolve is a civil engineering assignment solver hosted on a single Cloudflare Worker (free tier). Read `README.md` before editing.

## Core Invariants

- **Keep API keys server-side only.** Keys live in `.dev.vars` locally and in Wrangler secrets in production. Never expose one to frontend code, and never put one in a URL or query string (Google auth uses the `x-goog-api-key` header for exactly this reason).
- **Providers and channels are separate concepts.** A provider is a UI choice (`chatgpt`, `claude`, `gemini`, `kimi`, `minimax`); a channel is the upstream account (`poe`, `moonshot`, `minimax`, `google`). Routing lives in `ROUTES` in `worker/channels.ts` — add channels there, not by branching in `worker/solve.ts`.
- **Thinking effort is mapped per route, never passed through.** The five UI levels do not exist on every model: OpenAI-style enums take `none`/`xhigh` only on GPT-5.x, Claude has no "off" value, Gemini takes an integer token budget and Pro-tier models cannot disable thinking. A level with no mapping sends nothing.
- **Only visible output becomes a `delta`.** Reasoning summaries (`response.reasoning_summary_text.delta`, `reasoning_content`, Gemini parts flagged `thought: true`) must never be concatenated into the answer — they corrupt the JSON the parser expects, and they get more frequent at higher effort.
- **Model output is untrusted.** Uploaded images are user-supplied, so anything in them can steer what a model writes. Anything rendered through `dangerouslySetInnerHTML` must pass DOMPurify first (`src/lib/math-markdown.ts`).
- **Keep `/api/solve/:provider` streaming.** The Worker sends SSE headers immediately and heartbeats every 15s — that is what lets minutes-long provider calls survive on Workers without any job storage. Do not convert it to a buffered request/response.
- **No server-side storage.** The app is intentionally stateless: no KV, D1, R2, or Durable Objects. Uploads are converted to data URLs in the browser and never persisted. This is also why each provider re-uploads the same images: deduplicating would require storage or a single fan-out request, and both are ruled out.
- **Enforce request limits on real bytes.** `content-length` is a claim, not a fact — a chunked request has none. `readBoundedBody` in `worker/index.ts` counts what actually arrives and abandons the request at the cap, before the JSON parser sees it. Parsing the body is the single largest CPU cost in an invocation; keep it bounded.
- **Provider failures are per-provider.** A Claude failure must not hide the others — each tab has its own run state.
- **Keep math rendering in the web UI.** Users read formulas via KaTeX directly; PDF export is a browser-print convenience, not a requirement for reading solutions.
- **Keep katex/marked/dompurify out of the initial bundle.** They are only imported by `src/lib/math-markdown.ts`, which is only reachable through the lazily loaded solution panel. Do not import them (or that module) from eagerly loaded code.
- **`shared/` is pure string logic** shared by the Worker and the client. No DOM, no Workers APIs, no imports from `src/` or `worker/`.
- Accepted uploads: JPEG, PNG, WebP, GIF, PDF only. HEIC/TIFF cannot be canvas-decoded in browsers; iOS auto-converts HEIC on the picker.
- Kimi and MiniMax models **must be vision-capable** — the assignment is sent as images, never as OCR text.

## Failure handling

`worker/solve.ts` distinguishes three failure modes; keep them distinct:

1. **Parameter rejection** (400/422 naming `reasoning`, a schema field, or a generic parameter error) → step down the capability ladder: drop `reasoning`, then relax strict JSON schema to plain JSON mode, then drop the schema. Reported to the client as a `status` event. No sleep, does not consume the retry budget.
2. **Transient failure** (408/409/429/5xx, or a failure that never reached a response) → one retry after 3s.
3. **Everything else** (401, 404, in-body errors like MiniMax's `base_resp.status_code`) → fail immediately. Retrying an auth error only delays the message the user needs.

Never retry after a `delta` has reached the client, and never retry the safety-timeout abort.

## History

The repo previously carried a second, unused backend from the original Bun/Zo deployment (`server.ts`, `backend-lib/`, root `index.tsx`, `zosite.json`). It was outside both tsconfig `include` globs, so `npm run check` never covered it. It has been removed — recover it from git history if you need to consult the old provider logic. Everything that ships now lives in `worker/`, `shared/`, and `src/`, and all three are typechecked.

## Provider gotchas found by testing

These were all discovered by running real requests, not from vendor docs. Re-verify before changing a model id or a route flag.

- **Every model must be vision-capable.** The assignment is only ever sent as images. A text-only model does not necessarily fail — MiniMax M2/M2.1 reply "I cannot view the image" and then invent a plausible solution, which is far worse than an error.
- **Poe bot handles drift.** `GPT-5.6-Terra` and `Claude-Opus-5` do not exist; list what a key can see with `GET https://api.poe.com/v1/models`.
- **Claude on Poe rejects the reasoning parameter**, and the downgrade ladder catches it. Do not "fix" this by removing the parameter for everyone — GPT-5.x accepts it.
- **Kimi Code cannot be given forced tools** (thinking is always on), so its route sets `structured: false` and the prompt carries the shape contract. Its non-streamed path also gets cut by the gateway while the model thinks — keep that route streaming.
- **MiniMax honours a forced tool call only while thinking is on**, and wraps schema results in the schema name (`{"civil_solution": {...}}`).
- Errors can arrive as HTTP 200 with a body-level failure (`base_resp`), and a streamed request can come back as plain JSON. Both are handled in `worker/solve.ts`; do not assume `response.ok` plus an event-stream content type.

## Verification

```bash
npm run check    # tsc --noEmit for SPA + worker
npm run build    # production build
npm run dev      # Vite + workerd locally; test /api/health and the UI
```

`GET /api/health` reports each provider's channel, model, and whether its key is configured — check it first when a provider tab errors.

For API testing use `curl -N` against the dev server (see README). Deployment is `npm run deploy` (requires `wrangler login` and at least one key secret).

## Update Policy

Update `README.md` and this file whenever architecture, provider behavior, deployment, or error handling changes.
