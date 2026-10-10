import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Keep the real task builder, routing and runner. Only the DO host is replaced;
// runtime integration is covered by task-job-runtime.test.mjs.
const out = resolve(".wrangler/tests/task-job.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({
  stdin: { contents: 'export * from "./worker/jobs"; export * from "./worker/run"; export { buildTask } from "./worker/tasks";', resolveDir: process.cwd() },
  outfile: out, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "do-host", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
  } }],
});
const { TaskJob, JOB_RETENTION_MS, ALARM_TASK_TIMEOUT_MS, runTask, taskTimeoutFor, buildTask } = await import(pathToFileURL(out));
const env = { OPENCODE_API_KEY: "test-only", OPENCODE_BASE_URL: "https://mock.invalid" };
const body = { images: ["data:image/png;base64,aW1hZ2U="], notes: "PRIVATE_NOTES", solution: "PRIVATE_SOLUTION", question: "Explain the support force." };
const originalFetch = globalThis.fetch;
let calls = 0;
beforeEach(() => {
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ output_text: JSON.stringify({ answer: "The support balances the load." }) });
  };
});
after(() => { globalThis.fetch = originalFetch; });

class Storage {
  values = new Map();
  alarm = null;
  beforeAlarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) this.values.set(k, structuredClone(v));
  }
  async setAlarm(time) { await this.beforeAlarm?.(time); this.alarm = time; }
  async getAlarm() { return this.alarm; }
  async deleteAll() { this.values.clear(); }
}
const make = (storage = new Storage()) => ({ storage, job: new TaskJob({ storage }, env) });
const start = (job, provider = "muse") => job.fetch(new Request(`https://job/run?jobId=test&kind=ask&provider=${provider}`, { method: "POST", body: JSON.stringify(body) }));
const attach = job => job.fetch(new Request("https://job/attach"));
const stop = job => job.fetch(new Request("https://job/cancel", { method: "DELETE" }));
const events = async response => (await response.text()).split("\n\n").filter(frame => frame.includes("data: ")).map(frame => {
  const lines = frame.split("\n");
  return { type: lines.find(line => line.startsWith("event: ")).slice(7), ...JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)) };
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const params = (provider = "muse") => {
  const result = buildTask("ask", provider, body, env);
  assert.ok(result.params);
  return result.params;
};
const collect = async params => {
  const items = [];
  await runTask({ event: async e => { items.push(e); }, heartbeat() {}, close: async () => {} }, params);
  return items;
};

test("Muse waits for alarm; live SSE and reattachment share exactly one run", async () => {
  const { job, storage } = make();
  const first = events(await start(job));
  const second = events(await attach(job));
  assert.equal(calls, 0);
  assert.ok(storage.alarm <= Date.now());
  assert.equal((await start(job)).status, 409);
  await job.alarm();
  const a = await first, b = await second;
  assert.equal(a[0].type, "job");
  assert.equal(a.at(-1).type, "done");
  assert.deepEqual(a.at(-1), b.at(-1));
  assert.equal(calls, 1);
  assert.ok(storage.alarm >= Date.now() + JOB_RETENTION_MS - 1000);
  await job.alarm();
  assert.equal(calls, 1);
  assert.equal((await events(await attach(job))).at(-1).type, "done");
});

test("request images, notes, solution and credentials never enter storage", async () => {
  const { job, storage } = make();
  const result = events(await start(job));
  const check = () => {
    const stored = JSON.stringify([...storage.values]);
    for (const secret of [...body.images, body.notes, body.solution, env.OPENCODE_API_KEY]) assert.ok(!stored.includes(secret));
  };
  check();
  await job.alarm();
  await result;
  check();
});

test("Stop while queued stores Cancelled without calling upstream", async () => {
  const { job } = make();
  const result = events(await start(job));
  await stop(job);
  await job.alarm();
  assert.equal((await result).at(-1).message, "Cancelled.");
  assert.equal(calls, 0);
});

test("Stop after dispatch consumes the task but before runTask starts", async () => {
  const { job, storage } = make();
  const result = events(await start(job));
  const gate = deferred();
  storage.beforeAlarm = () => gate.promise;
  const alarm = job.alarm();
  await stop(job);
  gate.resolve();
  await alarm;
  assert.equal((await result).at(-1).message, "Cancelled.");
  assert.equal(calls, 0);
});

test("Stop during upstream fetch aborts it; alarm redelivery makes no extra call", async () => {
  const { job } = make();
  const called = deferred();
  globalThis.fetch = async (_url, init) => {
    calls++;
    called.resolve();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const result = events(await start(job));
  const alarm = job.alarm();
  await called.promise;
  await job.alarm();
  await stop(job);
  await alarm;
  assert.equal((await result).at(-1).message, "Cancelled.");
  assert.equal(calls, 1);
});

test("lost client can retrieve the same completed alarm result", async () => {
  const { job } = make();
  const first = await start(job);
  await first.body.cancel();
  await job.alarm();
  assert.equal((await events(await attach(job))).at(-1).type, "done");
  assert.equal(calls, 1);
});

test("reset before dispatch reports a lost job instead of replaying a model call", async () => {
  const { job, storage } = make();
  await (await start(job)).body.cancel();
  const restarted = make(storage).job;
  await restarted.alarm();
  const response = await attach(restarted);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /lost this job/);
  assert.equal(calls, 0);
  assert.ok(storage.alarm > Date.now());
});

test("reset after completion preserves the answer on a late dispatch alarm", async () => {
  const { job, storage } = make();
  const result = events(await start(job));
  await job.alarm();
  await result;
  const restarted = make(storage).job;
  await restarted.alarm();
  assert.equal((await events(await attach(restarted))).at(-1).type, "done");
  assert.equal(calls, 1);
});

test("retention cleanup handles new and legacy stored jobs", async () => {
  for (const expiresAt of [Date.now() - 1, undefined]) {
    const { job, storage } = make();
    await storage.put({ jobId: "expired", terminal: { type: "done" }, ...(expiresAt ? { expiresAt } : {}) });
    await job.alarm();
    assert.equal(storage.values.size, 0);
    assert.equal((await attach(job)).status, 404);
  }
});

test("failure to schedule dispatch sends an error without an upstream call", async () => {
  const { job, storage } = make();
  storage.beforeAlarm = time => { if (time <= Date.now()) throw new Error("scheduler unavailable"); };
  const result = await events(await start(job));
  assert.match(result.at(-1).message, /could not be scheduled/);
  assert.equal(calls, 0);
});

test("failure to set dispatch safety alarm stores an error without starting", async () => {
  const { job, storage } = make();
  const result = events(await start(job));
  let failed = false;
  storage.beforeAlarm = () => { if (!failed) { failed = true; throw new Error("storage unavailable"); } };
  await job.alarm();
  assert.match((await result).at(-1).message, /could not start/);
  assert.equal(calls, 0);
});

test("other providers still start from their HTTP handler", async () => {
  const { job } = make();
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ answer: "The support balances the load." }) }, finish_reason: "stop" }] });
  };
  assert.equal((await events(await start(job, "deepseek"))).at(-1).type, "done");
  assert.equal(calls, 1);
});

test("Muse timeout is capped below the alarm wall limit; other providers retain theirs", () => {
  const muse = params(), other = params("chatgpt");
  muse.task.images = Array(30).fill(body.images[0]);
  other.task.images = muse.task.images;
  assert.equal(taskTimeoutFor(muse), ALARM_TASK_TIMEOUT_MS);
  assert.ok(taskTimeoutFor(other) > ALARM_TASK_TIMEOUT_MS);
});

test("already cancelled task never calls upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal((await collect({ ...params(), signal: controller.signal })).at(-1).message, "Cancelled.");
  assert.equal(calls, 0);
});

test("dispatch beyond the original deadline times out without calling upstream", async () => {
  const result = await collect({ ...params(), deadlineAt: Date.now() - 1 });
  assert.equal(result.at(-1).timedOut, true);
  assert.equal(calls, 0);
});

test("a region refusal is reported once without retrying or changing models", async () => {
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { message: "This model is not available in your country." } }, { status: 403 });
  };
  const { job } = make();
  const result = events(await start(job));
  await job.alarm();
  const terminal = (await result).at(-1);
  assert.equal(terminal.type, "error");
  assert.match(terminal.message, /country restriction/);
  assert.doesNotMatch(terminal.message, /country you are in/);
  assert.equal(calls, 1);
});
