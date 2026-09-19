# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`AGENTS.md` holds the project invariants (keys server-side, providers vs channels, effort mapping, untrusted model output, no storage, CPU budget on the free plan) and the provider gotchas found by real testing. `README.md` holds the full architecture, API, and config reference. Both are authoritative; this file only adds what is not already written there. Keep all three in sync when architecture, provider behaviour, deployment, or error handling changes.

Note: comments in `worker/channels.ts` and `AGENTS.md` that mention `worker/solve.ts` refer to what is now `worker/run.ts`.

## Commands

```bash
npm run dev        # Vite + Worker in workerd (localhost:5173), HMR, reads .dev.vars
npm run check      # tsc --noEmit for the SPA (tsconfig.json) AND the worker (worker/tsconfig.json)
npm run build      # vite build -> dist/client + worker bundle
npm run preview    # serve the production build
npm run deploy     # vite build && wrangler deploy (needs `npx wrangler login` + secrets)
```

There is no test runner and no linter; `npm run check` is the only automated verification. Both tsconfigs must pass — `shared/` is included by both, so a change there is typechecked under DOM libs (SPA) and under Workers types (worker). To typecheck just one side: `npx tsc --noEmit` or `npx tsc --noEmit -p worker`.

Manual verification against the dev server:

```bash
curl http://localhost:5173/api/health
```

```bash
curl -N -X POST http://localhost:5173/api/solve/claude -H "content-type: application/json" -d '{"images":["data:image/jpeg;base64,..."],"notes":"","effort":"low"}'
```

Local secrets go in `.dev.vars` (copy from `.dev.vars.example`); they are read by the Worker via `c.env`, never by Vite. Anything in `wrangler.jsonc` `vars` can be overridden there for local runs.

## Architecture in one pass

One Cloudflare Worker serves the Vite SPA as static assets and a Hono app for `/api/*` (`run_worker_first`). Everything is stateless streaming over SSE.

### Request path (worker)

`worker/index.ts` → `worker/run.ts` → `worker/channels.ts`

- **`index.ts`** validates the body (`readBoundedBody` counts real bytes against `MAX_BODY_BYTES`), then builds a **`Task`** — `{ prompt(fn), instructions, schemaName, schema, images, referenceImages?, session }` — and a `finalize(rawText)` callback, and hands both to `runTask`. `/api/solve` and `/api/interpret` differ *only* in the Task they build and the `finalize` they pass. A new model-calling feature is a new Task, not a new orchestrator.
- **`run.ts`** is dialect- and task-agnostic: immediate SSE headers, 15 s heartbeats, 280 s safety timeout, delta coalescing (2048 chars / 400 ms), and the retry/downgrade loop. `Capabilities = { reasoning: bool, schema: "strict" | "loose" | "none" }` degrade independently when an upstream 400/422 names a parameter (`paramRejection`); transient statuses get one retry after 3 s; nothing is retried once a `delta` has reached the client.
- **`channels.ts`** owns the `ROUTES` table (`Record<ProviderKey, Partial<Record<ChannelKey, RouteSpec>>>`), `resolveRoute(provider, env, override?)`, and per-**dialect** request building + stream parsing for the four dialects: `responses`, `chat-completions`, `anthropic`, `gemini`. A `RouteSpec` carries `effort: EffortSpec` (enum or token budget, per level — a missing level sends nothing), optional `forceEffort` / `minEffort`, and `streaming` / `structured` flags that record what the upstream can actually do. `interpretOverride` is how `/api/interpret` pins itself to Poe top-tier models regardless of the solve-time channel.

Adding a channel = one entry in `ROUTES` plus its env vars in `WorkerEnv` and `wrangler.jsonc`. Adding a dialect = extending `buildRequest`, `extractDelta`, `extractFinalText`, `extractPayloadError`, `streamTerminator`, `isReasoningOnlyFrame`.

### Shared contract (`shared/`)

Pure string logic compiled into both bundles — no DOM, no Workers APIs, no imports from `src/` or `worker/`.

- `stream-protocol.ts` — request body types, `SolveEvent` / `InterpretEvent` (`status` | `delta` | `done` | `error`), and every size limit.
- `providers.ts` — `ProviderKey` / `ChannelKey` registries, defaults (`DEFAULT_PROVIDER`, `DEFAULT_INTERPRETERS`, `DEFAULT_VERIFIER`), `HealthResponse` shape.
- `prompt.ts` — `EffortKey` and the solve / interpret / verify prompt builders. `enforceShape` appends the six-field contract when the route cannot pin the schema (`structured: false`).
- `solution.ts` — `solutionSchema` plus the repair pipeline (`finalizeProviderArtifact`) that makes the lower schema rungs safe: alternate field names, `problems[]` shapes, schema-name wrappers, JSON-in-a-field, plain-text synthesis, LaTeX fence stripping.
- `interpretation.ts` — the same pair (schema + parser) for the interpretation pass.

### Client (`src/`)

- `hooks/use-solve.ts` — per-provider state machine (`idle → waiting → streaming → done | error`) over `lib/sse.ts`. Providers run through `runPool(…, 1, …)` — strictly one at a time; a stream that closes with no terminal event is treated as a CPU kill and retried once after the wave. That concurrency of 1 is a product decision (see the CPU section of `AGENTS.md`), not a placeholder.
- `hooks/use-interpret.ts` — reader A → reader B → judge, sequentially, then pauses in `review` for the user to edit before any solve fires.
- `pages/civil-answer-app.tsx` composes the page and `lazy()`-loads `solution-panel.tsx`, which is the only path to `lib/math-markdown.ts` (katex / marked / dompurify). `pdf-to-images.ts` is likewise only reached by dynamic `import()`. Keep those imports lazy — `vite.config.ts` `manualChunks` splits katex/marked/react on top.
- `lib/attachments.ts` converts uploads to JPEG data URLs in the browser (canvas downscale to 2048 px; PDFs rasterized, max 8 pages). The client also pre-checks `estimateBodyBytes` so an oversized batch never fires a doomed request.

`@/` aliases `src/` (both `tsconfig.json` paths and `vite.config.ts`).
