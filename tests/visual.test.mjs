// Visualize 圖解: the boards' parser, the pinned DeepSeek route, the request it
// sends (no response_format: the answer is not JSON), a fix merged into the
// deck, and the sandboxed document a board runs in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const out = resolve(".wrangler/tests/visual.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({
  stdin: {
    contents: 'export * from "./shared/visual"; export * from "./worker/tasks"; export * from "./worker/channels"; export * from "./worker/run"; export * from "./src/lib/board-document";',
    resolveDir: process.cwd(),
  },
  outfile: out, bundle: true, platform: "node", format: "esm",
});
const app = await import(pathToFileURL(out));

const env = { OPENCODE_API_KEY: "fake-go-key" };
const image = "data:image/png;base64,aW1hZ2U=";
const board = (title, html) => `<<<BOARD>>>\ntitle: ${title}\ntitle_zh: 標題\nnote: Look here\nnote_zh: 睇呢度\n<<<HTML>>>\n${html}\n<<<END>>>`;
// What JSON repairs would break: a script's "\n", a LaTeX \frac, a tab before "t".
const tricky = '<svg viewBox="0 0 10 10"></svg>\n<script type="module">\n\tconst label = "line one\\nline two";\n\tconst tex = String.raw`\\frac{a}{b}`;\n\ttext = 1;\n</script>';

test("boards are read between their markers, HTML untouched", () => {
  const raw = `Some preamble\n${board("The beam", tricky)}\n\n${board("The moment", "<div>two</div>")}`;
  const { boards } = app.parseVisual(raw, "deepseek");
  assert.equal(boards.length, 2);
  assert.deepEqual(
    { title: boards[0].title, title_zh: boards[0].title_zh, note: boards[0].note, note_zh: boards[0].note_zh },
    { title: "The beam", title_zh: "標題", note: "Look here", note_zh: "睇呢度" },
  );
  assert.equal(boards[0].html, tricky);
  assert.equal(boards[1].html, "<div>two</div>");
});

test("a fenced board, think tags, a cut-off last board and too many boards", () => {
  const fenced = board("Fenced", "```html\n<div>x</div>\n```");
  assert.equal(app.parseVisual(fenced, "deepseek").boards[0].html, "<div>x</div>");
  const thinking = `<think>${board("Draft", "<p>no</p>")}</think>${board("Kept", "<p>yes</p>")}`;
  assert.deepEqual(app.parseVisual(thinking, "deepseek").boards.map((b) => b.title), ["Kept"]);
  const cut = `${board("Whole", "<p>1</p>")}\n<<<BOARD>>>\ntitle: Half\n<<<HTML>>>\n<svg><path d="M0`;
  assert.deepEqual(app.parseVisual(cut, "deepseek").boards.map((b) => b.title), ["Whole"]);
  const many = Array.from({ length: 6 }, (_, i) => board(`B${i}`, `<p>${i}</p>`)).join("\n");
  assert.equal(app.parseVisual(many, "deepseek").boards.length, app.MAX_BOARDS);
});

test("no board throws while an attempt is left; bare HTML is kept on the last", () => {
  assert.throws(() => app.parseVisual("I cannot draw that.", "deepseek"), /returned no boards/);
  assert.throws(() => app.parseVisual("<<<BOARD>>>\ntitle: Half\n<<<HTML>>>\n<svg", "deepseek"), /cut off/);
  const bare = "<svg viewBox='0 0 1 1'><circle r='1'/></svg>";
  assert.throws(() => app.parseVisual(bare, "deepseek"));
  assert.equal(app.parseVisual(bare, "deepseek", { allowIncomplete: true }).boards[0].html, bare);
});

test("visualize runs on Muse Spark (the default) or DeepSeek V4.1 Flash on OpenCode Go only, whatever the env says", () => {
  assert.deepEqual([...app.VISUAL_PROVIDERS], ["muse", "deepseek"]);
  assert.equal(app.DEFAULT_VISUAL_PROVIDER, "muse");
  const body = { images: [image], notes: "", solutions: ["The solution."] };
  const overridden = {
    ...env,
    DEEPSEEK_CHANNEL: "poe",
    OPENCODE_DEEPSEEK_MODEL: "deepseek-other",
    MUSE_CHANNEL: "poe",
    OPENCODE_MUSE_MODEL: "muse-other",
  };
  const expected = {
    muse: { model: "muse-spark-1.3-contributor", dialect: "responses", startInAlarm: true, region: "wnam" },
    deepseek: { model: "deepseek-v4.1-flash", dialect: "chat-completions", startInAlarm: undefined, region: undefined },
  };
  for (const [provider, want] of Object.entries(expected)) {
    for (const config of [env, overridden]) {
      const built = app.buildTask("visualize", provider, body, config);
      assert.ok(built.params, JSON.stringify(built));
      const route = app.resolveRoute(provider, config, built.params.routeOverride);
      assert.equal(route.channel, "opencode", provider);
      for (const field of ["model", "dialect", "startInAlarm", "region"]) {
        assert.equal(route[field], want[field], `${provider}: ${field}`);
      }
      assert.equal(built.params.task.startSchema, "none");
      assert.equal(built.params.effort, "medium");
    }
  }
  for (const provider of ["chatgpt", "claude", "gemini", "kimi", "mimo"]) {
    assert.equal(app.buildTask("visualize", provider, body, env).status, 400, provider);
  }
  assert.equal(app.buildTask("visualize", "deepseek", { ...body, solutions: [] }, env).status, 400);
  assert.equal(app.buildTask("visualize", "deepseek", { ...body, images: [] }, env).status, 400);
});

test("the request carries no response_format, and the prompt the board format", () => {
  const built = app.buildTask("visualize", "deepseek", { images: [image], notes: "", solutions: ["R_A = 5 kN"] }, env);
  const { task } = built.params;
  const route = app.resolveRoute("deepseek", env, built.params.routeOverride);
  const request = app.buildRequest(route, { reasoning: true, schema: task.startSchema }, task, "medium", true);
  const sent = JSON.parse(request.body);
  assert.equal(sent.model, "deepseek-v4.1-flash");
  assert.equal(sent.response_format, undefined);
  assert.equal(sent.reasoning_effort, "medium");
  assert.ok(request.url.startsWith("https://opencode.ai/zen/go/v1/"));
  assert.ok(request.headers["x-opencode-session"]);
  const prompt = sent.messages[1].content[0].text;
  assert.match(prompt, /<<<BOARD>>>/);
  assert.match(prompt, /three@0\.160\.0\/build\/three\.module\.js/);
  assert.match(prompt, /R_A = 5 kN/);
  assert.doesNotMatch(sent.messages[0].content, /Return JSON/);
});

test("Muse Spark's request carries no text format either, and a deck gets the long timeout", () => {
  const body = { images: [image], notes: "", solutions: ["R_A = 5 kN"] };
  const built = app.buildTask("visualize", "muse", body, env);
  const { task } = built.params;
  const route = app.resolveRoute("muse", env, built.params.routeOverride);
  const sent = JSON.parse(app.buildRequest(route, { reasoning: true, schema: task.startSchema }, task, "medium", true).body);
  assert.equal(sent.model, "muse-spark-1.3-contributor");
  assert.equal(sent.text?.format, undefined);
  // Muse's route has the 280 s default; a deck gets 20 minutes, capped by the alarm ceiling.
  assert.equal(app.taskTimeoutFor(built.params), app.ALARM_TASK_TIMEOUT_MS);
  assert.equal(app.taskTimeoutFor(app.buildTask("visualize", "deepseek", body, env).params), 20 * 60_000);
  assert.equal(app.taskTimeoutFor(app.buildTask("ask", "muse", { ...body, solution: "S", question: "Why?" }, env).params), 280_000);
});

test("a fix draws one board and stores the whole deck with it in", () => {
  const deck = [
    { title: "One", title_zh: "一", note: "", note_zh: "", html: "<p>1</p>" },
    { title: "Two", title_zh: "二", note: "", note_zh: "", html: "<p>2</p>" },
  ];
  const body = { images: [image], notes: "", solutions: ["S"], fix: { board: 1, instructions: "Script error: x is not defined", boards: deck } };
  const built = app.buildTask("visualize", "deepseek", body, env);
  assert.ok(built.params, JSON.stringify(built));
  const prompt = built.params.task.prompt({ enforceShape: true, effort: "medium" });
  assert.match(prompt, /board 2 of 2/);
  assert.match(prompt, /<p>2<\/p>/);
  assert.match(prompt, /x is not defined/);
  const result = built.params.finalize(board("Two, fixed", "<p>2!</p>"), { lastAttempt: false });
  assert.equal(result.fixed, 1);
  assert.deepEqual(result.visual.boards.map((b) => b.title), ["One", "Two, fixed"]);
  for (const fix of [{ ...body.fix, board: 2 }, { ...body.fix, instructions: "" }, { ...body.fix, boards: [{ title: "x" }] }]) {
    assert.equal(app.buildTask("visualize", "deepseek", { ...body, fix }, env).status, 400);
  }
});

test("runTask sends no schema and delivers the boards", async () => {
  const built = app.buildTask("visualize", "deepseek", { images: [image], notes: "", solutions: ["S"] }, env);
  const events = [];
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: board("Only", "<p>ok</p>") }, finish_reason: "stop" }] });
  };
  try {
    const sink = { event: async (event) => { events.push(event); }, heartbeat: () => {}, close: async () => {} };
    const outcome = await app.runTask(sink, built.params);
    assert.equal(outcome.outcome, "done");
    assert.equal(outcome.model, "deepseek-v4.1-flash");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.response_format, undefined);
  const done = events.find((event) => event.type === "done");
  assert.deepEqual(done.visual.boards.map((b) => b.html), ["<p>ok</p>"]);
});

test("a board's document: the policy first, the bridge next, then the board", () => {
  const html = "<p>line 1</p>\n<script>boom()</script>";
  const doc = app.boardDocument(html, { generation: 7 });
  const csp = doc.indexOf("Content-Security-Policy");
  assert.ok(csp > 0 && csp < doc.indexOf("<script"), "the policy comes before any script");
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /default-src 'none'/);
  assert.ok(doc.indexOf("var GENERATION = 7") < doc.indexOf(html));
  // The board's first line is the document's line HEAD_LINES + 1.
  const headLines = Number(/var HEAD_LINES = (\d+)/.exec(doc)[1]);
  assert.equal(doc.split("\n")[headLines], "<p>line 1</p>");
  // Colours cannot break out of the style block.
  assert.doesNotMatch(app.boardDocument("", { generation: 1, palette: { ...app.DEFAULT_PALETTE, ink: "red;}</style><script>x()</script>" } }), /<\/style><script>x/);
});

test("reports read as facts, without repeats, and empty only once the board has loaded", () => {
  const lines = app.readBoardReports([
    { type: "error", text: "x is not defined (line 3 of the board's HTML)" },
    { type: "error", text: "x is not defined (line 3 of the board's HTML)" },
    { type: "blocked", text: "connect-src blocked https://example.com" },
    { type: "size", ready: false, height: 0, width: 600, overflowX: 0, empty: true },
  ]);
  assert.deepEqual(lines, ["Script error: x is not defined (line 3 of the board's HTML)", "The sandbox blocked it: connect-src blocked https://example.com"]);
  assert.match(app.readBoardReports([{ type: "size", ready: true, height: 0, width: 600, overflowX: 0, empty: true }])[0], /empty/);
  assert.match(app.readBoardReports([{ type: "size", ready: true, height: 300, width: 320, overflowX: 80, empty: false }])[0], /80 px wider/);
  assert.ok(app.isBoardMessage({ from: app.BOARD_MESSAGE, generation: 1, type: "error", text: "x" }));
  assert.ok(!app.isBoardMessage({ from: "elsewhere", generation: 1, type: "error" }));
});

test("stored boards are checked field by field", () => {
  const good = { title: "T", title_zh: "", note: "", note_zh: "", html: "<p>x</p>" };
  assert.deepEqual(app.readBoards([good]), [good]);
  assert.equal(app.readBoards([]), null);
  assert.equal(app.readBoards([{ ...good, html: "" }]), null);
  assert.equal(app.readBoards([{ ...good, html: 5 }]), null);
  assert.equal(app.readBoards(Array(app.MAX_BOARDS + 1).fill(good)), null);
  assert.deepEqual(app.mergeFixedBoard([good, good], 0, { ...good, title: "New" }).map((b) => b.title), ["New", "T"]);
});
