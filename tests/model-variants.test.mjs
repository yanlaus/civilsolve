import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const out = resolve(".wrangler/tests/model-variants.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({
  stdin: { contents: 'export * from "./shared/providers"; export * from "./worker/channels"; export * from "./worker/tasks"; export * from "./src/lib/presets"; export * from "./src/lib/effort-band"; export * from "./worker/run"; export * from "./src/lib/run-store";', resolveDir: process.cwd() },
  outfile: out, bundle: true, platform: "node", format: "esm",
});
const app = await import(pathToFileURL(out));
const env = { OPENCODE_API_KEY: "fake-go-key", POE_API_KEY: "fake-poe-key", GOOGLE_API_KEY: "fake-google-key" };
const image = "data:image/png;base64,aW1hZ2U=";
const body = { images: [image], solution: "The support balances the load.", question: "Explain the reaction.", solutions: ["A", "B"], answers: ["A", "B"] };
const route = (variant, config = env) => app.resolveRoute("claude", config, app.variantOverride("claude", variant, config));

test("Muse replaces standalone Haiku in both presets and remains an alarm solver", () => {
  assert.deepEqual(app.DEFAULT_SOLVERS, ["muse", "deepseek", "gemini"]);
  for (const mode of ["quick", "careful"]) assert.deepEqual(app.PRESETS[mode].providers, app.DEFAULT_SOLVERS);
  assert.equal(app.DEFAULT_MODE, "quick");
  assert.equal(app.SOLVER_KEYS.length, 9);
  assert.ok(app.SOLVER_KEYS.includes("muse"));
  assert.ok(!app.SOLVER_KEYS.includes("haiku"));
  assert.equal(app.SOLUTION_ORDER[0], "muse");
  const task = app.buildTask("solve", "muse", body, env);
  assert.ok(task.params);
  assert.equal(app.resolveRoute(task.params.provider, env, task.params.routeOverride).startInAlarm, true);
});

test("Claude menu has one Haiku and one Opus, with variant-aware credit labels", () => {
  assert.deepEqual(app.MODEL_CHOICES.filter(c => c.provider === "claude").map(app.choiceKey), ["claude:haiku", "claude:opus"]);
  assert.ok(!app.MODEL_CHOICES.some(c => c.provider === "haiku"));
  assert.equal(app.usesMoreCredit("claude", "haiku"), false);
  assert.equal(app.usesMoreCredit("claude", "opus"), true);
  assert.equal(app.usesMoreCredit("grok"), true);
  assert.equal(app.usesMoreCredit("muse"), false);
  assert.equal(app.providerDisplayName("claude", "haiku"), "Claude Haiku");
  assert.equal(app.providerDisplayName("claude", "opus"), "Claude Opus");
});

test("Haiku and Opus use their own channel, dialect, key, model and effort", () => {
  const haiku = route("haiku"), opus = route("opus");
  assert.equal(haiku.channel, "opencode");
  assert.equal(haiku.dialect, "messages");
  assert.equal(haiku.apiKey, env.OPENCODE_API_KEY);
  assert.equal(haiku.model, "claude-haiku-5-5");
  assert.equal(haiku.minEffort, "high");
  assert.equal(haiku.timeoutMs, 20 * 60000);
  assert.equal(opus.channel, "poe");
  assert.equal(opus.dialect, "responses");
  assert.equal(opus.apiKey, env.POE_API_KEY);
  assert.equal(opus.model, "claude-opus-4.8");
  assert.equal(opus.minEffort, undefined);
});

test("missing one account disables only its Claude model and reports its effort band", () => {
  for (const [config, available, unavailable] of [[{ OPENCODE_API_KEY: "fake" }, "haiku", "opus"], [{ POE_API_KEY: "fake" }, "opus", "haiku"]]) {
    const status = app.routeStatus("claude", config);
    assert.equal(app.modelStatus(status, available).configured, true);
    assert.equal(app.modelStatus(status, unavailable).configured, false);
  }
  const status = app.routeStatus("claude", env);
  assert.equal(app.effortBand(app.modelStatus(status, "haiku")).clamp("medium"), "high");
  assert.equal(app.effortBand(app.modelStatus(status, "opus")).clamp("medium"), "medium");
  assert.ok(!JSON.stringify(status).includes("fake-"));
});

test("all task kinds honour an explicit Claude variant, including interpretation overrides", () => {
  for (const kind of ["solve", "interpret", "judge", "study", "ask", "align"]) {
    for (const variant of ["haiku", "opus"]) {
      const built = app.buildTask(kind, "claude", { ...body, variant, ...(kind === "study" ? { kind: "explain", solutions: ["A"] } : {}) }, env);
      assert.ok(built.params, `${kind}: ${JSON.stringify(built)}`);
      const resolved = app.resolveRoute("claude", env, built.params.routeOverride);
      assert.equal(resolved.model, variant === "haiku" ? "claude-haiku-5-5" : "claude-opus-4.8");
    }
  }
  for (const [provider, variant] of [["claude", "flash"], ["gemini", "haiku"], ["muse", "opus"]]) {
    assert.equal(app.buildTask("solve", provider, { ...body, variant }, env).status, 400);
  }
});

test("explicit picks keep the right model even with legacy channel and model overrides", () => {
  const custom = { ...env, CLAUDE_CHANNEL: "poe", OPENCODE_HAIKU_MODEL: "haiku-test", POE_CLAUDE_MODEL: "opus-test" };
  assert.equal(route("haiku", custom).model, "haiku-test");
  assert.equal(route("opus", { ...custom, CLAUDE_CHANNEL: "opencode" }).model, "opus-test");
});

test("old Haiku runs and old unversioned Claude picks retain their original models", () => {
  assert.ok(app.buildTask("solve", "haiku", body, env).params);
  assert.equal(app.resolveRoute("haiku", env).model, "claude-haiku-5-5");
  assert.equal(app.resolveRoute("claude", env).model, "claude-opus-4.8");
  assert.equal(app.providerDisplayName("claude"), "Claude Opus");
  assert.deepEqual(app.canonicalChoice({ provider: "haiku" }), { provider: "claude", variant: "haiku" });
  assert.deepEqual(app.canonicalChoice({ provider: "claude" }), { provider: "claude", variant: "opus" });
  const saved = { savedAt: Date.now(), providers: ["haiku", "claude"], solveJobs: { haiku: "old-job", claude: "opus-job" }, judge: null };
  globalThis.window = { localStorage: { getItem: () => JSON.stringify(saved) } };
  try { assert.deepEqual(app.loadRun(), saved); } finally { delete globalThis.window; }
});

test("Gemini keeps its Flash/Pro models and backup account behavior", () => {
  assert.deepEqual(app.PROVIDER_VARIANTS.gemini.map(v => v.shortLabel), ["Flash", "Pro"]);
  const config = { GOOGLE_BACKUP_API_KEY: "fake-backup" };
  const pro = app.resolveRoute("gemini", config, app.variantOverride("gemini", "pro", config));
  assert.equal(pro.channel, "google-backup");
  assert.equal(pro.model, "gemini-3.1-pro-preview");
  assert.equal(app.routeStatus("gemini", env).variants.flash, "gemini-3.8-flash");
});

test("real runner sends native vision and Haiku's effort through Messages, Opus through Responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const variant of ["haiku", "opus"]) {
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        const sent = JSON.parse(init.body);
        assert.match(JSON.stringify(sent), /aW1hZ2U=/);
        if (variant === "haiku") {
          assert.match(url, /\/messages$/);
          assert.equal(sent.model, "claude-haiku-5-5");
          assert.equal(sent.output_config.effort, "xhigh");
          assert.equal(sent.messages[0].content[0].type, "image");
          return Response.json({ content: [{ type: "text", text: JSON.stringify({ answer: "The load is balanced." }) }], stop_reason: "end_turn" });
        }
        assert.match(url, /poe\.com\/v1\/responses$/);
        assert.equal(sent.model, "claude-opus-4.8");
        return Response.json({ output_text: JSON.stringify({ answer: "The load is balanced." }) });
      };
      const built = app.buildTask("ask", "claude", { ...body, variant, effort: "medium" }, env);
      const events = [];
      await app.runTask({ event: async e => events.push(e), heartbeat() {}, close: async () => {} }, built.params);
      assert.equal(events.at(-1).type, "done", events.at(-1).message);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});
