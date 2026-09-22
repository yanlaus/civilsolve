# CivilSolve

CivilSolve solves civil engineering assignments. Users upload question images or PDFs, optionally add instructions, choose a thinking-effort level and one or more AI providers, and receive a worked solution per provider. Seven providers are available; the selected ones **solve at the same time**:

| Provider | Default channel | Default model | Default choice |
|---|---|---|---|
| ChatGPT | OpenCode Go | `gpt-5.6-luna`, high or max thinking | default judge for both optional passes |
| Gemini | Google (switchable to Poe) | `gemini-3.8-flash`, falling back to `gemini-3.5-flash` | **selected**; free-tier key |
| DeepSeek | OpenCode Go | `deepseek-v4.1-flash` | badged **Less credit** |
| Grok | OpenCode Go | `grok-4.6` | badged **More credit** |
| MiMo | OpenCode Go | `mimo-v2.5` | |
| Muse Spark | OpenCode Go | `muse-spark-1.3-contributor` | **selected**; badged **Less credit**; needs a workspace opt-in |
| Claude | Poe | `claude-opus-4.8` | listed last; badged **More credit** |

Each card shows three things — brand, the account it runs on, and the model id — plus a cost badge where it matters. Grok and Claude are badged "More credit" (`HIGHER_CREDIT_PROVIDERS` in `shared/providers.ts`): Claude runs as Opus on Poe, the priciest bot there by a wide margin, and Grok is the heaviest draw on the OpenCode Go plan, so Claude sits at the end. DeepSeek and Muse Spark are badged "Less credit" (`LOWER_CREDIT_PROVIDERS`): DeepSeek Flash is the lightest draw on that plan, and Muse Spark is one of OpenCode Zen's free tiers — free because it collects what is sent to it, assignment images included, for training, and its "contributor" tier will not answer at all until the OpenCode workspace has opted in to that. MiMo is the other free tier but is unbadged. Effort floors and model chains are not on the card: the floor is shown under Thinking Effort, and a chain announces itself in the status line only when it actually switches. Every one of these reads images; that is a hard requirement and was verified per model, not taken from a spec sheet. Kimi, MiniMax and Qwen were offered until September 2026 and removed after two full runs of a past-paper momentum fixture: Kimi 0/4, Qwen 0/8, MiniMax 1/4 correct (see `AGENTS.md`). Their routes and the Anthropic-protocol dialect they used are in git history. The picker is multi-select; every ticked provider solves at once and gets its own tab (Gemini and Muse Spark by default; the picker was single-choice on the free Workers plan, where concurrent per-token streams got killed). One thinking level serves them all, `high` by default, and the highest floor among the ticked providers rules (tick ChatGPT and everything below `high` is disabled). Two optional passes sit on top, both off by default: the interpretation pass fires two readers (Gemini and Muse Spark) then a reconciler (ChatGPT) — three calls in sequence before the first solve; the answer cross-check sends every finished solution to a judge (ChatGPT) that grades them against the images (see `POST /api/judge`).

Each result includes an interpreted problem statement, assumptions, a step-by-step solution, and a final answer, with in-browser KaTeX math rendering. Solutions can be exported as PDF (browser print), LaTeX source (`.tex`), or opened directly in Overleaf.

## Architecture

A single **Cloudflare Worker** (free tier) serves everything:

- **Static assets** — the Vite-built React SPA, served by Workers Static Assets with SPA fallback.
- **API** — a [Hono](https://hono.dev) app (`worker/index.ts`) handles `/api/*` via `run_worker_first`.

The solve flow is **stateless streaming** — no database, no object storage, no job queue:

1. The browser converts uploads to JPEG data URLs client-side (`src/lib/attachments.ts`): images are downscaled on a canvas (max 2048px), PDFs are rasterized page-by-page with pdf.js (max 8 pages).
2. It fires one `POST /api/solve/:provider` request for the chosen provider (one per solve).
3. Each Worker invocation resolves the provider's **channel**, calls that channel's API with **native vision input** (no OCR) and a strict JSON schema, and streams progress back over Server-Sent Events.
4. The provider's tab renders progressively — spinner, then live progress, then the finished solution.

Nothing is stored server-side. Closing the tab abandons an in-flight solve (accepted trade-off for a fully free, zero-storage deployment).

### Providers and channels

A **provider** is what the user picks in the UI. A **channel** is the upstream account the key comes from. One provider can be reachable over several channels, and the channel is resolved from env per request:

```
chatgpt  ──> opencode | poe     (CHATGPT_CHANNEL)
claude   ──> poe
gemini   ──> google | poe       (GEMINI_CHANNEL)
deepseek ──> opencode
grok     ──> opencode
mimo     ──> opencode
muse     ──> opencode
```

Channels speak three different API dialects, all handled in `worker/channels.ts`:

| Dialect | Used by | Endpoint shape | Reasoning parameter |
|---|---|---|---|
| `responses` | Poe; OpenCode Go (GPT Luna, Grok, Muse Spark) | `POST /v1/responses` | `reasoning: { effort }` (enum) |
| `chat-completions` | OpenCode Go (DeepSeek, MiMo) | OpenAI-compatible chat completions | `reasoning_effort` (enum) |
| `gemini` | Google | `:streamGenerateContent?alt=sse` | `generationConfig.thinkingConfig.thinkingBudget` (tokens) |

#### OpenCode Go

One key and one base URL (`https://opencode.ai/zen/go/v1`) front several protocols, and the gateway fixes which protocol each model speaks. Every request must carry an `x-opencode-session` header (a stable id per conversation; the Worker sends a fresh UUID per solve) or the gateway refuses it with `MissingSessionID`. Two model families need a one-time opt-in in the OpenCode workspace before the key can use them: models hosted only in China (`deepseek-v4-pro`) and the data-collecting `muse-spark-*` contributor models.

A route can pin its reasoning level with `forceEffort`, or put a floor under it with `minEffort`. One route uses a floor. ChatGPT: `gpt-5.6-luna` is offered at `high` or `max` only — those two picks are sent as-is (`max` maps to `reasoning.effort: "xhigh"`, which the gateway accepts) and anything lower is raised to `high`. The upload form disables the levels below a floor and labels the provider.

#### Getting structured output out of each dialect

The dialects disagree about how a caller can pin the response shape, so `worker/channels.ts` records what each route can actually do instead of discovering it by trial:

| Dialect | How the shape is pinned |
|---|---|
| `responses`, `chat-completions` | `json_schema` response format |
| `gemini` | `responseSchema` (an OpenAPI subset that rejects `additionalProperties`) |

A route can also be flagged `structured: false` when its upstream cannot be made to hold the shape at all; `buildTutorPrompt` then appends an explicit six-field contract to the prompt instead. No current route needs it, but the mechanism stays: on the since-removed Kimi Code route it turned a different envelope on nearly every run into six consecutive runs of the exact six fields.

`shared/solution.ts` remains the safety net behind all of this, including for providers that wrap the answer in the schema name (`{"civil_solution": {…}}`), and for a response that was cut off mid-stream (see below).

### Thinking effort is not portable

The five UI levels (`none`/`low`/`medium`/`high`/`max`) do **not** mean the same thing to every model, so they are mapped per route rather than passed through:

- OpenAI-style enums accept `none` and `xhigh` only on GPT-5.x. Other bots clamp: `max` → `high`, and `none` is omitted.
- Claude has no "off" enum value — thinking is disabled by omitting the parameter.
- Gemini takes an integer token budget (2048 / 8192 / 16384 / 32768). Pro-tier models reject a budget of `0`, so `none` falls back to the model default.

A level with no mapping sends **nothing** rather than a value the model would reject.

Because no vendor publishes a reliable per-model matrix, the Worker also **degrades itself**: if an upstream answers 400/422 complaining about a parameter, the request is retried one rung down a ladder — drop `reasoning`, then relax the strict JSON schema to plain JSON mode, then drop the schema entirely. Each downgrade is reported to the client as a `status` event. The parsing pipeline in `shared/solution.ts` is what makes the lower rungs safe.

A thinking model can also fail by thinking too much: it spends every output token it has on reasoning and stops before writing a single answer character. The OpenCode Go routes do this against the gateway's own default cap, since the Worker sends none there (`incomplete_details.reason: "max_output_tokens"` or `finish_reason: "length"`, depending on the dialect). Retrying that unchanged would repeat it, so the Worker retries **one effort level down** instead, reported as a `status` event too. The step-down goes below the route's `minEffort` on purpose — the floor decides where a solve starts, not what it has to fail at. Raising the cap is not a substitute: measured, a model simply thinks longer to fill the extra room (see `AGENTS.md`).

A stream can also just stop — no terminal frame, no error, nothing received — when the gateway drops the connection mid-reasoning. That is retried once at the same effort. When a stream stops *after* partial answer text, what arrived is a valid prefix of the solution JSON. If that prefix reaches the final answer, `shared/solution.ts` closes the open string and object, keeps every complete field, marks the cut one, and rebuilds the LaTeX body if that was the casualty. If it does not reach the answer, it is retried instead (same effort for a drop, one level down if the output cap was hit), and only when no retry remains is the working delivered with a note in place of the answer.

### Stack

| Layer | Tech |
|---|---|
| Hosting | Cloudflare Workers free tier (static assets + API) |
| Server | Hono on workerd |
| Frontend | React 19 + Vite 7 + Tailwind CSS 4 |
| Math | KaTeX (lazy-loaded chunk) |
| Markdown | marked + DOMPurify (lazy-loaded chunk) |
| PDF input | pdfjs-dist (lazy-loaded, browser-side rasterization) |
| PDF export | Browser print stylesheet (`Save as PDF`) |
| LLM access | Poe Responses API, OpenCode Go (Responses + chat completions), Google Generative Language API |

### File structure

```
├── worker/
│   ├── index.ts            # Hono app: /api/health, /api/solve, /api/interpret, /api/judge
│   ├── channels.ts         # Routes, per-dialect request building + parsing
│   └── run.ts              # Heartbeats, timeout, retry/downgrade, SSE output
├── shared/                 # Pure logic shared by worker and client
│   ├── providers.ts        # Provider + channel registry, health payload types
│   ├── solution.ts         # Schema, parsing, repair pipeline, LaTeX helpers
│   ├── interpretation.ts   # Interpret/verify schema and parsing
│   ├── judgement.ts        # Answer cross-check (judge) schema and parsing
│   ├── prompt.ts           # Solve, interpret/verify and judge prompts, shape contract
│   └── stream-protocol.ts  # SSE event types + request limits
├── src/
│   ├── pages/civil-answer-app.tsx      # Page composition
│   ├── components/solve/
│   │   ├── upload-form.tsx             # Dropzone, notes, providers, effort, both optional passes
│   │   ├── interpretation-review.tsx   # Confirm the diagram reading
│   │   ├── solution-panel.tsx          # Tabs, streaming states, verdict card, exports (lazy)
│   │   └── solution-article.tsx        # Markdown + KaTeX rendering
│   ├── hooks/
│   │   ├── use-solve.ts                # Per-provider SSE state machine, solvers -> judge
│   │   └── use-interpret.ts            # interpret -> verify -> review
│   └── lib/
│       ├── sse.ts                      # Shared SSE reader over fetch
│       ├── math-markdown.ts            # Math normalization, sanitize, render
│       ├── attachments.ts              # File -> JPEG data URL conversion
│       ├── lecture-notes.ts            # Reference payload from notes files
│       ├── pdf-to-images.ts            # pdf.js rasterization (dynamic import)
│       └── exports.ts                  # Print PDF, .tex download, Overleaf
├── wrangler.jsonc          # Worker config (assets, vars, run_worker_first)
├── .dev.vars.example       # Local secrets template (copy to .dev.vars)
└── vite.config.ts          # @cloudflare/vite-plugin + manualChunks
```

## API

### `GET /api/health`

Reports which providers are usable, without exposing any secret value:

```json
{
  "providers": {
    "chatgpt":  { "channel": "opencode", "model": "gpt-5.6-luna",                 "configured": true, "minEffort": "high" },
    "claude":   { "channel": "poe",      "model": "claude-opus-4.8",              "configured": true },
    "gemini":   { "channel": "google",   "model": "gemini-3.8-flash",             "configured": true, "fallbackModels": ["gemini-3.5-flash"] },
    "deepseek": { "channel": "opencode", "model": "deepseek-v4.1-flash",          "configured": true },
    "grok":     { "channel": "opencode", "model": "grok-4.6",                     "configured": true },
    "mimo":     { "channel": "opencode", "model": "mimo-v2.5",                    "configured": true },
    "muse":     { "channel": "opencode", "model": "muse-spark-1.3-contributor",   "configured": true }
  }
}
```

The upload form uses this to disable providers whose key is missing, and to disable effort levels below a route's `minEffort`.

### `POST /api/interpret/:provider`

Optional pre-pass that reads the question without solving it. Body: `{ mode: "interpret" | "verify", images, notes, interpretations? }`. Returns the same SSE shape with `done → { interpretation }`.

The browser drives it as: two providers run `interpret` in parallel, a third runs `verify` over both readings, and the result pauses for the user to edit before any solving starts. The confirmed text is then sent to `/api/solve` as `interpretation`, where the prompt marks it authoritative over the raw images.

Off by default — it costs three model calls and delays the first solution. It runs **sequentially**: reader one, then reader two, then the judge (written for the free plan, where two concurrent streams was exactly the load that tripped the CPU limit; the account is on Workers Paid since 22 September 2026, so the readers could now run together — see "Deployment"). The default trio is **Gemini** (Google, free-tier Flash) and **Muse Spark** (OpenCode Go) as readers, **ChatGPT** (`gpt-5.6-luna` on OpenCode Go) as judge. Readers run at a user-chosen effort (default `low`); the judge runs at `max`. ChatGPT, Gemini and Claude are pinned to routes chosen for the pass, independent of the solve-time channel (`interpretOverride`): ChatGPT to Luna — it read on Poe's `gpt-5.4-pro` until 22 September 2026, correct but slow (~95 s vs ~5 s for Gemini) and billed to Poe — and Claude to Opus on Poe. Measured with the new defaults: Gemini 39 s and Muse Spark 12 s to read, Luna 31 s to reconcile, with a 1,271-character discrepancies field. The Gemini reader uses a **model chain**, `gemini-3.8-flash,gemini-3.5-flash`: 3.8 first, 3.5 when 3.8 does not answer (see "Model chains" below). If `GOOGLE_API_KEY` is not configured it reads on Poe's `gemini-3.1-pro` instead, so the pass keeps working. A provider not pinned here (DeepSeek, Grok, MiMo, Muse Spark) keeps its normal route if picked.

#### Model chains

Any model var may hold a comma-separated chain, primary first. When an attempt fails in a way worth retrying — 503, 429, a dropped stream, a fragment the parser cannot use — the Worker moves to the next model in the chain instead of repeating the same one, after the same 3 s pause as a transient retry, and reports it as a `status` event ("gemini-3.8-flash did not answer. Trying gemini-3.5-flash..."). The fallback starts with a fresh transient budget. `/api/health` reports the chain as `fallbackModels`, and the picker shows it on the card. Measured on Google the day this was added: `gemini-3.8-flash` closed the socket on a 190 KB request four times out of six and once answered with empty fields; `gemini-3.5-flash` behind it was 4/4.

### `POST /api/judge/:provider`

Optional post-pass, the **answer cross-check**. Body: `{ images, notes, interpretation?, solutions: [text, text, ...], effort? }` with two to four solutions. Returns the same SSE shape with `done → { judgement }`: `{ correct: number[], final_answer, assessments: string[], comparison, confidence: "high" | "medium" | "low" }` — `correct` holds the zero-based indices of the solutions the judge found right (empty for none), `assessments` has one entry per solution in order. On the wire the judge answers with letters (`correct_solutions: ["A", "C"]`); the parser maps them to indices and, on schema-less rungs, reads prose ("A and C", "both", "none").

The browser drives it as: every ticked provider runs `/api/solve` **at the same time**, then the judge gets every finished solution (flattened by `artifactToText`, capped at 24,000 characters each, working cut before the answer) with the same images and the confirmed interpretation if there was one. A solver that returned nothing is left out and named on the verdict card; fewer than two finished solutions and the check is skipped. The solutions are anonymised as Solution A, B, C, D in picker order — the judge never learns which provider wrote which, so it grades the work, not the brand — and the browser maps the letters back to provider names. The prompt tells the judge to re-derive the numbers from the images rather than read the solutions for consistency: every wrong answer seen on the fixtures was internally consistent (a jet velocity assumed instead of derived, a pressure force counted twice), and a consistency check would pass them all.

The judge runs on the provider's normal solve route at `high` by default (the most reliable level in the B.8 matrix; `effort` in the body overrides). The default judge is ChatGPT (Luna); the user can pick any configured provider. Measured on the B.8 fixture with the first version (two solvers, Gemini judging): Muse ‖ DeepSeek at `low` finished together in 85 s (the slower of the two), Gemini judged in 43 s, verdict **A, high confidence**, with the correct −143 N / −178 N as the verified answer and B's error named to the term (a pressure force of 565.5 N where 282.7 N was right). The three-solver path (Muse, DeepSeek, Grok → Luna) was verified against a scripted upstream: `correct_solutions: ["A", "C"]` came back mapped to Muse and Grok with three assessments. Combining it with the interpretation pass gives the most robust run: a reviewed reading feeds every solver and the judge.

### `POST /api/solve/:provider` (`chatgpt` | `claude` | `gemini` | `deepseek` | `grok` | `mimo` | `muse`)

Request JSON:

```json
{
  "images": ["data:image/jpeg;base64,..."],
  "notes": "optional user instructions",
  "effort": "none | low | medium | high | max",
  "interpretation": "optional confirmed problem statement",
  "referenceText": "optional lecture-notes text",
  "referenceImages": ["optional lecture-notes pages"]
}
```

Limits: 1–16 images (JPEG/PNG/WebP/GIF data URLs), 20 MB body, 4000-char notes.

The body limit is enforced on the bytes actually received, not on `content-length`: the Worker reads the request through a counting reader and abandons it with `413` the moment it passes the cap, so a chunked upload with no declared length cannot slip a huge payload into the JSON parser. The browser also estimates the encoded size before sending and refuses an oversized batch locally, rather than firing one doomed request per provider.

Response is `text/event-stream`:

```
event: status   data: {"message":"Asking Claude (via Poe)..."}   ← sent immediately
event: delta    data: {"text":"<raw model fragment>"}            ← liveness/progress
event: done     data: {"solution":{...}}                         ← parsed + normalized
event: error    data: {"message":"..."}
: heartbeat                                                      ← comment every 15s
```

Only **visible output** is forwarded as `delta`. Reasoning summaries, tool-call arguments, and Gemini "thought" parts are filtered out per dialect — concatenating them would corrupt the JSON the parser expects, and they get more frequent at higher effort levels.

Set the `NO_STREAM` var (production: empty) to make those providers use a non-streamed upstream fetch, still delivered over the same SSE response with heartbeats. The client is agnostic. This is what kept DeepSeek alive on the **free** Workers plan: its `chat-completions` route streams every reasoning token as its own chunk, and the runtime bills each one — a streamed B.8 solve was killed at 2,010 ms of CPU with no answer written, where the same solve non-streamed costs 13 ms. It only suits a model that finishes inside OpenCode's ~100–120 s idle cut. Since the move to Workers Paid (22 September 2026, 30 s of CPU per invocation) it is cleared: the same streamed solve completed for 3,201 ms of CPU, shows progress, and is not exposed to the idle cut. Set it back to `deepseek` if the account ever returns to the free plan.

## Configuration

### Secrets (one per upstream account)

| Variable | Needed for | Where to get it |
|---|---|---|
| `OPENCODE_API_KEY` | ChatGPT, DeepSeek, Grok, MiMo, Muse Spark | <https://opencode.ai/go> |
| `POE_API_KEY` | Claude, Gemini; ChatGPT when `CHATGPT_CHANNEL=poe` | <https://poe.com/api_key> |
| `GOOGLE_API_KEY` | Gemini, only when `GEMINI_CHANNEL=google` | <https://aistudio.google.com/apikey> |

- Local: copy `.dev.vars.example` to `.dev.vars` and fill in the keys you have. `.dev.vars` is gitignored.
- Production: `npx wrangler secret put POE_API_KEY` (repeat per key).

A provider whose key is blank is shown as unavailable in the UI rather than failing mid-solve. You only need the keys for the providers you intend to use.

> `.dev.vars` is read by the **Worker**, not by Vite. Never move these into `.env`, and never prefix them with `VITE_` — anything named `VITE_*` is inlined into the browser bundle.

### Vars (in `wrangler.jsonc`, non-secret)

| Variable | Default | Purpose |
|---|---|---|
| `CHATGPT_CHANNEL` | `opencode` | `opencode` or `poe` |
| `CLAUDE_CHANNEL` | `poe` | Channel for Claude |
| `GEMINI_CHANNEL` | `google` | `google` or `poe` |
| `DEEPSEEK_CHANNEL` / `GROK_CHANNEL` / `MIMO_CHANNEL` / `MUSE_CHANNEL` | `opencode` | Only OpenCode Go serves these |
| `OPENCODE_CHATGPT_MODEL` | `gpt-5.6-luna` | Floored at high effort; max is honoured |
| `OPENCODE_DEEPSEEK_MODEL` | `deepseek-v4.1-flash` | Reads diagrams (undocumented) and beat `deepseek-v4-flash-vision-exp` on the fixture; the latter is the documented vision model and the fallback if this regresses |
| `OPENCODE_GROK_MODEL` | `grok-4.6` | |
| `OPENCODE_MIMO_MODEL` | `mimo-v2.5` | OpenCode Zen's free tier; the docs' `mimo-v2.5-free` id is rejected on the Go gateway |
| `OPENCODE_MUSE_MODEL` | `muse-spark-1.3-contributor` | Free "contributor" tier; the workspace must opt in or the gateway answers 403 `DataPolicyError` |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/go/v1` | Endpoint override |
| `POE_CHATGPT_MODEL` | `gpt-5.4` | Poe bot handle |
| `POE_CLAUDE_MODEL` | `claude-opus-4.8` | Poe bot handle |
| `POE_GEMINI_MODEL` | `gemini-3.1-pro` | Poe bot handle |
| `GOOGLE_GEMINI_MODEL` | `gemini-3.8-flash,gemini-3.5-flash` | Google model chain for `GEMINI_CHANNEL=google`. The owner's key is free-tier: Flash works, `gemini-3.1-pro-preview` answers 429 |
| `INTERPRET_CHATGPT_MODEL` / `INTERPRET_GEMINI_MODEL` / `INTERPRET_CLAUDE_MODEL` | `gpt-5.6-luna` / `gemini-3.8-flash,gemini-3.5-flash` / `claude-opus-4.8` | Pinned routes for the interpretation pass; ChatGPT is an OpenCode Go id, Gemini a Google chain, Claude a Poe bot |
| `POE_BASE_URL` | `https://api.poe.com/v1/responses` | Endpoint override |
| `GOOGLE_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Endpoint override |
| `NO_STREAM` | *(empty)* | Providers that skip upstream streaming. Was `deepseek` on the free plan: DeepSeek streams its reasoning token by token, which that plan billed as CPU and killed mid-solve (2,010 ms → `exceededCpu`); non-streamed the same solve costs 13 ms. Only for models that finish inside OpenCode's ~100–120 s idle cut. Cleared on Workers Paid |

The assignment is always sent as images, so **every model here must be vision-capable**. A text-only model does not necessarily fail: some answer "I cannot view the image" and then invent a plausible solution, which is worse. Verify vision before changing a model id.

Poe bot handles change over time. List the ones your key can actually see with:

```bash
curl -H "Authorization: Bearer $POE_API_KEY" https://api.poe.com/v1/models
```

### Switching Gemini to a Google key

```
GEMINI_CHANNEL=google
GOOGLE_API_KEY=<your AI Studio key>
```

Nothing else changes — the dialect, schema translation (Gemini's `responseSchema` rejects `additionalProperties`), and thinking-budget mapping are handled in `worker/channels.ts`.

### Adding a channel to a provider

Add an entry under that provider in `ROUTES` (`worker/channels.ts`) naming the dialect, key var, model var, and endpoint. If it speaks an existing dialect, that is the only change needed.

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
```

```bash
curl -N -X POST http://localhost:5173/api/solve/claude -H "content-type: application/json" -d '{"images":["data:image/jpeg;base64,..."],"notes":"","effort":"low"}'
```

## Deployment

```bash
npx wrangler login
npx wrangler secret put POE_API_KEY
npm run deploy     # vite build && wrangler deploy
```

The app deploys to `https://civilsolve.<account>.workers.dev`.

The account is on **Workers Paid** ($5/month) since 22 September 2026, which raises CPU per invocation from 10 ms to 30 s (the default; `limits.cpu_ms` in `wrangler.jsonc` goes to 5 min). Measured on production the same day: MiMo streamed B.8 1,424 ms `ok`; DeepSeek streamed B.8 3,201 ms `ok` in 77 s (the free plan killed it at 63 s); DeepSeek as interpretation judge 1,906 ms `ok`. Nothing else in the plan matters here: a solve is at most 5 requests, static assets are unlimited, and the immediate SSE headers + heartbeats keep long solves alive. Everything below this line was written against the free plan and is kept because it explains why the code is shaped the way it is — the single-choice picker, the sequential interpretation pass, `NO_STREAM` — and what to re-enable if the account ever drops back.

**Piping the provider stream is I/O-wait, but the upload is not.** Each selected provider gets its own copy of the images, and each Worker invocation parses that JSON body and re-serializes it into the upstream request — two full passes over several megabytes, all of it counted as CPU. That is why the body cap is enforced early and why the browser blocks oversized batches before sending. If you raise `MAX_IMAGES` or `MAX_BODY_BYTES` in `shared/stream-protocol.ts`, measure CPU time per invocation before assuming it still fits.

Deduplicating the N uploads would need either server-side storage or a single fan-out request, and both are ruled out by design (see `AGENTS.md`) — so the lever available is payload size, not request count.

**Every ticked provider runs at once** (`SOLVE_CONCURRENCY` in `use-solve.ts`, 4 — the most the cross-check can grade). The picker was single-choice on the free plan: there each per-token stream (the OpenCode Go routes) draws roughly 300–1800 ms of CPU for its whole duration — versus ~20–50 ms for a Poe-buffered route — and the plan's CPU budget is a rolling, account-wide allowance, so running several heavy streams together, or back-to-back, drains it and the runtime kills a stream mid-flight (the client shows it ended unexpectedly). One at a time kept every solve inside the budget. A stream that is still killed retries once automatically.

**Streaming a thinking model costs CPU the free plan meters.** The runtime charges per upstream chunk read, and per-token streams from OpenCode Go arrive as thousands of tiny chunks — roughly 330–500 ms of CPU per solve for those routes, against ~20–50 ms for Poe routes that buffer upstream. A single five-provider solve (~900 ms total) completes on the free plan when spaced out; back-to-back solves or the interpretation pass on top can exceed the plan's refilling budget, in which case the affected tab shows "ended unexpectedly, please try again". Nothing in the Worker's JavaScript can reduce this further (see `AGENTS.md` for the measurements); the fixes are Workers Paid, fewer providers per solve, or lower thinking on the OpenCode routes.

## Upload support

Accepted: JPEG, PNG, WebP, GIF, PDF. HEIC/HEIF/TIFF are no longer accepted (the old server normalized them with ImageMagick; browsers cannot decode them on a canvas). iOS converts HEIC to JPEG automatically when picking photos, so iPhone uploads still work.

## Provider output safety

Provider responses can be messy despite `strict: true`. The pipeline in `shared/solution.ts` handles: control-character stripping, alternate JSON field names, `problems[]`-array shapes, JSON-blob-inside-a-field repair, plain-text synthesis, LaTeX fence stripping, and LaTeX-body-preferred display repair. A provider failure only fails that provider's tab.

Model output is also **untrusted input** — the uploaded images are user-supplied, so anything in them can steer what a model writes. Rendered markdown is sanitized with DOMPurify before it reaches the DOM (`src/lib/math-markdown.ts`); KaTeX output is spliced in afterwards from placeholders so the sanitizer never mangles generated math.

## Maintenance rules

- Keep provider keys server-side only. No key ever reaches the client, and no key ever goes in a URL or query string.
- Keep `/api/solve/:provider` streaming — the immediate SSE response is what makes long solves survivable on Workers.
- Do not turn one provider's failure into a whole-solve failure.
- Keep `delta` events limited to visible output; never forward reasoning/thinking fragments.
- Keep rendered model output sanitized before it hits `dangerouslySetInnerHTML`.
- Map thinking effort per route. Never send one enum to every model.
- Update this README whenever architecture, provider behavior, deployment, or error handling changes.
