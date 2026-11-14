// Uploads the course method guides (course-guides/<subject>.md - gitignored,
// never committed: the repo is public and the guides come from the
// university's lecture notes) to R2, where the Worker reads them
// (worker/course-guides.ts): the PDFS bucket, key course-guides/<subject>.md.
//
//   npm run guides:upload          production bucket (needs `npx wrangler login`)
//   npm run guides:upload:local    the dev server's local bucket (.wrangler/state)
//
// Only files named after a subject in shared/subjects.ts are sent; a running
// isolate picks up a replaced guide within five minutes.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUCKET = "civilsolve-pdfs";
const SUBJECTS = ["steelwork", "temporary-works", "geotechnical", "other"];
const mode = process.argv.includes("--local") ? "--local" : process.argv.includes("--remote") ? "--remote" : null;
if (!mode) {
  console.error("Say where: --remote (production) or --local (npm run dev).");
  process.exit(1);
}

const folder = resolve("course-guides");
let files;
try {
  files = readdirSync(folder).filter((name) => SUBJECTS.includes(name.replace(/\.md$/, "")) && name.endsWith(".md"));
} catch {
  files = [];
}
if (!files.length) {
  console.error(`No guides in ${folder} (expected ${SUBJECTS.map((key) => `${key}.md`).join(", ")}).`);
  process.exit(1);
}

let failed = false;
for (const name of files) {
  const path = join(folder, name);
  console.log(`${name} (${statSync(path).size} bytes) -> ${BUCKET}/course-guides/${name} ${mode}`);
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${BUCKET}/course-guides/${name}`,
      "--file",
      path,
      // No "; charset=..." - with shell: true on Windows it would split; the
      // Worker reads the object as UTF-8 text either way.
      "--content-type",
      "text/markdown",
      mode,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
