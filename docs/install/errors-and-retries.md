# Errors and safe retries

Two features exist so that an AI agent (or any client) can tell **what went
wrong** and **whether it is safe to try again** without reading prose:

1. Every error from `/api/*` is an RFC 9457 **`application/problem+json`**
   document with a stable `code`.
2. Every write (`POST`, `PUT`, `PATCH`, `DELETE`) accepts an
   **`Idempotency-Key`** header, so a retry after a timeout never runs the
   operation twice.

Both are part of the core: they work for every kon without the kon doing
anything.

## Error format

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json; charset=utf-8

{
  "error": { "code": "VALIDATION", "message": "Unknown fields in the request", "details": { … } },
  "type": "https://github.com/Kitsuden/kitsuden/blob/main/docs/install/errors-and-retries.md#kitsuden_e_validation",
  "title": "Validation failed",
  "status": 422,
  "detail": "Unknown fields in the request",
  "instance": "/api/esports/matches/t1/report",
  "code": "KITSUDEN_E_VALIDATION",
  "retryable": false,
  "retry_after": null,
  "hint": "Correct the fields listed in `error.details` and send the request again.",
  "docs": "https://github.com/Kitsuden/kitsuden/blob/main/docs/install/errors-and-retries.md#kitsuden_e_validation",
  "requestId": "6f1c…"
}
```

| Field                                           | Meaning                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `type`, `title`, `status`, `detail`, `instance` | RFC 9457. `type` is the URL of the code's entry on this page.                                                  |
| `code`                                          | Stable code from the catalogue below. Branch on this, never on `detail`.                                       |
| `retryable`                                     | `true` if sending **the same request** again can succeed.                                                      |
| `retry_after`                                   | Seconds to wait before retrying (also sent as the `Retry-After` header), or `null`.                            |
| `hint`                                          | What to do, in one sentence.                                                                                   |
| `docs`                                          | Same as `type`.                                                                                                |
| `requestId`                                     | Quote it when reporting a problem; it is in the server log.                                                    |
| `error`                                         | **Compatibility.** Whatever the route sent before (a string, or `{ code, message, details }`). Always present. |

Other fields the route sent (`details`, `didYouMean`, `allow`,
`maxBytes`…) are kept. If one of them collided with a name above, its old
value is kept as `legacy_<name>` (for example `legacy_code`).

The catalogue lives in `@kitsuden/shared` (`KITSUDEN_ERRORS`, `buildProblem`,
`errorCodeForStatus`), so clients can import the same list.

**Exceptions:** `/api/auth/*` keeps better-auth's own error format (its client
depends on it). JSON-RPC responses from `/api/mcp` keep the JSON-RPC shape and
carry the problem in `error.data` (see below). Error responses are never
TOON-encoded, even if the request asked for TOON.

In production, a 5xx for a caller that is not an admin still hides the
internal message (SQL, paths); it keeps the same fields, with a generic
`detail`. The same holds for kon operations called as MCP tools: an agent
without the `admin` scope gets the code, status and `requestId` of a 5xx, not
its message. A 4xx keeps its message on both channels.

### MCP

`/api/mcp` speaks JSON-RPC, so the same problem object travels:

- in a JSON-RPC error, as `error.data` (`error.code` and `error.message` are
  unchanged);
- in a failed tool result (`isError: true`), as `structuredContent`, and
  summarised in the text content so the model can read `code`, `retryable`
  and `retry_after`.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32601,
    "message": "Method not found: tools/frobnicate",
    "data": {
      "code": "KITSUDEN_E_NOT_FOUND",
      "status": 404,
      "retryable": false,
      "retry_after": null,
      "…": "…"
    }
  }
}
```

## Idempotency-Key

Generate one random key per **operation** (a UUID is fine) and send it on the
first attempt and on every retry of that same operation:

```bash
curl -X POST https://api.example.com/api/shop/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 2f1d9c0e-8a4b-4b8e-9d55-1c0b6f0e7a21" \
  -d '{"items":[{"variantId":"v-1","quantity":1}],"customerEmail":"ana@example.com","fulfillmentType":"pickup"}'
```

| Situation                                                     | Response                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| First request                                                 | Executed normally. The response carries `Idempotency-Key`.                                                          |
| Retry with the same key and the same request                  | The **stored** response: same status, body and safe headers, plus `Idempotent-Replayed: true`. Nothing is executed. |
| Same key, different method, path, query or body               | `422` `KITSUDEN_E_IDEMPOTENCY_KEY_REUSED`. Nothing is executed.                                                     |
| Same key while the first request is still running             | `409` `KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS`, `Retry-After: 1`. Retry with the same key.                              |
| The original response contained a secret (e.g. a new API key) | `409` `KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE`. The operation already happened once.                                 |
| No store available                                            | `503` `KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE`. Nothing is executed (see _Failure mode_).                               |
| Malformed key                                                 | `422` `KITSUDEN_E_IDEMPOTENCY_KEY_INVALID`. Keys are 8-128 characters of `[A-Za-z0-9_.:-]`.                         |

Details:

- Keys are scoped to the caller: the agent, the signed-in user, or (for
  anonymous requests) the client IP. The same key from two callers is two
  different operations, and nobody can read another caller's response by
  guessing their key. Keys are stored hashed.
- What is replayed: 2xx, 3xx and deterministic 4xx (400, 404, 422…).
  What is **not** stored: 5xx, 401, 403, 408, 409, 423, 425 and 429. For
  those the key is released and a retry runs again, because the operation did
  not happen and the state that caused the error may have changed.
- Never stored: `Set-Cookie`, `Authorization` or any header outside a short
  allow-list (`Content-Type`, `Location`, `ETag`, `Last-Modified`, `Link`,
  `Cache-Control`, `Vary`…); response bodies with secrets (fields such as
  `token`, `apiKey`, `password`, `secret`, or values that look like
  `kitsuden_agent_*` keys); responses larger than
  `IDEMPOTENCY_MAX_RESPONSE_BYTES`. For the last two, only the fact that the
  operation happened is stored.
- Not covered: `/api/auth/*` (sign-in responses set session cookies),
  `/api/mcp` (a JSON-RPC session transport), streaming responses, and the
  admin-only `/api/system` and `/api/admin/system` routes (mounted before the
  middleware).
- Without the header nothing changes: idempotency is opt-in per request.

A replay is free for an agent: it spends no quota (requests, writes or budget
units). See [Agent quotas](../agents/permissions.md#quotas).

### Storage and failure mode

1. **Valkey** (normal case): `SET … NX PX` reserves the key atomically, which
   is what stops two simultaneous requests from both running.
2. **PostgreSQL** fallback, used only when Valkey does not answer: table
   `kitsuden_idempotency`, reserved with `INSERT … ON CONFLICT`. The API
   creates it the first time it needs it; if its database role cannot create
   tables, create it once with the DDL in `apps/api/src/lib/idempotency.ts`
   (`DDL_IDEMPOTENCY`).
3. **Neither available:** `IDEMPOTENCY_FAIL_MODE` decides.
   - `closed` (default): `503` retryable, the request is **not** executed. A
     client that sent an `Idempotency-Key` asked for "at most once"; running
     the write without being able to record it would silently break that
     promise, while a 503 costs one retry. Requests without the header are
     unaffected.
   - `open`: the request runs unprotected and the response carries
     `Idempotency-Status: unavailable`.

Known limit: the fallback is chosen per request. If Valkey goes down between
the first attempt and the retry, the retry looks in the table and does not see
the reservation made in Valkey.

| Variable                         | Default   | Meaning                                                                                                     |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `IDEMPOTENCY_TTL_SECONDS`        | `86400`   | How long a response is remembered.                                                                          |
| `IDEMPOTENCY_LOCK_SECONDS`       | `60`      | How long a reservation lives while its request runs (if the process dies, the key frees itself after this). |
| `IDEMPOTENCY_MAX_RESPONSE_BYTES` | `1048576` | Larger responses are not stored (the retry gets 409 NOT_REPLAYABLE).                                        |
| `IDEMPOTENCY_FAIL_MODE`          | `closed`  | `closed` or `open`, see above.                                                                              |

`kon-ecommerce` also keeps its own durable order idempotency in the database
(bound to the buyer's email, no expiry), underneath this one.

## Code catalogue

| Code                                    | Status | Retryable | Default `retry_after` |
| --------------------------------------- | ------ | --------- | --------------------- |
| `KITSUDEN_E_BAD_REQUEST`                | 400    | no        | —                     |
| `KITSUDEN_E_VALIDATION`                 | 422    | no        | —                     |
| `KITSUDEN_E_UNAUTHENTICATED`            | 401    | no        | —                     |
| `KITSUDEN_E_LEGACY_KEY_RETIRED`         | 401    | no        | —                     |
| `KITSUDEN_E_FORBIDDEN`                  | 403    | no        | —                     |
| `KITSUDEN_E_NOT_FOUND`                  | 404    | no        | —                     |
| `KITSUDEN_E_METHOD_NOT_ALLOWED`         | 405    | no        | —                     |
| `KITSUDEN_E_CONFLICT`                   | 409    | no        | —                     |
| `KITSUDEN_E_PAYLOAD_TOO_LARGE`          | 413    | no        | —                     |
| `KITSUDEN_E_UNSUPPORTED_MEDIA_TYPE`     | 415    | no        | —                     |
| `KITSUDEN_E_RATE_LIMITED`               | 429    | yes       | 60                    |
| `KITSUDEN_E_QUOTA_EXCEEDED`             | 429    | yes       | until 00:00 UTC       |
| `KITSUDEN_E_APPROVAL_REQUIRED`          | 202    | no        | —                     |
| `KITSUDEN_E_APPROVAL_UNSUPPORTED`       | 403    | no        | —                     |
| `KITSUDEN_E_DENIED_UNATTENDED`          | 403    | no        | —                     |
| `KITSUDEN_E_AGENT_SPONSOR_INVALID`      | 403    | no        | —                     |
| `KITSUDEN_E_IDEMPOTENCY_KEY_INVALID`    | 422    | no        | —                     |
| `KITSUDEN_E_IDEMPOTENCY_KEY_REUSED`     | 422    | no        | —                     |
| `KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS`    | 409    | yes       | 1                     |
| `KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE` | 409    | no        | —                     |
| `KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE`    | 503    | yes       | 5                     |
| `KITSUDEN_E_INTERNAL`                   | 500    | no        | —                     |
| `KITSUDEN_E_BAD_GATEWAY`                | 502    | yes       | 5                     |
| `KITSUDEN_E_UNAVAILABLE`                | 503    | yes       | 5                     |
| `KITSUDEN_E_DB_POOL_EXHAUSTED`          | 503    | yes       | 5                     |
| `KITSUDEN_E_TIMEOUT`                    | 504    | yes       | 5                     |

A `Retry-After` header sent by the route wins over the default.
Codes are only ever added; an existing code is never renamed or reused.

### `KITSUDEN_E_BAD_REQUEST`

The request is malformed (syntax, parameters, headers). Fix it before sending
it again. Also the fallback for 4xx statuses without a more specific code.

### `KITSUDEN_E_VALIDATION`

The body or query failed validation. `error.details` lists the fields; for an
unknown field it also names the closest valid one (`didYouMean`).

### `KITSUDEN_E_UNAUTHENTICATED`

No valid session or agent key. Send a session cookie or
`Authorization: Bearer kitsuden_agent_…`. `legacy_code` may carry the precise
reason (`INVALID_KEY`, `AGENT_DEACTIVATED`…).

### `KITSUDEN_E_LEGACY_KEY_RETIRED`

A `kitsuden_sk_*` key was used. Those keys were retired on 2026-08-01; create
an agent identity and use its `kitsuden_agent_*` key.

### `KITSUDEN_E_FORBIDDEN`

Authenticated, but the role or the agent's scopes do not allow this
operation. Retrying will not help.

### `KITSUDEN_E_NOT_FOUND`

The resource or the route does not exist (or the caller may not know it
exists). For unknown routes the body includes `didYouMean`; every route is in
`GET /api/docs/openapi.json`.

### `KITSUDEN_E_METHOD_NOT_ALLOWED`

The path exists with other methods, listed in the `Allow` header and in
`allow`.

### `KITSUDEN_E_CONFLICT`

The current state does not allow the change (duplicate, out of stock, wrong
status transition). Read the resource again and decide; a blind retry will
fail the same way.

### `KITSUDEN_E_PAYLOAD_TOO_LARGE`

The body is over the limit (10 MB by default; `maxBytes` says how much). Two
core routes have a bigger limit of their own: `POST /api/media/upload` (20 files
of 10 MB, 201 MB in all) and `POST /api/datasets/import` /
`/api/datasets/import/package` (100 MB, `DATASET_IMPORT_MAX_MB` up to 1024).
Behind the TLS overlay or the panel's nginx the proxy also cuts at 100 MB. Split
a bigger import into several requests.

### `KITSUDEN_E_UNSUPPORTED_MEDIA_TYPE`

Send the body with a supported `Content-Type`, usually `application/json`.

### `KITSUDEN_E_RATE_LIMITED`

Too many requests. Wait `retry_after` seconds.

### `KITSUDEN_E_QUOTA_EXCEEDED`

An agent key used up its **daily** quota: `writes_per_day` or `budget_units_per_day` (the
`quota` field says which, `limit` the configured value). `retry_after` is the number of seconds
until 00:00 UTC, when the counters reset. Per-minute limits answer with
`KITSUDEN_E_RATE_LIMITED` instead. See [Agent permissions, keys and quotas](../agents/permissions.md).

### `KITSUDEN_E_APPROVAL_REQUIRED`

Not an error: the response is `202 Accepted`. The agent's request needs human approval, so it
was **not executed**; it was stored as a proposal. The body carries `proposal` (`id`,
`status`, `statusUrl`, `expiresAt`) and the `Location` header points at
`GET /api/proposals/{id}`. Do not resend the request: poll the status URL (or the MCP tool
`kitsuden_proposal_status`) until it is `executed` (the real `result` is there), `failed`,
`rejected` or `expired`. Over MCP the tool result is not an error and carries the same body in
`structuredContent`. See [Human approval](../agents/approvals.md).

### `KITSUDEN_E_APPROVAL_UNSUPPORTED`

The request needs human approval but cannot be held as a proposal: its body (or MCP arguments)
carries a secret (`secret`; proposals never store secrets), it is an upload with a file that is
not an image by its content (`not_image`; image uploads ARE held), the form cannot be read
(`multipart`), it is not JSON (`not_json`), or it is too large (`too_large`: JSON over 256 KiB,
or an image over `APPROVALS_MAX_UPLOAD_MB`). `reason` says which. Nothing was executed. A human has to
do it, or an admin has to change the agent's approval mode. See
[Human approval](../agents/approvals.md).

### `KITSUDEN_E_DENIED_UNATTENDED`

The request would have been held for human approval, but nobody is attending the run (a cron
or event action, an agent run one of them started, or a request sent with
`Kitsuden-Unattended: true`) and an admin set unattended runs to `deny`. Nothing was executed
and no proposal was stored. The body carries `alternative`: what to do instead, as an admin
wrote it for the operation, the agent or the whole site (by default: record the decision with
`kitsuden_record_decision` so a person can act). Do not retry it in the same run. See
[Human approval](../agents/approvals.md#unattended-runs).

### `KITSUDEN_E_AGENT_SPONSOR_INVALID`

The agent has a human signer (the account that signs what the agent creates: blog post author,
dataset entry owner) and that account was deleted or is no longer an `admin` or `editor`. The
agent cannot create signed content until an admin assigns a new signer. Nothing was created. See
[Human signer](../agents/approvals.md#human-signer).

### `KITSUDEN_E_IDEMPOTENCY_KEY_INVALID`

The `Idempotency-Key` header is not 8-128 characters of `[A-Za-z0-9_.:-]`.

### `KITSUDEN_E_IDEMPOTENCY_KEY_REUSED`

The key was already used for a different method, path, query or body. Use a
new key for a new operation.

### `KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS`

Another request with the same key is still running. Retry with the same key
after `retry_after` seconds to receive its result.

### `KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE`

The original request with this key already succeeded, but its response
contained a secret or was too large, so it was not stored. Do not repeat the
write: read the resource instead.

### `KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE`

Neither Valkey nor the fallback table could record the key, and
`IDEMPOTENCY_FAIL_MODE=closed`. The request was **not** executed; retry later
with the same key.

### `KITSUDEN_E_INTERNAL`

An unexpected server error. Not retryable by default: retry only if the
operation is a read or carries an `Idempotency-Key`. Report the `requestId`.

A write can also get this code after the route had already decided to
answer success. That happens when a database error inside the request
aborted its transaction and Postgres discarded everything the request wrote
(see [the request transaction in a kon](kon-transactions.md)).
Nothing was saved, so retrying with the same `Idempotency-Key` is safe.

### `KITSUDEN_E_BAD_GATEWAY`

An upstream service failed. Retry after `retry_after` seconds.

### `KITSUDEN_E_UNAVAILABLE`

Temporarily unavailable (for example the rate-limit store is down). Retry
after `retry_after` seconds.

### `KITSUDEN_E_DB_POOL_EXHAUSTED`

All database connections are busy. Retry after `retry_after` seconds.

### `KITSUDEN_E_TIMEOUT`

The operation took too long. Retry after `retry_after` seconds, with an
`Idempotency-Key` for writes.
