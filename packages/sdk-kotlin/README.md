# Kitsuden for Kotlin

A minimal Kitsuden client for Android and JVM apps: datasets and their entries,
with coroutines. HTTP goes through `HttpURLConnection` (available on Android and
the JVM); the only dependencies are `kotlinx-coroutines-core` and
`kotlinx-serialization-json` (used as a JSON tree, no compiler plugin).

It covers the part of the API a mobile app needs. For everything else (agents,
approvals, MCP, media…) use the TypeScript (`packages/sdk`) or Python
(`packages/sdk-python`) SDK, or call the REST API directly (`GET <api>/llms.txt`).

## Install

Not published yet. Include the project (`includeBuild("../kitsuden/packages/sdk-kotlin")`
in your `settings.gradle.kts`) or copy `src/main/kotlin` into your app.
On Android, add the `INTERNET` permission and call the client from a coroutine.

## Use

```kotlin
import dev.kitsuden.sdk.*
import kotlinx.serialization.json.*

val kitsuden = KitsudenClient("https://panel.example.com", Credentials.AgentKey(token))

val datasets = kitsuden.listDatasets()
val entries = kitsuden.listEntries(datasets.first().id, limit = 100)

when (val result = kitsuden.createEntry(
    datasets.first().id,
    EntryInput(title = "Hello", data = buildJsonObject { put("score", 3) }),
)) {
    is WriteResult.Done -> println(result.value.id)
    // Nothing ran: a human must approve. Do not resend; poll proposal.statusUrl.
    is WriteResult.PendingApproval -> println("waiting for approval: ${result.proposal.id}")
}
```

### Credentials

|                                            |                                                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Credentials.AgentKey("kitsuden_agent_…")` | an agent key, sent as `Authorization: Bearer`. Never ship one inside an APK: anyone can extract it. Use it for your own tools, or give each user a session. |
| `Credentials.Session(token, cookieName)`   | a signed-in user's better-auth session token, sent as a cookie. Over HTTPS in production the cookie name is `__Secure-better-auth.session_token`.           |
| `Credentials.None`                         | public reads only.                                                                                                                                          |

### Errors

Every API error is a `KitsudenApiException` with the stable `code`
(`KITSUDEN_E_*`, see `docs/install/errors-and-retries.md`), `retryable`,
`retryAfter`, `hint` and `requestId`. Branch on `code`, never on the message.
A body that is not a problem (a proxy's error page) still gets the catalog code
for its status. No response at all is `KitsudenNetworkException`.

### Writes and retries

`createEntry`, `updateEntry` and `deleteEntry` send an `Idempotency-Key` (a
random UUID unless you pass `idempotencyKey`). To retry a write safely after a
network failure, call it again **with the same key**: the server returns the
first result instead of acting twice. The client does not retry by itself.

## Tests

```bash
cd packages/sdk-kotlin
gradle test          # JDK 17+; or generate a wrapper once with `gradle wrapper`
```

The tests use a fake transport: no network and no running API.
