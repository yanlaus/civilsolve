// The question's course subject (shared/subjects.ts): the classifier's task
// and parser, the subject a request carries, and the course guide put first
// in the instructions of the tasks that solve, grade or explain
// (worker/course-guides.ts) - read from a stand-in for the R2 bucket.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const out = resolve(".wrangler/tests/course-guides.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({
  stdin: {
    contents:
      'export * from "./shared/subjects"; export * from "./worker/tasks"; export * from "./worker/course-guides"; export { buildClassifyPrompt, courseGuideInstructions, CLASSIFY_INSTRUCTIONS } from "./shared/prompt";',
    resolveDir: process.cwd(),
  },
  outfile: out, bundle: true, platform: "node", format: "esm",
});
const app = await import(pathToFileURL(out));

const image = "data:image/png;base64,aW1hZ2U=";
const GUIDE = "# Steelwork course guide\n- Design strength from the course table.";

/** A stand-in for the PDFS bucket: the keys it holds, and how often it was read. */
function bucket(objects) {
  const reads = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      return key in objects ? { text: async () => objects[key] } : null;
    },
  };
}

function envWith(objects = {}) {
  return { OPENCODE_API_KEY: "fake-go-key", PDFS: bucket(objects) };
}

beforeEach(() => app.clearCourseGuideCache());

test("the classifier's answer: JSON, a wrapper, words for a subject, prose on the last attempt", () => {
  assert.deepEqual(app.parseClassification('{"subject":"steelwork","confidence":"high","reason":"A UB beam."}', "deepseek"), {
    subject: "steelwork",
    confidence: "high",
    reason: "A UB beam.",
  });
  assert.equal(
    app.parseClassification('{"result":{"subject":"Temporary Works","confidence":"medium"}}', "deepseek").subject,
    "temporary-works",
  );
  assert.equal(app.parseClassification('```json\n{"subject":"geotech"}\n```', "deepseek").subject, "geotechnical");
  assert.equal(app.parseClassification('{"subject":"steelwork","confidence":"sure"}', "deepseek").confidence, "medium");
  assert.throws(() => app.parseClassification("It is about formwork pressure.", "deepseek"), /did not name/);
  assert.equal(
    app.parseClassification("This belongs to temporary-works.", "deepseek", { allowIncomplete: true }).subject,
    "temporary-works",
  );
});

test("the classify task: the pages and notes, at low, with every subject in its prompt", () => {
  const built = app.buildTask("classify", "deepseek", { images: [image], notes: "Q3 only" }, envWith());
  assert.ok("params" in built, built.error);
  const { params } = built;
  assert.equal(params.effort, "low");
  assert.equal(params.task.instructions, app.CLASSIFY_INSTRUCTIONS);
  assert.deepEqual(params.task.images, [image]);
  const prompt = params.task.prompt({ enforceShape: true, effort: "low" });
  for (const key of app.SUBJECT_KEYS) assert.ok(prompt.includes(`\`${key}\``), key);
  assert.ok(prompt.includes("Q3 only"));
  assert.ok(prompt.includes('{"subject": "steelwork"'));
  assert.deepEqual(params.finalize('{"subject":"other","confidence":"low","reason":""}', { lastAttempt: false }), {
    subject: { subject: "other", confidence: "low", reason: "" },
  });
  assert.equal(app.buildTask("classify", "deepseek", { images: [], notes: "" }, envWith()).status, 400);
});

test("a request's subject: carried on the task, refused when unknown", () => {
  const solve = app.buildTask("solve", "deepseek", { images: [image], notes: "", subject: "steelwork" }, envWith());
  assert.equal(solve.params.subject, "steelwork");
  const none = app.buildTask("solve", "deepseek", { images: [image], notes: "" }, envWith());
  assert.equal(none.params.subject, undefined);
  const bad = app.buildTask("solve", "deepseek", { images: [image], notes: "", subject: "hydraulics" }, envWith());
  assert.deepEqual(bad, { error: "Unknown subject.", status: 400 });
});

test("the guide goes first in a solve's instructions, with a status line, and is read once", async () => {
  const env = envWith({ "course-guides/steelwork.md": `\n${GUIDE}\n` });
  const built = app.buildTask("solve", "deepseek", { images: [image], notes: "", subject: "steelwork" }, env);
  const own = built.params.task.instructions;
  const guided = await app.applyCourseGuide("solve", built.params, env);
  assert.ok(guided.task.instructions.startsWith("COURSE METHOD GUIDE - Steelwork 鋼結構"));
  assert.ok(guided.task.instructions.includes(`<course_guide>\n${GUIDE}\n</course_guide>`));
  assert.ok(guided.task.instructions.endsWith(`\n\n${own}`));
  assert.equal(guided.notice, "Following the Steelwork 鋼結構 course method guide.");
  // The task's own instructions are untouched on the original.
  assert.equal(built.params.task.instructions, own);

  // The same prefix for the judge, the notes and a question: one cacheable start.
  const judge = app.buildTask(
    "judge",
    "deepseek",
    { images: [image], notes: "", subject: "steelwork", solutions: ["A", "B"] },
    env,
  );
  const judged = await app.applyCourseGuide("judge", judge.params, env);
  const prefix = app.courseGuideInstructions("Steelwork 鋼結構", GUIDE);
  assert.ok(judged.task.instructions.startsWith(prefix));
  assert.ok(guided.task.instructions.startsWith(prefix));
  assert.deepEqual(env.PDFS.reads, ["course-guides/steelwork.md"]);
});

test("no guide: a reading, a comparison, no subject, a subject with no guide, or no bucket", async () => {
  const env = envWith({ "course-guides/steelwork.md": GUIDE });
  const interpret = app.buildTask("interpret", "deepseek", { images: [image], notes: "", subject: "steelwork" }, env);
  assert.equal(await app.applyCourseGuide("interpret", interpret.params, env), interpret.params);

  const plain = app.buildTask("solve", "deepseek", { images: [image], notes: "" }, env);
  assert.equal(await app.applyCourseGuide("solve", plain.params, env), plain.params);

  const geo = app.buildTask("solve", "deepseek", { images: [image], notes: "", subject: "geotechnical" }, env);
  assert.equal(await app.applyCourseGuide("solve", geo.params, env), geo.params);

  const bare = { OPENCODE_API_KEY: "fake-go-key" };
  const steel = app.buildTask("solve", "deepseek", { images: [image], notes: "", subject: "steelwork" }, bare);
  assert.equal(await app.applyCourseGuide("solve", steel.params, bare), steel.params);
});

test("a guide that cannot be read is tried again by the next task; a long one is cut", async () => {
  let fail = true;
  const env = {
    OPENCODE_API_KEY: "fake-go-key",
    PDFS: {
      async get() {
        if (fail) throw new Error("R2 down");
        return { text: async () => "x".repeat(app.MAX_GUIDE_CHARS + 500) };
      },
    },
  };
  assert.equal(await app.loadCourseGuide(env, "steelwork"), null);
  fail = false;
  assert.equal((await app.loadCourseGuide(env, "steelwork")).length, app.MAX_GUIDE_CHARS);
});
