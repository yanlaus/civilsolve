import { DurableObject } from "cloudflare:workers";

const LOCATIONS = new Set(["default", "wnam", "enam", "weur", "us", "eu"]);

async function capture(env) {
  async function measured(operation) {
    try { return await operation(); }
    catch (error) { return { error: String(error.message ?? error).slice(0, 240) }; }
  }
  const [trace, receiver] = await Promise.all([
    measured(async () => {
      const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
        redirect: "manual", signal: AbortSignal.timeout(10000),
      });
      const fields = Object.fromEntries((await response.text()).trim().split("\n").map(line => line.split("=")));
      return { status: response.status, country: fields.loc ?? null, colo: fields.colo ?? null };
    }),
    measured(async () => {
      const response = await fetch(env.RECEIVER_URL, {
        headers: { authorization: `Bearer ${env.PROBE_TOKEN}` },
        redirect: "manual", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { status: response.status, error: (await response.text()).slice(0, 240) };
      return { status: response.status, ...await response.json() };
    }),
  ]);
  return { trace, receiver };
}

export class AlarmProbe extends DurableObject {
  async fetch(request) {
    if (request.method === "POST") {
      if (await this.ctx.storage.get("baseline")) return new Response("Already scheduled", { status: 409 });
      const baseline = await capture(this.env);
      const scheduledAt = Date.now() + 15000;
      await this.ctx.storage.put({ baseline, scheduledAt });
      await this.ctx.storage.setAlarm(scheduledAt);
      return Response.json({ baseline, scheduledAt });
    }
    if (request.method === "DELETE") {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    // Retrieval reads stored evidence; it never makes an outbound request.
    return Response.json(Object.fromEntries(await this.ctx.storage.list()));
  }

  async alarm(info) {
    if (await this.ctx.storage.get("alarmResult")) return;
    const firedAt = Date.now();
    const result = await capture(this.env);
    await this.ctx.storage.put("alarmResult", {
      firedAt, completedAt: Date.now(), retryCount: info?.retryCount ?? null, ...result,
    });
  }
}

export default {
  async fetch(request, env) {
    if (!env.PROBE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    const [location, objectId] = segments;
    if (!LOCATIONS.has(location) || segments.length > 2) return new Response("Invalid location", { status: 400 });
    let namespace = env.PROBES;
    if (location === "us" || location === "eu") namespace = namespace.jurisdiction(location);
    if (request.method === "POST" && !objectId) {
      const id = namespace.idFromName(crypto.randomUUID());
      const options = ["default", "us", "eu"].includes(location) ? undefined : { locationHint: location };
      const response = await namespace.get(id, options).fetch("https://probe/schedule", { method: "POST" });
      return Response.json({
        id: id.toString(), location, clientCountry: request.cf?.country ?? null, ...await response.json(),
      });
    }
    if (!objectId || !/^[a-f0-9]{64}$/.test(objectId) || !["GET", "DELETE"].includes(request.method)) {
      return new Response("Invalid result request", { status: 400 });
    }
    return namespace.get(namespace.idFromString(objectId)).fetch("https://probe/result", { method: request.method });
  },
};
