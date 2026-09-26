# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`AGENTS.md` holds the project invariants (keys server-side, providers vs channels, routing defaults in code once, effort mapping, untrusted model output, answers-only storage for 24 hours, CPU budget - the account is on Workers Paid since 22 September 2026, and the free-plan findings explain the code's shape), the five failure modes, and the provider gotchas found by real testing. `README.md` holds the full architecture, API, and config reference. Both are authoritative; this file only adds what is not already written there. Keep all three in sync when architecture, provider behaviour, deployment, or error handling changes.

## Commands

```bash
npm run dev        # Vite + Worker in workerd (localhost:5173), HMR, reads .dev.vars
npm run check      # tsc --noEmit for the SPA (tsconfig.json) AND the worker (worker/tsconfig.json)
npm run build      # vite build -> dist/client + worker bundle
npm run preview    # serve the production build
npm run deploy     # vite build && wrangler deploy (needs `npx wrangler login` + secrets)
```

npm is the only package manager: `package-lock.json` is the one lockfile, and `.npmrc` sets `min-release-age=3` (no version younger than three days gets installed). Do not add another lockfile.

There is no test runner and no linter; `npm run check` is the only automated verification. Both tsconfigs must pass — `shared/` is included by both, so a change there is typechecked under DOM libs (SPA) and under Workers types (worker). To typecheck just one side: `npx tsc --noEmit` or `npx tsc --noEmit -p worker`.

Manual verification against the dev server:

```bash
curl http://localhost:5173/api/health
```

```bash
curl -N -X POST http://localhost:5173/api/solve/claude -H "content-type: application/json" -d '{"images":["data:image/jpeg;base64,..."],"notes":"","effort":"low"}'
```

Local secrets go in `.dev.vars` (copy from `.dev.vars.example`); they are read by the Worker via `c.env`, never by Vite. Any var in `WorkerEnv` (`worker/channels.ts`) can be set there to override a default for local runs. `wrangler.jsonc` `vars` is empty on purpose: the production routing is the code defaults (`DEFAULT_CHANNELS`, `ROUTES`, `INTERPRET_MODEL_DEFAULT`).

## Architecture in one pass

One Cloudflare Worker serves the Vite SPA as static assets and a Hono app for `/api/*` (`run_worker_first`). Everything streams over SSE, and every task runs in a `TaskJob` Durable Object of its own, which stores only its final answer, for 24 hours.

### Request path (worker)

`worker/index.ts` → `worker/run.ts` → `worker/channels.ts`

- **`index.ts`** first applies the `TASK_LIMITER` rate limit to the three task routes (per client IP, 429 past it; there is no sign-in - Cloudflare Access sign-in is parked on the `access-sign-in` branch, see `AGENTS.md`). Then it validates the body (`readBoundedBody` counts real bytes against `MAX_BODY_BYTES`), builds the task with `buildTask` (`worker/tasks.ts`) so a bad request gets its 400 at once, then hands the raw body to a fresh **`TaskJob`** Durable Object (`worker/jobs.ts`) and returns its stream. A task is `{ prompt(fn), instructions, schemaName, schema, images, referenceImages?, session }` plus a `finalize(rawText)` callback; it carries functions, so the job rebuilds it from the body with the same `buildTask`. `/api/solve`, `/api/interpret` and `/api/judge` differ *only* in the task `buildTask` makes. `GET /api/jobs/:id` re-attaches to a job, `DELETE /api/jobs/:id` cancels one. A new model-calling feature is a new task kind, not a new orchestrator.
- **`jobs.ts`** - `TaskJob` runs `runTask` into a hub sink that never rejects, so the run outlives the page; the stream opens with `event: job {id, startedAt, deadlineAt, now}` (the deadline from `taskTimeoutFor` in `run.ts`); `status` / `done` / `error` are stamped with `at`, and a re-attach replays every status so far (memory only); the final event is stored and an alarm deletes it 24 h later. Images are never stored.
- **`run.ts`** is dialect- and task-agnostic and writes to a `TaskSink` (the job's hub, or `streamSink` on the inline fallback path): immediate SSE headers, 15 s heartbeats, a safety timeout that is a 280 s floor (a route may raise it with `timeoutMs`; MiniMax, DeepSeek, MiMo and Kimi use 20 minutes) plus 2 min per assignment page after the first, capped at 45 min - `taskTimeoutMs` in `shared/stream-protocol.ts`, delta coalescing (2048 chars / 400 ms), and the retry/downgrade loop. `Capabilities = { reasoning: bool, schema: "strict" | "loose" | "none" }` degrade independently when an upstream 400/422 names a parameter (`paramRejection`); a 400/422 whose body carries no error message (`isSilentRejection`) is read as a schema rejection - DeepSeek's gateway refuses strict schemas that way; transient statuses and dropped streams get one retry after 3 s at the same effort; thinking exhaustion gets one retry one effort level down; nothing is retried once a `delta` has reached the client, except a stream that ended early with a fragment `finalize` rejects, and a completed response `finalize` rejects (a blank template, an empty object), which gets one retry (see failure handling in `AGENTS.md`). The timeout's `error` carries `timedOut: true`.
- **`channels.ts`** owns the `ROUTES` table (`Record<ProviderKey, Partial<Record<ChannelKey, RouteSpec>>>`), `resolveRoute(provider, env, override?)`, and per-**dialect** request building + stream parsing for the three dialects: `responses`, `chat-completions`, `gemini`. A `RouteSpec` carries `effort: EffortSpec` (enum or token budget, per level — a missing level sends nothing), optional `forceEffort` / `minEffort` / `maxEffort` (`clampEffort` in `run.ts` applies the band; the form disables the levels outside it), and `streaming` / `structured` flags that record what the upstream can actually do (`structured: false` puts the field contract in the prompt; the strict schema is still sent until the ladder drops it). `DEFAULT_CHANNELS` is each provider's channel list when its `*_CHANNEL` var is unset. A channel list may be a chain (MiniMax's default, `minimax,opencode`): `resolveRoute` picks the first channel whose key is set and keeps the rest as `fallbackChannels`, and `switchChannel` in `run.ts` moves down it on an account refusal (plan ended, key revoked) or after a channel's transient retry. `interpretOverride` is how `/api/interpret` pins ChatGPT (Luna on OpenCode Go), Gemini (Google chain) and Claude (Opus on Poe) to routes chosen for the pass, regardless of the solve-time channel.

Adding a channel = one entry in `ROUTES` plus its env vars in `WorkerEnv` (and `DEFAULT_CHANNELS` if it becomes the default); nothing goes in `wrangler.jsonc` unless production must override a default. Adding a dialect = extending `buildRequest`, `extractDelta`, `extractFinalText`, `extractPayloadError`, `streamTerminator`, `isReasoningOnlyFrame`, `isTerminalFrame`, `isThinkingExhausted`.

### Shared contract (`shared/`)

Pure string logic compiled into both bundles — no DOM, no Workers APIs, no imports from `src/` or `worker/`.

- `stream-protocol.ts` — request body types, `SolveEvent` / `InterpretEvent` / `JudgeEvent` (`status` | `delta` | `done` | `error`), every size limit, and `taskTimeoutMs` (how long a task may run, given how much was uploaded).
- `providers.ts` — `ProviderKey` / `ChannelKey` registries, defaults (`DEFAULT_PROVIDER`, `DEFAULT_INTERPRETERS`, `DEFAULT_VERIFIER`), `HealthResponse` shape. `PROVIDER_KEYS` is every provider (the reader and judge lists); `SOLVER_KEYS` leaves out `REVIEW_ONLY_PROVIDERS` (none since 26 September 2026), and only those get solver cards - the worker refuses a solve for the rest. `PROVIDER_VARIANTS` lists the models a provider offers under one card (Gemini: flash, pro); a reader/judge pick is a `ModelChoice` `{provider, variant?}` (`MODEL_CHOICES`, `choiceKey` "gemini:pro"), and the request body carries `variant`, which `buildTask` validates and `variantOverride` in `channels.ts` turns into a route override.
- `prompt.ts` — `EffortKey` and the solve / interpret / verify prompt builders. `enforceShape` appends the six-field contract when the route cannot pin the schema (`structured: false`).
- `solution.ts` — `solutionSchema` plus the repair pipeline (`finalizeProviderArtifact`) that makes the lower schema rungs safe: alternate field names, `problems[]` shapes, schema-name wrappers, JSON-in-a-field, a JSON prefix cut off mid-stream (`recoverTruncatedJson`), `<think>` reasoning left in the content (`stripThinkTags`, needed by MiniMax), plain-text synthesis, LaTeX fence stripping.
- `interpretation.ts` — the same pair (schema + parser) for the interpretation pass; `verifiedInterpretationSchema` adds `traditional_chinese` for the reconciler, shown under the English in the review step (display only - solvers get the English).
- `judgement.ts` — the same pair for the answer cross-check (the judge also writes `traditional_chinese`, the verdict explained in Traditional Chinese, shown under the English in the verdict card): the judge answers with solution letters (`correct_solutions`, an enum array) and one assessment per solution; `parseJudgement(raw, provider, count)` maps letters to indices and `readCorrect` reads prose from schema-less rungs. `artifactToText` in `solution.ts` flattens a solution for the judge.

### Client (`src/`)

- `hooks/use-solve.ts` — per-provider state machine (`idle → waiting → streaming → done | error`) over `lib/sse.ts`. Every ticked provider runs through `runPool(…, SOLVE_CONCURRENCY, …)` at once — 4, the most the cross-check can grade (it was 1 on the free plan; see the CPU section of `AGENTS.md`). A lost connection - a network `TypeError` such as Safari's "Load failed" when a phone backgrounds the browser, or a stream that closes with no terminal event - is resumed per provider by `withResume` (`lib/sse.ts`): it waits until the page is visible and online, then `openTaskStream` re-attaches to the same job by the id its `job` event carried (a `JobHandle`), backing off up to 15 s between tries and giving up only after `RECONNECT_WINDOW_MS` (2 minutes) without a reconnection getting through; it starts over, at most once (`MAX_RESTARTS`), only if the server no longer has the job. A read that gets no byte for `STREAM_IDLE_MS` (45 s; heartbeats come every 15 s) counts as a lost connection too - a phone's half-open socket otherwise spins forever. Each solver and the judge keep a `Progress` timeline (`lib/progress.ts`: start, deadline, end, every status with its time, on the page's clock via the job's `now`), which `solution-panel.tsx` shows as a running clock and a status log (the timeout is deliberately not shown); a timed-out task is orange. Job ids are saved in localStorage (`lib/run-store.ts`), so `restore()` recovers the last run after a reload; `cancel()` sends `DELETE /api/jobs/:id` for every job. The judge and every interpretation step use the same wrapper, and `useWakeLock` keeps the screen on while anything runs. With a judge set, `start(providers, body, judge)` follows the wave with `/api/judge` over every finished solution (≥2) and exposes it as `judgeRun`; the solutions go as Solution A, B, C, D in picker order, and solvers that returned nothing are listed as `skipped`.
- `hooks/use-interpret.ts` — reader A ‖ reader B in parallel (`Promise.allSettled`; one failure still reaches review with a `note`), then the judge, then pauses in `review` for the user to edit before any solve fires. Defaults: DeepSeek Flash (the solver's route) and Muse Spark read, ChatGPT reconciles (`DEFAULT_INTERPRETERS` / `DEFAULT_VERIFIER`).
- `pages/civil-answer-app.tsx` composes the page and `lazy()`-loads `solution-panel.tsx`, which is the only path to `lib/math-markdown.ts` (katex / marked / dompurify). `pdf-to-images.ts` is likewise only reached by dynamic `import()`. Keep those imports lazy — `vite.config.ts` `manualChunks` splits katex/marked/react on top.
- `lib/attachments.ts` converts uploads to JPEG data URLs in the browser (canvas downscale to 2048 px; PDFs rasterized - every page, or the pages typed on the file's card, parsed by `lib/page-range.ts`; the form counts each PDF's pages and blocks a batch over `MAX_IMAGES` instead of cutting it). The client also pre-checks `estimateBodyBytes` so an oversized batch never fires a doomed request.
- After a run, `use-solve.ts` keeps its request body (in memory, and in IndexedDB via `lib/upload-store.ts`, restored with the run) and exposes `solveProvider` (Retry on a failed tab, or Add a solver) and `crossCheck` (run the judge over ticked finished solutions), rendered by `components/solve/run-actions.tsx`. A restored run still only re-attaches; nothing is sent on page load. `hooks/use-health.ts` fetches `/api/health` once for the page and surfaces a refused sign-in.

- Themes: Classic (default), Slate, Graphite and Unicorn (Gundam-inspired), picked in the header (`theme-switcher.tsx`) and set as `data-theme` on `<html>`. All are light - the owner ruled out a dark theme, so there are no `dark:` variants. Colour, radius and heading font come from the `cs-*` tokens in `styles.css` (`text-cs-ink`, `bg-cs-surface`, `border-cs-line`, `bg-cs-accent`, `rounded-cs`, `font-display`, ...); use those instead of hex values, and a new theme is one `[data-theme]` block plus a `THEMES` entry. Status colours (error, timeout, credit badges) stay fixed hex on purpose. Unicorn adds decoration through the `cs-panel` and `cs-primary` hook classes. Solver cards and solution tabs show `ProviderLogo` (`provider-logo.tsx`): the vendors' official marks, SVG files in `src/assets/providers/` named by `ProviderKey`, taken from `@lobehub/icons-static-svg` (MIT). A new provider needs a file there too - the `Record<ProviderKey, string>` fails the typecheck until it has one.

`@/` aliases `src/` (both `tsconfig.json` paths and `vite.config.ts`).
