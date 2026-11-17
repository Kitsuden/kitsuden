/**
 * OAuth for external MCP servers (docs/agents/external-mcp.md, "OAuth")
 * ============================================================================
 *
 * An OPTION next to the static auth header, for servers that only take OAuth
 * 2.1 the way the MCP authorization specification describes it. No new
 * service: the API does the flow and Postgres keeps the tokens, encrypted with
 * the secrets-manager key like the auth header.
 *
 *   1. START (a human admin). Discover the server's authorization server:
 *      protected-resource metadata (RFC 9728), then authorization-server
 *      metadata (RFC 8414, or OpenID discovery). Register a client there
 *      (RFC 7591) unless the admin brings a client id. Answer the URL to open.
 *   2. CALLBACK (the admin's browser comes back). The route is public, as an
 *      OAuth redirect has to be: what authorizes it is the `state`, 256 random
 *      bits handed only to the admin who started, stored hashed, single use,
 *      ten minutes. Exchange the code with the PKCE verifier, store the tokens.
 *   3. USE. Every connection sends `Authorization: Bearer <access token>`; a
 *      token about to end is refreshed first, one process at a time.
 *
 * ── WHAT IS CHECKED, AND WHY ───────────────────────────────────────────────
 *
 *   · Every URL the server announces (metadata, endpoints) passes the same
 *     target check as the MCP server itself: https, public addresses only. A
 *     server must not be able to make the API call the cloud metadata service
 *     by announcing it as its token endpoint.
 *   · PKCE with S256 is required: a server that does not announce it is
 *     refused, as the MCP specification asks.
 *   · The token is asked for THIS server (`resource`, RFC 8707), and the
 *     callback finishes against the endpoints the flow started with.
 *   · No redirects are followed, each request has a timeout and a small cap.
 *   · Tokens are never returned by the API and never logged.
 */

import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "../db";
import { decryptSecret, encryptSecret, type EncryptedValue } from "../services/secrets";

import { serverTargetProblem } from "./external-mcp-target";
import { logger } from "./logger";
import { issuer } from "./oauth/config";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 256 * 1024;
const STATE_MINUTES = 10;
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60_000;

export const OAUTH_CALLBACK_PATH = "/api/mcp-oauth/callback";

/** Where the authorization server sends the admin's browser back. */
export function oauthRedirectUri(): string {
  return `${issuer()}${OAUTH_CALLBACK_PATH}`;
}

/** A problem the admin can act on: a 400 with this message. */
export class OAuthProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthProblem";
  }
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

// ═══════════════════════════════════════════════════════════════
// Outbound requests
// ═══════════════════════════════════════════════════════════════

async function checked(url: string, what: string): Promise<string> {
  const problem = await serverTargetProblem(url);
  if (problem) throw new OAuthProblem(`${what}: ${problem}`);
  return url;
}

async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  what: string
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  await checked(url, what);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Kitsuden-MCP-OAuth/1",
        ...init.headers,
      },
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthProblem(`${what}: ${err instanceof Error ? err.message : "request failed"}`);
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new OAuthProblem(`${what}: the answer is larger than ${MAX_BYTES / 1024} KB`);
      }
      chunks.push(value);
    }
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: the caller decides what that means for this request.
  }
  return { status: res.status, json };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// ═══════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/** `https://host/.well-known/<name>` with the URL's path appended, then without it. */
function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  const withPath = `${u.origin}/.well-known/${name}${path}`;
  const root = `${u.origin}/.well-known/${name}`;
  return path ? [withPath, root] : [root];
}

/**
 * The authorization server of an MCP server. The protected-resource document
 * names it; a server without one is its own authorization server (the older
 * MCP convention).
 */
export async function discoverAuthorizationServer(serverUrl: string): Promise<AuthorizationServer> {
  let authServer: string | null = null;
  for (const url of wellKnown(serverUrl, "oauth-protected-resource")) {
    const { status, json } = await request(url, {}, "Protected-resource metadata");
    if (status !== 200 || !json) continue;
    const list = Array.isArray(json.authorization_servers) ? json.authorization_servers : [];
    authServer = str(list[0]);
    if (authServer) break;
  }
  authServer ??= new URL(serverUrl).origin;
  await checked(authServer, "Authorization server");

  for (const name of ["oauth-authorization-server", "openid-configuration"]) {
    for (const url of wellKnown(authServer, name)) {
      const { status, json } = await request(url, {}, "Authorization-server metadata");
      if (status !== 200 || !json) continue;
      const authorizationEndpoint = str(json.authorization_endpoint);
      const tokenEndpoint = str(json.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint) continue;
      const methods = Array.isArray(json.code_challenge_methods_supported)
        ? json.code_challenge_methods_supported
        : [];
      if (!methods.includes("S256")) {
        throw new OAuthProblem(
          "The authorization server does not announce PKCE with S256, which MCP requires"
        );
      }
      const registrationEndpoint = str(json.registration_endpoint);
      // The browser opens the first; the API calls the other two.
      await checked(authorizationEndpoint, "Authorization endpoint");
      await checked(tokenEndpoint, "Token endpoint");
      if (registrationEndpoint) await checked(registrationEndpoint, "Registration endpoint");
      return {
        issuer: str(json.issuer) ?? authServer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
      };
    }
  }
  throw new OAuthProblem(
    "The server does not publish OAuth authorization-server metadata; use an auth header instead"
  );
}

// ═══════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════

interface Pending extends AuthorizationServer {
  clientId: string;
  /** Encrypted when present. */
  clientSecret: EncryptedValue | null;
  scopes: string | null;
  resource: string;
  redirectUri: string;
}

export interface StartInput {
  /** A client registered by hand with the authorization server. Without it, dynamic registration. */
  clientId?: string;
  clientSecret?: string;
  /** Space-separated scopes to ask for. Without it, the server's default. */
  scopes?: string;
}

const hashOf = (state: string) => createHash("sha256").update(state).digest("hex");
const base64url = (b: Buffer) => b.toString("base64url");

async function registerClient(
  endpoint: string,
  redirectUri: string
): Promise<{ clientId: string; clientSecret: string | null }> {
  const { status, json } = await request(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Kitsuden",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    "Client registration"
  );
  const clientId = str(json?.client_id);
  if (status < 200 || status >= 300 || !clientId) {
    throw new OAuthProblem(
      `Client registration was refused (${status}); register a client by hand and pass its clientId`
    );
  }
  return { clientId, clientSecret: str(json?.client_secret) };
}

/**
 * Starts an authorization for a server and answers the URL the admin opens.
 * Nothing changes on the server row until the callback succeeds.
 */
export async function startOAuth(
  server: { id: string; url: string },
  input: StartInput,
  startedBy: string
): Promise<{ authorizationUrl: string; redirectUri: string }> {
  const as = await discoverAuthorizationServer(server.url);
  const redirectUri = oauthRedirectUri();

  let clientId = str(input.clientId);
  let clientSecret = str(input.clientSecret);
  if (!clientId) {
    if (!as.registrationEndpoint) {
      throw new OAuthProblem(
        "The authorization server has no dynamic client registration; register a client by hand and pass its clientId"
      );
    }
    ({ clientId, clientSecret } = await registerClient(as.registrationEndpoint, redirectUri));
  }

  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const pending: Pending = {
    ...as,
    clientId,
    clientSecret: clientSecret ? encryptSecret(clientSecret) : null,
    scopes: str(input.scopes),
    resource: server.url,
    redirectUri,
  };

  await db.execute(sql`DELETE FROM external_mcp_oauth_states WHERE expires_at < now()`);
  await db.execute(sql`
    INSERT INTO external_mcp_oauth_states (state_hash, server_id, code_verifier, pending, started_by, expires_at)
    VALUES (${hashOf(state)}, ${server.id}::uuid, ${JSON.stringify(encryptSecret(verifier))}::jsonb,
            ${JSON.stringify(pending)}::jsonb, ${startedBy},
            now() + make_interval(mins => ${STATE_MINUTES}))`);

  const url = new URL(as.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", server.url);
  if (pending.scopes) url.searchParams.set("scope", pending.scopes);
  return { authorizationUrl: url.toString(), redirectUri };
}

// ═══════════════════════════════════════════════════════════════
// Tokens
// ═══════════════════════════════════════════════════════════════

interface Secrets {
  accessToken: string;
  refreshToken: string | null;
  clientSecret: string | null;
}

/** What is stored in `oauth_config`: nothing here is a secret. */
export interface OAuthConfig {
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string | null;
  resource: string;
  /** ISO time the access token ends, or null when the server did not say. */
  expiresAt: string | null;
  connectedAt: string;
  connectedBy: string;
}

async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  clientSecret: string | null,
  what: string
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string | null;
}> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(form.client_id)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  }
  const { status, json } = await request(
    endpoint,
    { method: "POST", headers, body: new URLSearchParams(form).toString() },
    what
  );
  const accessToken = str(json?.access_token);
  if (status !== 200 || !accessToken) {
    // The server's `error` code is safe to show; its description may echo input, so it is not.
    throw new OAuthProblem(
      `${what} was refused (${status}${str(json?.error) ? `: ${str(json?.error)}` : ""})`
    );
  }
  const type = str(json?.token_type);
  if (type && type.toLowerCase() !== "bearer") {
    throw new OAuthProblem(
      `${what}: the server issued a "${type}" token; only Bearer is supported`
    );
  }
  const seconds = Number(json?.expires_in);
  return {
    accessToken,
    refreshToken: str(json?.refresh_token),
    expiresAt:
      Number.isFinite(seconds) && seconds > 0
        ? new Date(Date.now() + seconds * 1000).toISOString()
        : null,
    scopes: str(json?.scope),
  };
}

/**
 * Finishes an authorization: the `state` must exist and be unexpired. It is
 * deleted before anything else, so it cannot be used twice. The connection is
 * recorded as made by whoever started it. Returns the server's id.
 */
export async function completeOAuth(state: string, code: string): Promise<string> {
  const [row] = rows(
    await db.execute(sql`
      DELETE FROM external_mcp_oauth_states WHERE state_hash = ${hashOf(state)}
      RETURNING server_id::text AS server_id, code_verifier, pending, started_by, expires_at > now() AS live`)
  );
  if (!row || row.live !== true) {
    throw new OAuthProblem("This authorization is unknown or has expired; start it again");
  }
  const user = String(row.started_by);
  const pending = row.pending as Pending;
  const serverId = String(row.server_id);
  const [server] = rows(
    await db.execute(sql`SELECT url FROM external_mcp_servers WHERE id = ${serverId}::uuid`)
  );
  // The URL changed while the admin was away: the token would be for another server.
  if (!server || server.url !== pending.resource) {
    throw new OAuthProblem(
      "The server's URL changed since this authorization started; start it again"
    );
  }

  const clientSecret = pending.clientSecret ? decryptSecret(pending.clientSecret) : null;
  const token = await tokenRequest(
    pending.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: decryptSecret(row.code_verifier as EncryptedValue),
      resource: pending.resource,
    },
    clientSecret,
    "The code exchange"
  );

  const config: OAuthConfig = {
    issuer: pending.issuer,
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    scopes: token.scopes ?? pending.scopes,
    resource: pending.resource,
    expiresAt: token.expiresAt,
    connectedAt: new Date().toISOString(),
    connectedBy: user,
  };
  const secrets: Secrets = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    clientSecret,
  };
  // OAuth replaces the static header: a server uses one or the other.
  await db.execute(sql`
    UPDATE external_mcp_servers
       SET oauth_config = ${JSON.stringify(config)}::jsonb,
           oauth_secret = ${JSON.stringify(encryptSecret(JSON.stringify(secrets)))}::jsonb,
           auth_header_name = NULL, auth_header_value = NULL,
           last_error = NULL, updated_by = ${user}, updated_at = now()
     WHERE id = ${serverId}::uuid`);
  logger.info({ serverId, issuer: config.issuer, by: user }, "[external-mcp] OAuth connected");
  return serverId;
}

/** Forgets the tokens and the client. The server goes back to no authentication. */
export async function disconnectOAuth(serverId: string, user: string): Promise<boolean> {
  const done = rows(
    await db.execute(sql`
      UPDATE external_mcp_servers
         SET oauth_config = NULL, oauth_secret = NULL, updated_by = ${user}, updated_at = now()
       WHERE id = ${serverId}::uuid AND oauth_config IS NOT NULL
      RETURNING id`)
  );
  await db.execute(sql`DELETE FROM external_mcp_oauth_states WHERE server_id = ${serverId}::uuid`);
  return done.length > 0;
}

/**
 * The bearer token to connect with, refreshed first when it is about to end.
 * `null` when the server does not use OAuth.
 *
 * The refresh runs in a transaction that locks the server's row: with refresh
 * token rotation, two processes refreshing at once would each spend the same
 * token and one of them would be left with a revoked one.
 */
export async function oauthBearer(serverId: string): Promise<string | null> {
  const [quick] = rows(
    await db.execute(sql`
      SELECT oauth_config, oauth_secret FROM external_mcp_servers WHERE id = ${serverId}::uuid`)
  );
  if (!quick?.oauth_config || !quick.oauth_secret) return null;
  const fresh = (config: OAuthConfig) =>
    !config.expiresAt || new Date(config.expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS;
  const open = (value: unknown) => JSON.parse(decryptSecret(value as EncryptedValue)) as Secrets;
  if (fresh(quick.oauth_config as OAuthConfig)) return open(quick.oauth_secret).accessToken;

  return db.transaction(async (tx) => {
    const [locked] = rows(
      await tx.execute(sql`
        SELECT oauth_config, oauth_secret FROM external_mcp_servers
         WHERE id = ${serverId}::uuid FOR UPDATE`)
    );
    if (!locked?.oauth_config || !locked.oauth_secret) return null;
    const config = locked.oauth_config as OAuthConfig;
    const secrets = open(locked.oauth_secret);
    // Another process refreshed it while this one waited for the lock.
    if (fresh(config)) return secrets.accessToken;
    if (!secrets.refreshToken) {
      throw new OAuthProblem(
        "The OAuth access token ended and there is no refresh token; connect again"
      );
    }
    const token = await tokenRequest(
      config.tokenEndpoint,
      {
        grant_type: "refresh_token",
        refresh_token: secrets.refreshToken,
        client_id: config.clientId,
        resource: config.resource,
      },
      secrets.clientSecret,
      "The token refresh"
    );
    const next: Secrets = {
      accessToken: token.accessToken,
      // A server that does not rotate keeps the old one valid.
      refreshToken: token.refreshToken ?? secrets.refreshToken,
      clientSecret: secrets.clientSecret,
    };
    await tx.execute(sql`
      UPDATE external_mcp_servers
         SET oauth_config = ${JSON.stringify({ ...config, expiresAt: token.expiresAt })}::jsonb,
             oauth_secret = ${JSON.stringify(encryptSecret(JSON.stringify(next)))}::jsonb
       WHERE id = ${serverId}::uuid`);
    return next.accessToken;
  });
}
