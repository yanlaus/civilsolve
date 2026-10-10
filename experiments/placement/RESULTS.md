# Placement and country experiment — 11 October 2026

**Scope update:** these measurements cover outbound requests made in an HTTP request's context. The later [alarm experiment](ALARM-RESULTS.md) observed different country metadata: all six alarm invocations were identified as US, while the same objects' HTTP invocations were identified as JP. Do not generalize the HTTP result to alarms.

**Changing placement changed the observed outbound data centre, but did not change the originating visitor country.** The actual test client was identified as Japan (`JP`). Six short Muse Spark requests succeeded; this does not reproduce or fix a refusal for an end user in a restricted country.

These are live measurements on three isolated, authenticated Cloudflare Workers, using Wrangler 4.107.0 and compatibility date 2026-07-01. Production remained at commit `574d9d12c79fe48c549f10e2bd1f21e13f68c71b`; its configuration and routing were not changed. No fallback model was used. No uploads or student data were sent.

## Placement measurements

Each object case used a fresh random object name. `colo` below is reported by `https://www.cloudflare.com/cdn-cgi/trace` on an outbound fetch. It is evidence of the outbound path, not an independent measurement of the object's physical execution location. The separate receiver returned the same colo for each object case.

| Target | Default Worker: outbound colo | US-East placed Worker: outbound colo | Country seen by outbound trace / object receiver |
|---|---|---|---|
| Worker itself | NRT | IAD | JP |
| Object, no hint | KIX | IAD | JP |
| Object, `wnam` | SJC | SJC | JP |
| Object, `enam` | MIA | ATL | JP |
| Object, `weur` | LHR | AMS | JP |
| Object, `jurisdiction("us")` | DFW | ATL | JP |
| Object, `jurisdiction("eu")` | ARN | WAW | JP |

- `placement.region = "aws:us-east-1"` affected the Worker and the default placement of newly created objects. Explicit object hints still selected their own regions.
- The remote runtime accepted `jurisdiction("us")`, despite the installed workers-types package not yet listing it. Production types/dependencies were not upgraded.
- The initial client request retained `country: JP` and `colo: NRT` in both Worker configurations. Its `cf-placement` header was null. Neither is sufficient to locate the executing Worker; the placed Worker's outbound trace reported IAD.
- Objects received a freshly constructed internal request with no `request.cf` geography, yet their outbound requests still carried JP. Merely constructing a new internal request did not remove the originating country context.

## Country metadata measurements

All synthetic metadata was sent **only to our own temporary receiver**, from fresh objects with an `enam` hint. The receiver read both its Cloudflare-provided `request.cf.country` and incoming headers.

| Attempt | Receiver `request.cf.country` | Receiver `CF-IPCountry` | Custom diagnostic header |
|---|---|---|---|
| Baseline, no country set by application | JP | JP | absent |
| Set outbound `CF-IPCountry: US` | JP | JP | absent |
| Set `X-Diagnostic-Country: US` | JP | JP | US |
| Set outbound `cf: { country: "US" }` | JP | JP | absent |

Setting a custom header can transmit arbitrary text, but did not change Cloudflare's geography. In this experiment, setting the Cloudflare country header or undocumented outbound `cf.country` key did not change the receiver's country either. These results do not establish which specific internal field OpenCode uses to enforce its policy.

## Muse Spark measurements

All six calls used the existing OpenCode Go key, `muse-spark-1.3-contributor`, the Responses endpoint, an independent session ID, and the text prompt “Reply with exactly the word OK. No explanation.” No country header or metadata override was sent to Muse. There was no automatic retry or model fallback.

| Request path | Outbound colo | Originating country | Muse HTTP status | Answer | Model request time |
|---|---|---|---|---|---|
| Object, no hint | NRT | JP | 200 | OK | 1.506 s |
| Object, `wnam` | DEN | JP | 200 | OK | 1.800 s |
| Object, `enam` | ATL | JP | 200 | OK | 5.757 s |
| Object, `weur` | CDG | JP | 200 | OK | 1.626 s |
| Object, `jurisdiction("us")` | DFW | JP | 200 | OK | 1.987 s |
| Worker, `aws:us-east-1` placement | IAD | JP | 200 | OK | 3.242 s |

These single samples are connectivity checks, not a performance benchmark. They show that the model works from this JP visitor context across these placements. They cannot demonstrate recovery from a restricted-country 403 because no affected-country client participated.

## Harness limitations and corrections

- The first non-model batch failed because this Workers runtime rejects `redirect: "error"`. The harness was corrected to `manual`, redeployed, and the full placement batch rerun. No model calls occurred during that failed batch.
- Direct Worker-to-Worker fetches to the separate same-account receiver returned error 1042. The same receiver worked for every Durable Object test. Plain Worker placement was therefore measured through Cloudflare's public trace endpoint; no compatibility override or service-binding substitute was introduced. Error 1042 was not counted as a Muse or country failure.
- Existing CivilSolve streaming, cancellation, and reattachment were not changed or retested. The diagnostic uses a short response to isolate network/geographic behavior.

## Cleanup and evidence

All three diagnostic Workers (`civilsolve-geo-fd6dc1-edge`, `civilsolve-geo-fd6dc1-placed`, `civilsolve-geo-fd6dc1-receiver`) were successfully deleted. Temporary local copies of the model secret and probe token were removed. The source `.dev.vars` was left intact. Only this experiment's source and sanitized results remain as uncommitted files.

See [raw measured results and successful deletion exit codes](results-2026-10-11.json). Source validation used Node's syntax checks and Wrangler's deployment dry run; the results above are from the live Cloudflare runtime.

Relevant official documentation:

- [Worker placement hints](https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region)
- [Durable Object location hints and jurisdictions](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Incoming Cloudflare request properties](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)
- [CF-IPCountry](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ipcountry)

The evidence supports retaining the current production configuration: none of the tested placement or metadata settings changed the upstream country in this request path. A provider-confirmed resolution or a genuine affected-country retest is still needed before claiming the travel-related refusal is fixed.
