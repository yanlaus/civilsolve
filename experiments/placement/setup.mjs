import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const directory = resolve(".wrangler/placement-probe");
await mkdir(directory, { recursive: true });
const active = await access(resolve(directory, "session.json")).then(() => true, () => false);
if (active) throw new Error("An experiment session already exists. Clean it up before creating another.");
const suffix = randomBytes(3).toString("hex");
const token = randomBytes(32).toString("hex");
const vars = await readFile(".dev.vars", "utf8");
const match = vars.match(/^\s*OPENCODE_API_KEY\s*=\s*(.*?)\s*$/m);
if (!match) throw new Error("OPENCODE_API_KEY is missing; no secrets written.");
const key = match[1].replace(/^(["'])(.*)\1$/, "$2");
const names = Object.fromEntries(["receiver", "edge", "placed"].map(kind => [kind, `civilsolve-geo-${suffix}-${kind}`]));
const common = {
  account_id: "adb105a3eddd1c60be3a66d47a5580ca", compatibility_date: "2026-07-01",
  workers_dev: true, preview_urls: false, observability: { enabled: false },
  limits: { cpu_ms: 1000 },
};
for (const kind of ["receiver", "edge", "placed"]) {
  const config = { ...common, name: names[kind],
    main: resolve(`experiments/placement/${kind === "receiver" ? "receiver" : "probe"}.mjs`) };
  if (kind !== "receiver") {
    config.durable_objects = { bindings: [{ name: "PROBES", class_name: "PlacementProbe" }] };
    config.migrations = [{ tag: "v1", new_sqlite_classes: ["PlacementProbe"] }];
    config.vars = { RECEIVER_URL: `https://${names.receiver}.yanlaus.workers.dev` };
  }
  if (kind === "placed") config.placement = { region: "aws:us-east-1" };
  await writeFile(resolve(directory, `${kind}.json`), JSON.stringify(config, null, 2));
}
await writeFile(resolve(directory, "receiver-secrets.json"), JSON.stringify({ PROBE_TOKEN: token }), { mode: 0o600 });
await writeFile(resolve(directory, "probe-secrets.json"), JSON.stringify({ PROBE_TOKEN: token, OPENCODE_API_KEY: key }), { mode: 0o600 });
await writeFile(resolve(directory, "session.json"), JSON.stringify({ names, token }), { mode: 0o600 });
console.log(JSON.stringify({ names, configDirectory: directory, secrets: "stored only in ignored .wrangler directory" }));
