import { DurableObject } from "cloudflare:workers";

const HINTS = new Set(["default", "wnam", "enam", "weur", "apac", "us", "eu"]);
const MUTATIONS = new Set(["baseline", "header-us", "declared-us", "cf-country-us"]);
const MODEL = "muse-spark-1.3-contributor";

function geography(request) {
  return {
    country: request.cf?.country ?? null,
    ingressColo: request.cf?.colo ?? null,
    placement: request.headers.get("cf-placement"),
  };
}

async function trace() {
  const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
    signal: AbortSignal.timeout(12000), redirect: "manual",
  });
  const fields = Object.fromEntries((await response.text()).trim().split("\n").map(line => line.split("=")));
  return { status: response.status, country: fields.loc ?? null, colo: fields.colo ?? null };
}

async function observe(env, mutation) {
  // Synthetic geography is sent only to the separate receiver owned by this account.
  const headers = new Headers({ authorization: `Bearer ${env.PROBE_TOKEN}` });
  if (mutation === "header-us") headers.set("cf-ipcountry", "US");
  if (mutation === "declared-us") headers.set("x-diagnostic-country", "US");
  const options = { headers, signal: AbortSignal.timeout(12000), redirect: "manual" };
  // Deliberately test an undocumented outbound key, without assuming it is supported.
  if (mutation === "cf-country-us") options.cf = { country: "US" };
  const response = await fetch(env.RECEIVER_URL, options);
  const body = await response.text();
  return { status: response.status, received: response.ok ? JSON.parse(body) : body.slice(0, 240) };
}

async function muse(env) {
  const started = Date.now();
  const response = await fetch("https://opencode.ai/zen/go/v1/responses", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "content-type": "application/json",
      "user-agent": "CivilSolve-placement-diagnostic/1.0",
      "x-opencode-session": crypto.randomUUID(),
    },
    body: JSON.stringify({ model: MODEL, input: "Reply with exactly the word OK. No explanation.", stream: false }),
  });
  const body = await response.text();
  let payload;
  try { payload = JSON.parse(body); } catch { payload = null; }
  const answer = payload?.output?.flatMap(item => item.content ?? [])
    .filter(item => item.type === "output_text").map(item => item.text).join("") ?? payload?.output_text ?? "";
  return {
    status: response.status, elapsedMs: Date.now() - started,
    answer: String(answer).slice(0, 120),
    error: response.ok ? null : String(payload?.error?.message ?? payload?.message ?? body).slice(0, 500),
  };
}

async function measured(operation) {
  try { return await operation(); }
  catch (error) { return { error: String(error.message ?? error).slice(0, 300) }; }
}

async function run(env, options) {
  const [outboundTrace, receiver] = await Promise.all([
    measured(trace), measured(() => observe(env, options.mutation)),
  ]);
  // Model calls never receive synthetic country headers or cf overrides.
  const model = options.muse ? await measured(() => muse(env)) : null;
  return { outboundTrace, receiver, model };
}

export class PlacementProbe extends DurableObject {
  async fetch(request) {
    const options = await request.json();
    return Response.json({ objectIncoming: geography(request), ...await run(this.env, options) });
  }
}

export default {
  async fetch(request, env) {
    if (!env.PROBE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.text();
    if (body.length > 1024) return new Response("Too large", { status: 413 });
    const options = JSON.parse(body);
    if (!HINTS.has(options.location) || !MUTATIONS.has(options.mutation) ||
        !["worker", "object"].includes(options.target) ||
        (options.muse && options.mutation !== "baseline")) {
      return new Response("Invalid test", { status: 400 });
    }
    const started = Date.now();
    const result = await measured(async () => {
      if (options.target === "worker") return run(env, options);
      let namespace = env.PROBES;
      if (options.location === "us" || options.location === "eu") {
        namespace = namespace.jurisdiction(options.location);
      }
      const id = namespace.idFromName(crypto.randomUUID());
      const hinted = !["default", "us", "eu"].includes(options.location);
      const stub = namespace.get(id, hinted ? { locationHint: options.location } : undefined);
      const response = await stub.fetch("https://probe/run", { method: "POST", body: JSON.stringify(options) });
      return response.json();
    });
    return Response.json({ incoming: geography(request), test: options, ...result, elapsedMs: Date.now() - started },
      { headers: { "cache-control": "no-store" } });
  },
};
