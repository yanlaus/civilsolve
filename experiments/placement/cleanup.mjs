import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const directory = resolve(".wrangler/placement-probe");
const { names } = JSON.parse(await readFile(resolve(directory, "session.json"), "utf8"));
const results = [];
for (const kind of ["edge", "placed", "receiver"]) {
  const name = names[kind];
  if (!new RegExp(`^civilsolve-geo-[a-f0-9]{6}-${kind}$`).test(name)) {
    throw new Error("Refusing to delete an unexpected Worker name.");
  }
  const configPath = resolve(directory, `${kind}.json`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.name !== name || config.account_id !== "adb105a3eddd1c60be3a66d47a5580ca") {
    throw new Error("Worker/account mismatch; nothing further deleted.");
  }
  const process = spawnSync(globalThis.process.execPath, [
    resolve("node_modules/wrangler/bin/wrangler.js"), "delete", name, "--config", configPath,
  ], { input: "y\n", encoding: "utf8", windowsHide: true, timeout: 45000 });
  console.log(process.stdout);
  if (process.stderr) console.error(process.stderr);
  results.push({ name, exitCode: process.status });
  await writeFile(resolve(directory, "cleanup-results.json"), JSON.stringify(results, null, 2));
  if (process.status !== 0) throw new Error(`Deletion failed for ${name}; session retained for retry.`);
}
for (const file of ["receiver-secrets.json", "probe-secrets.json", "session.json"]) {
  await unlink(resolve(directory, file));
}
console.log("All three diagnostic Workers deleted; temporary local secrets removed.");
