# CivilSolve

CivilSolve solves civil engineering assignments. Users upload question images or PDFs, optionally add instructions, choose a thinking-effort level and one or more AI providers, and receive a worked solution per provider. Eight providers solve (a ninth, Gemini, only reads and judges); the selected ones **solve at the same time**:

| Provider | Default channel | Default model | Default choice |
|---|---|---|---|
| ChatGPT | OpenCode Go | `gpt-5.6-luna`, high or max thinking, 20-minute timeout | default judge for both optional passes |
| DeepSeek | OpenCode Go | `deepseek-v4.1-flash` | **selected**; badged **Less credit** |
| Muse Spark | OpenCode Go | `muse-spark-1.3-contributor` | **selected**; badged **Less credit**; needs a workspace opt-in |
| Kimi | OpenCode Go | `kimi-k2.7-code`, medium thinking or above, 20-minute timeout | offered (a default solver for one day, 26 September 2026); badged **China model** |
| MiMo | OpenCode Go | `mimo-v2.6-flash` | badged **China model** |
| MiniMax | MiniMax, then OpenCode Go (a channel chain) | `MiniMax-M3`, 20-minute timeout | badged **China model** |
| Grok | OpenCode Go | `grok-4.6` | badged **More credit** |
| Claude | Poe | `claude-opus-4.8` | last solver; badged **More credit** |
| Gemini | Google Vertex AI (switchable to Poe) | **Flash** (default): `gemini-3.8-flash`, falling back to `gemini-3.5-flash`; **Pro**: `gemini-3.1-pro-preview` - picked on the card; 20-minute timeout | solver, reader and judge; billed to the owner's Google Cloud credit |

The rows are in picker order (`PROVIDER_KEYS`), the owner's since 26 September 2026 (Muse Spark before DeepSeek since 2 October 2026): ChatGPT, Muse Spark, DeepSeek, Kimi, MiMo, MiniMax, Gemini, Grok, Claude - nine solver cards, laid out three by three on every screen. The same order sets the reader and judge lists and the letters the judge sees, and the solution tabs - except that Muse Spark's tab always comes first (the owner's call, 30 September 2026), and is the one open while it runs. Muse Spark, DeepSeek and Gemini (3.8 Flash) are ticked when the page opens (`DEFAULT_SOLVERS`; Gemini since 1 October 2026, at the owner's request - each of its two Google projects has a spend cap on Vertex AI, set in the Cloud console below its monthly Google AI Pro credit, so a run pauses Gemini rather than billing past the credit, and the app moves to the other key when one is paused).

**A provider can offer several models under one card** (`PROVIDER_VARIANTS` in `shared/providers.ts`). Gemini does: its card has a **Flash | Pro** switch (Flash by default), and the reader, reconciler, judge and add-a-solver lists carry one entry per model - "Gemini (3.8 Flash)", "Gemini (3.1 Pro)". The pick travels as `variant` in the request body (`"flash"` or `"pro"`; a provider with one model answers `400` to any), the worker turns it into a route override (`variantOverride` in `worker/channels.ts`: Pro runs `GOOGLE_GEMINI_PRO_MODEL`), the run record keeps it for retries and reloads, and tabs and the verdict name the model that answered. On B.8 at `high` over Vertex AI, Pro was right twice (136 s, 189 s) and Flash once (160 s).

Each card shows three things — brand, the account it runs on, and the model id — plus a cost badge where it matters. Gemini runs on **Google Vertex AI** since 26 September 2026, on the owner's Google Cloud project and its prepaid credit - billed per call, unlike the free AI Studio key it replaced, which answered 503 "high demand" more often than not and left Gemini reader-and-judge-only for part of that day. It carries no badge (the "Free but unstable" one went with the free key). Grok and Claude are badged "More credit" (`HIGHER_CREDIT_PROVIDERS` in `shared/providers.ts`): Claude runs as Opus on Poe, the priciest bot there by a wide margin, and Grok is the heaviest draw on the OpenCode Go plan, so Claude sits at the end. DeepSeek and Muse Spark are badged "Less credit" (`LOWER_CREDIT_PROVIDERS`): DeepSeek Flash is the lightest draw on that plan, and Muse Spark is one of OpenCode Zen's free tiers — free because it collects what is sent to it, assignment images included, for training, and its "contributor" tier will not answer at all until the OpenCode workspace has opted in to that. MiMo is the other free tier and carries no cost badge. Kimi, MiMo and MiniMax are badged "China model" (`CHINA_PROVIDERS`; Kimi since 26 September 2026) as a provenance label, not a quality or cost one. Effort floors and model chains are not on the card: the floor is shown under Thinking Effort, and a chain announces itself in the status line only when it actually switches. Every one of these reads images; that is a hard requirement and was verified per model, not taken from a spec sheet. Kimi, MiniMax and Qwen were offered until September 2026 and removed after two full runs of a past-paper momentum fixture: Kimi 0/4, Qwen 0/8, MiniMax 1/4 correct (see `AGENTS.md`). Their routes and the Anthropic-protocol dialect they used are in git history. MiniMax came back as a solver on a new route (22 September 2026). Kimi came back on 25 September 2026 as a reader and judge only, and on 26 September as a solver too, on the card Gemini gave up; it is offered but not ticked by default. The picker is multi-select; every ticked provider solves at once and gets its own tab (DeepSeek and Muse Spark by default - Kimi was a third for one day, 26 September 2026; the picker was single-choice on the free Workers plan, where concurrent per-token streams got killed). One thinking level serves them all, `high` by default, and the highest floor among the ticked providers rules (tick ChatGPT and everything below `high` is disabled). Two optional passes sit on top, both off by default: the interpretation pass fires two readers at once (Muse Spark and Gemini Flash by default, since 3 October 2026; MiMo was the first from 27 September) then a reconciler (ChatGPT) - with it ticked, the button reads **Interpret Questions** instead of Solve Problems, since nothing is solved until the reading is confirmed — three calls, in two rounds, before the first solve; the answer cross-check sends every finished solution to a judge (ChatGPT) that grades them against the images (see `POST /api/judge`). Under the verdict, two optional **study notes** can be made from the solutions (see `POST /api/study`).

Each result includes an interpreted problem statement, assumptions, a step-by-step solution, and a final answer, with in-browser KaTeX math rendering. Solutions are saved as PDF (browser print); the `.tex` download and "Open in Overleaf" were removed on 25 September 2026. Models still write a `latex_body`, which the repair pipeline uses to rebuild a solution whose other fields came back malformed.

## Architecture

A single **Cloudflare Worker** (on Workers Paid since 22 September 2026) serves everything:

- **Static assets** — the Vite-built React SPA, served by Workers Static Assets with SPA fallback.
- **API** — a [Hono](https://hono.dev) app (`worker/index.ts`) handles `/api/*` via `run_worker_first`.
- **Jobs** — one `TaskJob` Durable Object per task (`worker/jobs.ts`), so a task outlives the page that started it (below).

The solve flow is **streaming over Server-Sent Events**, with each task running in a short-lived **job**:

1. The browser converts uploads to JPEG data URLs client-side (`src/lib/attachments.ts`): images are downscaled on a canvas (max 2048px), PDFs are rasterized page-by-page with pdf.js - every page, or the pages the user chose (see "Upload support").
2. It fires one `POST /api/solve/:provider` request per ticked provider, all at once.
3. The Worker validates the request, then hands it to a **`TaskJob` Durable Object** of its own (`worker/jobs.ts`). The job resolves the provider's **channel**, calls that channel's API with **native vision input** (no OCR) and a strict JSON schema (plus the field list in the prompt on routes that do not hold a schema reliably - see below), and streams progress back; the stream's first event names the job.
4. The provider's tab renders progressively — spinner, then live progress, then the finished solution.

**Leaving the page does not lose the answer.** On a phone, putting the browser in the background makes iOS cut the stream. The job keeps running regardless (a Durable Object outlives its client; a plain Worker request would be cancelled ~30 s after it), stores its final answer, and the page **re-attaches** to it when it is visible again (`GET /api/jobs/:id`, via `withResume` in `src/lib/sse.ts`) - no second model call. A short outage while the page stays open - a phone switching between Wi-Fi and mobile data, a weak signal - is ridden out the same way: the page keeps reconnecting, backing off to one try every 15 s, and gives up only after 2 minutes in which no reconnection got through, telling you to reload to pick the answer up. If the tab was reloaded or discarded, the page recovers the last run from localStorage on load. **Stop** cancels jobs on the server (`DELETE /api/jobs/:id`); closing the tab does not, so a run started and abandoned still finishes and waits for you. Every task has a Stop of its own, beside its clock (since 26 September 2026): each solver's progress box stops that solver and leaves the others running (its tab turns grey, "Stopped - no solution", with **Run it again**); the cross-check's stops the judge and keeps the solutions; the interpretation pass's stops the pass, and each reader's line has one that stops that reader - the other's reading then goes to review alone, flagged as not cross-checked. **Stop all**, under the Solve button, stops everything at once. A Stop pressed before the server has named the job (the upload still on its way) is shown at once and sent the moment the job's first event names it, so the model call is cancelled rather than left running. While work is running the page also holds a screen wake lock, so a phone left on the desk does not lock itself mid-solve. A connection the phone drops without telling the page - no error, no close, the read just waits - is caught too: the server sends a heartbeat every 15 s, and 45 s without a byte (`STREAM_IDLE_MS`) counts as a lost connection and re-attaches.

**Every tab shows its progress while it runs:** the latest status, a running clock (time since the request reached the server - the timeout itself is not shown, by the owner's choice), and every earlier status with the time it came - each retry, model switch, timeout of a model in a chain and reconnect - so a long wait is never one unchanging line. A finished tab says how long it took ("answered in 2 min 15 s"). A task that ran out of time gets an **orange** dot and an orange "Timed out - no solution returned" box, apart from the red of a real failure; the cross-check card and the interpretation step show the same clock. Opening a failed or timed-out tab keeps it open: the page only picks a tab for you until you pick one yourself.

**After a run, without uploading again:** a failed, timed-out or cancelled tab has a **Retry** button, a card under the solutions offers **Add a solver** (any configured provider not yet in the run), and the **Cross-check** section below it (its own section since 3 October 2026, the owner's call - the two shared one panel before) offers **Run the cross-check** (again) over the finished solutions you tick, with its verdict under the controls, with the judge you pick and how hard it thinks (**High** by default; levels the judge's route does not offer - ChatGPT runs at high or max - are greyed out, and the verdict card says which level it ran at). All three reuse the run's images, notes, thinking level and confirmed reading. A verdict given before a solver was added or retried says which solutions it did not grade. The cross-check waits for every solver still running.

**Finding your way: the step bar** (since 3 October 2026, the owner's request - in Careful nothing said the solutions had appeared below the interpreted question). A stepper kept at the top of the screen - a dot per step with its name under it, joined by one track that fills in the theme's accent as the run moves on (since the same evening; short dashes between the steps looked unprofessional to the owner) - shows the run's four steps - **Upload · 上載**, **Check reading · 核對題目**, **Answers · 答案**, **Cross-check · 核對答案** - each with where it stands ("Reading", "Your turn", "2/3 ready", "Verdict ready"; the cross-check says "Optional" until it is tapped, "Automatic" when Custom runs it by itself; a step the run leaves out, such as Quick's reading check, is greyed as Skipped), and tapping a step scrolls to it (`src/lib/journey.ts` works the states out of the page's own state; `components/solve/journey-bar.tsx` draws them). The page moves the student along: once a run starts the form folds into one line - the question's pages, **Edit · 修改** (the form back, as it was) and **New question · 新題目** (the run cleared - it stays in the history - and the form emptied of the question, its settings kept) - so what comes next is on screen; it scrolls to the reading when it is ready for review, and to the answers on Solve and on Confirm & Solve. The confirmed reading stays open above the answers while the solvers work, and folds once the first solution is in; the question's pages sit folded beside it. When the step to look at now is out of sight, a button at the bottom jumps to it ("↓ Answers · 2/3 ready", "↓ Cross-check · Verdict ready"), until the student has seen it. On a phone the review's Cancel and Confirm & Solve stay at the bottom of the screen while the reading is read.

**Reading the answers** (since 3 October 2026). Above the solution tabs, the **answer summary** (`answer-summary.tsx`) puts every solver's final answer side by side, with **核對答案 · Run the cross-check** on a line of its own under them (the default judge at high, over the first four finished solutions) until there is a verdict. Before the verdict it makes no comparison of its own (the owner, 4 October 2026: agreement is not proof - on B.8 four models gave the same wrong answer). Once every solver has answered, the answers are compared with each other at once - without waiting for the cross-check and without starting it (since 9 October 2026, the owner's call): the summary says "Comparing the answers... · 比較緊答案", then how far they line up - "The answers: 2 of 3 agree", with a chip per solver (一致 Agree, 部分一致 Partly, 唔同 Differs) and, under an answer that does not line up, a few words on what differs. A model does the comparing (`POST /api/align/:provider`, `hooks/use-align.ts`, `shared/align.ts`): DeepSeek Flash (`DEFAULT_ALIGNER`, on the OpenCode Go subscription) at `low`, sent only the final answers as text and the question in words - no images - so it takes seconds; one model call per comparison. `aligned` when every result matches the others' in value (within rounding), unit and direction - a direction written as a sign by one solver and in words by another being the same direction, the same size pointing the other way not - and results only one solution gives not counting against it; `partial` when some match and some differ in value or direction; `not_aligned` when they do not match; with three or more, each is measured against what most of the others give. It runs again whenever the answers change and none is still running - a solver added, retried or re-generated - but only for answers sent from this page: a run picked back up after a reload re-attaches to a comparison already sent (its job id is in localStorage) and sends nothing new. If it fails, the summary offers **Try again**. Measured on two sets of three answers - the owner's pipe bifurcation, whose forces Muse Spark gave the other way (the support's push on the pipe, upstream and up, against the force on the support, right and down), and a gate with one W different - DeepSeek named both, in 19 s and 7 s, as did Muse Spark (13 s, 5 s). The chips' tooltips say what each means. For a few hours on 9 October 2026 the judge wrote these in its verdict instead (so they waited for a cross-check); before that the page compared the numbers by rule (`shared/answers.ts`, in git history), which kept going wrong on what a reader sees at once - working shown by one answer and not another, a resultant within 2% of a component, directions written as signs by one solver and words by another. Once the verdict is in, the summary also shows "Cross-checked: 2 of 3 correct", the verified answer and a ✓/✗ per solver. Each solution opens on its **All** view: the final answer in a box on top, then the problem, assumptions and working in one scroll (the four single views are still there). **Try it yourself · 先自己諗** shows a solution a little at a time - the question, then the plan (every step's title), then one step at a time, the final answer last - cut out of the working by `shared/steps.ts`, which reads the bold `**Step N - ...**` lines the solve prompt asks for (and `### Q1(a)` headings on a paper with several problems; bold numbered headings from older solutions too). It is off at first; the choice is remembered in this browser, and how far a student has got is kept per solution while the page is open. **The question · 題目原圖** - the pages as the run sent them, from memory or IndexedDB - is a fold above the solutions, and sits beside the reading in the review step (two columns on a wide screen, above it on a phone); a page opens full screen to enlarge. While solvers run, the tab's title counts them ("(2/3) CivilSolve") and says "✓ Done" if they finished while the page was in the background; **Notify me when it's done** under the Solve button adds a browser notification - desktop browsers only (iOS has none outside an installed web app, and Android Chrome needs a service worker, which the app does not have), so the toggle hides where the browser has no notifications.

**Asking about a step · 問呢一步** (since 3 October 2026). Under each finished solution, **唔明？問吓 · Ask about this solution** holds the student's questions about it and their answers, as a thread; **問呢一步 · Ask** beside each step of the working (on the All and Solution views, and in Try it yourself) quotes that step with the question, opens the thread and brings its question box to the middle of the screen, ready to type - every time it is tapped. Each question is a job of its own (`POST /api/ask/:provider`, `hooks/use-ask.ts`, `components/solve/ask-panel.tsx`): the model gets the question images, the notes, the confirmed reading, the solution as text, the quoted step and the earlier questions and answers on the thread (the last six), and answers only what was asked - it does not write the solution again, and says so plainly if the question exposes a mistake. It answers in the language of the question: asked in Chinese, in spoken Cantonese written in Traditional Chinese with the engineering terms in English, like the simple explanation notes. By default the model that wrote the solution answers, at `medium`; the panel offers any configured model and level. Each question has its own Stop; the thread's job ids are saved for the run in localStorage, so a reload picks the answers back up (re-attaching, never re-sending). Measured on 3 October 2026: DeepSeek answered "點解 R_A 同 R_B 會一樣？" about a beam's reactions in 9 s, in Cantonese, with the symmetry argument and the $wL/2$ result. An answer's job has no PDF (`GET /api/pdf/:id` answers 404).

**History · 題目紀錄** (since 3 October 2026). Every question solved is kept in this browser for revision, after the server has deleted its answers (24 hours): a small picture of its first page (about 10 KB), the title, the notes and confirmed reading, every solver's finished solution as text, the verdict and the study notes (`src/lib/history-store.ts`, IndexedDB store `history`, written by `hooks/use-history.ts` a second after an answer comes in - a run picked back up after a reload only ever adds to its entry). The **History · 紀錄** button in the header opens the list - newest first, with each question's solvers and what the verdict said, if there was one - and an entry opens read-only: the verified answer, a tab per solver on the All view, the study notes, and a **PDF** link per answer, which works for good once the PDF was made (R2) and can still be made within 24 hours of solving. **Delete** and **Clear all** remove entries; at most 100 are kept, the oldest dropped first. None of it ever leaves the device.

**How a run is set up: Careful, Quick or Custom** (since 3 October 2026, `src/lib/presets.ts`). The form opens on **Quick · 快速** (the owner's call the same day; Careful was the default for its first hours): Muse Spark, DeepSeek and Gemini (3.8 Flash) at high and nothing else - 3 calls: two on the OpenCode Go subscription and Gemini's on the Vertex AI prepaid credit (Gemini since 4 October 2026, the owner's call; Quick was Muse Spark and DeepSeek alone before). **Careful · 穩陣** checks the reading first (the default readers and reconciler), then solves with the default solvers at high - 6 model calls. Neither preset cross-checks by itself (Careful did for its first hours, 7 calls; the owner's call the same day): the cross-check runs once, when the student taps it - and the tap works while the solvers are still going, too (see below). **Custom · 自訂** is the full form: providers, thinking level, the reading check and, new, "Cross-check the answers when the solvers finish" with its judge and level. A preset hides those sections behind a picture of what will run (`components/solve/preset-flow.tsx`, the owner's request the same day): its stages - **Read · 讀題** (the two readers, an arrow, the reconciler), **Solve · 解題** (the solvers and the thinking level) and **Check · 核對** (the judge) - each model shown by its logo, its name as a tooltip and for screen readers; side by side with arrows on a wide screen, stacked on a phone. All three stages are always drawn: one the run leaves out (Quick's reading and check) is greyed and marked **Skipped · 略過**. **Customise** starts Custom from it; Custom comes back with the user's own settings after a preset was picked. The page opens on Quick every time - the mode is not remembered (it was until 4 October 2026, so a student who once picked Careful kept getting it; the old `civilsolve:mode` key is cleared) - and the form says how many model calls the run makes.

**The cross-check is started from the solutions** (the only way from 26 September to 3 October 2026, and in both presets since; Custom can still switch it on to run by itself). The answer summary is there from the start of a run with **核對答案 · Run the cross-check**, greyed out until two solutions are in (the owner, 4 October 2026). Tapped while other solvers still run, it puts the default judge on the run (`queueCrossCheck` in `use-solve.ts`), the summary says it runs once when the answers are in (with **Cancel · 取消**, which takes it off again, as does the judge's Stop), and it is sent once, when the run's solvers are done, over the first finished solutions - exactly as if the run had started with it. Without a tap no cross-check is made. Afterwards: once the answers are in, the user ticks which ones to grade and picks the judge - or taps **Run the cross-check** on the answer summary. The judge gets the question as uploaded (every page image and the additional instructions), the confirmed interpretation when there was one, and the chosen solutions. The verdict card sits at the bottom, under those controls, and leads with the verdict itself - one line per solution, with its model's logo, **Correct 正確** or **Wrong 錯誤** - then the headline and the verified final answer; each solution's assessment, the reasoning and the Traditional Chinese version are under "Full verdict", which is open to begin with and folds away with its chevron (since 27 September 2026). Each assessment is a list of bullet points with the same points in Traditional Chinese under it (`assessments_chinese`), and **Generate PDF** beside the verified final answer makes a PDF of that answer alone (see below).

**PDFs are made by the server** (since 29 September 2026, the owner's call; it was the browser's print dialog, which on an iPhone meant going through the share sheet). **Generate PDF** - on a solution, beside the verdict's verified final answer, and on each kind of study notes (since 30 September 2026) - asks `GET /api/pdf/:id` for the answer's job; the Worker renders it with the page's own Markdown + KaTeX pipeline (`shared/markdown.ts`) and Cloudflare's headless Chrome (Browser Rendering) prints it to A4 with page numbers. The button then offers **Open PDF** (the link; on an iPhone it opens in Safari's PDF viewer, and Share → Save to Files keeps it), **WhatsApp** and **Copy link** (the labels short, like Open PDF). **WhatsApp** (since 4 October 2026, the owner's request, for an iPhone) sits beside **Generate PDF** too: it makes the PDF and sends the file itself. A web page cannot open WhatsApp with a file attached, so it goes through the share sheet (`navigator.share` with the PDF as a file - the file alone, since with text beside it some apps keep the text and drop the file), where the student picks WhatsApp and the chat. iOS opens the sheet only straight from a tap, not after a wait for the server, so the page keeps the PDF it fetched and shares it the moment **WhatsApp** is tapped again; when the PDF took long enough to make that the first tap has expired, the button turns solid green with "The PDF is ready - tap WhatsApp again". A phone browser that cannot share files (`navigator.canShare`) gets **WhatsApp link** instead: a `wa.me` message with the PDF's link. **On a computer** (since 5 October 2026, the owner's request) it works differently, share sheet or not: the PDF is downloaded to the computer, then WhatsApp Web (`web.whatsapp.com`) opens in a new tab, and the page says to open the chat and attach the file - drag it in, or the paperclip. A browser blocks a tab opened long after the click, so when making the PDF took that long the button turns solid green with "Click WhatsApp again", and that click opens WhatsApp Web without downloading the file a second time. A phone or tablet is told apart by its user agent (iPhone, iPad, iPod, Android; an iPad that reports itself as a Mac by its touch screen; Chromium's `userAgentData.mobile`). A PDF someone asks for is **kept for good** in R2 (the `civilsolve-pdfs` bucket, since 30 September 2026, the owner's call), so the link keeps working after the answer itself is deleted (24 hours), and opening it again costs no browser time; the page says "Saved on the server - the link keeps working". Nothing is made, or stored, until someone taps Generate PDF, and the uploaded images are never stored. If R2 is full (9 GB, below the free 10 GB) new PDFs are still made but kept only while the answer is, and the page says so. If the server cannot make one - the month's allowance used up, the browser service down - the button says why and offers **Print instead**, the old print dialog, which prints on white whatever the theme.

**Anything a model wrote can be asked for again, with your instructions** (since 27 September 2026). Under each finished solution, under the reading in the review step, and under the verdict there is a fold - "Not right? Give ... instructions and re-generate" - with a box for what to change and a **Re-generate** button. The same model gets everything the first request had plus its last version and your instructions, and writes a complete new version: a solution gets the question images, notes, lecture notes and confirmed reading; the reading gets the images, notes, the reading as you left it (your edits included) and both readers' readings; the verdict gets the images, notes, confirmed reading and the graded solutions as they are now. The prompts tell the model to follow the instructions but, where one contradicts the images or the engineering, to do what they require and say why (in `assumptions`, `discrepancies` or `comparison`). The new version says "Re-generated with your instructions: ...". While it runs there is a Stop, and if it fails or is stopped the previous version stays on the page with a note saying so. A solution re-generated after the verdict loses its ✓/✗ on the tab, and the verdict says it graded the version before - re-generate the verdict (or run the cross-check again) to grade the new one.

**Study notes, at the bottom of the page** (since 28 September 2026, the owner's two features). Once there is a finished solution, two cards under the verdict each make one kind of notes on request, by the model and at the thinking level picked on the card - by default the model that wrote the solution it starts from (DeepSeek's solution is explained by DeepSeek, the verified answer by the judge; since 28 September 2026, at the owner's request), and `medium`, which ChatGPT's route raises to `high`: **題型解題思路 · Problem type & approach** - what type of problem it is and the cues that give it away, the general method as numbered steps, the key formulas with what every symbol means and when they apply, and the common mistakes - and **淺白講解 · Explained simply** - the question and its solution talked through the way a tutor would, for a student who has not understood much of the subject yet: an everyday picture of the problem, the one idea it hangs on, each step with its numbers and a line on what each number means, and a short wrap-up with one line to remember. Its style follows an example the owner wrote (28 September 2026): short, conversational, pitched at a secondary-school student - the first version read like a textbook chapter. Since 5 October 2026 (the owner's call) it also builds intuition the way 3Blue1Brown does, balanced against that plain, short style: it opens with a question to be curious about ("which support works harder - and where would the plank crack first?"), shows the one key idea in a picture rather than stating a rule, says what is happening in the picture before each step's numbers ("$60 	imes 3$ is the sandbags' turning push about A"), and ends with one short "what if" (move the load to the middle: both supports share it). Measured on a 6 m beam with DeepSeek at `medium`: the old brief wrote 460 words, stated "the worst bending is where the shear is zero" as a rule, and added a line on bolt spacing the beam does not have; the new one wrote 508 words and 1,403 Chinese characters (the old: 1,594), with the zero-shear point explained from the picture and the "what if" right (40 kN each). Measured on that example (a bolted tension splice, from the textbook's worked solution): DeepSeek at `medium` wrote 442 words and 1,567 Chinese characters in 54 s, going through the bolt's three "死法" one by one; ChatGPT at `high` was accurate but longer (500 words), with English phrases in its Cantonese, in 83 s. Both were first told to point out any error in the solution, and both then "corrected" the textbook's $\sqrt{275/345}$ for the 20 mm plate to 355 - wrongly: S355's design strength is 345 above 16 mm. The notes now take the chosen solution as it stands; checking it is the cross-check's job. Either, both or neither: each is one model call. How they are shown (the owner's layout, 28 September 2026): the approach notes in four tabs - **Problem type**, **Approach**, **Key formulas**, **Common mistakes** - drawn like a solution's Problem / Assumptions / Solution / Final Answer tabs, each with that part's written Chinese in a fold below it that opens and closes on its own (`splitStudyParts` cuts the notes at their labels; notes it cannot cut are shown whole); the simple explanation in its spoken Cantonese first, with the English in a fold below. In both, a technical term keeps its English the first time. Each card's **Start from** picks what the notes are written from: one solver's finished solution, or - once the cross-check has run - its **verified answer**. The list follows the solution tabs: Muse Spark's solution first and the default when it has one (the owner's call, 30 September 2026), then the verified answer, then the other solutions; without Muse Spark the verified answer is the default. The solutions show the verdict's ✓ or ✗ there, and a card started from one judged wrong warns that the notes will follow its mistakes. The model gets the question (images, notes, confirmed reading) and the source: that one solution, or the verdict with the solutions it graded, for their working. (A first version had the model compare the solutions' final answers and refuse to write notes while they disagreed, asking for the cross-check first; the owner replaced that with the choice the same day.) Nothing of the notes is ever sent to the cross-check. Like the verdict, the notes have a Stop, can be re-generated with instructions - from the same source - and are picked back up after a reload. Each kind has its own **Generate PDF** (since 30 September 2026, at the owner's request), made and kept like a solution's (see PDFs above), with every fold open: the approach notes part by part, each part's Chinese under its English, and the simple explanation in Cantonese, then in English (`studyHtml` in `shared/study.ts`, which "Print instead" uses too).

**With the interpretation pass on, nothing is solved until the reading is confirmed.** Submitting clears the previous question's solutions and verdict first (left on screen, they looked like what the new reading was working on), the button says "Reading the question...", and the review step names the solvers that will start on Confirm.

**The reading, and the verdict, are typeset like the solutions** (since 26 September 2026): the readers, the reconciler and the judge are asked for Markdown with every formula, symbol and value-with-unit in `$...$` LaTeX, and the page renders them through the same KaTeX pipeline as a solution (`math-prose.tsx` over `lib/math-markdown.ts`). The review step opens on the rendered reading, with an **Edit** tab for its source (formulas as `$...$`) and **Preview** to check the edit. After **Confirm & Solve** the confirmed reading stays on the page, above the solutions, as "Interpreted question" (what the solvers were given, who read it, the Traditional Chinese a fold away) - it used to disappear. It is kept with the run's body in IndexedDB, so it is back after a reload too. Chinese text keeps its own 已知 / 所求 labels (a solver's stray Chinese labels are still translated), and a Chinese line is never forced into math mode. A unit written half outside the math - `mm$^2$`, `kg/m$^3$`, `kN$\cdot$m` - is typeset too (since 27 September 2026 it showed as typed), while a price like "$5 and $10" stays text. The same day an audit of every saved output fixed the renderer's own repairs, which were breaking correct math: "to the left" inside `\text{}` turned into `\left` (a KaTeX error), thin spaces were stripped so every unit sat against its number, and any sentence with an `=` in it was set in italic math with its spaces gone. Now a sentence stays text, bare `F_x` or `kg/m^3` in it is typeset where it stands, and math cut off with a response is closed (see `AGENTS.md`). The solve prompt asks for `interpreted_problem` (a sentence or two, then a `- ` line per given item and per thing asked) and `assumptions` (a `- ` line each) to be broken into lines, and for every unit to sit inside the math with its number.

**What is stored:** each job's final event - the solution, reading or verdict as text, or its error - and its kind, provider and start time, for **24 hours** after it finishes, then deleted by an alarm. The uploaded images are never written to server storage. The job id (a random UUID) is the only key; the browser keeps it in localStorage, and whoever has it can read that answer until it expires. The browser also keeps the last run's request body - the prepared page images, notes and confirmed reading, plus the reading's Chinese version and who read it, for display - in its own **IndexedDB** (`src/lib/upload-store.ts`), so Retry, Add a solver and the cross-check still work after a reload. That copy never leaves the device; it is replaced by the next run, deleted by **Clear** and **Stop** (the page keeps it in memory after Stop, and a Retry stores it again), and dropped after 24 hours.

### Providers and channels

A **provider** is what the user picks in the UI. A **channel** is the upstream account the key comes from. One provider can be reachable over several channels, and the channel is resolved per request. The first channel listed is the default (`DEFAULT_CHANNELS` in `worker/channels.ts`); the `*_CHANNEL` var overrides it:

```
chatgpt  ──> opencode | poe     (CHATGPT_CHANNEL)
claude   ──> poe
gemini   ──> google | poe       (GEMINI_CHANNEL)
deepseek ──> opencode
grok     ──> opencode
mimo     ──> opencode
minimax  ──> minimax → opencode   (MINIMAX_CHANNEL, a chain: see below)
kimi     ──> opencode
muse     ──> opencode
```

Channels speak three different API dialects, all handled in `worker/channels.ts`:

| Dialect | Used by | Endpoint shape | Reasoning parameter |
|---|---|---|---|
| `responses` | Poe; OpenCode Go (GPT Luna, Grok, Muse Spark) | `POST /v1/responses` | `reasoning: { effort }` (enum) |
| `chat-completions` | OpenCode Go (DeepSeek, Kimi, MiMo, MiniMax); MiniMax's own API | OpenAI-compatible chat completions | `reasoning_effort` (enum) |
| `gemini` | Google | `:streamGenerateContent?alt=sse` | `generationConfig.thinkingConfig.thinkingBudget` (tokens) |

#### OpenCode Go

One key and one base URL (`https://opencode.ai/zen/go/v1`) front several protocols, and the gateway fixes which protocol each model speaks. Every request must carry an `x-opencode-session` header (a stable id per conversation; the Worker sends a fresh UUID per solve) or the gateway refuses it with `MissingSessionID`. Two model families need a one-time opt-in in the OpenCode workspace before the key can use them: models hosted only in China (`deepseek-v4-pro`) and the data-collecting `muse-spark-*` contributor models.

A route can pin its reasoning level with `forceEffort`, or bound it with `minEffort` and `maxEffort`. Two routes use a bound. ChatGPT floors at `high`: `gpt-5.6-luna` is offered at `high` or `max` only — those two picks are sent as-is (`max` maps to `reasoning.effort: "xhigh"`, which the gateway accepts) and anything lower is raised. Kimi floors at `medium`: at `low` it misread a 4 m UDL as 6 m on the overhanging-beam fixture. No route sets a ceiling today: MiniMax had one at `low` for a day, and it was replaced by a longer timeout (below) because `reasoning_effort` does not actually shorten that model's thinking — measured at every level on both of its routes, with no monotonic relationship. `clampEffort` in `worker/run.ts` applies whichever bounds exist; the upload form disables the levels outside the band and names the provider that set it. One level serves every selected solver, so a floor above a ceiling would leave no valid level — the form blocks such a combination instead of picking a side.

#### Getting structured output out of each dialect

The dialects disagree about how a caller can pin the response shape, so `worker/channels.ts` records what each route can actually do instead of discovering it by trial:

| Dialect | How the shape is pinned |
|---|---|
| `responses`, `chat-completions` | `json_schema` response format |
| `gemini` | `responseSchema` (an OpenAPI subset that rejects `additionalProperties`) |

A route can also be flagged `structured: false` when its upstream accepts a schema but cannot be trusted to hold it. The prompt builders then always append the explicit field contract (`enforceShape`). The flag changes the prompt, not the request: on the strict rung the schema is still sent, and the downgrade ladder below drops it if the upstream refuses it. DeepSeek, Kimi and MiniMax (both routes) are flagged: MiniMax answered a two-problem paper as `{"problems": [...]}` with lists where strings belong, and DeepSeek and Kimi each came back once with a blank or empty object under a strict schema. On the since-removed Kimi Code route the contract turned a different envelope on nearly every run into six consecutive runs of the exact six fields.

`shared/solution.ts` remains the safety net behind all of this, including for providers that wrap the answer in the schema name (`{"civil_solution": {…}}`), and for a response that was cut off mid-stream (see below).

### Thinking effort is not portable

The five UI levels (`none`/`low`/`medium`/`high`/`max`) do **not** mean the same thing to every model, so they are mapped per route rather than passed through:

- OpenAI-style enums accept `none` and `xhigh` only on GPT-5.x. Other bots clamp: `max` → `high`, and `none` is omitted.
- Claude has no "off" enum value — thinking is disabled by omitting the parameter.
- Gemini 3 takes a thinking **level** (`thinkingConfig.thinkingLevel`: low / medium / high; `max` sends high, the top level). It took token budgets until 26 September 2026, when streamed gemini-3.5-flash on Vertex AI refused them on half of all requests ("Thinking budget is not supported for this model"). Pro cannot switch thinking off, so `none` sends nothing and falls back to the model default. The dialect still sends `thinkingBudget` for a route whose effort spec is a budget.

A level with no mapping sends **nothing** rather than a value the model would reject.

Because no vendor publishes a reliable per-model matrix, the Worker also **degrades itself**: if an upstream answers 400/422 complaining about a parameter, the request is retried one rung down a ladder — drop `reasoning`, then relax the strict JSON schema to plain JSON mode, then drop the schema entirely. Each downgrade is reported to the client as a `status` event. The parsing pipeline in `shared/solution.ts` is what makes the lower rungs safe.

A thinking model can also fail by thinking too much: it spends every output token it has on reasoning and stops before writing a single answer character. The OpenCode Go routes do this against the gateway's own default cap, since the Worker sends none there (`incomplete_details.reason: "max_output_tokens"` or `finish_reason: "length"`, depending on the dialect). Retrying that unchanged would repeat it, so the Worker retries **one effort level down** instead, reported as a `status` event too. The step-down goes below the route's `minEffort` on purpose — the floor decides where a solve starts, not what it has to fail at. Raising the cap is not a substitute: measured, a model simply thinks longer to fill the extra room (see `AGENTS.md`).

A stream can also just stop — no terminal frame, no error, nothing received — when the gateway drops the connection mid-reasoning. That is retried once at the same effort. When a stream stops *after* partial answer text, what arrived is a valid prefix of the solution JSON. If that prefix reaches the final answer, `shared/solution.ts` closes the open string and object, keeps every complete field, marks the cut one, and rebuilds the LaTeX body if that was the casualty. If it does not reach the answer, it is retried instead (same effort for a drop, one level down if the output cap was hit), and only when no retry remains is the working delivered with a note in place of the answer.

### Stack

| Layer | Tech |
|---|---|
| Hosting | Cloudflare Workers Paid (static assets + API) + Durable Objects (one `TaskJob` per task) |
| Server | Hono on workerd |
| Frontend | React 19 + Vite 7 + Tailwind CSS 4 |
| Math | KaTeX (lazy-loaded chunk) |
| Markdown | marked + DOMPurify (lazy-loaded chunk) |
| PDF input | pdfjs-dist (lazy-loaded, browser-side rasterization) |
| PDF export | Cloudflare Browser Rendering (`@cloudflare/puppeteer`, `GET /api/pdf/:id`); the browser print stylesheet as the fallback |
| LLM access | Poe Responses API, OpenCode Go (Responses + chat completions), Google Generative Language API, MiniMax API (chat completions) |

### File structure

```
├── worker/
│   ├── index.ts            # Hono app: rate limit, validation, task endpoints, /api/jobs/:id
│   ├── tasks.ts            # Request body -> task, for solve / interpret / judge / study
│   ├── jobs.ts             # TaskJob Durable Object: runs a task, keeps its answer 24 h
│   ├── pdf.ts              # GET /api/pdf/:id: an answer rendered and printed by Browser Rendering; PdfBudget
│   ├── channels.ts         # Routes, per-dialect request building + parsing
│   └── run.ts              # Heartbeats, timeout, retry/downgrade, SSE events to a sink
├── shared/                 # Pure logic shared by worker and client
│   ├── providers.ts        # Provider + channel registry, health payload types
│   ├── solution.ts         # Schema, parsing, repair pipeline, LaTeX helpers
│   ├── interpretation.ts   # Interpret/verify schema and parsing
│   ├── judgement.ts        # Answer cross-check (judge) schema and parsing
│   ├── study.ts            # Study notes (approach, simple explanation): schema, part labels, parsing
│   ├── prompt.ts           # Solve, interpret/verify, judge and study-notes prompts, shape contract
│   ├── markdown.ts         # Markdown + KaTeX rendering pipeline (page and PDF), sanitizer supplied by the caller
│   └── stream-protocol.ts  # SSE event types + request limits
├── src/
│   ├── pages/civil-answer-app.tsx      # Page composition
│   ├── styles.css                      # Tailwind + the four light themes (cs-* tokens)
│   ├── components/
│   │   ├── theme-provider.tsx          # Active theme (data-theme on <html>, localStorage)
│   │   └── theme-switcher.tsx          # Theme picker in the page header
│   ├── components/solve/
│   │   ├── upload-form.tsx             # Dropzone, notes, providers, effort, both optional passes
│   │   ├── provider-logo.tsx           # Official provider logo (src/assets/providers/*.svg)
│   │   ├── interpretation-review.tsx   # Confirm the diagram reading
│   │   ├── solution-panel.tsx          # Kept reading, tabs, streaming states, Stop, verdict card, exports (lazy)
│   │   ├── pdf-button.tsx              # Generate PDF -> Open PDF / Copy link, or Print instead
│   │   ├── study-notes.tsx             # The two optional study-notes cards under the verdict (lazy)
│   │   ├── task-status.tsx             # Progress box, status log and failure colours, shared
│   │   ├── math-prose.tsx              # Markdown + KaTeX for the reading and the verdict (lazy)
│   │   ├── run-actions.tsx             # Add a solver; the cross-check's controls (lazy)
│   │   └── solution-article.tsx        # Markdown + KaTeX rendering
│   ├── hooks/
│   │   ├── use-solve.ts                # Per-provider state machine, solvers -> judge, study notes, restore, retry
│   │   ├── use-interpret.ts            # interpret -> verify -> review
│   │   ├── use-health.ts               # GET /api/health once for the page
│   │   └── use-wake-lock.ts            # Keep the screen on while a run is in flight
│   └── lib/
│       ├── sse.ts                      # SSE reader, job handles, re-attach, resume on return
│       ├── run-store.ts                # Last run's job ids in localStorage (24 h)
│       ├── upload-store.ts             # Last run's request body (images) in IndexedDB (24 h)
│       ├── progress.ts                 # Per-task timeline: start, deadline, statuses, end
│       ├── effort-band.ts              # The thinking levels a model's route offers, for a picker
│       ├── math-markdown.ts            # The shared renderer + DOMPurify + KaTeX's stylesheet
│       ├── attachments.ts              # File -> JPEG data URL conversion
│       ├── page-range.ts               # "1-3, 5" -> the PDF pages to send
│       ├── lecture-notes.ts            # Reference payload from notes files
│       ├── pdf-to-images.ts            # pdf.js page count + rasterization (dynamic import)
│       └── exports.ts                  # "Print instead": the browser's print dialog
├── wrangler.jsonc          # Worker config (assets, JOBS / PDF_BUDGET / BROWSER bindings, limiters); vars only to override
├── .dev.vars.example       # Local secrets template (copy to .dev.vars)
├── .npmrc                  # min-release-age=3: skip package versions under 3 days old
└── vite.config.ts          # @cloudflare/vite-plugin + manualChunks
```

## API

`POST /api/solve`, `/api/interpret`, `/api/judge` and `/api/study` are rate limited per client IP: past the limit they answer `429` with `retry-after: 60`, and the page shows that message as the tab's error. There is no sign-in yet - see "Rate limiting" below.

### `GET /api/health`

Reports which providers are usable, without exposing any secret value:

```json
{
  "providers": {
    "chatgpt":  { "channel": "opencode", "model": "gpt-5.6-luna",               "configured": true, "minEffort": "high" },
    "deepseek": { "channel": "opencode", "model": "deepseek-v4.1-flash",        "configured": true },
    "muse":     { "channel": "opencode", "model": "muse-spark-1.3-contributor", "configured": true },
    "kimi":     { "channel": "opencode", "model": "kimi-k2.7-code",             "configured": true, "minEffort": "medium" },
    "mimo":     { "channel": "opencode", "model": "mimo-v2.6-flash",            "configured": true },
    "minimax":  { "channel": "minimax",  "model": "MiniMax-M3",                 "configured": true, "fallbackChannels": ["opencode"] },
    "grok":     { "channel": "opencode", "model": "grok-4.6",                   "configured": true },
    "claude":   { "channel": "poe",      "model": "claude-opus-4.8",            "configured": true },
    "gemini":   { "channel": "google",   "model": "gemini-3.8-flash",           "configured": true, "fallbackModels": ["gemini-3.5-flash"] }
  }
}
```

That is the production default with every key set; the values come from the defaults in `worker/channels.ts` unless a var overrides them. The upload form uses this to disable providers whose key is missing, and to disable effort levels below a route's `minEffort`.

### `POST /api/interpret/:provider`

Optional pre-pass that reads the question without solving it. Body: `{ mode: "interpret" | "verify" | "revise", images, notes, interpretations?, current?, instructions?, effort?, variant? }`. `revise` re-generates the reading under review with the user's `instructions`: `current` is the reading as the user left it, `interpretations` the two readings it came from, when there were two; it answers in the reconciler's shape, Chinese included, with `discrepancies` listing what changed. Returns the same SSE shape with `done → { interpretation }`.

The browser drives it as: two providers run `interpret` in parallel, a third runs `verify` over both readings, and the result pauses for the user to edit before any solving starts. The confirmed text is then sent to `/api/solve` as `interpretation`, where the prompt marks it authoritative over the raw images.

Off by default — it costs three model calls and delays the first solution. The two readers run **at the same time**, then the judge reconciles their readings (it needs both). Until 25 September 2026 all three ran one after another - written for the free plan, where two concurrent streams was exactly the load that tripped the CPU limit - so the pass took the sum of both readers rather than the slower one. If one reader fails, the other's reading still goes to review, flagged as not cross-checked, instead of the whole pass failing. The progress box shows the step ("Step 1 of 2 · Reading the question", then "Step 2 of 2 · Reconciling the two readings"), its elapsed time, and **one line per model** - its name, then what it is doing ("writing... 1,200 characters", "done", or why it failed) - instead of one line joined with dots, which was hard to follow with two readers at once. The judge also writes the reading in **Traditional Chinese** (`traditional_chinese`, verify mode only - `verifiedInterpretationSchema`), shown under the English in the review step for reference; the solvers are only ever given the English. Every field, the Chinese included, is Markdown with `$...$` LaTeX (`READING_FORMAT` in `shared/prompt.ts`), and `interpretationToText` joins them under bold **Diagram:** / **Given:** / **Required:** labels, each on a line of its own so a bullet list after it stays a list. The reconciler and a revision are sent readings already laid out under those labels, and a model that wrote a label into its field again showed it twice (3 October 2026): the prompts now say each part goes in its own field without a label, and `interpretationToText` drops a label a field opens with (`**Diagram:**`, `Given:`, `### Required`, `**To find:**`...) and cuts the problem statement where it repeats the labelled parts - only when each label is there once, in order, and most of what follows is in the fields already, so a paper with a "Given:" line per problem keeps them. Measured on B.8: the Chinese keeps every value (60 mm, 100 kPa, 30°, W = 0.5 kN) and translates the prose, and it made the ChatGPT reconcile take ~150 s at `max` (see the reconciler's level below). Readers without a working strict schema (Kimi, DeepSeek) may answer with arrays, objects, other key names or a wrapper; `parseInterpretation` flattens all of those (`textOf`), and on a last attempt delivers whatever came back rather than an error. The default trio is **Muse Spark** (`muse-spark-1.3-contributor` on OpenCode Go, free - since 3 October 2026, the owner's pick, in MiMo's place: on a one-page beam, three runs each, it read in 21-35 s, MiMo in 18-28 s and DeepSeek once in 46 s, every reading correct) and **Gemini Flash** (the `gemini-3.8-flash,gemini-3.5-flash` chain on Vertex AI - a billed call on the prepaid credit per reading) as readers, **ChatGPT** (`gpt-5.6-luna` on OpenCode Go) as judge - MiMo read in Kimi's place from 27 September 2026 (Kimi and Gemini Flash read from 26 September; DeepSeek Flash and Muse Spark from 25 September, while Gemini was on a free AI Studio key that failed too often). MiMo read B.8 in LaTeX and bullets at the first attempt, in 109 s - slower than Kimi (~40 s) or Gemini Flash (~15 s), and the pass waits for the slower reader. The reconciler also writes its discrepancies in Traditional Chinese (`discrepancies_chinese`). Since 3 October 2026 it sums the comparison up as well (the owner's request: the student should not have to read the discrepancies to learn whether the readers agreed): `agreement` - `agree`, `minor` (no value, dimension, support, load or requirement changes) or `differ` - and a short `conclusion_chinese` / `conclusion`, one sentence plus at most three bullets naming the key differences and which reading was kept. The review step leads with it, right under its heading - a coloured headline (兩個讀法一致 / 大致一致，有細微分別 / 兩個讀法有分歧 - 請核對), the Chinese conclusion, the English one smaller - and the full discrepancies sit folded under **詳細分歧 · Full details**, Chinese first. A re-generated reading uses the same fields for what changed (冇改動 / 小改動 / 有重要改動). A reading without them (a reconciler on a lower schema rung that left them out) shows the discrepancies unfolded, Chinese first. Each of the three models has its own thinking level, picked under its model on the form (since 26 September 2026; the two readers shared one before): the readers default to `medium`, the reconciler to **`high`**. Levels a model's route does not offer are disabled (Kimi floors at `medium`, ChatGPT at `high`), and a pick outside the band moves to its nearest edge when the model is changed. It ran at `max` until 26 September 2026, when a pass with the new default readers timed out: reconciling a Kimi and a Gemini Flash reading of B.8, ChatGPT at `max` took 223-381 s (5 timed runs; 204-324 s of it thinking, 15-20k reasoning tokens) against a 280 s limit, and it did so with plain-text readings too (246-262 s) - the Markdown + LaTeX format was not the cause (writing took 13-57 s either way). At `high` it took 69-75 s and kept every key fact of the diagram (60 mm, 10 m/s, 100 kPa, 35 mm, 30°, W = 0.5 kN, the inclined jet's speed not given), as every `max` run did; end to end through the page, both readers plus the reconcile took 117 s. `max` is still offered (it warns that it can take 4-6 minutes), and ChatGPT's route now has the 20-minute limit. ChatGPT, Gemini and Claude are pinned to routes chosen for the pass, independent of the solve-time channel (`interpretOverride`): ChatGPT to Luna — it read on Poe's `gpt-5.4-pro` until 22 September 2026, correct but slow (~95 s vs ~5 s for Gemini) and billed to Poe — and Claude to Opus on Poe. Measured with the defaults of 22 September 2026 (Gemini and Muse Spark reading): Gemini 39 s and Muse Spark 12 s to read, Luna 31 s to reconcile, with a 1,271-character discrepancies field. The Gemini reader uses a **model chain**, `gemini-3.8-flash,gemini-3.5-flash`: 3.8 first, 3.5 when 3.8 does not answer (see "Model chains" below). If `GOOGLE_API_KEY` is not configured it reads on Poe's `gemini-3.1-pro` instead, so the pass keeps working. A provider not pinned here (DeepSeek, Muse Spark, Kimi, MiMo, MiniMax, Grok) keeps its normal route if picked.

#### Model chains

Any model var may hold a comma-separated chain, primary first. When an attempt fails in a way worth retrying — 503, 429, a dropped stream, a fragment the parser cannot use — the Worker moves to the next model in the chain instead of repeating the same one, after the same 3 s pause as a transient retry, and reports it as a `status` event ("gemini-3.8-flash did not answer. Trying gemini-3.5-flash..."). The fallback starts with a fresh transient budget. `/api/health` reports the chain as `fallbackModels`, and the picker shows it on the card. Measured on Google the day this was added: `gemini-3.8-flash` closed the socket on a 190 KB request four times out of six and once answered with empty fields; `gemini-3.5-flash` behind it was 4/4.

### `POST /api/judge/:provider`

Optional post-pass, the **answer cross-check**. Body: `{ images, notes, interpretation?, solutions: [text, text, ...], effort?, revision? }` with two to four solutions; `revision: { previous, instructions }` re-generates a verdict - `previous` is the last verdict as text (`judgementToText`). Returns the same SSE shape with `done → { judgement }`: `{ correct: number[], final_answer, assessments: string[], comparison, confidence: "high" | "medium" | "low" }` — `correct` holds the zero-based indices of the solutions the judge found right (empty for none), `assessments` has one entry per solution in order. On the wire the judge answers with letters (`correct_solutions: ["A", "C"]`); the parser maps them to indices and, on schema-less rungs, reads prose ("A and C", "both", "none").

The browser sends it when the user runs the cross-check from the solutions (it is not chosen on the upload form): the judge gets the finished solutions the user ticked (flattened by `artifactToText`, capped at 24,000 characters each, working cut before the answer) with the same images and the confirmed interpretation if there was one. A solver that returned nothing is left out and named on the verdict card; fewer than two finished solutions and the check is skipped. The solutions are anonymised as Solution A, B, C, D in picker order — the judge never learns which provider wrote which, so it grades the work, not the brand — and the browser maps the letters back to provider names. The prompt tells the judge to re-derive the numbers from the images rather than read the solutions for consistency: every wrong answer seen on the fixtures was internally consistent (a jet velocity assumed instead of derived, a pressure force counted twice), and a consistency check would pass them all.

The judge also writes `traditional_chinese`: the verdict explained again in Traditional Chinese (which solutions are right, the verified answer and the decisive reason), shown under the English in the verdict card, and `assessments_chinese`, each solution's assessment in Chinese (both since the fields were added; a verdict from before has neither per-solution Chinese); measured on B.8, ChatGPT wrote 734 characters starting "解答 A 正確；解答 B 不正確" with the math intact. The judge runs on the provider's normal solve route at `high` by default (the most reliable level in the B.8 matrix; `effort` in the body overrides). The default judge is ChatGPT (Luna); the user can pick any configured provider. Measured on the B.8 fixture with the first version (two solvers, Gemini judging): Muse ‖ DeepSeek at `low` finished together in 85 s (the slower of the two), Gemini judged in 43 s, verdict **A, high confidence**, with the correct −143 N / −178 N as the verified answer and B's error named to the term (a pressure force of 565.5 N where 282.7 N was right). The three-solver path (Muse, DeepSeek, Grok → Luna) was verified against a scripted upstream: `correct_solutions: ["A", "C"]` came back mapped to Muse and Grok with three assessments. Combining it with the interpretation pass gives the most robust run: a reviewed reading feeds every solver and the judge.

#### How long a task may run

The timeout is a **floor per route plus an allowance per page**, counted across every attempt so a retry cannot extend it.

| Upload | Most providers | DeepSeek, Kimi, MiMo, MiniMax |
|---|---|---|
| 1 question | 4.7 min | 20 min |
| 3 pages | 8.7 min | 24 min |
| 8 pages | 18.7 min | 34 min |
| 16 pages (the cap) | 34.7 min | 45 min (the ceiling) |

`SAFETY_TIMEOUT_MS` in `worker/run.ts` is the 280 s floor; a route overrides it with `timeoutMs`, and four providers set 20 minutes (`LONG_THINKING_TIMEOUT_MS`): Kimi, which as a solver at `high` answered B.8 in 271 s, 9 s short of the floor; MiniMax on both of its routes — on the B.8 fixture it wrote 93–104k characters of reasoning and was still going at 280 s on three production runs out of three, and no effort level shortens that — and DeepSeek and MiMo, which on the two-part B.5 paper at `high` took 249 s and more than 280 s (MiMo timed out without writing a character). `taskTimeoutMs` in `shared/stream-protocol.ts` then adds `PER_EXTRA_PAGE_MS` (2 min) for each assignment page after the first, because a whole exam paper is a dozen questions in one request rather than one long question, and both the reading and the writing grow with it. Lecture-notes pages count half: they are read once as reference and never solved. `MAX_TIMEOUT_MS` (45 min) caps the result so a wedged upstream cannot hold a tab open all day — the heartbeats would otherwise keep it alive indefinitely.

Nothing in the platform forces these numbers. Cloudflare enforces no wall-clock limit on an HTTP request while the client stays connected, and time spent waiting on `fetch()` is not billed as CPU (a 77 s solve costs ~3 s of CPU). They encode how long a user should wait before being told nothing is coming; the 15 s heartbeats are what keep the stream itself alive. The 280 s value arrived with the original import and had no recorded reason until this was written.

### `POST /api/study/:provider`

Optional, the **study notes** (`shared/study.ts`). Body: `{ kind: "approach" | "explain", images, notes, interpretation?, solutions: [text, ...], verdict?, effort?, variant?, revision? }`. The notes start from what the user picked on the card: one solver's solution (`solutions` holds exactly that one, as `artifactToText` writes it), or the cross-check's verified answer - `verdict` as text (`judgementToText`) with the one to four solutions it graded, in its order so its letters still match, and a placeholder for a graded one that is no longer on the page. Without a verdict, more than one solution is a 400. The prompt builds on the verdict's verified answer and the method of the solutions it found correct, or on the one solution, following the correct engineering where it has a clear error - though a misread question is not one it catches: started from the B.8 solution that read the inlet pressure as 200 kPa, DeepSeek explained its wrong −460 N faithfully. `effort` defaults to `medium`: the notes explain a solution, they do not derive one. Returns the same SSE shape with `done → { study, kind }`: `{ guide, traditional_chinese }`, and the kind asked for - stored with the notes for their PDF (since 30 September 2026; for notes stored before, the PDF takes notes that cut into the approach parts as approach notes). Each part of the notes opens with its bold label on a line of its own (`STUDY_PARTS`: Problem type, Approach, Key formulas, Common mistakes; or What's going on, The key idea, Step by step, Wrap-up - each with its Chinese label, 發生咩事, 關鍵諗法, 逐步計 and 總結 for the Cantonese one); `openStudyLabels` puts every label on a line of its own, spelled as in `STUDY_PARTS`, with a blank line around it: models ran the part on after the label (DeepSeek wrote `**Approach** - 1. Identify ...`, which cut the numbered steps' list in two), wrote variants ("Key idea" for "The key idea"), and put "Wrap-up" straight under the numbered steps with no blank line, where Markdown reads it as more of the last step and indents it like one - the owner saw that on every explanation. The parser runs it, and the page again when it renders, for notes stored before. It runs on the provider's normal solve route, like the judge, and the notes are never sent to `/api/judge`. Measured on 28 September 2026 with saved solutions as input: given a verdict, DeepSeek at `low` wrote the approach notes in 103-126 s with B's double-counted pressure force among the common mistakes; the beam explained simply took 59 s (7,077 characters, 3,532 in Chinese); ChatGPT at `high` explained B.8 from one solution in 66 s; a re-generation with instructions took 28 s.

### `POST /api/align/:provider`

The answers compared with each other (`shared/align.ts`, since 9 October 2026), sent by the page itself once every solver has answered. Body: `{ answers: [text, ...], question?, notes, effort?, variant? }` - two to nine final answers as text, labelled Answer A, B, C... in that order, and the question in words (the confirmed reading, or the first solver's restatement); no images, so it takes seconds. `effort` defaults to `low`. The model does not solve or grade: the `done` event carries `comparison: { alignment: ["aligned" | "partial" | "not_aligned" | null, ...], notes: [text, ...] }`, one per answer, in order. 400 for fewer than two answers or more than nine.

### `GET /api/pdf/:id`

A finished solution, the verdict's verified final answer, or study notes, as an A4 PDF (`worker/pdf.ts`), for the job id the page has for it. It answers `application/pdf` inline with a file name from the solution's title (study notes: their kind's name, `problem-type-approach.pdf` or `explained-simply.pdf`) and `x-pdf-kept: forever` (kept in R2) or `24h` (the bucket missing or full), and puts the file in the edge cache - a week for one in R2, else up to the job's remaining retention (the Cache API does nothing on `workers.dev`). Order: the edge cache, then R2 (`pdf/<job id>.pdf`), then rendering; a rendered PDF is put in R2 before the response goes out, with its file name, title, kind and time as metadata, and counted in `PdfBudget` against `PDF_STORE_BYTES` (9 GB). On a cache miss it takes a `PDF_LIMITER` slot (10 per client IP per minute), reads the job's stored final event (`GET /result` on the TaskJob), and asks `PdfBudget` whether the month's browser time is under `PDF_MONTHLY_MS`. It then builds the document with the shared renderer, sanitizes it with `HTMLRewriter` (no script, style, link, frame, embed, form, image, `on*` handler or `href`/`src`), and prints it in a headless browser with JavaScript off that may fetch nothing but KaTeX's stylesheet and fonts from jsDelivr - the worst a hostile answer can do is change how its own PDF looks. Errors: 404 (bad id, answer gone, or a job with no PDF - a reading), 429 (per-IP limit, or the month's allowance used up), 503 (Browser Rendering refused or failed). Measured on 29 September 2026 through `npm run dev` (the remote browser adds a little): a 2-page beam solution in 13.8 s, a one-page verdict answer in 8.5 s, 0.01 s from the cache; KaTeX's fonts embedded, body text in Liberation Sans. Study notes, 30 September 2026, the same way: DeepSeek's approach notes on B.8 in 13.7 s (5 pages), an explanation in 9.4-11.4 s (2 pages), their Chinese in Noto Sans CJK TC, which Cloudflare's browser has and embeds (a PDF of notes is 340-440 KB, against 35-70 KB for a solution). The Chinese is tagged `zh-Hant`, not the page's `zh-Hant-HK`: with Hong Kong forms the printer left characters such as 流 and 體 out of the text a PDF reader copies and searches, though they showed. Some common characters (一, 入, 面) still copy as their look-alike Kangxi radicals - Chrome's PDF writer does that with Noto CJK.

Cost: Browser Rendering on Workers Paid includes 10 browser hours a month, then US$0.09 an hour (and 10 concurrent browsers, averaged monthly, then US$2 each). `PdfBudget`, one Durable Object for the account, adds up the time from launching each browser to closing it and refuses past 9 hours in the calendar month (UTC), so PDFs never bill beyond the plan - three PDFs used 36.8 s, so the cap is some 2,700 PDFs a month at that rate, more on production.

### Jobs: `GET /api/jobs/:id` and `DELETE /api/jobs/:id`

Every `POST /api/solve`, `/api/interpret`, `/api/judge` and `/api/study` runs in a job, and its SSE stream opens with:

```
event: job      data: {"id":"<uuid>","startedAt":1790347043501,"deadlineAt":1790347323501,"now":1790347043501}
```

`startedAt` and `deadlineAt` are when the job began and when it gives up (its timeout, above), on the server's clock; `now` lets the page correct for its own clock. Through a job every `status`, `done` and `error` carries `at`, the server time it happened, and an `error` carries `timedOut: true` when the task ran out of time rather than failed ("... timed out after 4 min 40 s and returned nothing.").

- `GET /api/jobs/:id` re-attaches: the same `job` event, then either the stored final event (`done` or `error`) and the end of the stream, or - for a run still in progress - every `status` so far (with its original `at`, so the page recognises the ones it already has) followed by everything live. The statuses are held in the object's memory only; what is stored is still the final event alone. `404` with `{"error": ...}` when the job never existed, has expired (24 h after it finished), or was lost mid-run.
- `DELETE /api/jobs/:id` cancels a running job; it ends with `error: Cancelled.`, which is what is then stored. `204` whether or not there was anything to cancel.

Only well-formed UUIDs reach the Durable Object namespace. Without the `JOBS` binding the task endpoints run inline in the Worker, as before jobs existed, and a disconnect then ends the run.

### `POST /api/solve/:provider` (`chatgpt` | `deepseek` | `muse` | `kimi` | `mimo` | `minimax` | `grok` | `claude`)

A provider listed in `REVIEW_ONLY_PROVIDERS` (none since 26 September 2026) answers `400` here, and so does a `variant` the provider does not offer; an unknown provider answers `404`. An optional `revision: { previous, instructions }` (the last solution as text, up to 24,000 characters, and the user's instructions, up to 4,000) re-generates a solution; both are required when it is there.

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
event: job      data: {"id":"<uuid>","startedAt":…,"deadlineAt":…,"now":…}   ← first, names the job
event: status   data: {"message":"Asking Claude (via Poe)...","at":…}   ← sent immediately
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
| `OPENCODE_API_KEY` | ChatGPT, DeepSeek, Muse Spark, Kimi, MiMo, Grok; MiniMax when its own key is missing or refused (the second link of its chain) | <https://opencode.ai/go> |
| `POE_API_KEY` | Claude; Gemini when `GEMINI_CHANNEL=poe` (and as the interpretation reader when neither Google key is set); ChatGPT when `CHATGPT_CHANNEL=poe` | <https://poe.com/api_key> |
| `GOOGLE_API_KEY` | Gemini (its default channel): a **Google Cloud key allowed to call Vertex AI** - AI Studio's endpoint refuses it (`API_KEY_SERVICE_BLOCKED`) | Google Cloud console → APIs & Services → Credentials |
| `GOOGLE_BACKUP_API_KEY` | Gemini's backup: a **second Vertex AI key**, from another project, used when `GOOGLE_API_KEY` is refused (credit used up, key revoked) or Vertex stops answering; Gemini's only channel when `GOOGLE_API_KEY` is unset | Google Cloud console (the other project) → Vertex AI Studio, or APIs & Services → Credentials |
| `MINIMAX_API_KEY` | MiniMax, first in its chain; delete it and MiniMax runs on OpenCode Go | <https://platform.minimaxi.com> |

- Local: copy `.dev.vars.example` to `.dev.vars` and fill in the keys you have. `.dev.vars` is gitignored.
- Production: `npx wrangler secret put POE_API_KEY` (repeat per key).

A provider whose key is blank is shown as unavailable in the UI rather than failing mid-solve. You only need the keys for the providers you intend to use.

> `.dev.vars` is read by the **Worker**, not by Vite. Never move these into `.env`, and never prefix them with `VITE_` — anything named `VITE_*` is inlined into the browser bundle.

### Bindings (in `wrangler.jsonc`)

| Binding | Class | Purpose |
|---|---|---|
| `JOBS` | `TaskJob` (`worker/jobs.ts`), SQLite-backed, migration `v1` | One Durable Object per task, so it finishes after the page leaves and keeps its answer 24 hours. Available on Workers Free and Paid; each job is billed for the time it is active (≈ 128 MB × run time), comfortably inside the Paid plan's 400,000 GB-s a month. Remove it and tasks run inline again |
| `TASK_LIMITER` | Workers Rate Limiting (`ratelimits`, namespace `2609`) | 20 model-calling requests (solve, interpret, judge) per client IP per minute. A whole run with every option on is about a dozen, so it only stops a runaway client. Re-attaching and cancelling are not counted. Remove it and nothing is limited |
| `BROWSER` | Browser Rendering (`browser`, `remote: true`) | The headless Chrome that prints PDFs (`worker/pdf.ts`); needs the `nodejs_compat` flag for `@cloudflare/puppeteer`. There is no local browser: `npm run dev` uses Cloudflare's, over `npx wrangler login`, and it cannot open `localhost` pages - which is why the Worker hands it the finished HTML instead of a URL. Remove it and `GET /api/pdf` answers 503 |
| `PDF_BUDGET` | `PdfBudget` (`worker/pdf.ts`), SQLite-backed, migration `v2` | The month's browser time for PDFs, one object for the account; refuses past `PDF_MONTHLY_MS` (9 of the 10 included hours). Also counts the bytes of PDF kept in R2 and stops storing past `PDF_STORE_BYTES` (9 GB) |
| `PDFS` | R2 bucket `civilsolve-pdfs` (location hint Asia-Pacific) | Every PDF someone asked for, kept for good, at `pdf/<job id>.pdf`. R2 includes 10 GB-month, a million writes and ten million reads a month free, and egress is free; a PDF is 35-70 KB, so the 9 GB cap is over 100,000 of them. The app never deletes one - delete by hand in the dashboard (R2 → `civilsolve-pdfs`) if ever needed. `npm run dev` uses a local stand-in in `.wrangler/state`. Remove it and PDFs live only in the edge cache |
| `PDF_LIMITER` | Workers Rate Limiting (`ratelimits`, namespace `2610`) | 10 PDFs made per client IP per minute; one served from the cache is not counted |

### Vars (optional overrides, non-secret)

None is set: `wrangler.jsonc` carries an empty `vars` block. The **Default** column is the code default in `worker/channels.ts` (`DEFAULT_CHANNELS`, `ROUTES`, `INTERPRET_MODEL_DEFAULT`), and it is what production runs - the model ids live next to the route flags (`structured`, `timeoutMs`, `minEffort`) that were measured for them, so there is one place to read and change the routing. Set a var in `wrangler.jsonc` `vars` (production) or `.dev.vars` (local) only to depart from a default; `WorkerEnv` in the same file lists every one, and `GET /api/health` reports what is in effect.

| Variable | Default | Purpose |
|---|---|---|
| `CHATGPT_CHANNEL` | `opencode` | `opencode` or `poe` |
| `CLAUDE_CHANNEL` | `poe` | Channel for Claude |
| `GEMINI_CHANNEL` | `google` | `google` or `poe` |
| `DEEPSEEK_CHANNEL` / `GROK_CHANNEL` / `MIMO_CHANNEL` / `KIMI_CHANNEL` / `MUSE_CHANNEL` | `opencode` | Only OpenCode Go serves these |
| `MINIMAX_CHANNEL` | `minimax,opencode` | A chain, first usable channel first: the owner's token plan, then the shared Go subscription. `minimax` or `opencode` pins one |
| `OPENCODE_CHATGPT_MODEL` | `gpt-5.6-luna` | Floored at high effort; max is honoured |
| `OPENCODE_DEEPSEEK_MODEL` | `deepseek-v4.1-flash` | Reads diagrams (undocumented) and beat `deepseek-v4-flash-vision-exp` on the fixture; the latter is the documented vision model and the fallback if this regresses |
| `OPENCODE_GROK_MODEL` | `grok-4.6` | |
| `OPENCODE_KIMI_MODEL` | `kimi-k2.7-code` | Floored at medium effort (it misread a diagram at low); `kimi-k3` is the dearer sibling |
| `OPENCODE_MIMO_MODEL` | `mimo-v2.6-flash` | OpenCode Zen's free tier; Zen lists it as `mimo-v2.6-flash-free`, which the Go gateway rejects |
| `OPENCODE_MINIMAX_MODEL` | `minimax-m3` | Used on the `opencode` channel: the second link of MiniMax's default chain, or alone with `MINIMAX_CHANNEL=opencode`. The only MiniMax id the gateway serves — `minimax-m2.7` and `minimax-m2.5` answer 503 |
| `MINIMAX_MODEL` | `MiniMax-M3` | Used by the default `minimax` channel |
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com/v1` | Endpoint override; the international deployment is `https://api.minimax.io` |
| `OPENCODE_MUSE_MODEL` | `muse-spark-1.3-contributor` | Free "contributor" tier; the workspace must opt in or the gateway answers 403 `DataPolicyError` |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/go/v1` | Endpoint override |
| `POE_CHATGPT_MODEL` | `gpt-5.4` | Poe bot handle |
| `POE_CLAUDE_MODEL` | `claude-opus-4.8` | Poe bot handle |
| `POE_GEMINI_MODEL` | `gemini-3.1-pro` | Poe bot handle |
| `GOOGLE_GEMINI_MODEL` | `gemini-3.8-flash,gemini-3.5-flash` | Gemini's "Flash" pick: a model chain on Vertex AI |
| `GOOGLE_GEMINI_PRO_MODEL` | `gemini-3.1-pro-preview` | Gemini's "Pro" pick (`gemini-3.1-pro` is a 404 on Vertex) |
| `INTERPRET_CHATGPT_MODEL` / `INTERPRET_GEMINI_MODEL` / `INTERPRET_CLAUDE_MODEL` | `gpt-5.6-luna` / `gemini-3.8-flash,gemini-3.5-flash` / `claude-opus-4.8` | Pinned routes for the interpretation pass; ChatGPT is an OpenCode Go id, Gemini a Google chain, Claude a Poe bot |
| `POE_BASE_URL` | `https://api.poe.com/v1/responses` | Endpoint override |
| `GOOGLE_BASE_URL` | `https://aiplatform.googleapis.com/v1/publishers/google` | Endpoint override (Vertex AI; `https://generativelanguage.googleapis.com/v1beta` is AI Studio, with an AI Studio key) |
| `NO_STREAM` | *(empty)* | Providers that skip upstream streaming. Was `deepseek` on the free plan: DeepSeek streams its reasoning token by token, which that plan billed as CPU and killed mid-solve (2,010 ms → `exceededCpu`); non-streamed the same solve costs 13 ms. Only for models that finish inside OpenCode's ~100–120 s idle cut. Cleared on Workers Paid. (`POE_NO_STREAM`, its old name, is no longer read) |

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

With the default, nothing has to change when the plan ends. The Worker moves a solve down the chain when MiniMax **refuses the account** — HTTP 401/402/403, or a message about balance, quota, credit, billing, an expired plan or an invalid key, including MiniMax's own codes 1004 / 1008 / 2049 and its HTTP-200 `base_resp` envelope — or when it **stops answering** after its transient retry. The tab says which, e.g. "MiniMax (via MiniMax) refused the account (HTTP 401: login fail…) — its plan or credit may have run out. Trying MiniMax (via OpenCode Go)…". The move costs about a second per solve. To stop paying that second once the plan is gone, delete the key — the chain then skips straight to OpenCode Go without a redeploy:

```bash
npx wrangler secret delete MINIMAX_API_KEY
```

A channel is a different account and endpoint, so a move starts the new route fresh: capabilities, effort band and retry budgets are renegotiated, and only the safety timeout keeps running. An explicit single channel is respected — `minimax` alone fails with MiniMax's message rather than quietly spending the Go subscription. Any provider's channel var may be a chain; MiniMax and Gemini (below) use one today. Verified against the real APIs on 23 September 2026: a rejected key moved the solve to OpenCode Go 1 s in and it finished correctly; a removed key skipped MiniMax entirely; a `base_resp` 1008 "insufficient balance" reply (from a stand-in server) moved it as well; `minimax` alone failed with the 401; `opencode` alone never called MiniMax.

Both channels bill as monthly subscriptions the owner already pays for, so the chain is about which quota is spent, not about per-call cost. MiniMax's own endpoint is plain OpenAI chat completions at `https://api.minimaxi.com/v1` and reads images, so nothing else changes — the anthropic-protocol route this provider used until 19 September 2026 is not needed and is not coming back. The model is spelled `MiniMax-M3` there and `minimax-m3` on the gateway; `MiniMax-M3[1m]` selects the 1M-token context. Use `https://api.minimax.io` (`MINIMAX_BASE_URL`) for the international deployment. Verified on both fixtures through the app's own prompt: B.8 correct in 141 s, the beam correct in 27 s, both at `low`.

### Gemini's channel

Gemini solves, reads and judges on Google Vertex AI by default (`GOOGLE_API_KEY`, a Google Cloud key; Flash or Pro as picked), with a **backup key** (`GOOGLE_BACKUP_API_KEY`, channel `google-backup`, since 1 October 2026): the owner's second Vertex AI key, from another Google Cloud project with its own credit. When the first key is **refused** - its credit ran out (403 billing, 429 quota), the key was revoked or deleted (400 "API key not valid") - or Vertex **stops answering** after its retry, the Worker moves that task to the backup key by itself and the tab says so: "Gemini (via Google Vertex AI) refused the account (HTTP 403: This API method requires billing to be enabled…) - its plan or credit may have run out. Trying Gemini (via Google Vertex AI, backup key)…". It covers the Flash and Pro picks and the interpretation pass alike, with the same model (`BACKUP_CHANNELS` in `worker/channels.ts`). Without `GOOGLE_API_KEY` Gemini runs on the backup alone; without `GOOGLE_BACKUP_API_KEY` there is no backup. The backup only helps with credit if its project bills to a different billing account. An AI Studio key ("AIza…") can be the backup too, with `GOOGLE_BACKUP_BASE_URL=https://generativelanguage.googleapis.com/v1beta` - AI Studio names the models alike - but on the free tier it has no quota for Pro. Both of the owner's keys are `AQ.` keys (Vertex AI Studio in the Cloud console): AI Studio's endpoint blocks them (`API_KEY_SERVICE_BLOCKED`). Verified with a stand-in Google on 1 October 2026: a 403 billing refusal, a 429 quota refusal and a 400 invalid key each moved Flash, Pro and the reader to the backup at once, with the backup key and the same model; a 503 moved it after the retry. Then for real: with the stand-in refusing the first key, the owner's backup key solved the beam on Vertex AI with `gemini-3.8-flash` in 21.8 s.

To move Gemini to Poe's `gemini-3.1-pro` (Pro, paid on Poe):

```
GEMINI_CHANNEL=poe
```

Without either Google key, the interpretation pass moves a Gemini reader to Poe by itself (`interpretOverride`); as a judge it shows as unavailable until a Google key is back or `GEMINI_CHANNEL=poe` is set. Either way the dialect, schema translation (Gemini's `responseSchema` rejects `additionalProperties`), and thinking-budget mapping are handled in `worker/channels.ts`.

### Adding a channel to a provider

Add an entry under that provider in `ROUTES` (`worker/channels.ts`) naming the dialect, key var, model var, and endpoint, and add those vars to `WorkerEnv`. A new account also needs a `ChannelKey` in `shared/providers.ts`. To make it the default, put it in `DEFAULT_CHANNELS`. If it speaks an existing dialect, that is all.

## Development

```bash
npm install
npm run dev        # Vite dev server + Worker in workerd, with HMR (Generate PDF uses Cloudflare's browser: npx wrangler login first)
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

### Rate limiting

The model-calling routes are limited by the `TASK_LIMITER` binding (Workers Rate Limiting, `ratelimits` in `wrangler.jsonc`): 20 solve, interpret and judge requests per client IP (`cf-connecting-ip`) per minute, counted per Cloudflare location. A whole run with every option on is about a dozen, so this only stops a runaway client or script; people on one shared network share the limit. Past it the request gets `429` and the tab says to wait a minute. The period can only be 10 or 60 seconds. Re-attaching to a job (`GET /api/jobs/:id`) and cancelling one are not counted - they call no model.

**There is no sign-in yet: anyone with the URL can use the app and spend the provider subscriptions.** Cloudflare Access sign-in is built - the Worker verifies the Access token on every `/api/*` request and fails closed without one, and the rate limit is then keyed per user rather than per IP - and parked on the `access-sign-in` branch until Access is set up in the Zero Trust dashboard. Merge that branch then; its README has the setup steps. Deploying it before Access is set up closes the API to everyone.

The account is on **Workers Paid** ($5/month) since 22 September 2026, which raises CPU per invocation from 10 ms to 30 s (the default; `limits.cpu_ms` in `wrangler.jsonc` goes to 5 min). Measured on production the same day: MiMo streamed B.8 1,424 ms `ok`; DeepSeek streamed B.8 3,201 ms `ok` in 77 s (the free plan killed it at 63 s); DeepSeek as interpretation judge 1,906 ms `ok`. Nothing else in the plan matters here: a solve is at most 5 requests, static assets are unlimited, and the immediate SSE headers + heartbeats keep long solves alive. Everything below this line was written against the free plan and is kept because it explains why the code was shaped the way it was — the single-choice picker, the sequential interpretation pass, `NO_STREAM`, all since relaxed — and what to re-enable if the account ever drops back.

**Piping the provider stream is I/O-wait, but the upload is not.** Each selected provider gets its own copy of the images. The Worker parses that JSON body to validate it, the task's `TaskJob` parses it again to run it, and every attempt re-serializes it into the upstream request — several full passes over several megabytes, all of it counted as CPU. That is why the body cap is enforced early and why the browser blocks oversized batches before sending. If you raise `MAX_IMAGES` or `MAX_BODY_BYTES` in `shared/stream-protocol.ts`, measure CPU time per invocation before assuming it still fits.

Deduplicating the N uploads by storing them is ruled out by design (see `AGENTS.md`). A single fan-out request - one upload, one Worker handing the images to several jobs, held in memory only - would not break that rule, but it has not been built, so for now the lever is payload size, not request count.

**Every ticked provider runs at once** (`SOLVE_CONCURRENCY` in `use-solve.ts`, 4 — the most the cross-check can grade). The picker was single-choice on the free plan: there each per-token stream (the OpenCode Go routes) draws roughly 300–1800 ms of CPU for its whole duration — versus ~20–50 ms for a Poe-buffered route — and the plan's CPU budget is a rolling, account-wide allowance, so running several heavy streams together, or back-to-back, drains it and the runtime kills a stream mid-flight (the client shows it ended unexpectedly). One at a time kept every solve inside the budget. A stream that is still killed retries once automatically.

**Streaming a thinking model costs CPU the free plan meters.** The runtime charges per upstream chunk read, and per-token streams from OpenCode Go arrive as thousands of tiny chunks — roughly 330–500 ms of CPU per solve for those routes, against ~20–50 ms for Poe routes that buffer upstream. A single five-provider solve (~900 ms total) completes on the free plan when spaced out; back-to-back solves or the interpretation pass on top can exceed the plan's refilling budget, in which case the affected tab shows "ended unexpectedly, please try again". Nothing in the Worker's JavaScript can reduce this further (see `AGENTS.md` for the measurements); the fixes are Workers Paid, fewer providers per solve, or lower thinking on the OpenCode routes.

## Upload support

Accepted: JPEG, PNG, WebP, GIF, PDF. HEIC/HEIF/TIFF are no longer accepted (the old server normalized them with ImageMagick; browsers cannot decode them on a canvas). iOS converts HEIC to JPEG automatically when picking photos, so iPhone uploads still work.

**PDFs: every page is sent, or the pages you choose.** When a PDF is added, the form reads its page count and shows it on the file's card, with a field for the pages to send (`1-3, 5`, `8-`; empty means every page). Each image counts one page, and one request carries at most 16 (`MAX_IMAGES`); past that the form says how many pages it has and will not solve until you choose. Until 26 September 2026 every PDF was cut to its first 8 pages without a word, so a 12-page paper lost its last four while the models answered the rest as if that were all. Lecture-notes PDFs are handled separately (`pdfToNotesPayload`): text pages are sent as text, and at most 8 image pages.

## Provider output safety

Provider responses can be messy despite `strict: true`. The pipeline in `shared/solution.ts` handles: control-character stripping, alternate JSON field names, `problems[]`-array shapes (every problem kept under its own heading, with steps, givens and formulas accepted as lists or objects - a whole exam paper comes back this way from models that ignore the schema), `<think>` reasoning left in the content, JSON-blob-inside-a-field repair, plain-text synthesis, LaTeX fence stripping, LaTeX-body-preferred display repair, labels such as "Given:" moved onto a line of their own only when they are run into a sentence (never out of a bullet or a bold), LaTeX commands whose backslash a JSON escape swallowed (`\rho` read as a carriage return and "ho" - `restoreSwallowedCommands`), and line breaks escaped twice (`\\n` in the JSON, which showed on the page as a literal "\n" with the lines run into one paragraph - `fixEscapedNewlines`, which leaves `\nu`, `\neq` and LaTeX's `\\` alone). A provider failure only fails that provider's tab.

Model output is also **untrusted input** — the uploaded images are user-supplied, so anything in them can steer what a model writes. Rendered markdown is sanitized with DOMPurify before it reaches the DOM (`src/lib/math-markdown.ts`), and with `HTMLRewriter` before the PDF browser gets it (`worker/pdf.ts`, which also runs that browser with JavaScript off and fetching nothing but KaTeX); KaTeX output is spliced in afterwards from placeholders (`shared/markdown.ts`) so the sanitizer never mangles generated math.

## Maintenance rules

- Keep provider keys server-side only. No key ever reaches the client, and no key ever goes in a URL or query string.
- Keep `/api/solve/:provider` streaming — the immediate SSE response is what makes long solves survivable on Workers.
- Do not turn one provider's failure into a whole-solve failure.
- Keep `delta` events limited to visible output; never forward reasoning/thinking fragments.
- Keep rendered model output sanitized before it hits `dangerouslySetInnerHTML`.
- Map thinking effort per route. Never send one enum to every model.
- Update this README whenever architecture, provider behavior, deployment, or error handling changes.
