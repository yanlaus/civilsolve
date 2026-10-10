# Alarm geography experiment — 11 October 2026

**The alarm changed the observed country metadata.** All six objects were identified as JP when calling the receiver during an HTTP request, and as US when calling the same receiver from a later platform-triggered `alarm()` invocation. The outbound colo stayed the same within each pair, including objects whose trace reported Japanese and European data centres.

This corrects the scope of the [earlier placement experiment](RESULTS.md): changing placement alone in an HTTP request did not change the originating country; changing the invocation context to an alarm did change it in this runtime/account test.

## Method

- Two isolated authenticated Workers: an alarm probe and a receiver owned by the same account. Neither had any model credentials. Neither could call a model endpoint. Logs were disabled; there were no images, assignments, or student data.
- Six fresh SQLite-backed Durable Objects, one per location choice. Within each object, the HTTP handler captured a baseline, stored the diagnostic result, scheduled one alarm 15 seconds later, and returned its response.
- The alarm handler independently called `https://www.cloudflare.com/cdn-cgi/trace` and our own receiver. It did not copy any incoming request or country headers. Both paths used the same capture function and fixed destinations.
- The client stopped contacting the objects for 25 seconds after scheduling the remaining objects. Retrieval only read stored results, and did not perform outbound measurements. Every recorded alarm completion preceded retrieval.
- An initial HTTP 500 while creating the `enam` object interrupted scheduling. The client resumed from the two saved IDs, preserving their already scheduled alarms, then successfully created the other four objects. All six measured alarms completed with `retryCount: 0`.

## Observations

| Object placement | Outbound trace/receiver colo, both invocations | HTTP country | Alarm country | Alarm retries |
|---|---|---|---|---|
| No hint | NRT | JP | US | 0 |
| `wnam` | SJC | JP | US | 0 |
| `enam` | IAD | JP | US | 0 |
| `weur` | AMS | JP | US | 0 |
| `jurisdiction("us")` | SEA | JP | US | 0 |
| `jurisdiction("eu")` | WAW | JP | US | 0 |

In every case, Cloudflare trace's `loc`, the receiver's `request.cf.country`, and its `CF-IPCountry` header agreed. No synthetic country header or outbound `cf.country` override was used. `US` therefore cannot be interpreted as proof that the object physically executed in the United States: the Japan and EU cases also reported US during their alarms. The mechanism assigning that value was not determined.

## What this establishes, and what remains untested

The measured alarm invocation did not preserve the original JP visitor country in these outbound requests. This is a technical difference from the HTTP-triggered path, not merely a change of regional placement.

**No Muse Spark request was made.** This experiment does not establish whether OpenCode would accept a model call from an alarm, whether an actual restricted-country user's task would succeed, or whether this country behavior is a stable platform guarantee. The only client network tested was identified as JP. The receiver was a separate Worker in our own account, not OpenCode's gateway.

This metadata experiment itself made no production code change. Afterwards, on 11 October 2026, the owner explicitly requested alarm dispatch, superseding the earlier repository instruction. That subsequent TaskJob implementation keeps input only in memory and coordinates dispatch, cancellation and retention through the same alarm. See [its separate validation report](TASK-ALARM-RESULTS.md); neither report establishes success for an actual restricted-country Muse user.

## Cleanup and evidence

Each object's alarm and diagnostic storage was explicitly deleted after retrieval. Both temporary Workers (`civilsolve-alarm-e03e47-probe`, `civilsolve-alarm-e03e47-receiver`) were then successfully deleted, and the temporary local token/session files removed. CivilSolve production code, configuration, data, and model routing were unchanged.

See [raw paired measurements and deletion results](alarm-results-2026-10-11.json). Syntax checks and a Wrangler deployment dry run passed before the live test. The test used Wrangler 4.107.0 and compatibility date 2026-07-01, without changing production dependencies.

[Cloudflare's alarm documentation](https://developers.cloudflare.com/durable-objects/api/alarms/) specifies platform-triggered execution and at-least-once delivery. It does not promise the country metadata measured here.
