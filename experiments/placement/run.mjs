import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { names, token } = JSON.parse(await readFile(".wrangler/placement-probe/session.json", "utf8"));
const batch = process.argv[2] ?? "locations";
const cases = [];
if (batch === "locations") {
  for (const worker of ["edge", "placed"]) {
    cases.push({ worker, target: "worker", location: "default", mutation: "baseline", muse: false });
    for (const location of ["default", "wnam", "enam", "weur", "us", "eu"]) {
      cases.push({ worker, target: "object", location, mutation: "baseline", muse: false });
    }
  }
} else if (batch === "headers") {
  for (const target of ["object"]) {
    for (const mutation of ["baseline", "header-us", "declared-us", "cf-country-us"]) {
      cases.push({ worker: "edge", target, location: target === "object" ? "enam" : "default", mutation, muse: false });
    }
  }
} else if (batch === "muse") {
  for (const location of ["default", "wnam", "enam", "weur", "us"]) {
    cases.push({ worker: "edge", target: "object", location, mutation: "baseline", muse: true });
  }
  cases.push({ worker: "placed", target: "worker", location: "default", mutation: "baseline", muse: true });
} else throw new Error("Unknown test batch");

const results = [];
const resultPath = resolve(`.wrangler/placement-probe/${batch}-${Date.now()}.json`);
for (const test of cases) {
  const { worker, ...body } = test;
  try {
    const response = await fetch(`https://${names[worker]}.yanlaus.workers.dev`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000), redirect: "error",
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { error: text.slice(0, 300) }; }
    results.push({ worker, httpStatus: response.status, ...result });
  } catch (error) { results.push({ ...test, error: error.message }); }
  await writeFile(resultPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
