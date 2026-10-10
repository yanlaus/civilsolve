// Isolated runtime fixture: production TaskJob, no provider credentials.
export { TaskJob } from "../../worker/jobs";

export default {
  async fetch(request: Request, env: { JOBS: DurableObjectNamespace; TEST_TOKEN: string }) {
    if (request.headers.get("authorization") !== `Bearer ${env.TEST_TOKEN}`) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    const [id, action = "attach"] = url.pathname.slice(1).split("/");
    if (!/^[a-z0-9-]{1,80}$/.test(id) || !["run", "attach", "result", "cancel"].includes(action)) return new Response(null, { status: 400 });
    const target = new URL(`https://job/${action}`);
    target.searchParams.set("jobId", id);
    target.searchParams.set("kind", "ask");
    target.searchParams.set("provider", url.searchParams.get("provider") ?? "muse");
    const response = await env.JOBS.get(env.JOBS.idFromName(id), { locationHint: "wnam" }).fetch(target, {
      method: request.method, body: request.method === "POST" ? await request.text() : undefined,
    });
    const headers = new Headers(response.headers);
    headers.set("x-test-client-country", String(request.cf?.country ?? "unknown"));
    return new Response(response.body, { status: response.status, headers });
  },
};
