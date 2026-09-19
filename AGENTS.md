# CivilSolve Agent Notes

CivilSolve is a civil engineering assignment solver hosted on a single Cloudflare Worker (free tier). Read `README.md` before editing.

## Core Invariants

- **Keep API keys server-side only.** Keys live in `.dev.vars` locally and in Wrangler secrets in production. Never expose one to frontend code, and never put one in a URL or query string (Google auth uses the `x-goog-api-key` header for exactly this reason).
- **Providers and channels are separate concepts.** A provider is a UI choice (`chatgpt`, `claude`, `gemini`, `kimi`, `minimax`, `deepseek`, `grok`, `qwen`); a channel is the upstream account (`poe`, `opencode`, `kimi`, `moonshot`, `minimax`, `google`). Routing lives in `ROUTES` in `worker/channels.ts` — add channels there, not by branching in `worker/run.ts`.
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
- Every model **must be vision-capable** — the assignment is sent as images, never as OCR text. Verify with an image before changing any model id; text-only models often answer anyway.

## Failure handling

`worker/run.ts` distinguishes three failure modes; keep them distinct:

1. **Parameter rejection** (400/422 naming `reasoning`, a schema field, or a generic parameter error) → step down the capability ladder: drop `reasoning`, then relax strict JSON schema to plain JSON mode, then drop the schema. Reported to the client as a `status` event. No sleep, does not consume the retry budget.
2. **Transient failure** (408/409/429/5xx, or a failure that never reached a response) → one retry after 3s.
3. **Thinking exhaustion** (the model spent its whole output allowance on reasoning and wrote no answer) → retry once, one effort level down. Repeating the request unchanged would repeat the outcome, so this sheds thinking instead. The step-down deliberately goes below the route's `minEffort`: the floor chooses where a solve *starts*, not what it must fail at. Detected by `isThinkingExhausted` on all three streaming dialects — anthropic `stop_reason: "max_tokens"`, responses `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"`, chat-completions `finish_reason: "length"` — always with the guard that no usable content arrived, so a truncated answer is still delivered rather than retried. Capped at one because the wasted attempt runs to its full budget (~120 s) and a second would risk the 280 s safety timeout. A level with nothing below it (`none` on a clamped route) reports the clear message and stops.
4. **Dropped connection** (the stream ends with no terminal frame — no `[DONE]`, no `finish_reason`, no `response.completed`, no `message_stop` — and nothing accumulated) → same as a transient: one retry after 3s **at the same effort**. Tracked by `isTerminalFrame` per dialect. Measured on OpenCode Go: kimi-k2.7-code streamed 20,725 characters of reasoning over 128 s and the connection closed mid-word. This is deliberately *not* the effort step-down: nothing says the effort was the problem, and for Kimi a step-down lands on the `low` that misreads diagrams. Before this was distinguished, it surfaced as the same "returned an empty response" as exhaustion did.
5. **Everything else** (401, 404, in-body errors like MiniMax's `base_resp.status_code`) → fail immediately. Retrying an auth error only delays the message the user needs.

Never retry after a `delta` has reached the client, and never retry the safety-timeout abort.

## History

The repo previously carried a second, unused backend from the original Bun/Zo deployment (`server.ts`, `backend-lib/`, root `index.tsx`, `zosite.json`). It was outside both tsconfig `include` globs, so `npm run check` never covered it. It has been removed — recover it from git history if you need to consult the old provider logic. Everything that ships now lives in `worker/`, `shared/`, and `src/`, and all three are typechecked.

- **The interpretation pass is opt-in.** `/api/interpret` costs three extra model calls before the first solution appears, so it stays off unless the user ticks it. Do not make it the default.
- **`worker/run.ts` is task-agnostic.** Solve and interpret differ only in prompt, schema, and `finalize`. Add new model-calling features as another `Task`, not another orchestrator.

## CPU on the Workers free plan

Measured with `wrangler tail` (`cpuTime` per request), September 2026. Re-measure before drawing new conclusions; do not reason from Node timings, which are 40-100x lower than workerd's for the same stream.

- **Cost is per upstream chunk read, in the runtime, not in our JS.** A thinking model on OpenCode Go sends one HTTP chunk per token; workerd hands them over at ~57 bytes per `read()` and charges roughly 70 us each. One 47 s Kimi solve is ~7,400 reads. That is why CPU tracks streaming *duration* (~8-30 ms per second) and why cutting client writes 26x (1113 -> 43) and skipping JSON.parse on reasoning frames left CPU unchanged (410-1378 ms before, 531 ms after, same fixture).
- **Reads cannot be coalesced from JS.** A BYOB reader with a 64 KB buffer plus a 100 ms pause before each read still averaged 57 B/read; workerd does not queue between reads. That experiment was measured and discarded - do not repeat it.
- **Non-streamed upstream is not an escape.** Both api.kimi.com and opencode.ai close a request that produces no bytes for ~100-120 s, which a thinking model exceeds. `NO_STREAM` only suits fast models.
- **Where the CPU goes, per provider, one easy solve:** Poe routes 22-48 ms (Poe buffers upstream, few chunks); OpenCode Go routes 330-500 ms (per-token). A default five-provider solve is ~900 ms total.
- **The free plan's limit behaves like a refilling budget, not a fixed 10 ms.** Rested single requests of 1378 ms passed; a 192 ms request right after several heavy ones was killed (`outcome=exceededCpu`). A kill is hard: no `error` event is written, the client sees the stream end and shows "ended unexpectedly, please try again". Rapid-fire testing drains the budget far faster than real use does - space test runs out by minutes.
- **What this means for users:** one solve at a time, minutes apart, works (5/5 providers after a rest). Back-to-back solves, the interpretation pass (three extra calls) plus five providers, or several users at once will get some tabs killed. Workers Paid removes the limit; the owner has declined it. The remaining levers are all product choices: fewer default providers, lower thinking on the OpenCode routes, or accepting retries.

## Provider gotchas found by testing

- **OpenCode Go needs `x-opencode-session` on every request.** Without it the gateway returns `MissingSessionID` even though `GET /models` works, so a valid key can look broken. The Worker sends a UUID per solve.
- **OpenCode Go fixes the protocol per model** — Responses for GPT Luna and Grok, chat completions for Kimi/DeepSeek/Qwen, Anthropic messages for MiniMax/Qwen per the docs. Images, though, are only accepted by Qwen on chat completions, and only by 3.8: `qwen3.7-max` rejects image parts on both protocols.
- **`kimi-k2.7-code` misreads diagrams at effort `low`.** On an overhanging beam with a 4 m partial UDL it read the UDL as 6 m and returned 13.75/36.25 kN instead of 10/30 (127 s). At `medium` it reads the same image correctly (55 s); at `high` too (185 s). It is the default over `kimi-k3` on cost, so its route carries `minEffort: "medium"` — remove that floor and the cheap setting gives confidently wrong reactions again. `kimi-k3` got it right at `low` in 28 s.
- **`longcat-2.0`, `hy3`, `hy4-preview` cannot see images** (LongCat replies "NO IMAGE"; Hy rejects image parts). `deepseek-v4-pro` and `muse-spark-*` need a workspace opt-in before the key can call them.
- **`gpt-5.6-luna` accepts `reasoning.effort: "xhigh"`.** The ChatGPT route floors at `high` (`minEffort`), so the user chooses between `high` and `max`; on the hard fixture `max` was the fastest of the set at 13.7 s, so top thinking does not cost latency there.

- **Kimi Code is unreachable from deployed Workers.** `api.kimi.com` is itself behind Cloudflare and answers requests originating from Workers' egress with a 403 challenge page ("Attention Required! | Cloudflare"). Measured from Cloudflare's edge, every variation returns the same 403: our headers, a browser User-Agent, no User-Agent, and a bare `GET https://api.kimi.com/` with no credential at all. The same code and key succeed from a laptop, so this is the egress network, not the request. Headers cannot fix it. The workarounds are `KIMI_BASE_URL` pointed at a non-Cloudflare proxy, or `KIMI_CHANNEL=moonshot` with a Moonshot platform key. Kimi still works in local dev.

These were all discovered by running real requests, not from vendor docs. Re-verify before changing a model id or a route flag.

- **Every model must be vision-capable.** The assignment is only ever sent as images. A text-only model does not necessarily fail — MiniMax M2/M2.1 reply "I cannot view the image" and then invent a plausible solution, which is far worse than an error.
- **Poe bot handles drift.** `GPT-5.6-Terra` and `Claude-Opus-5` do not exist; list what a key can see with `GET https://api.poe.com/v1/models`.
- **Claude on Poe rejects the reasoning parameter**, and the downgrade ladder catches it. Do not "fix" this by removing the parameter for everyone — GPT-5.x accepts it.
- **Kimi Code cannot be given forced tools** (thinking is always on), so its route sets `structured: false` and the prompt carries the shape contract. Its non-streamed path also gets cut by the gateway while the model thinks — keep that route streaming.
- **MiniMax honours a forced tool call only while thinking is on**, and wraps schema results in the schema name (`{"civil_solution": {...}}`). Its route therefore floors at `minEffort: "high"` — `ANTHROPIC_BUDGET` has no `none` entry, so that pick would send no `thinking` block and silently drop the route to prose. Remove the floor and effort `none` costs the structured output, not just accuracy.

- **M3 at `high` sometimes thinks until it runs out of tokens and never answers.** Measured on the B.8 momentum fixture (the one whose right answer is Fx = -142.9 N, Fy = -177.5 N), seven runs through the Worker: at `high` two exhausted at ~120 s and one answered correctly in 67 s; at `medium` two answered correctly (56 s, 81 s) and one exhausted. It is variance, not a threshold — do not "fix" it by picking a level, and do not conclude a level is safe from one run. Two things were tried and rejected:
  - **Raising `max_tokens` does not prevent it.** At 40960 it still exhausted. At 90112 it did finish — and returned a *confidently wrong* answer (Fx = -38.0 N, Fy = +135.7 N). More room buys more thinking, and more thinking drifted to a wrong reading of the diagram. `ANTHROPIC_OVERSHOOT_FACTOR` stays at 2 for headroom against truncation, not as a cure for this.
  - **Lowering the floor to `medium`** was tried and reverted: `medium` exhausts too, so it trades the failure mode for a weaker default rather than removing it.

  What is actually deployed is the one-step effort ladder above, which turns the failure into a second attempt instead of an error.

- **"Returned an empty response" was hiding two different failures, and Kimi's is not exhaustion.** Re-running the empty cells after the exhaustion detector was extended: ChatGPT@max and Grok@high simply succeeded (intermittent), but Kimi@medium came back with the *old* message — its stream carried no terminal frame at all. A direct dump showed the connection closing mid-word after 128 s of reasoning, `finish_reason: null`, no `[DONE]`. That is failure mode 4 above (dropped connection, same-effort retry), not mode 3. Qwen@medium in the same re-run produced a `done` whose `finalAnswer` was a raw `"latex_body": …` fragment — partial content had streamed before the cut, so it was delivered as a truncated answer and the repair pipeline in `shared/solution.ts` made a poor job of it. That is a parser-quality gap, not yet addressed.

- **The OpenCode Go routes have the same exhaustion failure, and it was invisible until September 2026.** The worker sends no output-token cap on the `responses` or `chat-completions` dialects, so the gateway's own default is the ceiling. A gpt-5.6-luna run that *succeeded* used 16,343 output tokens (11,912 reasoning) — 41 short of 16,384 — so any run that thinks slightly harder is cut mid-reasoning with no message item. Forcing a small cap reproduces it exactly: `response.incomplete`, `incomplete_details.reason: "max_output_tokens"`, every output token spent on reasoning, zero answer. Before `isThinkingExhausted` covered these dialects, `extractCompleted` only matched `response.completed` and `extractPayloadError` only matched `response.failed`, so this surfaced as the useless "returned an empty response" — 6 of 18 cells in the B.8 matrix below. Do not "fix" it by sending a large explicit cap without measuring: for OpenAI-style models the effort level, not the cap, governs how much they think, so a generous cap may well help there — but that is untested, and on MiniMax the same idea produced a wrong answer.

- **B.8 matrix, every non-Poe provider × every distinct effort, September 2026** (correct: Fx = -142.9 N, Fy = -177.5 N; times through the local worker): ChatGPT high ✓ 59 s, max empty; Kimi medium empty, high 280 s timeout; MiniMax high ✓ 111 s, max 280 s timeout; DeepSeek none ✓, low ✗ (Fy = -460, pressure term double-counted), medium ✓, high ✗ (-460); Grok none empty, low ✓ 29 s, medium ✓, high empty; Qwen none empty, low ✗ (-38/+4), medium empty, high ✗ (-38/+4). 6/18 correct. Two lessons: **the top effort of every provider failed**, and the current default (ChatGPT at high) is the most reliable cell. The `-38 N / +4 N` answer is a reading error, not arithmetic — it assumes the second jet is also 10 m/s instead of deriving 19.4 m/s from continuity — and Qwen produced it at both efforts; MiniMax produced a variant of it when given a huge `max_tokens`. Re-measure before drawing conclusions from any single cell; the empties are intermittent.
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
