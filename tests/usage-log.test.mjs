import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// The usage log (worker/usage.ts) through a real TaskJob, runner and task
// builder, with D1 replaced by a recorder.
const out = resolve(".wrangler/tests/usage-log.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({
  stdin: { contents: 'export * from "./worker/jobs"; export * from "./worker/usage";', resolveDir: process.cwd() },
  outfile: out, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "do-host", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
  } }],
});
const { TaskJob, describeRequest, questionFingerprint } = await import(pathToFileURL(out));

class Recorder {
  statements = [];
  failing = false;
  prepare(sql) {
    const db = this;
    return { bind: (...values) => ({
      async first() { if (db.failing) throw new Error("D1 down"); db.statements.push({ sql, values }); return { id: 7 }; },
      async run() { if (db.failing) throw new Error("D1 down"); db.statements.push({ sql, values }); return {}; },
    }) };
  }
}
class Storage {
  values = new Map();
  alarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) this.values.set(k, structuredClone(v)); }
  async setAlarm(time) { this.alarm = time; }
  async getAlarm() { return this.alarm; }
  async deleteAll() { this.values.clear(); }
}

const body = { images: ["data:image/png;base64,aW1hZ2U="], notes: "PRIVATE_NOTES", solution: "PRIVATE_SOLUTION", question: "Explain the support force." };
const originalFetch = globalThis.fetch;
let calls = 0;
beforeEach(() => {
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? Response.json({ error: { message: "Upstream request failed: Endpoint is unavailable." } }, { status: 502 })
      : Response.json({ output_text: JSON.stringify({ answer: "The support balances the load." }) });
  };
});
after(() => { globalThis.fetch = originalFetch; });

const make = () => {
  const usage = new Recorder();
  const env = { OPENCODE_API_KEY: "test-only", OPENCODE_BASE_URL: "https://mock.invalid", USAGE: usage };
  return { usage, job: new TaskJob({ storage: new Storage() }, env) };
};
const start = job => job.fetch(new Request("https://job/run?jobId=job-1&kind=ask&provider=chatgpt", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "x-usage-ip": "203.0.113.7", "x-usage-country": "HK" },
}));
const drain = async response => (await response.text()).split("\n\n").filter(Boolean);
// The start row is written without holding the task up: wait for it.
const settle = async usage => {
  for (let i = 0; i < 100 && !usage.statements.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
};

test("a task's row is written when it starts and completed with every upstream call counted", async () => {
  const { job, usage } = make();
  const stream = drain(await start(job));
  await settle(usage);
  const [insert] = usage.statements;
  assert.match(insert.sql, /^INSERT INTO usage_log/);
  const columns = insert.sql.match(/\(([^)]*)\)/)[1].split(",").map(name => name.trim());
  const row = Object.fromEntries(columns.map((name, i) => [name, insert.values[i]]));
  assert.equal(row.ip, "203.0.113.7");
  assert.equal(row.country, "HK");
  assert.equal(row.job_id, "job-1");
  assert.equal(row.kind, "ask");
  assert.equal(row.provider, "chatgpt");
  assert.equal(row.outcome, "running");
  assert.equal(row.question, await questionFingerprint(body.images));
  assert.equal(row.pages, 1);

  await job.alarm();
  await stream;
  const update = usage.statements.at(-1);
  assert.match(update.sql, /^UPDATE usage_log SET/);
  const [, , outcome, model, channel, modelCalls, effort, error, id] = update.values;
  assert.deepEqual({ outcome, model, channel, modelCalls, effort, error, id }, {
    outcome: "done", model: "gpt-6-luna", channel: "opencode", modelCalls: 2, effort: "high", error: null, id: 7,
  });
  // Metadata only.
  const logged = JSON.stringify(usage.statements.map(statement => statement.values));
  for (const content of [...body.images, body.notes, body.solution, body.question, "test-only"]) {
    assert.ok(!logged.includes(content), content);
  }
});

test("a Stop while queued is logged as cancelled, with no model call", async () => {
  const { job, usage } = make();
  const stream = drain(await start(job));
  await job.fetch(new Request("https://job/cancel", { method: "DELETE" }));
  await job.alarm();
  await stream;
  const update = usage.statements.at(-1);
  assert.equal(update.values[2], "cancelled");
  assert.equal(update.values[5], 0);
  assert.equal(calls, 0);
});

test("a log that cannot be written never fails the task", async () => {
  const { job, usage } = make();
  usage.failing = true;
  const stream = drain(await start(job));
  await job.alarm();
  const frames = await stream;
  assert.match(frames.at(-1), /^event: done/);
});

test("each request is described by its part, never its content", async () => {
  const pages = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"];
  const reading = await describeRequest("interpret", "glm", { images: pages, mode: "verify", effort: "medium" });
  assert.equal(reading.detail, "reconcile");
  assert.equal(reading.pages, 2);
  assert.equal((await describeRequest("interpret", "glm", { images: pages })).detail, "read");
  const notes = await describeRequest("study", "deepseek", { images: pages, kind: "approach", solutions: ["A", "B"], revision: { previous: "x", instructions: "y" } });
  assert.deepEqual([notes.detail, notes.solutions, notes.revision], ["approach", 2, true]);
  assert.equal((await describeRequest("judge", "mimo", { images: pages, solutions: ["A", "B", "C"], variant: "pro" })).solutions, 3);
  assert.equal((await describeRequest("align", "deepseek", { answers: ["1", "2"] })).solutions, 2);
  const same = await describeRequest("solve", "muse", { images: pages });
  assert.equal(same.question, reading.question);
  assert.notEqual((await describeRequest("solve", "muse", { images: pages.slice(0, 1) })).question, reading.question);
  assert.match(same.question, /^[0-9a-f]{16}$/);
});
