# Connecting MCP clients with OAuth

Any MCP client that supports MCP authorization (Claude Code, Claude Desktop and
claude.ai connectors, Cursor, VS Code, the MCP Inspector, ChatGPT connectors…)
can connect to Kitsuden's `/api/mcp` **without copying a key**. The client
discovers Kitsuden's authorization server, opens a browser, a human on your
team picks **which agent** the client acts as and what it may do, and the
client gets short-lived tokens it refreshes on its own.

Kitsuden implements the **MCP Authorization specification, revision
2026-07-28** (<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>):
OAuth 2.1 (draft-ietf-oauth-v2-1-13) with Protected Resource Metadata
(RFC 9728), Authorization Server Metadata (RFC 8414), Client ID Metadata
Documents (draft-ietf-oauth-client-id-metadata-document-00, the preferred
registration) and Dynamic Client Registration (RFC 7591, kept for older
clients), the authorization code grant with PKCE `S256` only, Resource
Indicators (RFC 8707), the `iss` authorization response parameter (RFC 9207)
and token revocation (RFC 7009).

Static agent keys (`kitsuden_agent_*`) keep working exactly as before. OAuth
is another way to _become_ the same agent, not a parallel permission system.

## Contents

- [Connect Claude in one step](#connect-claude-in-one-step)
- [Other clients](#other-clients)
- [Before you start: the public URL](#before-you-start-the-public-url)
- [What the human decides](#what-the-human-decides)
- [What a connection can do](#what-a-connection-can-do)
- [Tokens](#tokens)
- [Revoking](#revoking)
- [Endpoints](#endpoints)
- [Security notes](#security-notes)
- [Configuration](#configuration)
- [What is not covered](#what-is-not-covered)

## Connect Claude in one step

**Claude Code** (terminal):

```bash
claude mcp add --transport http kitsuden https://api.example.com/api/mcp
```

Then run `/mcp` inside Claude Code, choose `kitsuden` → **Authenticate**. Your
browser opens the Kitsuden panel; sign in if needed, pick the agent and the
scopes, and press **Allow**. That is all: Claude Code stores the tokens and
refreshes them.

**Claude Desktop / claude.ai**: _Settings → Connectors → Add custom
connector_, paste `https://api.example.com/api/mcp`, then **Connect**. The same
consent screen opens. (These connectors are reached from Anthropic's servers,
so the API must be on a public HTTPS URL.)

Replace `https://api.example.com` with your API's public URL — the value of
`OAUTH_ISSUER_URL` (see below).

## Other clients

Any client that follows the MCP authorization spec only needs the server URL,
`https://api.example.com/api/mcp`:

- **Cursor** (`~/.cursor/mcp.json`): `{ "mcpServers": { "kitsuden": { "url": "https://api.example.com/api/mcp" } } }`
- **VS Code** (`.vscode/mcp.json`): `{ "servers": { "kitsuden": { "type": "http", "url": "https://api.example.com/api/mcp" } } }`
- **MCP Inspector**: `npx @modelcontextprotocol/inspector`, transport _Streamable HTTP_,
  URL as above, then _Open Auth Settings → Quick OAuth Flow_.

`/api/mcp` accepts **Streamable HTTP** with plain JSON responses (a
`POST initialize` opens a session and returns `Mcp-Session-Id`; there is no
server-to-client stream, so `GET` with that header answers `405`). Choose
"HTTP" / "Streamable HTTP" in your client. The older `GET /api/mcp` +
`POST ?sessionId=` flow still exists for Kitsuden's own tools, but it answers
in the `POST` body instead of over the event stream, so standard HTTP+SSE
clients cannot use it.

## Before you start: the public URL

The issuer and the protected resource are built from **one** value:

| Variable           | Example                   | Used for                                                        |
| ------------------ | ------------------------- | --------------------------------------------------------------- |
| `OAUTH_ISSUER_URL` | `https://api.example.com` | `issuer`, endpoints, resource `https://api.example.com/api/mcp` |

It must be the exact origin clients use (scheme, host and port; no path). If
it is unset, `BETTER_AUTH_URL` is used. In production it **must be `https`**:
with `NODE_ENV=production` and a non-`https` issuer, OAuth turns itself off
(metadata answers `404`) rather than run an authorization server over http.

The consent screen lives in the admin panel at `ADMIN_URL/oauth/consent`, so
`ADMIN_URL` must also be the panel's public URL.

## What the human decides

The consent screen (panel, English or Spanish) shows the client's name, its
client ID, **where the answer will be sent** (the redirect host, with a
warning when it is `localhost`), and asks:

1. **Which agent the client acts as.** An **admin** can pick any active agent
   or create a new one. An **editor** can pick only agents they already sign.
   Agents themselves (static or OAuth keys) can never consent.
2. **Which scopes.** Only scopes the agent already has are offered; an editor
   is not offered `admin`, `admin:*`, `mcp:admin` or patterns that cover them.
   `mcp:connect` is required. Deny scopes (`!pattern`) are never part of a
   grant: the agent's denies always apply.

Whoever allows the connection **becomes the agent's human signer** (see
[approvals.md › Human signer](approvals.md#human-signer)): what the agent
creates through this connection is signed by them. The change is audited.

Denying sends the client back with `error=access_denied`.

## What a connection can do

An OAuth access token resolves to **the same agent context** as the agent's
static key. Everything that already applies to the agent applies unchanged:
scopes and denies ([permissions.md](permissions.md)), `allowedTools` and
toolsets ([toolsets.md](toolsets.md)), quotas, human approval
([approvals.md](approvals.md)), RLS, provenance and the audit log.

The only difference: the effective scopes are **narrowed** by the grant:

```
effective = the agent's denies (now) + each granted scope the agent still has (now)
```

Removing a scope from the agent removes it from its OAuth connections on the
next request. Adding a scope to the agent does **not** add it to existing
connections: the client has to ask again. A proposal made through an OAuth
connection is executed, once approved, with what that connection allows.

Each connection appears in the agent's **Keys** tab as a key named
`OAuth · <client>` (it has no secret of its own). Its id is the `keyId` in the
audit log, so you can tell which client did what.

## Tokens

|                                | Lifetime                                                | Notes                                        |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------- |
| Authorization code             | 60 s                                                    | one use; a second use revokes what it issued |
| Access token `kitsuden_oat_…`  | 15 min (`OAUTH_ACCESS_TOKEN_TTL`)                       | only valid at `/api/mcp`                     |
| Refresh token `kitsuden_ort_…` | 30 days (`OAUTH_REFRESH_TOKEN_TTL`), family max 90 days | rotated on every use                         |

- **Audience-bound.** A token is issued for the resource
  `<issuer>/api/mcp` and is rejected anywhere else (REST, GraphQL…) and by
  another Kitsuden with a different issuer. Requests to `/api/mcp` with an
  invalid, expired or foreign token get `401` with
  `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"`.
- **Rotation and reuse detection.** Each refresh returns a new refresh token
  and spends the old one. Presenting a spent refresh token again (a stolen
  copy, or a client bug) revokes the **whole family**: every access and
  refresh token that came from that authorization.
- A refresh may ask for **fewer** scopes, never more (`invalid_scope`).
- Codes, tokens and client secrets are stored as SHA-256 hashes only and are
  never logged.

## Revoking

- **Panel → OAuth connections** lists every connected client (admins see all,
  editors the ones they allowed) with the agent, who allowed it, scopes and
  last use. **Revoke** cuts the connection on the client's next request.
- Revoking the `OAuth · <client>` key in the agent's **Keys** tab does the same.
- Deactivating the agent stops all its connections.
- Clients can revoke their own tokens with `POST /api/oauth/revoke` (RFC 7009);
  revoking a refresh token revokes its family.

Clean-up runs hourly: expired requests, codes and tokens are deleted; dynamic
clients nobody approved within 7 days are deleted; connections with no live
refresh token and no use for 90 days are revoked as `stale`; clients whose
connections are all revoked and unused for 90 days are deleted.

## Endpoints

| Method and path                                         | Who                   | What                                   |
| ------------------------------------------------------- | --------------------- | -------------------------------------- |
| `GET /.well-known/oauth-protected-resource[/api/mcp]`   | anyone                | RFC 9728 metadata                      |
| `GET /.well-known/oauth-authorization-server`           | anyone                | RFC 8414 metadata                      |
| `POST /api/oauth/register`                              | anyone (rate-limited) | RFC 7591 registration                  |
| `GET /api/oauth/authorize`                              | browser               | validates, then redirects to the panel |
| `POST /api/oauth/token`                                 | client                | `authorization_code`, `refresh_token`  |
| `POST /api/oauth/revoke`                                | client                | RFC 7009                               |
| `GET/POST /api/oauth/consent/:id`                       | admin/editor (humans) | consent screen data and decision       |
| `GET /api/oauth/grants`, `DELETE /api/oauth/grants/:id` | admin/editor (humans) | connected clients, revoke              |

Supported: `response_type=code`, `code_challenge_method=S256`,
`grant_type` `authorization_code` and `refresh_token`, client authentication
`none`, `client_secret_post` and `client_secret_basic`. Not supported, by
design: implicit, password, client credentials, `plain` PKCE.

## Security notes

- **Redirect URIs** are registered as `https`, loopback `http`
  (`localhost`, `127.0.0.1`, `[::1]`) or a native app scheme (`cursor://…`,
  turn off with `KITSUDEN_OAUTH_CUSTOM_SCHEMES=false`), never with a fragment
  or credentials. They are compared **exactly**; the only exception (OAuth 2.1
  §8.4.2) is the port of a loopback `http` redirect. An unknown client or a
  redirect that does not match shows an error and never redirects.
- **Client ID Metadata Documents** (a client ID that is an `https` URL) are
  fetched over `https` on port 443 only, without following redirects, with a
  5-second timeout and a 64 KB limit, and only if every address the host
  resolves to is public (no loopback, private, link-local, CGNAT or multicast
  ranges). The document's `client_id` must equal the URL exactly. Copies are
  cached for its `Cache-Control` max-age (5 min – 24 h). A DNS answer that
  changes between the check and the connection (rebinding) is not fully ruled
  out; restrict hosts with `KITSUDEN_OAUTH_CIMD_ALLOWED_HOSTS` if that matters.
- **Rate limits** per IP, failing closed: registration 30/hour
  (`OAUTH_REGISTER_LIMIT`), token, revoke and authorize 60/minute
  (`OAUTH_TOKEN_LIMIT`); at most 1000 unapproved registrations per 24 h from
  one network, /24 or /48 (`OAUTH_MAX_PENDING_CLIENTS`).
- **A grant lasts as long as its human can give it.** Every token and refresh
  check reads the role of whoever consented: deleted, moved out of the team, or
  an editor holding a scope only an admin can delegate, and it stops working on
  the next request. Giving the role back revives it; revoke it to end it for good.
- The public endpoints answer CORS for any origin **without credentials**;
  the consent and connection endpoints use the panel session and its normal
  CORS/CSRF rules.
- Kitsuden's own `better-auth` (1.6.x) ships `mcp` and `oidc-provider` plugins;
  they were not used because they store tokens in clear, do not detect refresh
  token reuse, do not bind tokens to a resource, and model the _user_ rather
  than an _agent_ as the subject.

## Configuration

| Variable                                     | Default           |                                                           |
| -------------------------------------------- | ----------------- | --------------------------------------------------------- |
| `OAUTH_ISSUER_URL`                           | `BETTER_AUTH_URL` | public API origin, `https` in production                  |
| `KITSUDEN_OAUTH_ENABLED`                     | on                | `false` turns OAuth off                                   |
| `KITSUDEN_OAUTH_CIMD`                        | on                | `false`: no Client ID Metadata Documents                  |
| `KITSUDEN_OAUTH_CIMD_ALLOWED_HOSTS`          | (any public host) | comma list, subdomains included                           |
| `KITSUDEN_OAUTH_DCR`                         | on                | `false`: no dynamic registration                          |
| `KITSUDEN_OAUTH_CUSTOM_SCHEMES`              | on                | `false`: only https/loopback redirects                    |
| `OAUTH_ACCESS_TOKEN_TTL`                     | 900               | seconds, 60–3600                                          |
| `OAUTH_REFRESH_TOKEN_TTL`                    | 2592000           | seconds                                                   |
| `OAUTH_FAMILY_MAX_TTL`                       | 7776000           | seconds                                                   |
| `OAUTH_REGISTER_LIMIT` / `OAUTH_TOKEN_LIMIT` | 30 / 60           | per IP, per hour / minute                                 |
| `OAUTH_MAX_PENDING_CLIENTS`                  | 1000              | unapproved registrations per 24 h, per network (/24, /48) |

The tables are created by migration `0055_oauth_for_mcp.sql`; their RLS
(system and admin only) is in `rls-system-only.sql`.

## What is not covered

- Server-to-client streams (notifications, sampling) and resumable Streamable
  HTTP sessions; sessions live in memory and end on restart.
- `private_key_jwt` client authentication and OpenID Connect (no ID tokens,
  no `/.well-known/openid-configuration`).
- Step-up: a `403` for a missing scope inside a tool call is a tool error, not
  an `insufficient_scope` challenge. Only a missing `mcp:connect` produces a
  `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`.
- OAuth tokens for REST routes: they are bound to `/api/mcp`. Use a static key
  for REST.
