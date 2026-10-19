import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// A solution's PDF is named by its date, model, problem and "Solution"
// (shared/file-names.ts) - the server's PDFs and "Print instead" alike.
const out = resolve(".wrangler/tests/file-names.mjs");
await mkdir(resolve(".wrangler/tests"), { recursive: true });
await build({ entryPoints: ["shared/file-names.ts"], outfile: out, bundle: true, platform: "node", format: "esm" });
const { hongKongDate, solutionFileName } = await import(pathToFileURL(out));

// 18 October 2026, 17:30 UTC: already the 19th in Hong Kong.
const at = Date.UTC(2026, 9, 18, 17, 30);

test("the date is the Hong Kong day", () => {
  assert.equal(hongKongDate(at), "2026-10-19");
  assert.equal(hongKongDate(Date.UTC(2026, 9, 18, 15, 59)), "2026-10-18");
});

test("a solution is named by date, model, problem and Solution", () => {
  assert.equal(
    solutionFileName({ at, model: "deepseek-v4.1-flash", problem: "Simply supported beam reactions" }),
    "2026-10-19_deepseek-v4.1-flash_Simply-supported-beam-reactions_Solution",
  );
  // LaTeX and symbols in a model-written title.
  assert.equal(
    solutionFileName({ at, model: "gpt-6-luna", problem: "Forces on a $90^\\circ$ pipe bend (Q3)" }),
    "2026-10-19_gpt-6-luna_Forces-on-a-90-pipe-bend-Q3_Solution",
  );
});

test("an unknown part is left out, never called a verified answer", () => {
  assert.equal(solutionFileName({ at, model: "mimo-v2.6-pro" }), "2026-10-19_mimo-v2.6-pro_Solution");
  assert.equal(solutionFileName({ at, problem: "樑的反力" }), "2026-10-19_Solution");
  const long = solutionFileName({ at, model: "claude-opus-4.8", problem: "word ".repeat(40) });
  assert.match(long, /^2026-10-19_claude-opus-4\.8_(word-)+word_Solution$/);
  assert.ok(long.split("_")[2].length <= 60);
  assert.doesNotMatch(long, /verified/i);
});
