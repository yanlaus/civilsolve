export default {
  async fetch(request, env) {
    if (!env.PROBE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    return Response.json({
      country: request.cf?.country ?? null,
      colo: request.cf?.colo ?? null,
      countryHeader: request.headers.get("cf-ipcountry"),
      declaredCountry: request.headers.get("x-diagnostic-country"),
      workerSubrequest: request.headers.has("cf-worker"),
    }, { headers: { "cache-control": "no-store" } });
  },
};
