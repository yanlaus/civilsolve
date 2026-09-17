# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`AGENTS.md` holds the invariants, the measured CPU numbers for the Workers free plan, and the per-provider gotchas found by running real requests — read it before touching `worker/`. `README.md` documents the API surface, every env var, and the deployment steps. Both are kept current; update them whenever architecture, provider behavior, deployment, or error handling changes.

## Commands

```bash
npm install
npm run dev      # Vite + workerd together (SPA and Worker, HMR); http://localhost:5173
npm run check    # tsc --noEmit for the SPA config AND the worker config — the only gate
npm run build    # vite build -> dist/client + worker bundle
npm run preview  # serve the production build
npm run deploy   # vite build && wrangler deploy (needs wrangler login + a key secret)
```

There is no test runner and no linter. `npm run check` is the whole verification story, and it must run both tsconfigs: `tsconfig.json` covers `src` + `shared`, `worker/tsconfig.json` covers `worker` + `shared` with `@cloudflare/workers-types`. Code in only one of those graphs is unchecked — that is how a dead second backend survived here for months.

Manual verification of a change to a provider route:

```bash
curl http://localhost:5173/api/health   # per-provider channel, model, key-configured
curl -N -X POST http://localhost:5173/api/solve/claude \
  -H "content-type: application/json" \
  -d '{"images":["data:image/jpeg;base64,..."],"notes":"","effort":"low"}'
```

`/api/health` is the first thing to check when a provider tab errors. Keys come from `.dev.vars` (copy `.dev.vars.example`) — read by the **Worker**, not Vite; never move them to `.env` or prefix `VITE_`.

`bunfig.toml` sets a 3-day `minimumReleaseAge` on installs. Both `bun.lock` and `package-lock.json` are committed; scripts are npm-based.

## Architecture

One Cloudflare Worker (free tier) serves the built SPA as static assets and the API, with `run_worker_first: ["/api/*"]`. No KV/D1/R2/Durable Objects, no database, no job queue — deliberately.

A solve is one stateless streaming request:

1. `src/lib/attachments.ts` turns uploads into JPEG data URLs in the browser (canvas downscale to 2048px; PDFs rasterized by `pdf-to-images.ts` via a dynamically imported pdf.js).
2. The client POSTs to `/api/solve/:provider` for the **one** selected provider and reads SSE (`src/lib/sse.ts`, `src/hooks/use-solve.ts`).
3. The Worker resolves a **route**, calls the upstream with native vision input, and translates the upstream stream into the app-level SSE protocol (`status` / `delta` / `done` / `error` plus 15s heartbeats).

The three-layer split is what matters:

- **`worker/index.ts`** — Hono app. Validates the request (`readBoundedBody` counts real bytes, ignoring `content-length`), builds a `Task` (prompt builder, instructions, schema, images), and hands it to `runTask`.
- **`worker/run.ts`** — task-agnostic orchestration: immediate SSE headers, heartbeats, the 280s safety abort, delta coalescing, and the retry/downgrade policy. Knows nothing about dialects. Add a new model-calling feature as another `Task` here, never as a second orchestrator.
- **`worker/channels.ts`** — all upstream knowledge: the `ROUTES` table (provider × channel → dialect, model var, key var, endpoint, effort spec, `structured`, `streaming`, `forceEffort`/`minEffort`), request building, and per-dialect stream parsing. New channels and per-model quirks go in `ROUTES`, not as branches in `run.ts`.

**Provider vs channel** is the central abstraction. A *provider* (`chatgpt`, `claude`, `gemini`, `kimi`, `minimax`, `deepseek`, `grok`, `qwen`) is a UI choice; a *channel* (`poe`, `opencode`, `kimi`, `moonshot`, `minimax`, `google`) is the upstream account, picked from env (`<PROVIDER>_CHANNEL` in `wrangler.jsonc`) per request. Four dialects — `responses`, `chat-completions`, `anthropic`, `gemini` — differ in how they take reasoning effort and how (or whether) a response shape can be pinned.

`shared/` is pure string logic imported by both sides — no DOM, no Workers APIs, no imports from `src/` or `worker/`:

- `providers.ts` registry and defaults, `stream-protocol.ts` event types + request limits, `prompt.ts` prompts and the fallback shape contract, `solution.ts` / `interpretation.ts` schemas plus the parse-and-repair pipeline that makes the downgrade rungs safe.

The optional interpretation pass (`/api/interpret/:provider`, `src/hooks/use-interpret.ts`) is a second `Task` through the same orchestrator: two readers then a judge, run sequentially, pinned to Poe top-tier models via `interpretOverride`, pausing at a human review step whose confirmed text is then sent to `/api/solve` as authoritative.

## Constraints that shape the code

These are the ones most likely to be violated by a reasonable-looking change. `AGENTS.md` has the rest and the measurements behind them.

- **One provider per solve, and the CPU budget is why.** The free plan charges per upstream chunk read, so a per-token stream costs 330–500 ms of CPU for its duration; the budget is a refilling account-wide allowance and a kill is silent (the client just sees the stream end). Do not restore multi-provider fan-out or make the interpretation pass default-on.
- **Keep `/api/solve/:provider` streaming.** Immediate SSE headers + heartbeats are the only reason minutes-long provider calls survive without job storage.
- **Effort is mapped per route, never passed through.** A level with no mapping sends nothing rather than a value the model rejects.
- **Only visible output becomes a `delta`.** Reasoning summaries and thought parts must be filtered per dialect — concatenating them corrupts the JSON the parser expects.
- **Three failure modes stay distinct in `run.ts`:** parameter rejection → step down the capability ladder (no sleep, no retry budget); transient (408/409/429/5xx, or no response at all) → one retry after 3s; everything else (401, 404, in-body errors like MiniMax's `base_resp`) → fail now. Never retry after a `delta` has shipped, and never retry the safety-timeout abort.
- **Every model must be vision-capable.** The assignment is only ever sent as images; text-only models invent a plausible solution instead of failing. Verify with a real image before changing any model id.
- **Model output is untrusted** — it is steered by user-uploaded images. Anything reaching `dangerouslySetInnerHTML` goes through DOMPurify in `src/lib/math-markdown.ts` first.
- **Keep katex/marked/dompurify out of the eager bundle.** They are only reachable through `src/lib/math-markdown.ts` via the lazily loaded solution panel.
- **Keys are server-side only**, never in a URL or query string (Google auth uses the `x-goog-api-key` header for this reason).
