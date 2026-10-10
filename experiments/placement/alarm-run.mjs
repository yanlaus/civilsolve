import { readFile, writeFile } from "node:fs/promises";

const { names, token } = JSON.parse(await readFile(".wrangler/alarm-geography-probe/session.json", "utf8"));
const baseUrl = `https://${names.probe}.yanlaus.workers.dev`;
const resultPath = process.argv[2] ?? `.wrangler/alarm-geography-probe/results-${Date.now()}.json`;
async function call(path, method = "GET") {
  const response = await fetch(`${baseUrl}/${path}`, {
    method, headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.status === 204 ? null : response.json();
}
const results = process.argv[2] ? JSON.parse(await readFile(resultPath, "utf8")) : [];
for (const location of ["default", "wnam", "enam", "weur", "us", "eu"]) {
  if (results.some(result => result.location === location && result.id)) continue;
  const result = await call(location, "POST");
  results.push(result);
  await writeFile(resultPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ scheduled: location, clientCountry: result.clientCountry, baseline: result.baseline }));
}
console.log("All scheduling requests have ended. Waiting 25 seconds without contacting the objects.");
await new Promise(resolve => setTimeout(resolve, 25000));
for (const result of results) {
  const evidence = await call(`${result.location}/${result.id}`);
  Object.assign(result, evidence);
  result.retrievedAt = Date.now();
  result.storageCleared = false;
  if (result.alarmResult) {
    await call(`${result.location}/${result.id}`, "DELETE");
    result.storageCleared = true;
  }
  await writeFile(resultPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
}
if (results.some(result => !result.alarmResult || !result.storageCleared)) process.exitCode = 1;
