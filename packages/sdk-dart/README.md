# Kitsuden for Dart and Flutter

A minimal Kitsuden client for Flutter and Dart apps: datasets and their entries.
One dependency: [`http`](https://pub.dev/packages/http).

It covers the part of the API a mobile app needs. For everything else (agents,
approvals, MCP, media…) use the TypeScript (`packages/sdk`) or Python
(`packages/sdk-python`) SDK, or call the REST API directly (`GET <api>/llms.txt`).

## Install

Not published to pub.dev yet. From this repository:

```yaml
dependencies:
  kitsuden:
    path: ../kitsuden/packages/sdk-dart
```

## Use

```dart
import 'package:kitsuden/kitsuden.dart';

final kitsuden = KitsudenClient(
  Uri.parse('https://panel.example.com'),
  credentials: AgentKey(token),
);

final datasets = await kitsuden.listDatasets();
final entries = await kitsuden.listEntries(datasets.first.id, limit: 100);

switch (await kitsuden.createEntry(
  datasets.first.id,
  const EntryInput(title: 'Hello', data: {'score': 3}),
)) {
  case Done(:final value):
    print(value.id);
  case PendingApproval(:final proposal):
    // Nothing ran: a human must approve. Do not resend; poll proposal.statusUrl.
    print('waiting for approval: ${proposal.id}');
}
```

### Credentials

|                                      |                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentKey('kitsuden_agent_…')`       | an agent key, sent as `Authorization: Bearer`. Never ship one inside an app: anyone can extract it. Use it for your own tools, or give each user a session.                                                                        |
| `SessionToken(token, cookieName: …)` | a signed-in user's better-auth session token, sent as a cookie. Over HTTPS in production the cookie name is `__Secure-better-auth.session_token`. On Flutter web the browser owns cookies: there, use the browser session instead. |
| `NoCredentials()`                    | public reads only.                                                                                                                                                                                                                 |

### Errors

Every API error is a `KitsudenApiException` with the stable `code`
(`KITSUDEN_E_*`, see `docs/install/errors-and-retries.md`), `retryable`,
`retryAfter`, `hint` and `requestId`. Branch on `code`, never on the message.
A body that is not a problem (a proxy's error page) still gets the catalog code
for its status. No response at all is `KitsudenNetworkException`.

### Writes and retries

`createEntry`, `updateEntry` and `deleteEntry` send an `Idempotency-Key` (a
random UUID unless you pass `idempotencyKey:`). To retry a write safely after a
network failure, call it again **with the same key**: the server returns the
first result instead of acting twice. The client does not retry by itself.

## Tests

```bash
cd packages/sdk-dart
dart pub get
dart test
```

The tests use `MockClient` from `package:http/testing.dart`: no network and no
running API.
