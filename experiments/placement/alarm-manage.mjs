import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory = resolve(".wrangler/alarm-geography-probe");
const action = process.argv[2];
if (action === "setup") {
  await mkdir(directory, { recursive: true });
  if (await access(resolve(directory, "session.json")).then(() => true, () => false)) throw new Error("Session already exists.");
  const suffix = randomBytes(3).toString("hex");
  const token = randomBytes(32).toString("hex");
  const names = { receiver: `civilsolve-alarm-${suffix}-receiver`, probe: `civilsolve-alarm-${suffix}-probe` };
  for (const kind of ["receiver", "probe"]) {
    const config = {
      account_id: "adb105a3eddd1c60be3a66d47a5580ca", name: names[kind], compatibility_date: "2026-07-01",
      main: resolve(`experiments/placement/${kind === "receiver" ? "receiver" : "alarm-probe"}.mjs`),
      workers_dev: true, preview_urls: false, observability: { enabled: false }, limits: { cpu_ms: 1000 },
    };
    if (kind === "probe") {
      config.durable_objects = { bindings: [{ name: "PROBES", class_name: "AlarmProbe" }] };
      config.migrations = [{ tag: "v1", new_sqlite_classes: ["AlarmProbe"] }];
      config.vars = { RECEIVER_URL: `https://${names.receiver}.yanlaus.workers.dev` };
    }
    await writeFile(resolve(directory, `${kind}.json`), JSON.stringify(config, null, 2));
  }
  await writeFile(resolve(directory, "secrets.json"), JSON.stringify({ PROBE_TOKEN: token }), { mode: 0o600 });
  await writeFile(resolve(directory, "session.json"), JSON.stringify({ names, token }), { mode: 0o600 });
  console.log(JSON.stringify({ names, modelCredentials: "none" }));
} else if (action === "cleanup") {
  const { names } = JSON.parse(await readFile(resolve(directory, "session.json"), "utf8"));
  const results = [];
  for (const kind of ["probe", "receiver"]) {
    const name = names[kind];
    const configPath = resolve(directory, `${kind}.json`);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!new RegExp(`^civilsolve-alarm-[a-f0-9]{6}-${kind}$`).test(name) || config.name !== name ||
        config.account_id !== "adb105a3eddd1c60be3a66d47a5580ca") throw new Error("Unexpected deletion target.");
    const result = spawnSync(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "delete", name,
      "--config", configPath], { input: "y\n", encoding: "utf8", windowsHide: true, timeout: 45000 });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    results.push({ name, exitCode: result.status });
    await writeFile(resolve(directory, "cleanup-results.json"), JSON.stringify(results, null, 2));
    if (result.status !== 0) throw new Error("Cleanup failed; session retained.");
  }
  await unlink(resolve(directory, "secrets.json"));
  await unlink(resolve(directory, "session.json"));
  console.log("Both diagnostic Workers and temporary credentials removed.");
} else throw new Error("Use setup or cleanup.");
