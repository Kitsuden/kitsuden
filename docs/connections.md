# Connections

Accounts at other services, connected once in Kitsuden and used by every kon that needs one: a
person's Google or Microsoft 365 mailbox and calendar, or the organization's API key for Stripe,
Resend and the like. A kon never sees a token or a key. It asks `ctx.connections` for a client
whose `fetch` adds the credential itself, and only over https to the provider's own hosts.

Code: `apps/api/src/lib/connections`, routes in `apps/api/src/routes/connections.ts`, migration
`0082_connections.sql`.

## For a kon

```ts
const google = await ctx.connections?.client("kon-inbox", {
  provider: "google",
  ownerId: userId, // that person's own connection; omit for the organization's
  scopeSets: ["mail.read"], // the connection must cover these
  purpose: "sync mail", // recorded, with the kon's id, every time the credential opens
});
const res = await google.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
```

- `client` throws a `ConnectionError`: 404 `NO_CONNECTION`, 409 when the connection expired,
  503 without a secrets key. `fetch` throws 403 `HOST_NOT_ALLOWED` for a URL off the provider's hosts.
- A 401 from the provider is retried once with a fresh token; a second one marks the connection
  `error`.
- `registerProvider(konId, { id, name, authTypes: ["api_key"], scopeSets: {}, apiHosts, apiKeyHeader? })`
  adds a provider the kon owns. Google and Microsoft, and another kon's provider, cannot be replaced.
- `visible(konId, connectionId)` reads a connection as the caller of the current request sees it,
  so a kon can let a person pick one of their own.
- `ctx.connections` is bound to the kon's id, like `ctx.secrets`: a kon that passes another id is
  refused. It is absent on a host without the battery; a kon checks for it.

## Events

| Event                            | Payload                                        |
| -------------------------------- | ---------------------------------------------- |
| `connections:connection.created` | `connectionId`, `provider`, `scope`, `ownerId` |
| `connections:connection.expired` | the same and `reason`                          |
| `connections:connection.revoked` | `connectionId`, `provider`, `scope`, `ownerId` |

## Routes

| Route                                           | Who                                 | What                                                |
| ----------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `GET /api/connections/providers`                | a signed-in person                  | The catalog and what is configured.                 |
| `GET /api/connections/connections`              | a signed-in person                  | Your connections; an admin also the organization's. |
| `GET /api/connections/connections/:id`          | the owner                           | One connection.                                     |
| `POST /api/connections/oauth/start`             | a person                            | The consent URL (PKCE, ten minutes, one use).       |
| `GET /api/connections/oauth/callback`           | by `state`, starter only (below)    | Stores the credential sealed and redirects back.    |
| `POST /api/connections/api-keys`                | a person (admin for `organization`) | Stores an API key sealed.                           |
| `POST /api/connections/connections/:id/refresh` | the owner                           | Refreshes now.                                      |
| `POST /api/connections/connections/:id/revoke`  | the owner                           | Revokes and deletes the credential.                 |

The callback must come back to whoever started the round trip: the browser that holds the HttpOnly
`kitsuden_conn_oauth` cookie set by `/oauth/start`, or a session of the same person. A consent link
opened by anyone else answers 403 and the round trip is burnt, so nobody can send their link to
another person and keep that person's account in a connection of their own.

## Who sees what

Row security in 0082, and the same rule in the routes' queries:

- a person reads and changes only their own `user` connections;
- an admin manages the `organization` connections and does not see a person's;
- an agent never starts a consent or stores a key;
- the refresh worker and kons asking for a client run as the system.

## Credentials

Sealed with the installation's secrets key (`lib/kon-secrets.ts`, owner `kitsuden-connections`).
Every opening is recorded in `secret_access_log` with a purpose that names the kon, never the
value. The OAuth `state` is stored hashed and the PKCE verifier sealed. Both columns are registered
in `kitsuden_secret_columns`, so an offline key rotation re-encrypts them.

## Configuration

| Variable                                                                                                 | What                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CONNECTIONS_GOOGLE_CLIENT_ID`, `CONNECTIONS_GOOGLE_CLIENT_SECRET`                                       | The installation's Google OAuth client.                                                                       |
| `CONNECTIONS_MICROSOFT_CLIENT_ID`, `CONNECTIONS_MICROSOFT_CLIENT_SECRET`, `CONNECTIONS_MICROSOFT_TENANT` | The Microsoft Entra app (tenant default `common`).                                                            |
| `CONNECTIONS_CALLBACK_URL`                                                                               | The redirect URI registered at the providers (default `BETTER_AUTH_URL` + `/api/connections/oauth/callback`). |
| `CONNECTIONS_RETURN_ORIGINS`                                                                             | Origins a person may be sent back to (default `ALLOWED_ORIGINS`).                                             |
