// Fake provider used only with the isolated production-TaskJob test fixture.
export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.TEST_TOKEN}`) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/responses", "/chat/completions"].includes(path)) return new Response(null, { status: 404 });
    await request.arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 1200));
    const content = JSON.stringify({ answer: JSON.stringify({ country: request.cf?.country, countryHeader: request.headers.get("cf-ipcountry"), colo: request.cf?.colo, callId: crypto.randomUUID() }) });
    return Response.json(path === "/responses" ? { output_text: content } : { choices: [{ message: { content }, finish_reason: "stop" }] });
  },
};
