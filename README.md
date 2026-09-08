# CivilSolve

CivilSolve solves civil engineering assignments. Users upload question images or PDFs, optionally add instructions, choose a thinking-effort level, and receive worked solutions from up to five models in parallel:

| Provider | Default channel | Default model |
|---|---|---|
| ChatGPT | Poe | `gpt-5.4` |
| Claude | Poe | `claude-opus-4.8` |
| Gemini | Poe (switchable to Google) | `gemini-3.1-pro` |
| Kimi | Kimi Code token plan | `kimi-for-coding` |
| MiniMax | MiniMax (mainland) | `MiniMax-M3` |

Each result includes an interpreted problem statement, assumptions, a step-by-step solution, and a final answer, with in-browser KaTeX math rendering. Solutions can be exported as PDF (browser print), LaTeX source (`.tex`), or opened directly in Overleaf.

## Architecture

A single **Cloudflare Worker** (free tier) serves everything:

- **Static assets** — the Vite-built React SPA, served by Workers Static Assets with SPA fallback.
- **API** — a [Hono](https://hono.dev) app (`worker/index.ts`) handles `/api/*` via `run_worker_first`.

The solve flow is **stateless streaming** — no database, no object storage, no job queue:

1. The browser converts uploads to JPEG data URLs client-side (`src/lib/attachments.ts`): images are downscaled on a canvas (max 2048px), PDFs are rasterized page-by-page with pdf.js (max 8 pages).
2. It fires one `POST /api/solve/:provider` request per selected provider, in parallel.
3. Each Worker invocation resolves the provider's **channel**, calls that channel's API with **native vision input** (no OCR) and a strict JSON schema, and streams progress back over Server-Sent Events.
4. Provider tabs render progressively — each one flips from spinner to live progress to finished solution independently.

Nothing is stored server-side. Closing the tab abandons an in-flight solve (accepted trade-off for a fully free, zero-storage deployment).

### Providers and channels

A **provider** is what the user picks in the UI. A **channel** is the upstream account the key comes from. One provider can be reachable over several channels, and the channel is resolved from env per request:

```
chatgpt ──> poe
claude  ──> poe
gemini  ──> poe | google        (GEMINI_CHANNEL)
kimi    ──> kimi | moonshot     (KIMI_CHANNEL)
minimax ──> minimax
```

Channels speak four different API dialects, all handled in `worker/channels.ts`:

| Dialect | Used by | Endpoint shape | Reasoning parameter |
|---|---|---|---|
| `responses` | Poe | `POST /v1/responses` | `reasoning: { effort }` (enum) |
| `chat-completions` | Moonshot | OpenAI-compatible chat completions | `reasoning_effort` (enum) |
| `anthropic` | Kimi Code, MiniMax | `POST /v1/messages` | `thinking: { budget_tokens }` (tokens) |
| `gemini` | Google | `:streamGenerateContent?alt=sse` | `generationConfig.thinkingConfig.thinkingBudget` (tokens) |

#### Getting structured output out of each dialect

The dialects disagree about how — and whether — a caller can pin the response shape, so `worker/channels.ts` records what each route can actually do instead of discovering it by trial:

| Dialect | How the shape is pinned |
|---|---|
| `responses`, `chat-completions` | `json_schema` response format |
| `gemini` | `responseSchema` (an OpenAPI subset that rejects `additionalProperties`) |
| `anthropic` | No `response_format` exists — a **forced tool call** is the only lever |

The two Anthropic-protocol gateways then differ from each other:

- **MiniMax M3** honours a forced `tool_choice`, but only while extended thinking is on. Without thinking it quietly ignores the tool and answers in prose.
- **Kimi Code** has thinking permanently on for its coding models and rejects any forced tool alongside it: *"tool_choice 'specified' is incompatible with thinking enabled"*. So that route is flagged `structured: false` and never offers tools.

When a route cannot pin the shape, `buildTutorPrompt` appends an explicit six-field contract to the prompt instead. This matters more than it sounds: without it, Kimi returned a different envelope on nearly every run — `{problems:[…]}`, `{assignment_title, problems}`, a bare object — and the parser only handled some of them. With it, six consecutive runs returned the exact six fields.

`shared/solution.ts` remains the safety net behind all of this, including for providers that wrap the answer in the schema name (`{"civil_solution": {…}}`, which MiniMax does).

### Thinking effort is not portable

The five UI levels (`none`/`low`/`medium`/`high`/`max`) do **not** mean the same thing to every model, so they are mapped per route rather than passed through:

- OpenAI-style enums accept `none` and `xhigh` only on GPT-5.x. Other bots clamp: `max` → `high`, and `none` is omitted.
- Claude has no "off" enum value — thinking is disabled by omitting the parameter.
- Gemini takes an integer token budget (2048 / 8192 / 16384 / 32768). Pro-tier models reject a budget of `0`, so `none` falls back to the model default.
- Anthropic-protocol routes take `thinking.budget_tokens`, capped lower (max 24576) because `max_tokens` must exceed the budget and these gateways cap total output. Kimi thinks regardless of what is sent.

A level with no mapping sends **nothing** rather than a value the model would reject.

Because no vendor publishes a reliable per-model matrix, the Worker also **degrades itself**: if an upstream answers 400/422 complaining about a parameter, the request is retried one rung down a ladder — drop `reasoning`, then relax the strict JSON schema to plain JSON mode, then drop the schema entirely. Each downgrade is reported to the client as a `status` event. The parsing pipeline in `shared/solution.ts` is what makes the lower rungs safe.

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
| LLM access | Poe Responses API, Kimi Code + MiniMax (Anthropic protocol), Moonshot, Google Generative Language API |

### File structure

```
├── worker/
│   ├── index.ts            # Hono app: /api/health, /api/solve, /api/interpret
│   ├── channels.ts         # Routes, per-dialect request building + parsing
│   └── run.ts              # Heartbeats, timeout, retry/downgrade, SSE output
├── shared/                 # Pure logic shared by worker and client
│   ├── providers.ts        # Provider + channel registry, health payload types
│   ├── solution.ts         # Schema, parsing, repair pipeline, LaTeX helpers
│   ├── interpretation.ts   # Interpret/verify schema and parsing
│   ├── prompt.ts           # Solve + interpret/verify prompts, shape contract
│   └── stream-protocol.ts  # SSE event types + request limits
├── src/
│   ├── pages/civil-answer-app.tsx      # Page composition
│   ├── components/solve/
│   │   ├── upload-form.tsx             # Dropzone, notes, providers, effort
│   │   ├── interpretation-review.tsx   # Confirm the diagram reading
│   │   ├── solution-panel.tsx          # Tabs, streaming states, exports (lazy)
│   │   └── solution-article.tsx        # Markdown + KaTeX rendering
│   ├── hooks/
│   │   ├── use-solve.ts                # Per-provider SSE state machine
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
    "chatgpt": { "channel": "poe",      "model": "gpt-5.4",         "configured": true  },
    "claude":  { "channel": "poe",      "model": "claude-opus-4.8", "configured": true  },
    "gemini":  { "channel": "poe",      "model": "gemini-3.1-pro",  "configured": true  },
    "kimi":    { "channel": "kimi",     "model": "kimi-for-coding", "configured": true  },
    "minimax": { "channel": "minimax",  "model": "MiniMax-M3",      "configured": true  }
  }
}
```

The upload form uses this to disable providers whose key is missing.

### `POST /api/interpret/:provider`

Optional pre-pass that reads the question without solving it. Body: `{ mode: "interpret" | "verify", images, notes, interpretations? }`. Returns the same SSE shape with `done → { interpretation }`.

The browser drives it as: two providers run `interpret` in parallel, a third runs `verify` over both readings, and the result pauses for the user to edit before any solving starts. The confirmed text is then sent to `/api/solve` as `interpretation`, where the prompt marks it authoritative over the raw images.

Off by default — it costs three extra model calls and delays the first solution.

### `POST /api/solve/:provider` (`chatgpt` | `claude` | `gemini` | `kimi` | `minimax`)

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

Set the `NO_STREAM` var (e.g. `"kimi"`) to make those providers use a non-streamed upstream fetch, still delivered over the same SSE response with heartbeats. The client is agnostic.

## Configuration

### Secrets (one per upstream account)

| Variable | Needed for | Where to get it |
|---|---|---|
| `POE_API_KEY` | ChatGPT, Claude, Gemini (Poe channel) | <https://poe.com/api_key> |
| `KIMI_API_KEY` | Kimi | Kimi Code Console, <https://www.kimi.com/code> |
| `MOONSHOT_API_KEY` | Kimi, only when `KIMI_CHANNEL=moonshot` | <https://platform.moonshot.cn> (mainland) |
| `MINIMAX_API_KEY` | MiniMax | <https://platform.minimaxi.com> (mainland) |
| `GOOGLE_API_KEY` | Gemini, only when `GEMINI_CHANNEL=google` | <https://aistudio.google.com/apikey> |

- Local: copy `.dev.vars.example` to `.dev.vars` and fill in the keys you have. `.dev.vars` is gitignored.
- Production: `npx wrangler secret put POE_API_KEY` (repeat per key).

A provider whose key is blank is shown as unavailable in the UI rather than failing mid-solve. You only need the keys for the providers you intend to use.

> `.dev.vars` is read by the **Worker**, not by Vite. Never move these into `.env`, and never prefix them with `VITE_` — anything named `VITE_*` is inlined into the browser bundle.

### Vars (in `wrangler.jsonc`, non-secret)

| Variable | Default | Purpose |
|---|---|---|
| `CHATGPT_CHANNEL` | `poe` | Channel for ChatGPT |
| `CLAUDE_CHANNEL` | `poe` | Channel for Claude |
| `GEMINI_CHANNEL` | `poe` | `poe` or `google` |
| `KIMI_CHANNEL` | `kimi` | `kimi` or `moonshot` |
| `MINIMAX_CHANNEL` | `minimax` | Channel for MiniMax |
| `POE_CHATGPT_MODEL` | `gpt-5.4` | Poe bot handle |
| `POE_CLAUDE_MODEL` | `claude-opus-4.8` | Poe bot handle |
| `POE_GEMINI_MODEL` | `gemini-3.1-pro` | Poe bot handle |
| `GOOGLE_GEMINI_MODEL` | `gemini-3.1-pro` | Google model id |
| `KIMI_CODE_MODEL` | `kimi-for-coding` | Tier-dependent; also `k3`, `k3-256k` |
| `MOONSHOT_KIMI_MODEL` | `kimi-latest` | **Must be vision-capable** |
| `MINIMAX_MODEL` | `MiniMax-M3` | **Must be vision-capable**; `MiniMax-M3[1m]` for 1M context |
| `POE_BASE_URL` | `https://api.poe.com/v1/responses` | Endpoint override |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding` | Anthropic-protocol base |
| `MOONSHOT_BASE_URL` | `https://api.moonshot.cn/v1/chat/completions` | Mainland; global is `api.moonshot.ai` |
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com/anthropic` | Mainland; international is `api.minimax.io` |
| `GOOGLE_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Endpoint override |
| `NO_STREAM` | *(empty)* | Providers that skip upstream streaming |

The assignment is always sent as images, so **every model here must be vision-capable**. A text-only model does not necessarily fail: MiniMax-M2/M2.1 answer "I cannot view the image" and then invent a plausible solution, which is worse. Verify vision before changing a model id.

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

Free-tier fit: a solve is at most 5 requests (100k/day limit), static assets are unlimited, and the immediate SSE headers + heartbeats keep long solves alive.

**Piping the provider stream is I/O-wait, but the upload is not.** Each selected provider gets its own copy of the images, and each Worker invocation parses that JSON body and re-serializes it into the upstream request — two full passes over several megabytes, all of it counted as CPU. That is why the body cap is enforced early and why the browser blocks oversized batches before sending. If you raise `MAX_IMAGES` or `MAX_BODY_BYTES` in `shared/stream-protocol.ts`, measure CPU time per invocation before assuming it still fits.

Deduplicating the N uploads would need either server-side storage or a single fan-out request, and both are ruled out by design (see `AGENTS.md`) — so the lever available is payload size, not request count.

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
