import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const { outputFiles: [bundle] } = await build({ entryPoints: ["tests/fixtures/task-job-worker.ts"], bundle: true, write: false, format: "esm", external: ["cloudflare:workers"] });
const body = JSON.stringify({ images: ["data:image/png;base64,aW1hZ2U="], solution: "A force is balanced by the support.", question: "Why is it balanced?" });

test("real Workers runtime: alarm delivers SSE, survives disconnect, and honours Stop", { timeout: 30000 }, async () => {
  let calls = 0;
  const runtime = new Miniflare({
    modules: true, script: bundle.text, compatibilityDate: "2026-07-01",
    durableObjects: { JOBS: { className: "TaskJob", useSQLite: true } },
    bindings: { TEST_TOKEN: "local-only", OPENCODE_API_KEY: "fake-provider-key", OPENCODE_BASE_URL: "https://mock.invalid" },
    outboundService: async request => {
      calls++;
      assert.equal(new URL(request.url).hostname, "mock.invalid");
      await new Promise(resolve => setTimeout(resolve, 150));
      return Response.json({ output_text: JSON.stringify({ answer: "The support balances the load." }) });
    },
  });
  const call = (path, method = "GET") => runtime.dispatchFetch(`https://test/${path}`, {
    method, headers: { authorization: "Bearer local-only" }, ...(method === "POST" ? { body } : {}),
  });
  try {
    const first = await call("live/run", "POST");
    assert.equal(first.status, 200);
    const stream = await first.text();
    assert.match(stream, /event: job/);
    assert.match(stream, /event: done/);
    assert.equal(calls, 1);
    assert.match(await (await call("live/attach")).text(), /event: done/);
    assert.equal(calls, 1);

    const lost = await call("disconnected/run", "POST");
    await lost.body.cancel();
    assert.match(await (await call("disconnected/attach")).text(), /event: done/);
    assert.equal(calls, 2);

    const stopped = await call("stopped/run", "POST");
    const terminal = stopped.text();
    await call("stopped/cancel", "DELETE");
    const stoppedText = await terminal;
    assert.match(stoppedText, /Cancelled\./);
    assert.doesNotMatch(stoppedText, /event: done/);
    const result = await (await call("stopped/result")).json();
    assert.equal(result.terminal.message, "Cancelled.");
  } finally {
    await runtime.dispose();
  }
});
