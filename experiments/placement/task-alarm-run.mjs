import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const { names, token } = JSON.parse(await readFile(".wrangler/task-alarm-probe/session.json", "utf8"));
const base = `https://${names.probe}.yanlaus.workers.dev`;
const body = JSON.stringify({ images: ["data:image/png;base64,aW1hZ2U="], solution: "A support balances the load.", question: "Explain the support." });
const results = [];
const call = async (path, method = "GET") => {
  const response = await fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(method === "POST" ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, method === "DELETE" ? 204 : 200, await (response.ok ? Promise.resolve("") : response.text()));
  return response;
};
const events = async response => (await response.text()).split("\n\n").filter(frame => frame.includes("data: ")).map(frame => {
  const lines = frame.split("\n");
  return { type: lines.find(line => line.startsWith("event: ")).slice(7), ...JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)) };
});
for (const scenario of ["http-control", "alarm-live", "alarm-disconnect", "alarm-stop"]) {
  const id = randomUUID();
  const response = await call(`${id}/run?provider=${scenario === "http-control" ? "deepseek" : "muse"}`, "POST");
  const clientCountry = response.headers.get("x-test-client-country");
  let received;
  if (scenario === "alarm-disconnect") {
    await response.body.cancel();
    await new Promise(resolve => setTimeout(resolve, 2000));
    received = await events(await call(`${id}/attach`));
  } else {
    const reading = events(response);
    if (scenario === "alarm-stop") await call(`${id}/cancel`, "DELETE");
    received = await reading;
  }
  const terminal = received.at(-1);
  assert.equal(terminal.type, scenario === "alarm-stop" ? "error" : "done", JSON.stringify(terminal));
  if (scenario === "alarm-stop") assert.equal(terminal.message, "Cancelled.");
  const replay = (await events(await call(`${id}/attach`))).at(-1);
  assert.deepEqual(replay, terminal);
  const result = { scenario, clientCountry, terminal, reattachedSameAnswer: true };
  results.push(result);
  await writeFile(".wrangler/task-alarm-probe/results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
}
