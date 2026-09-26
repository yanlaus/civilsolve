# CivilSolve

CivilSolve solves civil engineering assignments. Users upload question images or PDFs, optionally add instructions, choose a thinking-effort level and one or more AI providers, and receive a worked solution per provider. Eight providers are available; the selected ones **solve at the same time**:

| Provider | Default channel | Default model | Default choice |
|---|---|---|---|
| ChatGPT | OpenCode Go | `gpt-5.6-luna`, high or max thinking | default judge for both optional passes |
| DeepSeek | OpenCode Go | `deepseek-v4.1-flash` | **selected**; badged **Less credit** |
| Muse Spark | OpenCode Go | `muse-spark-1.3-contributor` | **selected**; badged **Less credit**; needs a workspace opt-in |
| Kimi | OpenCode Go | `kimi-k2.7-code`, medium thinking or above, 20-minute timeout | offered; a default solver for one day (26 September 2026) |
| MiMo | OpenCode Go | `mimo-v2.6-flash` | badged **China model** |
| MiniMax | MiniMax, then OpenCode Go (a channel chain) | `MiniMax-M3`, 20-minute timeout | badged **China model** |
| Grok | OpenCode Go | `grok-4.6` | badged **More credit** |
| Claude | Poe | `claude-opus-4.8` | last solver; badged **More credit** |
| Gemini | Google (switchable to Poe) | `gemini-3.8-flash`, falling back to `gemini-3.5-flash` | **reader and judge only** since 26 September 2026 - the free-tier key answers 503 "high demand" more often than not; last in those lists |

The rows are in picker order (`PROVIDER_KEYS`), the owner's since 26 September 2026: ChatGPT, DeepSeek, Muse Spark, Kimi, MiMo, MiniMax, Grok, Claude - then Gemini, which has no solver card. The same order sets the reader and judge lists, the solution tabs and the letters the judge sees.

Each card shows three things — brand, the account it runs on, and the model id — plus a cost badge where it matters. Gemini is no longer a solver (`REVIEW_ONLY_PROVIDERS`): its free-tier Google key costs nothing but often fails to answer, so it is offered only as a reader and judge, where it is listed last and not marked (the "(free but unstable)" note came off those lists at the owner's request); `/api/solve/gemini` answers 400. Grok and Claude are badged "More credit" (`HIGHER_CREDIT_PROVIDERS` in `shared/providers.ts`): Claude runs as Opus on Poe, the priciest bot there by a wide margin, and Grok is the heaviest draw on the OpenCode Go plan, so Claude sits at the end. DeepSeek and Muse Spark are badged "Less credit" (`LOWER_CREDIT_PROVIDERS`): DeepSeek Flash is the lightest draw on that plan, and Muse Spark is one of OpenCode Zen's free tiers — free because it collects what is sent to it, assignment images included, for training, and its "contributor" tier will not answer at all until the OpenCode workspace has opted in to that. MiMo is the other free tier and carries no cost badge. MiMo and MiniMax are badged "China model" (`CHINA_PROVIDERS`) as a provenance label, not a quality or cost one. Effort floors and model chains are not on the card: the floor is shown under Thinking Effort, and a chain announces itself in the status line only when it actually switches. Every one of these reads images; that is a hard requirement and was verified per model, not taken from a spec sheet. Kimi, MiniMax and Qwen were offered until September 2026 and removed after two full runs of a past-paper momentum fixture: Kimi 0/4, Qwen 0/8, MiniMax 1/4 correct (see `AGENTS.md`). Their routes and the Anthropic-protocol dialect they used are in git history. MiniMax came back as a solver on a new route; Kimi came back on 25 September 2026 as a **reader and judge only** (`REVIEW_ONLY_PROVIDERS`): it is in the reader, reconciler and judge lists but has no solver card, and `/api/solve/kimi` answers 400. The picker is multi-select; every ticked provider solves at once and gets its own tab (DeepSeek and Muse Spark by default - Kimi was a third for one day, 26 September 2026; the picker was single-choice on the free Workers plan, where concurrent per-token streams got killed). One thinking level serves them all, `high` by default, and the highest floor among the ticked providers rules (tick ChatGPT and everything below `high` is disabled). Two optional passes sit on top, both off by default: the interpretation pass fires two readers (Gemini and Muse Spark) then a reconciler (ChatGPT) — three calls in sequence before the first solve; the answer cross-check sends every finished solution to a judge (ChatGPT) that grades them against the images (see `POST /api/judge`).

Each result includes an interpreted problem statement, assumptions, a step-by-step solution, and a final answer, with in-browser KaTeX math rendering. Solutions are saved as PDF (browser print); the `.tex` download and "Open in Overleaf" were removed on 25 September 2026. Models still write a `latex_body`, which the repair pipeline uses to rebuild a solution whose other fields came back malformed.

## Architecture

A single **Cloudflare Worker** (free tier) serves everything:

- **Static assets** — the Vite-built React SPA, served by Workers Static Assets with SPA fallback.
- **API** — a [Hono](https://hono.dev) app (`worker/index.ts`) handles `/api/*` via `run_worker_first`.

The solve flow is **streaming over Server-Sent Events**, with each task running in a short-lived **job**:

1. The browser converts uploads to JPEG data URLs client-side (`src/lib/attachments.ts`): images are downscaled on a canvas (max 2048px), PDFs are rasterized page-by-page with pdf.js - every page, or the pages the user chose (see "Upload support").
2. It fires one `POST /api/solve/:provider` request per ticked provider, all at once.
3. The Worker validates the request, then hands it to a **`TaskJob` Durable Object** of its own (`worker/jobs.ts`). The job resolves the provider's **channel**, calls that channel's API with **native vision input** (no OCR) and a strict JSON schema, and streams progress back; the stream's first event names the job.
4. The provider's tab renders progressively — spinner, then live progress, then the finished solution.

**Leaving the page does not lose the answer.** On a phone, putting the browser in the background makes iOS cut the stream. The job keeps running regardless (a Durable Object outlives its client; a plain Worker request would be cancelled ~30 s after it), stores its final answer, and the page **re-attaches** to it when it is visible again (`GET /api/jobs/:id`, via `withResume` in `src/lib/sse.ts`) - no second model call. A short outage while the page stays open - a phone switching between Wi-Fi and mobile data, a weak signal - is ridden out the same way: the page keeps reconnecting, backing off to one try every 15 s, and gives up only after 2 minutes in which no reconnection got through, telling you to reload to pick the answer up. If the tab was reloaded or discarded, the page recovers the last run from localStorage on load. **Stop** cancels the jobs on the server (`DELETE /api/jobs/:id`); closing the tab does not, so a run started and abandoned still finishes and waits for you. While work is running the page also holds a screen wake lock, so a phone left on the desk does not lock itself mid-solve. A connection the phone drops without telling the page - no error, no close, the read just waits - is caught too: the server sends a heartbeat every 15 s, and 45 s without a byte (`STREAM_IDLE_MS`) counts as a lost connection and re-attaches.

**Every tab shows its progress while it runs:** the latest status, a running clock (time since the request reached the server - the timeout itself is not shown, by the owner's choice), and every earlier status with the time it came - each retry, model switch, timeout of a model in a chain and reconnect - so a long wait is never one unchanging line. A finished tab says how long it took ("answered in 2 min 15 s"). A task that ran out of time gets an **orange** dot and an orange "Timed out - no solution returned" box, apart from the red of a real failure; the cross-check card and the interpretation step show the same clock. Opening a failed or timed-out tab keeps it open: the page only picks a tab for you until you pick one yourself.

**After a run, without uploading again:** a failed, timed-out or cancelled tab has a **Retry** button, and a panel under the solutions offers **Add a solver** (any configured provider not yet in the run) and **Run the cross-check** (again) over the finished solutions you tick, with the judge you pick. All three reuse the run's images, notes, thinking level and confirmed reading. A verdict given before a solver was added or retried says which solutions it did not grade. While an automatic cross-check is still pending they wait for it, and the cross-check waits for every solver still running.

**What is stored:** each job's final event - the solution, reading or verdict as text, or its error - and its kind, provider and start time, for **24 hours** after it finishes, then deleted by an alarm. The uploaded images are never written to server storage. The job id (a random UUID) is the only key; the browser keeps it in localStorage, and whoever has it can read that answer until it expires. The browser also keeps the last run's request body - the prepared page images, notes and confirmed reading - in its own **IndexedDB** (`src/lib/upload-store.ts`), so Retry, Add a solver and the cross-check still work after a reload. That copy never leaves the device; it is replaced by the next run, deleted by **Clear** and **Stop** (the page keeps it in memory after Stop, and a Retry stores it again), and dropped after 24 hours.

### Providers and channels

A **provider** is what the user picks in the UI. A **channel** is the upstream account the key comes from. One provider can be reachable over several channels, and the channel is resolved from env per request:

```
chatgpt  ──> opencode | poe     (CHATGPT_CHANNEL)
claude   ──> poe
gemini   ──> google | poe       (GEMINI_CHANNEL)
deepseek ──> opencode
grok     ──> opencode
mimo     ──> opencode
minimax  ──> minimax → opencode   (MINIMAX_CHANNEL, a chain: see below)
muse     ──> opencode
```

Channels speak three different API dialects, all handled in `worker/channels.ts`:

| Dialect | Used by | Endpoint shape | Reasoning parameter |
|---|---|---|---|
| `responses` | Poe; OpenCode Go (GPT Luna, Grok, Muse Spark) | `POST /v1/responses` | `reasoning: { effort }` (enum) |
| `chat-completions` | OpenCode Go (DeepSeek, MiMo, MiniMax); MiniMax's own API | OpenAI-compatible chat completions | `reasoning_effort` (enum) |
| `gemini` | Google | `:streamGenerateContent?alt=sse` | `generationConfig.thinkingConfig.thinkingBudget` (tokens) |

#### OpenCode Go

One key and one base URL (`https://opencode.ai/zen/go/v1`) front several protocols, and the gateway fixes which protocol each model speaks. Every request must carry an `x-opencode-session` header (a stable id per conversation; the Worker sends a fresh UUID per solve) or the gateway refuses it with `MissingSessionID`. Two model families need a one-time opt-in in the OpenCode workspace before the key can use them: models hosted only in China (`deepseek-v4-pro`) and the data-collecting `muse-spark-*` contributor models.

A route can pin its reasoning level with `forceEffort`, or bound it with `minEffort` and `maxEffort`. Two routes use a bound. ChatGPT floors at `high`: `gpt-5.6-luna` is offered at `high` or `max` only — those two picks are sent as-is (`max` maps to `reasoning.effort: "xhigh"`, which the gateway accepts) and anything lower is raised. No route sets a ceiling today: MiniMax had one at `low` for a day, and it was replaced by a longer timeout (below) because `reasoning_effort` does not actually shorten that model's thinking — measured at every level on both of its routes, with no monotonic relationship. `clampEffort` in `worker/run.ts` applies whichever bounds exist; the upload form disables the levels outside the band and names the provider that set it. One level serves every selected solver, so a floor above a ceiling would leave no valid level — the form blocks such a combination instead of picking a side.

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
│   ├── index.ts            # Hono app: sign-in check, rate limit, validation, task endpoints, /api/jobs/:id
│   ├── access.ts           # Cloudflare Access token verification (who may call /api/*)
│   ├── tasks.ts            # Request body -> task, for solve / interpret / judge
│   ├── jobs.ts             # TaskJob Durable Object: runs a task, keeps its answer 24 h
│   ├── channels.ts         # Routes, per-dialect request building + parsing
│   └── run.ts              # Heartbeats, timeout, retry/downgrade, SSE events to a sink
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
│   │   ├── run-actions.tsx             # Add a solver / run the cross-check after a run (lazy)
│   │   └── solution-article.tsx        # Markdown + KaTeX rendering
│   ├── hooks/
│   │   ├── use-solve.ts                # Per-provider state machine, solvers -> judge, restore, retry
│   │   ├── use-interpret.ts            # interpret -> verify -> review
│   │   ├── use-health.ts               # GET /api/health once for the page; sign-in refusals
│   │   └── use-wake-lock.ts            # Keep the screen on while a run is in flight
│   └── lib/
│       ├── sse.ts                      # SSE reader, job handles, re-attach, resume on return
│       ├── run-store.ts                # Last run's job ids in localStorage (24 h)
│       ├── upload-store.ts             # Last run's request body (images) in IndexedDB (24 h)
│       ├── math-markdown.ts            # Math normalization, sanitize, render
│       ├── attachments.ts              # File -> JPEG data URL conversion
│       ├── page-range.ts               # "1-3, 5" -> the PDF pages to send
│       ├── lecture-notes.ts            # Reference payload from notes files
│       ├── pdf-to-images.ts            # pdf.js page count + rasterization (dynamic import)
│       └── exports.ts                  # Save as PDF (browser print)
├── wrangler.jsonc          # Worker config (assets, vars, run_worker_first)
├── .dev.vars.example       # Local secrets template (copy to .dev.vars)
└── vite.config.ts          # @cloudflare/vite-plugin + manualChunks
```

## API

Every `/api/*` route is for signed-in users only (see "Sign-in and rate limiting" below). Without a valid Cloudflare Access token a route answers `401 {"error": ...}`; with sign-in not configured on the server, `503`. `POST /api/solve`, `/api/interpret` and `/api/judge` are also rate limited per user: past the limit they answer `429` with `retry-after: 60`. The page shows each of these messages as the tab's error.

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

Off by default — it costs three model calls and delays the first solution. The two readers run **at the same time**, then the judge reconciles their readings (it needs both). Until 25 September 2026 all three ran one after another - written for the free plan, where two concurrent streams was exactly the load that tripped the CPU limit - so the pass took the sum of both readers rather than the slower one. If one reader fails, the other's reading still goes to review, flagged as not cross-checked, instead of the whole pass failing. The status line shows each reader's own progress ("DeepSeek: writing... 1,200 characters · Kimi: done") and the step's elapsed time. The judge also writes the reading in **Traditional Chinese** (`traditional_chinese`, verify mode only - `verifiedInterpretationSchema`), shown under the English in the review step for reference; the solvers are only ever given the English. Measured on B.8: the Chinese keeps every value (60 mm, 100 kPa, 30°, W = 0.5 kN) and translates the prose, and it makes the ChatGPT reconcile take ~150 s at `max`. Readers without a working strict schema (Kimi, DeepSeek) may answer with arrays, objects, other key names or a wrapper; `parseInterpretation` flattens all of those (`textOf`), and on a last attempt delivers whatever came back rather than an error. The default trio is **DeepSeek Flash** (`deepseek-v4.1-flash` on OpenCode Go - the same model and route that solves, since DeepSeek has no pinned interpretation route; it replaced Gemini, whose free-tier key fails too often, on 25 September 2026) and **Muse Spark** (OpenCode Go) as readers, **ChatGPT** (`gpt-5.6-luna` on OpenCode Go) as judge. Readers run at a user-chosen effort (default `medium`); the judge runs at `max`. ChatGPT, Gemini and Claude are pinned to routes chosen for the pass, independent of the solve-time channel (`interpretOverride`): ChatGPT to Luna — it read on Poe's `gpt-5.4-pro` until 22 September 2026, correct but slow (~95 s vs ~5 s for Gemini) and billed to Poe — and Claude to Opus on Poe. Measured with the new defaults: Gemini 39 s and Muse Spark 12 s to read, Luna 31 s to reconcile, with a 1,271-character discrepancies field. The Gemini reader uses a **model chain**, `gemini-3.8-flash,gemini-3.5-flash`: 3.8 first, 3.5 when 3.8 does not answer (see "Model chains" below). If `GOOGLE_API_KEY` is not configured it reads on Poe's `gemini-3.1-pro` instead, so the pass keeps working. A provider not pinned here (DeepSeek, Grok, MiMo, Muse Spark) keeps its normal route if picked.

#### Model chains

Any model var may hold a comma-separated chain, primary first. When an attempt fails in a way worth retrying — 503, 429, a dropped stream, a fragment the parser cannot use — the Worker moves to the next model in the chain instead of repeating the same one, after the same 3 s pause as a transient retry, and reports it as a `status` event ("gemini-3.8-flash did not answer. Trying gemini-3.5-flash..."). The fallback starts with a fresh transient budget. `/api/health` reports the chain as `fallbackModels`, and the picker shows it on the card. Measured on Google the day this was added: `gemini-3.8-flash` closed the socket on a 190 KB request four times out of six and once answered with empty fields; `gemini-3.5-flash` behind it was 4/4.

### `POST /api/judge/:provider`

Optional post-pass, the **answer cross-check**. Body: `{ images, notes, interpretation?, solutions: [text, text, ...], effort? }` with two to four solutions. Returns the same SSE shape with `done → { judgement }`: `{ correct: number[], final_answer, assessments: string[], comparison, confidence: "high" | "medium" | "low" }` — `correct` holds the zero-based indices of the solutions the judge found right (empty for none), `assessments` has one entry per solution in order. On the wire the judge answers with letters (`correct_solutions: ["A", "C"]`); the parser maps them to indices and, on schema-less rungs, reads prose ("A and C", "both", "none").

The browser drives it as: every ticked provider runs `/api/solve` **at the same time**, then the judge gets every finished solution (flattened by `artifactToText`, capped at 24,000 characters each, working cut before the answer) with the same images and the confirmed interpretation if there was one. A solver that returned nothing is left out and named on the verdict card; fewer than two finished solutions and the check is skipped. The solutions are anonymised as Solution A, B, C, D in picker order — the judge never learns which provider wrote which, so it grades the work, not the brand — and the browser maps the letters back to provider names. The prompt tells the judge to re-derive the numbers from the images rather than read the solutions for consistency: every wrong answer seen on the fixtures was internally consistent (a jet velocity assumed instead of derived, a pressure force counted twice), and a consistency check would pass them all.

The judge also writes `traditional_chinese`: the verdict explained again in Traditional Chinese (which solutions are right, the verified answer, what each got wrong and why), shown under the English in the verdict card; measured on B.8, ChatGPT wrote 734 characters starting "解答 A 正確；解答 B 不正確" with the math intact. The judge runs on the provider's normal solve route at `high` by default (the most reliable level in the B.8 matrix; `effort` in the body overrides). The default judge is ChatGPT (Luna); the user can pick any configured provider. Measured on the B.8 fixture with the first version (two solvers, Gemini judging): Muse ‖ DeepSeek at `low` finished together in 85 s (the slower of the two), Gemini judged in 43 s, verdict **A, high confidence**, with the correct −143 N / −178 N as the verified answer and B's error named to the term (a pressure force of 565.5 N where 282.7 N was right). The three-solver path (Muse, DeepSeek, Grok → Luna) was verified against a scripted upstream: `correct_solutions: ["A", "C"]` came back mapped to Muse and Grok with three assessments. Combining it with the interpretation pass gives the most robust run: a reviewed reading feeds every solver and the judge.

#### How long a task may run

The timeout is a **floor per route plus an allowance per page**, counted across every attempt so a retry cannot extend it.

| Upload | Most providers | DeepSeek, Kimi, MiMo, MiniMax |
|---|---|---|
| 1 question | 4.7 min | 20 min |
| 3 pages | 8.7 min | 24 min |
| 8 pages | 18.7 min | 34.7 min |
| 16 pages (the cap) | 34.7 min | 45 min (the ceiling) |

`SAFETY_TIMEOUT_MS` in `worker/run.ts` is the 280 s floor; a route overrides it with `timeoutMs`, and four providers set 20 minutes (`LONG_THINKING_TIMEOUT_MS`): Kimi, which as a solver at `high` answered B.8 in 271 s, 9 s short of the floor; MiniMax on both of its routes — on the B.8 fixture it wrote 93–104k characters of reasoning and was still going at 280 s on three production runs out of three, and no effort level shortens that — and DeepSeek and MiMo, which on the two-part B.5 paper at `high` took 249 s and more than 280 s (MiMo timed out without writing a character). `taskTimeoutMs` in `shared/stream-protocol.ts` then adds `PER_EXTRA_PAGE_MS` (2 min) for each assignment page after the first, because a whole exam paper is a dozen questions in one request rather than one long question, and both the reading and the writing grow with it. Lecture-notes pages count half: they are read once as reference and never solved. `MAX_TIMEOUT_MS` (45 min) caps the result so a wedged upstream cannot hold a tab open all day — the heartbeats would otherwise keep it alive indefinitely.

Nothing in the platform forces these numbers. Cloudflare enforces no wall-clock limit on an HTTP request while the client stays connected, and time spent waiting on `fetch()` is not billed as CPU (a 77 s solve costs ~3 s of CPU). They encode how long a user should wait before being told nothing is coming; the 15 s heartbeats are what keep the stream itself alive. The 280 s value arrived with the original import and had no recorded reason until this was written.

### Jobs: `GET /api/jobs/:id` and `DELETE /api/jobs/:id`

Every `POST /api/solve`, `/api/interpret` and `/api/judge` runs in a job, and its SSE stream opens with:

```
event: job      data: {"id":"<uuid>","startedAt":1790347043501,"deadlineAt":1790347323501,"now":1790347043501}
```

`startedAt` and `deadlineAt` are when the job began and when it gives up (its timeout, above), on the server's clock; `now` lets the page correct for its own clock. Through a job every `status`, `done` and `error` carries `at`, the server time it happened, and an `error` carries `timedOut: true` when the task ran out of time rather than failed ("... timed out after 4 min 40 s and returned nothing.").

- `GET /api/jobs/:id` re-attaches: the same `job` event, then either the stored final event (`done` or `error`) and the end of the stream, or - for a run still in progress - every `status` so far (with its original `at`, so the page recognises the ones it already has) followed by everything live. The statuses are held in the object's memory only; what is stored is still the final event alone. `404` with `{"error": ...}` when the job never existed, has expired (24 h after it finished), or was lost mid-run.
- `DELETE /api/jobs/:id` cancels a running job; it ends with `error: Cancelled.`, which is what is then stored. `204` whether or not there was anything to cancel.

Only well-formed UUIDs reach the Durable Object namespace. Without the `JOBS` binding the task endpoints run inline in the Worker, as before jobs existed, and a disconnect then ends the run.

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
| `OPENCODE_API_KEY` | ChatGPT, DeepSeek, Grok, MiMo, Muse Spark; MiniMax when `MINIMAX_CHANNEL=opencode` | <https://opencode.ai/go> |
| `POE_API_KEY` | Claude, Gemini; ChatGPT when `CHATGPT_CHANNEL=poe` | <https://poe.com/api_key> |
| `GOOGLE_API_KEY` | Gemini, only when `GEMINI_CHANNEL=google` | <https://aistudio.google.com/apikey> |
| `MINIMAX_API_KEY` | MiniMax, first in its chain; delete it and MiniMax runs on OpenCode Go | <https://platform.minimaxi.com> |

- Local: copy `.dev.vars.example` to `.dev.vars` and fill in the keys you have. `.dev.vars` is gitignored.
- Production: `npx wrangler secret put POE_API_KEY` (repeat per key).

A provider whose key is blank is shown as unavailable in the UI rather than failing mid-solve. You only need the keys for the providers you intend to use.

> `.dev.vars` is read by the **Worker**, not by Vite. Never move these into `.env`, and never prefix them with `VITE_` — anything named `VITE_*` is inlined into the browser bundle.

### Bindings (in `wrangler.jsonc`)

| Binding | Class | Purpose |
|---|---|---|
| `JOBS` | `TaskJob` (`worker/jobs.ts`), SQLite-backed, migration `v1` | One Durable Object per task, so it finishes after the page leaves and keeps its answer 24 hours. Available on Workers Free and Paid; each job is billed for the time it is active (≈ 128 MB × run time), comfortably inside the Paid plan's 400,000 GB-s a month. Remove it and tasks run inline again |
| `TASK_LIMITER` | Workers Rate Limiting (`ratelimits`, namespace `2609`) | 20 model-calling requests (solve, interpret, judge) per signed-in user per minute. A whole run with every option on is about a dozen, so it only stops a runaway client. Re-attaching and cancelling are not counted. Remove it and nothing is limited |

### Vars (in `wrangler.jsonc`, non-secret)

| Variable | Default | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | *(empty)* | Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com`. Empty: the deployed API refuses everything (see "Sign-in and rate limiting") |
| `ACCESS_AUD` | *(empty)* | The Access application's Audience (AUD) tag |
| `CHATGPT_CHANNEL` | `opencode` | `opencode` or `poe` |
| `CLAUDE_CHANNEL` | `poe` | Channel for Claude |
| `GEMINI_CHANNEL` | `google` | `google` or `poe` |
| `DEEPSEEK_CHANNEL` / `GROK_CHANNEL` / `MIMO_CHANNEL` / `MUSE_CHANNEL` | `opencode` | Only OpenCode Go serves these |
| `MINIMAX_CHANNEL` | `minimax,opencode` | A chain, first usable channel first: the owner's token plan, then the shared Go subscription. `minimax` or `opencode` pins one |
| `OPENCODE_CHATGPT_MODEL` | `gpt-5.6-luna` | Floored at high effort; max is honoured |
| `OPENCODE_DEEPSEEK_MODEL` | `deepseek-v4.1-flash` | Reads diagrams (undocumented) and beat `deepseek-v4-flash-vision-exp` on the fixture; the latter is the documented vision model and the fallback if this regresses |
| `OPENCODE_GROK_MODEL` | `grok-4.6` | |
| `OPENCODE_MIMO_MODEL` | `mimo-v2.6-flash` | OpenCode Zen's free tier; Zen lists it as `mimo-v2.6-flash-free`, which the Go gateway rejects |
| `OPENCODE_MINIMAX_MODEL` | `minimax-m3` | Only used when `MINIMAX_CHANNEL=opencode`. The only MiniMax id the gateway serves — `minimax-m2.7` and `minimax-m2.5` answer 503 |
| `MINIMAX_MODEL` | `MiniMax-M3` | Used by the default `minimax` channel |
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com/v1` | Endpoint override; the international deployment is `https://api.minimax.io` |
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

### Switching MiniMax between its own key and OpenCode Go

MiniMax runs on a **channel chain**: the owner's MiniMax token plan first, OpenCode Go second.

```
MINIMAX_CHANNEL=minimax,opencode   # default: plan first, Go when the plan refuses
MINIMAX_CHANNEL=minimax            # the plan only - fail if it refuses
MINIMAX_CHANNEL=opencode           # Go only - the plan is never touched
```

With the default, nothing has to change when the plan ends. The Worker moves a solve down the chain when MiniMax **refuses the account** — HTTP 401/402/403, or a message about balance, quota, credit, billing, an expired plan or an invalid key, including MiniMax's own codes 1004 / 1008 / 2049 and its HTTP-200 `base_resp` envelope — or when it **stops answering** after its transient retry. The tab says which, e.g. "MiniMax (via MiniMax) refused the account (HTTP 401: login fail…) — the plan may have ended. Trying MiniMax (via OpenCode Go)…". The move costs about a second per solve. To stop paying that second once the plan is gone, delete the key — the chain then skips straight to OpenCode Go without a redeploy:

```bash
npx wrangler secret delete MINIMAX_API_KEY
```

A channel is a different account and endpoint, so a move starts the new route fresh: capabilities, effort band and retry budgets are renegotiated, and only the safety timeout keeps running. An explicit single channel is respected — `minimax` alone fails with MiniMax's message rather than quietly spending the Go subscription. Any provider's channel var may be a chain; only MiniMax uses one today. Verified against the real APIs on 23 September 2026: a rejected key moved the solve to OpenCode Go 1 s in and it finished correctly; a removed key skipped MiniMax entirely; a `base_resp` 1008 "insufficient balance" reply (from a stand-in server) moved it as well; `minimax` alone failed with the 401; `opencode` alone never called MiniMax.

Both channels bill as monthly subscriptions the owner already pays for, so the chain is about which quota is spent, not about per-call cost. MiniMax's own endpoint is plain OpenAI chat completions at `https://api.minimaxi.com/v1` and reads images, so nothing else changes — the anthropic-protocol route this provider used until 19 September 2026 is not needed and is not coming back. The model is spelled `MiniMax-M3` there and `minimax-m3` on the gateway; `MiniMax-M3[1m]` selects the 1M-token context. Use `https://api.minimax.io` (`MINIMAX_BASE_URL`) for the international deployment. Verified on both fixtures through the app's own prompt: B.8 correct in 141 s, the beam correct in 27 s, both at `low`.

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

### Sign-in and rate limiting

The app spends the owner's provider subscriptions, so only people you allow can use it. **Cloudflare Access** signs them in at Cloudflare's edge, before anything reaches the Worker, and the Worker checks the proof Access attaches to every request (`worker/access.ts`): an RS256 JWT in the `Cf-Access-Jwt-Assertion` header, verified against the team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) for its signature, audience, issuer and expiry. A request that reaches the Worker without passing Access - a hostname Access does not cover, such as a preview URL, or an Access application that was removed - is refused with `401`, so no provider key is spent on it. With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` empty the deployed API refuses everything with `503`: it fails closed. Requests to `localhost` (`npm run dev`, `npm run preview`) are the one exception, since Access never sees them; Cloudflare routes by hostname, so no request to the deployed Worker can pass for one.

Set it up **before** deploying this version:

1. In the Cloudflare dashboard, open **Workers & Pages → civilsolve → Settings → Domains & Routes** and enable **Cloudflare Access** on the `workers.dev` route (and on Preview URLs, if they are on). This creates an Access application for the Worker. For a custom domain, add a self-hosted Access application for that hostname in **Zero Trust → Access → Applications** instead.
2. In **Zero Trust → Access → Applications**, edit that application's policy to allow exactly the people who may use the app (for example *Emails* `you@example.com`, or *Emails ending in* your school's domain). The One-time PIN login method needs no identity provider. Set the **session duration** to 24 hours or more, so a long solve does not outlive the sign-in.
3. Copy the application's **Audience (AUD) tag** and your **team domain** (`<team>.cloudflareaccess.com`, under Zero Trust → Settings) into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`, then `npm run deploy`.
4. Check: opening the app in a private window should show the Access login; `curl -i https://civilsolve.<account>.workers.dev/api/health` should not return the provider list.

A sign-in that expires in the middle of a run makes Access redirect the page's requests to its login page, which the browser reports as a network error; the page keeps reconnecting for 2 minutes and then asks for a reload, which signs in again and picks the run back up (its job ids are saved).

**Rate limiting** is the `TASK_LIMITER` binding (Workers Rate Limiting, `ratelimits` in `wrangler.jsonc`): 20 solve, interpret and judge requests per signed-in user per minute, counted per Cloudflare location. A whole run with every option on is about a dozen, so this only stops a runaway client or script; past it the request gets `429` and the tab says to wait a minute. The period can only be 10 or 60 seconds. Re-attaching to a job (`GET /api/jobs/:id`) and cancelling one are not counted - they call no model.

The account is on **Workers Paid** ($5/month) since 22 September 2026, which raises CPU per invocation from 10 ms to 30 s (the default; `limits.cpu_ms` in `wrangler.jsonc` goes to 5 min). Measured on production the same day: MiMo streamed B.8 1,424 ms `ok`; DeepSeek streamed B.8 3,201 ms `ok` in 77 s (the free plan killed it at 63 s); DeepSeek as interpretation judge 1,906 ms `ok`. Nothing else in the plan matters here: a solve is at most 5 requests, static assets are unlimited, and the immediate SSE headers + heartbeats keep long solves alive. Everything below this line was written against the free plan and is kept because it explains why the code is shaped the way it is — the single-choice picker, the sequential interpretation pass, `NO_STREAM` — and what to re-enable if the account ever drops back.

**Piping the provider stream is I/O-wait, but the upload is not.** Each selected provider gets its own copy of the images, and each Worker invocation parses that JSON body and re-serializes it into the upstream request — two full passes over several megabytes, all of it counted as CPU. That is why the body cap is enforced early and why the browser blocks oversized batches before sending. If you raise `MAX_IMAGES` or `MAX_BODY_BYTES` in `shared/stream-protocol.ts`, measure CPU time per invocation before assuming it still fits.

Deduplicating the N uploads would need either server-side storage or a single fan-out request, and both are ruled out by design (see `AGENTS.md`) — so the lever available is payload size, not request count.

**Every ticked provider runs at once** (`SOLVE_CONCURRENCY` in `use-solve.ts`, 4 — the most the cross-check can grade). The picker was single-choice on the free plan: there each per-token stream (the OpenCode Go routes) draws roughly 300–1800 ms of CPU for its whole duration — versus ~20–50 ms for a Poe-buffered route — and the plan's CPU budget is a rolling, account-wide allowance, so running several heavy streams together, or back-to-back, drains it and the runtime kills a stream mid-flight (the client shows it ended unexpectedly). One at a time kept every solve inside the budget. A stream that is still killed retries once automatically.

**Streaming a thinking model costs CPU the free plan meters.** The runtime charges per upstream chunk read, and per-token streams from OpenCode Go arrive as thousands of tiny chunks — roughly 330–500 ms of CPU per solve for those routes, against ~20–50 ms for Poe routes that buffer upstream. A single five-provider solve (~900 ms total) completes on the free plan when spaced out; back-to-back solves or the interpretation pass on top can exceed the plan's refilling budget, in which case the affected tab shows "ended unexpectedly, please try again". Nothing in the Worker's JavaScript can reduce this further (see `AGENTS.md` for the measurements); the fixes are Workers Paid, fewer providers per solve, or lower thinking on the OpenCode routes.

## Upload support

Accepted: JPEG, PNG, WebP, GIF, PDF. HEIC/HEIF/TIFF are no longer accepted (the old server normalized them with ImageMagick; browsers cannot decode them on a canvas). iOS converts HEIC to JPEG automatically when picking photos, so iPhone uploads still work.

**PDFs: every page is sent, or the pages you choose.** When a PDF is added, the form reads its page count and shows it on the file's card, with a field for the pages to send (`1-3, 5`, `8-`; empty means every page). Each image counts one page, and one request carries at most 16 (`MAX_IMAGES`); past that the form says how many pages it has and will not solve until you choose. Until 26 September 2026 every PDF was cut to its first 8 pages without a word, so a 12-page paper lost its last four while the models answered the rest as if that were all. Lecture-notes PDFs are handled separately (`pdfToNotesPayload`): text pages are sent as text, and at most 8 image pages.

## Provider output safety

Provider responses can be messy despite `strict: true`. The pipeline in `shared/solution.ts` handles: control-character stripping, alternate JSON field names, `problems[]`-array shapes (every problem kept under its own heading, with steps, givens and formulas accepted as lists or objects - a whole exam paper comes back this way from models that ignore the schema), `<think>` reasoning left in the content, JSON-blob-inside-a-field repair, plain-text synthesis, LaTeX fence stripping, and LaTeX-body-preferred display repair. A provider failure only fails that provider's tab.

Model output is also **untrusted input** — the uploaded images are user-supplied, so anything in them can steer what a model writes. Rendered markdown is sanitized with DOMPurify before it reaches the DOM (`src/lib/math-markdown.ts`); KaTeX output is spliced in afterwards from placeholders so the sanitizer never mangles generated math.

## Maintenance rules

- Keep provider keys server-side only. No key ever reaches the client, and no key ever goes in a URL or query string.
- Keep every `/api/*` route behind the Access check in `worker/index.ts`, and keep it failing closed when sign-in is not configured.
- Keep `/api/solve/:provider` streaming — the immediate SSE response is what makes long solves survivable on Workers.
- Do not turn one provider's failure into a whole-solve failure.
- Keep `delta` events limited to visible output; never forward reasoning/thinking fragments.
- Keep rendered model output sanitized before it hits `dangerouslySetInnerHTML`.
- Map thinking effort per route. Never send one enum to every model.
- Update this README whenever architecture, provider behavior, deployment, or error handling changes.
