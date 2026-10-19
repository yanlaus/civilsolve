import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// The question's pages kept on the server (worker/questions.ts): written once
// per question, deleted 24 hours after its last task, kept for good once a
// PDF was made. R2 and the Durable Object host are stand-ins.
const out = resolve(".wrangler/tests/question-store.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({
  stdin: { contents: 'export * from "./worker/questions";', resolveDir: process.cwd() },
  outfile: out, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "do-host", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
  } }],
});
const { QuestionStore, storeQuestionPages, QUESTION_RETENTION_MS } = await import(pathToFileURL(out));

class Bucket {
  objects = new Map();
  puts = 0;
  async put(key, bytes, options) { this.puts++; this.objects.set(key, { bytes, options }); }
  async list({ prefix }) {
    return { objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false };
  }
  async delete(keys) { for (const key of [keys].flat()) this.objects.delete(key); }
}
class Storage {
  values = new Map();
  alarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) this.values.set(k, structuredClone(v)); }
  async setAlarm(time) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
  async deleteAll() { this.values.clear(); this.alarm = null; }
}
/** One object per name, its calls one at a time - as a Durable Object's are. */
function namespace(env) {
  const objects = new Map();
  return {
    objects,
    idFromName: name => name,
    get(name) {
      if (!objects.has(name)) {
        const storage = new Storage();
        const store = new QuestionStore({ storage }, env);
        let queue = Promise.resolve();
        const stub = new Proxy({}, { get: (_, method) => (...args) => (queue = queue.then(() => store[method](...args))) });
        objects.set(name, { store, storage, stub });
      }
      return objects.get(name).stub;
    },
  };
}
const setup = () => {
  const env = { PDFS: new Bucket() };
  env.QUESTIONS = namespace(env);
  return env;
};
const page = text => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`;
const question = "0123456789abcdef";
const pages = [page("page one"), page("page two")];
const notes = [page("lecture notes")];

test("three tasks of one question started at once write one copy", async () => {
  const env = setup();
  await Promise.all([1, 2, 3].map(() => storeQuestionPages(env, question, pages, notes)));
  assert.deepEqual([...env.PDFS.objects.keys()].sort(), [
    "question/0123456789abcdef/n01.jpg",
    "question/0123456789abcdef/p01.jpg",
    "question/0123456789abcdef/p02.jpg",
  ]);
  assert.equal(env.PDFS.puts, 3);
  assert.equal(Buffer.from(env.PDFS.objects.get(`question/${question}/p02.jpg`).bytes).toString(), "page two");
  assert.equal(env.PDFS.objects.get(`question/${question}/p01.jpg`).options.httpMetadata.contentType, "image/jpeg");
});

test("a reading sent without the notes does not stop a solve sent with them from writing them", async () => {
  const env = setup();
  await Promise.all([storeQuestionPages(env, question, pages, []), storeQuestionPages(env, question, pages, notes)]);
  assert.deepEqual([...env.PDFS.objects.keys()].sort(), [
    "question/0123456789abcdef/n01.jpg",
    "question/0123456789abcdef/p01.jpg",
    "question/0123456789abcdef/p02.jpg",
  ]);
  assert.equal(env.PDFS.puts, 3);
});

test("pages already there are not written again; notes that come later are", async () => {
  const env = setup();
  await storeQuestionPages(env, question, pages, []);
  assert.equal(env.PDFS.puts, 2);
  await storeQuestionPages(env, question, pages, []);
  assert.equal(env.PDFS.puts, 2);
  await storeQuestionPages(env, question, pages, notes);
  assert.equal(env.PDFS.puts, 3);
  assert.ok(env.PDFS.objects.has(`question/${question}/n01.jpg`));
});

test("the pages go 24 hours after the last task, unless a PDF kept them", async () => {
  const env = setup();
  const before = Date.now();
  await storeQuestionPages(env, question, pages, notes);
  const { store, storage } = env.QUESTIONS.objects.get(question);
  assert.ok(storage.alarm >= before + QUESTION_RETENTION_MS);
  await store.alarm();
  assert.equal(env.PDFS.objects.size, 0);
  assert.equal(storage.values.size, 0);

  const kept = setup();
  await storeQuestionPages(kept, question, pages, notes);
  const object = kept.QUESTIONS.objects.get(question);
  const bytes = await object.store.keep();
  assert.equal(bytes, "page one".length + "page two".length + "lecture notes".length);
  assert.equal(await object.store.keep(), 0);
  assert.equal(object.storage.alarm, null);
  await object.store.alarm();
  assert.equal(kept.PDFS.objects.size, 3);
  assert.deepEqual(await object.store.info(), { kept: true, deleteAt: null });
});

test("only images are written, and nothing without a fingerprint or a bucket", async () => {
  const env = setup();
  await storeQuestionPages(env, question, ["data:text/html;base64,PHNjcmlwdD4=", page("ok")], []);
  assert.deepEqual([...env.PDFS.objects.keys()], [`question/${question}/p02.jpg`]);
  await storeQuestionPages(env, "not-a-fingerprint", pages, []);
  await storeQuestionPages({ QUESTIONS: env.QUESTIONS }, question, pages, []);
  assert.equal(env.PDFS.objects.size, 1);
});
