# CivilSolve Agent Notes

CivilSolve is a civil engineering assignment solver hosted on a single Cloudflare Worker (free tier). Read `README.md` before editing.

## Core Invariants

- **Keep API keys server-side only.** Keys live in `.dev.vars` locally and in Wrangler secrets in production. Never expose one to frontend code, and never put one in a URL or query string (Google auth uses the `x-goog-api-key` header for exactly this reason).
- **Providers and channels are separate concepts.** A provider is a UI choice (`chatgpt`, `claude`, `gemini`, `deepseek`, `grok`); a channel is the upstream account (`poe`, `opencode`, `google`). Routing lives in `ROUTES` in `worker/channels.ts` — add channels there, not by branching in `worker/run.ts`.
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
- Every model **must be vision-capable** — the assignment is sent as images, never as OCR text. Verify with an image before changing any model id; text-only models often answer anyway, and some say "I cannot view the image" and then invent a plausible solution, which is far worse than an error.

## Failure handling

`worker/run.ts` distinguishes five failure modes; keep them distinct:

1. **Parameter rejection** (400/422 naming `reasoning`, a schema field, or a generic parameter error) → step down the capability ladder: drop `reasoning`, then relax strict JSON schema to plain JSON mode, then drop the schema. Reported to the client as a `status` event. No sleep, does not consume the retry budget.
2. **Transient failure** (408/409/429/5xx, or a failure that never reached a response) → one retry after 3s.
3. **Thinking exhaustion** (the model spent its whole output allowance on reasoning and wrote no answer) → retry once, one effort level down. Repeating the request unchanged would repeat the outcome, so this sheds thinking instead. The step-down deliberately goes below the route's `minEffort`: the floor chooses where a solve *starts*, not what it must fail at. Detected by `isThinkingExhausted` — responses `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"`, chat-completions `finish_reason: "length"` — always with the guard that no usable content arrived, so a truncated answer is still delivered rather than retried. Capped at one because the wasted attempt runs to its full budget (~120 s measured) and a second would risk the 280 s safety timeout. A level with nothing below it (`none` on a clamped route) reports the clear message and stops.
4. **Dropped connection** (the stream ends with no terminal frame — no `[DONE]`, no `finish_reason`, no `response.completed` — and nothing accumulated) → same as a transient: one retry after 3s **at the same effort**. Tracked by `isTerminalFrame` per dialect. Measured on OpenCode Go: 20,725 characters of reasoning streamed over 128 s, then the connection closed mid-word. This is deliberately *not* the effort step-down: nothing says the effort was the problem. Before this was distinguished, it surfaced as the same "returned an empty response" as exhaustion did.
5. **Everything else** (401, 404, an `error` object inside an HTTP 200 body) → fail immediately. Retrying an auth error only delays the message the user needs.

Never retry after a `delta` has reached the client, and never retry the safety-timeout abort.

A stream request does not guarantee a stream back: a gateway may answer an invalid request with HTTP 200 and a plain JSON body, or ignore `stream: true`. `fetchStreamed` in `worker/run.ts` checks the content type and parses a non-stream body as a payload; do not assume `response.ok` plus an event-stream content type.

**When a stream drops after partial content**, what arrived is a valid prefix of the solution JSON. `recoverTruncatedJson` in `shared/solution.ts` closes the open string and the object, keeps every complete field, marks the cut one, drops a cut `latex_body` so the fallback rebuilds it, and says so when the cut landed before `final_answer`. The prose synthesizer refuses text that is plainly a schema attempt, so an unsalvageable blob reports invalid JSON instead of a "solution" whose final answer is a stray `"latex_body": …` fragment — which is what one Qwen run produced before this existed. Verified through the real `/api/solve` path against seven cut points (inside the LaTeX, inside `step_by_step`, inside `final_answer`, inside a key name, after a dangling key, inside a `\u` escape, between tokens).

## History

- **Kimi, MiniMax and Qwen were removed in September 2026**, along with the Kimi Code / Moonshot / MiniMax channels and the Anthropic-protocol dialect that only they used. The evidence is the B.8 matrix below: across two full runs (36 cells) Kimi was 0/4, Qwen 0/8 and MiniMax 1/4. Everything learned about them — Kimi Code rejecting forced tools while thinking, `api.kimi.com` returning a 403 challenge page to Workers' egress, MiniMax honouring a forced tool only while thinking is on and wrapping results in the schema name, `kimi-k2.7-code` misreading a 4 m UDL as 6 m at effort `low`, MiniMax M3 thinking itself out of `max_tokens` at a 16384 budget and returning a confidently wrong answer when given 90112 — is in git history (the `ROUTES` entries, `ANTHROPIC_BUDGET`, `toAnthropicImage`, the `base_resp` check, and the corresponding notes here, all before commit `df91701`). Two mechanisms they motivated stay because they are general: the `structured: false` route flag with the prompt-carried shape contract, and the effort step-down in failure mode 3.
- The repo previously carried a second, unused backend from the original Bun/Zo deployment (`server.ts`, `backend-lib/`, root `index.tsx`, `zosite.json`). It was outside both tsconfig `include` globs, so `npm run check` never covered it. It has been removed — recover it from git history if you need to consult the old provider logic. Everything that ships now lives in `worker/`, `shared/`, and `src/`, and all three are typechecked.

- **The interpretation pass is opt-in.** `/api/interpret` costs three extra model calls before the first solution appears, so it stays off unless the user ticks it. Do not make it the default.
- **`worker/run.ts` is task-agnostic.** Solve and interpret differ only in prompt, schema, and `finalize`. Add new model-calling features as another `Task`, not another orchestrator.

## CPU on the Workers free plan

Measured with `wrangler tail` (`cpuTime` per request), September 2026. Re-measure before drawing new conclusions; do not reason from Node timings, which are 40-100x lower than workerd's for the same stream.

- **Cost is per upstream chunk read, in the runtime, not in our JS.** A thinking model on OpenCode Go sends one HTTP chunk per token; workerd hands them over at ~57 bytes per `read()` and charges roughly 70 us each. One 47 s solve on a per-token route is ~7,400 reads. That is why CPU tracks streaming *duration* (~8-30 ms per second) and why cutting client writes 26x (1113 -> 43) and skipping JSON.parse on reasoning frames left CPU unchanged (410-1378 ms before, 531 ms after, same fixture).
- **Reads cannot be coalesced from JS.** A BYOB reader with a 64 KB buffer plus a 100 ms pause before each read still averaged 57 B/read; workerd does not queue between reads. That experiment was measured and discarded - do not repeat it.
- **Non-streamed upstream is not an escape.** opencode.ai closes a request that produces no bytes for ~100-120 s, which a thinking model exceeds. `NO_STREAM` only suits fast models.
- **Where the CPU goes, per provider, one easy solve:** Poe routes 22-48 ms (Poe buffers upstream, few chunks); OpenCode Go routes 330-500 ms (per-token). The chunk count is set by the sender: a direct measurement of the same fixture showed OpenCode Go's median chunk at 54 B against Poe's 177 B, with roughly 25x more chunks.
- **The free plan's limit behaves like a refilling budget, not a fixed 10 ms.** Rested single requests of 1378 ms passed; a 192 ms request right after several heavy ones was killed (`outcome=exceededCpu`). A kill is hard: no `error` event is written, the client sees the stream end and shows "ended unexpectedly, please try again". Rapid-fire testing drains the budget far faster than real use does - space test runs out by minutes.
- **What this means for users:** one solve at a time, minutes apart, works. Back-to-back solves, the interpretation pass (three extra calls) on top of a solve, or several users at once will get some tabs killed. Workers Paid ($5/month, 30 s CPU per invocation by default) removes exactly this class of failure and nothing else: every failure in the B.8 matrix below happened on a local worker with no CPU limit at all. The owner has declined it. The remaining levers are all product choices: lower thinking on the OpenCode routes, or accepting retries.

## Provider gotchas found by testing

- **OpenCode Go needs `x-opencode-session` on every request.** Without it the gateway returns `MissingSessionID` even though `GET /models` works, so a valid key can look broken. The Worker sends a UUID per solve.
- **OpenCode Go fixes the protocol per model** — Responses for GPT Luna and Grok, chat completions for DeepSeek. Which models accept images is not documented reliably; `deepseek-v4-flash-vision-exp` is the one DeepSeek model it documents as vision.
- **`longcat-2.0`, `hy3`, `hy4-preview` cannot see images** (LongCat replies "NO IMAGE"; Hy rejects image parts). `deepseek-v4-pro` and `muse-spark-*` need a workspace opt-in before the key can call them.
- **`gpt-5.6-luna` accepts `reasoning.effort: "xhigh"`.** The ChatGPT route floors at `high` (`minEffort`), so the user chooses between `high` and `max`; on the hard fixture `max` was the fastest of the set at 13.7 s, so top thinking does not cost latency there.
- **Poe bot handles drift.** `GPT-5.6-Terra` and `Claude-Opus-5` do not exist; list what a key can see with `GET https://api.poe.com/v1/models`. Newer Gemini handles there (`gemini-3.8-flash`) answer "Model does not support responses method" — the Poe route uses the Responses API, so only bots mapped to it work.
- **Claude on Poe rejects the reasoning parameter**, and the downgrade ladder catches it. Do not "fix" this by removing the parameter for everyone — GPT-5.x accepts it.
- **DeepSeek rejects the strict JSON schema** on every run and the ladder relaxes it; this costs nothing and is expected. At `high` it has twice double-counted the pressure term on the B.8 fixture (Fy = -460 N for -177.5 N); at `none` and `medium` it was right every time.
- **The OpenCode Go routes can think themselves out of tokens, and it was invisible until September 2026.** The worker sends no output-token cap on the `responses` or `chat-completions` dialects, so the gateway's own default is the ceiling. A gpt-5.6-luna run that *succeeded* used 16,343 output tokens (11,912 reasoning) — 41 short of 16,384 — so any run that thinks slightly harder is cut mid-reasoning with no message item. Forcing a small cap reproduces it exactly: `response.incomplete`, `incomplete_details.reason: "max_output_tokens"`, every output token spent on reasoning, zero answer. Before `isThinkingExhausted` covered these dialects, `extractCompleted` only matched `response.completed` and `extractPayloadError` only matched `response.failed`, so this surfaced as the useless "returned an empty response" — 6 of 18 cells in the first B.8 matrix. Do not "fix" it by sending a large explicit cap without measuring: on the since-removed MiniMax route the same idea produced a confidently wrong answer.
- **"Returned an empty response" was hiding two different failures.** Re-running the empty cells after the exhaustion detector was extended, one provider still came back with the *old* message — its stream carried no terminal frame at all. A direct dump showed the connection closing mid-word after 128 s of reasoning, `finish_reason: null`, no `[DONE]`. That is failure mode 4 (dropped connection, same-effort retry), not mode 3. Do not assume an empty stream means the model ran out of tokens.
- **B.8 matrix, every non-Poe provider × every distinct effort, two runs in September 2026** (correct: Fx = -142.9 N, Fy = -177.5 N; through the local worker, i.e. with no CPU limit). Before the fixes: ChatGPT high ✓ 59 s, max empty; DeepSeek none ✓, low ✗ (-460), medium ✓, high ✗ (-460); Grok none empty, low ✓ 29 s, medium ✓, high empty; Kimi 0/2, MiniMax 1/2, Qwen 0/4. After the fixes: ChatGPT high ✓, max ✓; DeepSeek none ✓, low ✓, medium ✓, high ✗ (-460); Grok none ✓, low ✗ (-38/+4), medium ✓, high 280 s timeout; Kimi 0/2, MiniMax 0/2, Qwen 0/4. Three lessons: **the top effort of every provider is the least reliable**; the default (ChatGPT at `high`) is the most reliable cell, 2/2; and run-to-run variance dominates — Grok@low was right in one run and wrong in the next, so never conclude a level is safe from one cell. The `-38 N / +4 N` answer is a reading error, not arithmetic — it assumes the second jet is also 10 m/s instead of deriving 19.4 m/s from continuity — and four different models produced it; the interpretation pass exists for exactly this.

These were all discovered by running real requests, not from vendor docs. Re-verify before changing a model id or a route flag.

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
