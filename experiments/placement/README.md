# Placement and country diagnostics

The original placement experiment below does not import CivilSolve's production entrypoint or modify its routes, jobs, defaults, or Wrangler configuration. Read [RESULTS.md](RESULTS.md) for the 11 October 2026 measurements. The subsequent [TaskJob alarm integration test](TASK-ALARM-RESULTS.md) imports the actual job implementation into an isolated fixture with a fake upstream.

The two probes use the same Durable Object forwarding pattern as `worker/index.ts`: create a fresh ID, apply a location hint when requested, then call the object's HTTP handler. The object makes upstream requests in the originating request's context, without storage, alarms, scheduled jobs, or detached relays. Every probe and receiver request requires a random bearer token. Logs are disabled, results omit IP addresses, and redirects are not followed.

Synthetic country metadata is sent only to the separate receiver owned by this account. Muse calls use unmodified country metadata and the existing OpenCode Go account. Each call asks for `OK`, with a 20-second timeout and no retry. The harness does not try to bypass the provider's geographic restrictions.

## Reproduce

Run from the repository root, using the installed Wrangler and existing account login. Confirm the fixed account and workers.dev subdomain in `setup.mjs` before use.

1. Run `node experiments/placement/setup.mjs`. It creates three uniquely named configurations and the minimal secrets under ignored `.wrangler/placement-probe/`. It refuses to overwrite an active session. Secret values are never printed or supplied as command arguments.
2. Run `node node_modules/wrangler/bin/wrangler.js deploy --config .wrangler/placement-probe/placed.json --dry-run` to validate packaging.
3. Deploy the `receiver` configuration with `--secrets-file .wrangler/placement-probe/receiver-secrets.json`, then `edge` and `placed` with `--secrets-file .wrangler/placement-probe/probe-secrets.json`. These are temporary diagnostic deployments, not the production app.
4. Run `node experiments/placement/run.mjs locations`, then `headers`. These batches make no model calls. Both save a timestamped JSON result after every case.
5. Run `node experiments/placement/run.mjs muse` only when live calls on the existing account are authorized. It makes six short model requests, sequentially, with no fallback.
6. Run `node experiments/placement/cleanup.mjs`. It validates each generated Worker name and account, deletes the three diagnostic Workers, then removes the temporary local secrets. It never targets the production Worker.

The measured `colo` is the data centre reported by the outbound trace/receiver, not an independent inspection of the executing object. Incoming `request.cf.colo` is not treated as proof of execution placement. Only the observed visitor country can be claimed as tested: an experiment originating in Japan does not reproduce a Hong Kong traveller's refusal.

The installed workers-types predates `jurisdiction("us")`; this JavaScript probe deliberately measures current remote runtime support without upgrading production dependencies.

## Alarm follow-up

The separate alarm harness compares a direct HTTP invocation and a later platform alarm in the same object. It has **no model key or model endpoint**, makes no model calls, and stores only its own diagnostic results. See [ALARM-RESULTS.md](ALARM-RESULTS.md).

1. Run `node experiments/placement/alarm-manage.mjs setup`. Configurations and a random authentication token go into ignored `.wrangler/alarm-geography-probe/`.
2. Dry-run the `probe.json` configuration, then deploy `receiver.json` and `probe.json`, each with `--secrets-file .wrangler/alarm-geography-probe/secrets.json`.
3. Run `node experiments/placement/alarm-run.mjs`. It creates six objects, captures a baseline, schedules each alarm 15 seconds later, ends those requests, waits 25 seconds without contacting the objects, and retrieves stored evidence. It deletes each object's alarm and diagnostic storage after retrieval. A failed client run can resume from its saved results by passing that JSON file path as the first argument.
4. Run `node experiments/placement/alarm-manage.mjs cleanup` to remove both temporary Workers and their temporary local token. It validates the account and generated names before deletion.
