# Proof of possession (DPoP) and short-lived agent credentials

An agent key is a bearer secret: whoever holds it acts as the agent. Three
features shrink what a leaked key or token is worth:

- **DPoP** (RFC 9449): a key or token bound to a public key is useless without a
  fresh proof signed by the matching private key.
- **Token exchange**: an agent trades its long-lived key for a token of minutes,
  with a subset of its scopes and, optionally, a path prefix.
- **Run credentials**: every in-process agent run gets its own credential,
  checked before each tool call and revoked when the run ends.

Inspired by alibaba/open-agent-auth (Apache-2.0: workload proof tokens and
request-scoped workload identities); no code is copied. Migration `0086`.

## Contents

- [Binding a key to a public key](#binding-a-key-to-a-public-key)
- [Building a proof](#building-a-proof)
- [OAuth connections](#oauth-connections)
- [Exchanging a key for a short-lived token](#exchanging-a-key-for-a-short-lived-token)
- [Run credentials](#run-credentials)
- [Approvals](#approvals)
- [Configuration](#configuration)
- [Limits and caveats](#limits-and-caveats)

## Binding a key to a public key

A person (admin session) binds a static key to a public JWK: EC P-256 (`ES256`)
or Ed25519 (`EdDSA`).

```http
PUT /api/v1/agents/:id/keys/:keyId/dpop
{ "jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }
```

`{ "jwk": null }` unbinds it. The key list shows `dpopJkt`, the RFC 7638
thumbprint of the bound key. From then on the key works only as

```http
Authorization: DPoP kitsuden_agent_…
DPoP: <proof>
```

and a plain `Bearer` request gets `401` with
`WWW-Authenticate: DPoP error="invalid_dpop_proof"`.

`PUT /api/v1/agents/:id/dpop` with `{ "required": true }` refuses every
credential of that agent without a valid proof, and an unbound static key
outright. Both routes are for human admins only and are audited
(`config_change`).

## Building a proof

A proof is a compact JWS with `typ: "dpop+jwt"`, `alg` `ES256` or `EdDSA`, and
the public `jwk` in its header. Its claims:

| Claim | Value                                                                  |
| ----- | ---------------------------------------------------------------------- |
| `jti` | unique per request (a replay is refused)                               |
| `htm` | the request method                                                     |
| `htu` | the PUBLIC URL called, without query or fragment                       |
| `iat` | now, in seconds (±`DPOP_IAT_SKEW_SECONDS`, 60 by default)              |
| `ath` | base64url(SHA-256(the access token)) on every request that carries one |

`htu` uses the API's public origin (`OAUTH_ISSUER_URL`, else
`BETTER_AUTH_URL`), never the `Host` header, so it works behind a proxy.

```ts
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function proof(method: string, url: string, token: string): string {
  const header = b64({ typ: "dpop+jwt", alg: "ES256", jwk });
  const payload = b64({
    jti: randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    ath: createHash("sha256").update(token).digest("base64url"),
  });
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363", // JWS wants raw r||s, not DER
  }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}
```

## OAuth connections

The MCP authorization server advertises
`dpop_signing_alg_values_supported: ["ES256", "EdDSA"]`. A client that sends a
`DPoP` header to `POST /api/oauth/token` gets `token_type: "DPoP"`, and both the
access token and the refresh token are bound to that key. Refreshing a bound
family needs a proof from the same key. Clients that send no proof get bearer
tokens, as before.

## Exchanging a key for a short-lived token

```http
POST /api/agent/token/exchange
Authorization: Bearer kitsuden_agent_…
{ "scopes": ["datasets:read"], "ttlSeconds": 300, "audience": "/api/datasets" }
```

```json
{
  "token": "kitsuden_ast_…",
  "tokenType": "Bearer",
  "expiresAt": "…",
  "scopes": ["datasets:read"],
  "audience": "/api/datasets"
}
```

- `scopes` must be ones the caller holds (otherwise `403 SCOPE_NOT_HELD`); the
  caller's denials always carry over. Omitted: all of the caller's scopes.
- `ttlSeconds`: default 300, at least 30, at most `AGENT_SHORT_TOKEN_MAX_TTL`
  (900).
- `audience`: the token works only on that path and below it.
- If the exchange itself came with a valid DPoP proof, the new token is bound to
  the same key (`tokenType: "DPoP"`).
- It cannot be exchanged again (`403 NO_CHAINING`).
- It dies with its parent: revoking or expiring the key, or deactivating the
  agent, refuses it on its next request.
- Only the token's SHA-256 is stored. Issuance is audited
  (`short_token_issued`). Never held for approval, no write quota.

Use it to hand a sub-process, a script or another tool a credential that can do
less and that stops working on its own.

## Run credentials

`runAgent` (actions of type `agent`, `KonContext.agents.run`, the playground)
mints a credential for each run. Before **every** tool call it checks that the
credential is not revoked or expired and that the agent is still active; the
call's scopes are the agent's at that moment, narrowed by the credential's
(removing a scope mid-run takes effect on the next call). Its id is the call's
`keyId` in the audit log and in any proposal the run creates. It is revoked when
the run ends, however it ends. A refused call is audited as
`run_credential_refused`.

A run credential never authenticates over HTTP. It lives
`AGENT_RUN_CREDENTIAL_TTL` seconds (600): a run longer than that cannot call
tools any more.

## Approvals

A proposal made under a short token or a run credential is still executed after
a human approves it, even if that credential has expired or was revoked in the
meantime: the human approval is the authority then. What still stops it is what
stops any proposal: the agent deactivated, or the PARENT key revoked or expired.

## Configuration

| Variable                    | Default | Meaning                                          |
| --------------------------- | ------- | ------------------------------------------------ |
| `AGENT_SHORT_TOKEN_MAX_TTL` | `900`   | longest life of an exchanged token (60–3600 s)   |
| `AGENT_RUN_CREDENTIAL_TTL`  | `600`   | life of a run credential (60–3600 s)             |
| `DPOP_IAT_SKEW_SECONDS`     | `60`    | clock skew accepted on a proof's `iat` (1–600 s) |

Expired short credentials are deleted by the hourly agent-audit sweep, except
one a pending proposal still refers to.

## Limits and caveats

- **Replay cache**: proof `jti`s are remembered in Valkey (`SET NX`) when it is
  configured and answering, so every API instance sees every proof. Without
  Valkey they are remembered in the API process only: with several instances a
  proof could then be replayed once against another instance inside the `iat`
  window. Run one instance, or configure Valkey.
- An unbound key keeps working as a bearer secret unless the agent has
  `require_dpop`. Bind the keys of agents that run outside your machines.
- DPoP protects the credential in transit and at rest elsewhere; it does not
  protect against a compromised client that holds the private key.
