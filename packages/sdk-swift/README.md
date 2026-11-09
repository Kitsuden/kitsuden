# Kitsuden for Swift

A minimal Kitsuden client for iOS, macOS, tvOS and watchOS apps: datasets and
their entries, with `async`/`await` and `URLSession`. No dependencies.

It covers the part of the API a mobile app needs. For everything else (agents,
approvals, MCP, media…) use the TypeScript (`packages/sdk`) or Python
(`packages/sdk-python`) SDK, or call the REST API directly (`GET <api>/llms.txt`).

## Install

Swift Package Manager, from this repository (not published yet):

```swift
.package(path: "../kitsuden/packages/sdk-swift")   // or a git URL + path once published
```

## Use

```swift
import Kitsuden

let kitsuden = KitsudenClient(
    baseURL: URL(string: "https://panel.example.com")!,
    credentials: .agentKey(ProcessInfo.processInfo.environment["KITSUDEN_API_TOKEN"]!)
)

let datasets = try await kitsuden.listDatasets()
let entries = try await kitsuden.listEntries(datasetId: datasets[0].id, limit: 100)

switch try await kitsuden.createEntry(
    datasetId: datasets[0].id,
    EntryInput(title: "Hello", data: ["score": 3, "tags": ["a", "b"]])
) {
case .done(let entry):
    print(entry.id)
case .pendingApproval(let proposal):
    // Nothing ran: a human must approve. Do not resend; poll proposal.statusUrl.
    print("waiting for approval:", proposal.id)
}
```

### Credentials

|                                 |                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.agentKey("kitsuden_agent_…")` | an agent key, sent as `Authorization: Bearer`. Never ship one inside an app binary: anyone can extract it. Use it for your own tools, or give each user a session. |
| `.session(token:cookieName:)`   | a signed-in user's better-auth session token, sent as a cookie. Over HTTPS in production the cookie name is `__Secure-better-auth.session_token`.                  |
| `.none`                         | public reads only.                                                                                                                                                 |

### Errors

Every API error is a `KitsudenAPIError` with the stable `code`
(`KITSUDEN_E_*`, see `docs/install/errors-and-retries.md`), `retryable`,
`retryAfter`, `hint` and `requestId`. Branch on `code`, never on the message.
A body that is not a problem (a proxy's error page) still gets the catalog code
for its status. No response at all is `KitsudenTransportError.network`.

### Writes and retries

`createEntry`, `updateEntry` and `deleteEntry` send an `Idempotency-Key` (a
new UUID unless you pass `idempotencyKey:`). To retry a write safely after a
network failure, call it again **with the same key**: the server returns the
first result instead of acting twice. The client does not retry by itself.

## Tests

```bash
cd packages/sdk-swift
swift test
```

The tests use a fake transport: no network and no running API.
