# TaskJob alarm integration — 11 October 2026

The production `TaskJob` implementation now dispatches Muse/OpenCode tasks from `alarm()`, at the owner's request. This report covers an isolated deployment of that code, not a CivilSolve production deployment.

## What was tested

The fixture imports the actual `worker/jobs.ts`, task builder, routing and runner. Its only upstream is an authenticated fake model Worker; neither deployment has real model credentials. A synthetic image string and question exercise `/ask`. No student data or model calls were used.

| Scenario | Client country | Country received upstream | Result |
|---|---|---|---|
| DeepSeek route, HTTP control | JP | JP | SSE completed |
| Muse route, alarm, client still connected | JP | US | SSE completed |
| Muse route, alarm, client disconnected | JP | US | Same answer recovered |
| Muse route, alarm, Stop | JP | Not measured | `Cancelled.` stored and replayed |

Both native `request.cf.country` and the receiver's `CF-IPCountry` agreed. Each completed answer included a unique fake-call identifier; reattaching returned the identical terminal event. The probe retained Muse's `wnam` placement hint. The reported upstream colos were SJC for the HTTP control, LAX for the connected alarm, and DFW for the disconnected alarm; these are receiver observations, not an independent physical-location guarantee.

This confirms that an open SSE client does not prevent alarm context from changing the observed country in this test. It does **not** establish that OpenCode accepts a restricted-country student's actual Muse request, or guarantee Cloudflare will always report US for alarm subrequests.

## Lifecycle checks

`npm run test:jobs` runs 16 focused checks with the actual runner and a mocked DO host, plus a local Workers-runtime integration check using the real `TaskJob` and a fake upstream. They cover dispatch, duplicate alarms, Stop while queued and during startup/fetch, reconnection, reset before/after completion, new and legacy retention records, scheduler failure, input remaining out of storage, upstream region refusal, unchanged HTTP startup for other providers, and deadlines. The runtime test also keeps the original SSE connection open during alarm execution.

The task input exists only in DO memory. A reset before execution follows the existing job-lost recovery path. Alarm dispatch does not introduce automatic replay or additional model retries. Muse's timeout is capped at 14 minutes, below the platform's 15-minute alarm limit; other routes keep their existing limits.

## Cleanup and reproduction

Both temporary Workers, `civilsolve-task-alarm-d6a082-probe` and `civilsolve-task-alarm-d6a082-receiver`, were deleted successfully. Generated test tokens and session files were removed. Production routes, secrets, data and deployment were untouched.

The sanitized [results and deletion records](task-alarm-results-2026-10-11.json) contain no credentials or student data.

To repeat this isolated integration test with the configured Cloudflare account:

1. Run `node experiments/placement/task-alarm-manage.mjs setup`.
2. Deploy `.wrangler/task-alarm-probe/receiver.json`, then `probe.json`, with the installed Wrangler and `--secrets-file .wrangler/task-alarm-probe/secrets.json`.
3. Run `node experiments/placement/task-alarm-run.mjs`.
4. Run `node experiments/placement/task-alarm-manage.mjs cleanup`, including after a failed test.

The generated key is only a test token for the fake model endpoint. No production API key is read by this harness.
