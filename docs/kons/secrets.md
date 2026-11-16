# Secrets in a kon

A kon that connects to someone else's service ends up holding a credential: an
OAuth refresh token, an API key. `ctx.secrets` stores it encrypted and records
every time it is read.

```ts
// when the user connects their account
const sealed = ctx.secrets.seal("kon-connections", refreshToken);
await db.insert(connections).values({ userId, provider: "google", refreshToken: sealed });

// when the kon needs it
const token = await ctx.secrets.open("kon-connections", row.refreshToken, {
  purpose: "refresh-access-token",
  subject: `connection:${row.id}`,
  actorUserId: row.userId,
});
```

`ctx.secrets` is optional: a host without it, or a test, leaves it undefined. A
kon must then refuse to store the credential, never store it readable.

## What it guarantees

- **Encrypted at rest** with the installation's secrets key
  (`KITSUDEN_SECRETS_KEY`, AES-256-GCM): the same key and the same rotation as the
  core's own secrets.
- **Bound to the kon.** The kon's id is authenticated together with the
  ciphertext, so a value sealed for one kon does not decrypt under another id,
  and editing the label does not help. The context each kon receives is tied to
  its own id: `ctx.secrets` (and `ctx.automation`, `ctx.entities.define`) throw
  `this kon is "x" and cannot act as "y"` when the first argument is not the
  kon's own.
- **Every opening is recorded** before the value is handed over: which kon, the
  purpose, the subject, the account and the request. A refusal is recorded too.
  If the record cannot be written, nothing is opened.
- **The value is never recorded**, and `seal` and `open` never put it in an error
  message.

A kon is code running in the API's process, so this is not a sandbox: it has its
own database connection and the environment, secrets key included, and a hostile
kon can read what it wants. What it gives is that the database, a backup and the
generic read surfaces never show the credential, that one kon cannot act as
another by mistake or by a copied snippet, and that every legitimate use leaves a
trace that names the right kon. Installing a kon is still a decision to trust it.

## Storing a sealed secret

`seal` returns a small object (`{ v, kon, valueEncrypted, iv, authTag }`). Store
it in a `jsonb` column, and:

1. **Name the column so it ends in `token`, `secret` or `password`**
   (`refresh_token`, `api_secret`). The explorer, GraphQL, inline relations,
   reports and the record history hide columns with those names. `credentials`
   or `api_key` are not hidden.
2. **Declare the column**, so a rotation of the secrets key re-encrypts it:

```ts
export default defineKon({
  id: "kon-connections",
  secretColumns: [{ table: "conn_connections", column: "refresh_token" }],
});
```

`idColumn` defaults to `id`. An undeclared column is left behind by a rotation,
and its secrets stop opening.

3. **Never return it from an operation.** Your own routes are not covered by the
   generic hiding; use the `maskFields` interceptor or leave the column out of
   the response.

## Opening

`purpose` is required: a short, fixed word for why (`sync-mailbox`,
`refresh-access-token`). `subject` says what the secret belongs to
(`connection:<id>`); never put the value or anything derived from it there.
`actorUserId` is the account on whose behalf it is opened; inside a request it
defaults to whoever is asking.

`open` rejects with `KonSecretError` when the value was sealed for another kon,
was tampered with, or the installation's key changed without a rekey.

Open as late as possible and do not keep the result: read the token, use it, let
it go.

## The access log

```
GET /api/admin/secret-access?kon=kon-connections&limit=100
```

Administrators only. Each entry has `konId`, `outcome` (`opened` or `refused`),
`purpose`, `subject`, `actorUserId`, `requestId` and `createdAt`.

## Rotating the key

`apps/api/scripts/rekey-secrets.ts` re-encrypts the core's secrets and every
column kons declared, in one transaction, and can be run again safely. It runs
offline; the columns are read from `kitsuden_secret_columns`, which the loader
fills from `secretColumns` at each start. Start the API once after installing a
kon before rotating, so its columns are known.

## Limits

- One key for the whole installation; there is no key per kon or per user.
- The log is not pruned automatically.
- OAuth itself is not here: this stores the token a kon obtained. The flow, the
  refresh and the provider's API are the kon's.
