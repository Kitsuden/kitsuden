/**
 * OAuth 2.1 for MCP — the authorization server
 * ============================================================================
 *
 * Registration (DCR and Client ID Metadata Documents), authorization request,
 * consent, code exchange, refresh with rotation, revocation and the
 * sweep of expired items. The HTTP routes are in routes/oauth.ts; token
 * authentication in services/agent-auth.ts (via ./tokens).
 *
 * The model, in one line: a GRANT says «human H let client C
 * act as agent A with these scopes». It hangs off a row of
 * `agent_api_keys` (algorithm 'oauth'), so the agent behaves the same
 * as with its static key. Guide: docs/agents/oauth.md.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { isIPv4, isIPv6 } from "net";

import { concedeScope, isDenial, normalizeScopes } from "@kitsuden/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../../db";
import { agentApiKeys, agentIdentities, authUsers } from "../../db/schema-core";
import {
  oauthAuthorizationRequests,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
} from "../../db/schema-oauth";
import { logAgentAction, logAuthFailure } from "../../services/agent-audit";

import { isClientIdUrl, readClientDocument } from "./cimd";
import {
  CLIENT_PREFIX,
  CLIENT_SECRET_PREFIX,
  BASIC_SCOPES,
  CODE_TTL_S,
  REQUEST_TTL_S,
  cimdOn,
  issuer,
  mcpResource,
  accessTtl,
  familyTtl,
  refreshTtl,
  consentUrl,
} from "./config";
import { grantStillDelegable, humanCanDelegate, newToken } from "./tokens";
import {
  errorMayRedirect,
  hashOf,
  readScopes,
  invalidRedirectReason,
  pkceMatches,
  requestedResource,
  redirectMatches,
  validChallenge,
} from "./uris";

export type Client = typeof oauthClients.$inferSelect;

/** Error OAuth (RFC 6749 §5.2 / RFC 7591 §3.2.2). */
export class ErrorOAuth extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400
  ) {
    super(description);
  }
}

const now = () => new Date();
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC REGISTRATION (RFC 7591)
// ═══════════════════════════════════════════════════════════════════════════

const METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type Method = (typeof METHODS)[number];

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: Method;
  client_uri?: string;
  logo_uri?: string;
  software_id?: string;
  software_version?: string;
}

export async function registerClient(body: unknown, ip: string | null): Promise<RegisteredClient> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ErrorOAuth("invalid_client_metadata", "The body must be a JSON object");
  }
  const m = body as Record<string, unknown>;
  const redirectUris = m.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    throw new ErrorOAuth("invalid_redirect_uri", "redirect_uris must be an array of 1-10 URIs");
  }
  for (const r of redirectUris) {
    const reason = invalidRedirectReason(r);
    if (reason)
      throw new ErrorOAuth(
        "invalid_redirect_uri",
        `redirect_uri ${String(r).slice(0, 100)} ${reason}`
      );
  }
  // RFC 7591 §2: client_secret_basic by default. MCP clients (public) send `none`.
  const method = (m.token_endpoint_auth_method ?? "client_secret_basic") as Method;
  if (!METHODS.includes(method)) {
    throw new ErrorOAuth(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be one of: ${METHODS.join(", ")}`
    );
  }
  const grantTypes =
    m.grant_types === undefined ? ["authorization_code", "refresh_token"] : m.grant_types;
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.length === 0 ||
    grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token") ||
    !grantTypes.includes("authorization_code")
  ) {
    throw new ErrorOAuth(
      "invalid_client_metadata",
      "grant_types must include authorization_code and may include refresh_token (no implicit, password or client_credentials)"
    );
  }
  if (
    m.response_types !== undefined &&
    (!Array.isArray(m.response_types) || m.response_types.some((r) => r !== "code"))
  ) {
    throw new ErrorOAuth("invalid_client_metadata", 'response_types must be ["code"]');
  }
  const id = `${CLIENT_PREFIX}${randomBytes(18).toString("base64url")}`;
  const secret =
    method === "none" ? null : `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  const name = text(m.client_name, 200) ?? "MCP client";
  const [row] = await db
    .insert(oauthClients)
    .values({
      id,
      kind: "dcr",
      clientName: name,
      clientUri: text(m.client_uri, 500),
      logoUri: text(m.logo_uri, 500),
      softwareId: text(m.software_id, 200),
      softwareVersion: text(m.software_version, 100),
      redirectUris: redirectUris as string[],
      grantTypes: ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: method,
      secretHash: secret ? hashOf(secret) : null,
      registeredIp: ip,
    })
    .returning();
  const c = row!;
  return {
    client_id: c.id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(c.createdAt.getTime() / 1000),
    client_name: c.clientName,
    redirect_uris: c.redirectUris,
    grant_types: c.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(c.clientUri ? { client_uri: c.clientUri } : {}),
    ...(c.logoUri ? { logo_uri: c.logoUri } : {}),
    ...(c.softwareId ? { software_id: c.softwareId } : {}),
    ...(c.softwareVersion ? { software_version: c.softwareVersion } : {}),
  };
}

/**
 * Unconsented clients created in the last 24 h (brake against filling
 * the table). With `ip`, those of that origin: /24 for IPv4, /48 for IPv6. The
 * global count let anyone with a few dozen IPs block registration for everybody.
 */
export async function recentPendingClients(ip?: string | null): Promise<number> {
  const range = ip ? registerRange(ip) : null;
  const r = (await db.execute(sql`
    SELECT count(*)::int AS n FROM oauth_clients c
    WHERE c.kind = 'dcr' AND c.created_at > now() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
      ${range ? sql`AND c.registered_ip LIKE ${`${range}%`}` : sql``}
  `)) as unknown as { rows: { n: number }[] };
  return r.rows[0]?.n ?? 0;
}

/** The text prefix shared by the addresses of a client's network, or `null` if it is not an IP. */
export function registerRange(ip: string): string | null {
  if (isIPv4(ip)) return `${ip.split(".").slice(0, 3).join(".")}.`;
  if (isIPv6(ip)) return `${ip.toLowerCase().split(":").slice(0, 3).join(":")}:`;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENTS: lookup (DCR) and metadata documents (CIMD)
// ═══════════════════════════════════════════════════════════════════════════

/** The client of a client_id, reading (or refreshing) its document if it is a URL. */
export async function clientById(clientId: string): Promise<Client | null> {
  if (!clientId || clientId.length > 2000) return null;
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  if (!isClientIdUrl(clientId)) return row && row.kind === "dcr" ? row : null;
  if (!cimdOn()) return null;
  if (row && row.kind === "cimd" && row.metadataExpiresAt && row.metadataExpiresAt > now())
    return row;
  const read = await readClientDocument(clientId);
  if (!read.ok) {
    throw new ErrorOAuth("invalid_client", `Client ID Metadata Document rejected: ${read.reason}`);
  }
  const d = read.doc;
  const values = {
    kind: "cimd",
    clientName: d.clientName,
    clientUri: d.clientUri,
    logoUri: d.logoUri,
    softwareId: d.softwareId,
    softwareVersion: d.softwareVersion,
    redirectUris: d.redirectUris,
    grantTypes: d.grantTypes,
    tokenEndpointAuthMethod: "none",
    secretHash: null,
    metadataExpiresAt: d.expires,
  };
  const [saved] = await db
    .insert(oauthClients)
    .values({ id: clientId, ...values })
    .onConflictDoUpdate({ target: oauthClients.id, set: values })
    .returning();
  return saved ?? null;
}

/**
 * Client authentication at /token and /revoke (OAuth 2.1 §2.4): `none`
 * (client_id only), `client_secret_post` or `client_secret_basic`.
 */
export async function authenticateClient(
  header: string | undefined,
  parameters: Record<string, string>
): Promise<Client> {
  let clientId = parameters.client_id;
  let secret: string | undefined = parameters.client_secret;
  let byBasic = false;
  if (header?.toLowerCase().startsWith("basic ")) {
    byBasic = true;
    try {
      const plain = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const i = plain.indexOf(":");
      if (i < 0) throw new Error();
      const id = decodeURIComponent(plain.slice(0, i));
      if (clientId && clientId !== id) throw new Error();
      clientId = id;
      secret = decodeURIComponent(plain.slice(i + 1));
    } catch {
      throw new ErrorOAuth("invalid_client", "Malformed HTTP Basic client credentials", 401);
    }
  }
  if (!clientId) throw new ErrorOAuth("invalid_client", "client_id is required", 401);
  let client: Client | null;
  try {
    client = await clientById(clientId);
  } catch (e) {
    if (e instanceof ErrorOAuth) throw new ErrorOAuth("invalid_client", e.description, 401);
    throw e;
  }
  if (!client) throw new ErrorOAuth("invalid_client", "Unknown client", 401);
  const method = client.tokenEndpointAuthMethod as Method;
  if (method === "none") {
    if (secret)
      throw new ErrorOAuth("invalid_client", "This is a public client: send no client_secret", 401);
    return client;
  }
  if (!secret || (method === "client_secret_basic") !== byBasic || !client.secretHash) {
    throw new ErrorOAuth(
      "invalid_client",
      `Client authentication failed (expected ${method})`,
      401
    );
  }
  const a = Buffer.from(hashOf(secret));
  const b = Buffer.from(client.secretHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ErrorOAuth("invalid_client", "Client authentication failed", 401);
  }
  return client;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATION (GET /api/oauth/authorize)
// ═══════════════════════════════════════════════════════════════════════════

export type AuthorizationResult =
  /** Error that CANNOT be returned to the client (invalid client or redirect): it is displayed. */
  | { type: "screen"; error: string; description: string }
  /** Where to send the browser: the consent, or the client's redirect with an error. */
  | { type: "redirect"; url: string };

export function returnUrl(
  redirectUri: string,
  parameters: Record<string, string | null | undefined>
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(parameters))
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  // RFC 9207: the issuer, on success and on error
  u.searchParams.set("iss", issuer());
  return u.toString();
}

/** Does this client have any grant that is not revoked? (a human approved it) */
async function hasLiveGrant(clientId: string): Promise<boolean> {
  const [g] = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.clientId, clientId), isNull(oauthGrants.revokedAt)))
    .limit(1);
  return Boolean(g);
}

export async function startAuthorization(
  q: Record<string, string | undefined>
): Promise<AuthorizationResult> {
  const clientId = q.client_id ?? "";
  let client: Client | null = null;
  try {
    client = await clientById(clientId);
  } catch (e) {
    if (e instanceof ErrorOAuth)
      return { type: "screen", error: e.error, description: e.description };
    throw e;
  }
  if (!client) return { type: "screen", error: "invalid_client", description: "Unknown client_id" };
  const redirectUri = q.redirect_uri ?? "";
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return {
      type: "screen",
      error: "invalid_request",
      description: "redirect_uri is missing or does not exactly match a registered redirect URI",
    };
  }
  const registeredClientId = client.id;
  /**
   * An error goes back to the client with a 302 only if its redirect is
   * trustworthy (RFC 9700 §4.11): loopback, or a client a human already
   * approved (a grant that is not revoked). A client registered anonymously
   * and never approved sees the error screen: otherwise open registration plus
   * this 302 with no login or consent make an open redirector (security review F68).
   */
  const error = async (code: string, description: string): Promise<AuthorizationResult> => {
    if (!errorMayRedirect(redirectUri, await hasLiveGrant(registeredClientId))) {
      return { type: "screen", error: code, description };
    }
    return {
      type: "redirect",
      url: returnUrl(redirectUri, { error: code, error_description: description, state: q.state }),
    };
  };
  if (q.response_type !== "code") {
    return error("unsupported_response_type", "Only response_type=code is supported");
  }
  if (q.code_challenge_method !== "S256" || !validChallenge(q.code_challenge)) {
    return error(
      "invalid_request",
      "PKCE is required: code_challenge (43 base64url chars) with code_challenge_method=S256"
    );
  }
  const scopes = readScopes(q.scope);
  if (scopes === null) return error("invalid_scope", "Malformed scope parameter");
  const resource = requestedResource(q.resource);
  if (resource && !resource.ok)
    return error("invalid_target", `The only resource served here is ${mcpResource()}`);
  if (q.state && q.state.length > 2000) return error("invalid_request", "state is too long");

  const id = randomUUID();
  await db.insert(oauthAuthorizationRequests).values({
    id,
    clientId: client.id,
    redirectUri,
    state: q.state ?? null,
    codeChallenge: q.code_challenge!,
    requestedScopes: scopes,
    resource: resource?.ok ? resource.resource : mcpResource(),
    expiresAt: inSeconds(REQUEST_TTL_S),
  });
  return { type: "redirect", url: consentUrl(id) };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSENT (panel)
// ═══════════════════════════════════════════════════════════════════════════

export interface Human {
  id: string;
  role: string;
}

/** The role as of NOW (not the cookie's). */
export async function freshHuman(id: string): Promise<Human | null> {
  const [u] = await db
    .select({ id: authUsers.id, role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  return u ? { id: u.id, role: (u.role as string | null) ?? "user" } : null;
}

export { humanCanDelegate };

/** The agents this human can choose: an admin, all active ones; an editor, those they already sign. */
/** Whom this person can delegate to: an admin, to any active agent; the others, to those they sign. */
function eligibleFilter(h: Human) {
  return h.role === "admin"
    ? eq(agentIdentities.isActive, true)
    : and(eq(agentIdentities.isActive, true), eq(agentIdentities.sponsorUserId, h.id));
}

/** Cap on the consent screen LIST (not on what can be chosen). */
const MAX_AGENTS_ON_SCREEN = 500;

/**
 * The agents the screen shows: most recent first, up to
 * `MAX_AGENTS_ON_SCREEN` (one more to know whether there are more). Before they went by
 * name and cut off at 500, and the DECISION looked up the chosen agent in that
 * same list: with more than 500, a valid agent gave «not yours to delegate».
 */
async function eligibleAgents(h: Human) {
  return db
    .select()
    .from(agentIdentities)
    .where(eligibleFilter(h))
    .orderBy(desc(agentIdentities.updatedAt), agentIdentities.name)
    .limit(MAX_AGENTS_ON_SCREEN + 1);
}

/** The chosen agent, by id and with the same filter: no cap. */
async function eligibleAgent(h: Human, id: string | undefined) {
  if (!id) return undefined;
  const [a] = await db
    .select()
    .from(agentIdentities)
    .where(and(eligibleFilter(h), eq(agentIdentities.id, id)))
    .limit(1);
  return a;
}

async function liveRequest(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [p] = await db
    .select({ p: oauthAuthorizationRequests, c: oauthClients })
    .from(oauthAuthorizationRequests)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAuthorizationRequests.clientId))
    .where(eq(oauthAuthorizationRequests.id, id))
    .limit(1);
  if (!p || p.p.decidedAt || p.p.expiresAt <= now()) return null;
  return p;
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}//`;
  } catch {
    return uri;
  }
}

export async function consentView(requestId: string, h: Human) {
  const alive = await liveRequest(requestId);
  if (!alive) return null;
  const { p, c } = alive;
  const agents = await eligibleAgents(h);
  let loopbackOnly = false;
  try {
    const u = new URL(p.redirectUri);
    loopbackOnly = u.protocol === "http:";
  } catch {
    /* nothing */
  }
  return {
    request: {
      id: p.id,
      expiresAt: p.expiresAt,
      requestedScopes: p.requestedScopes,
      resource: p.resource,
    },
    client: {
      id: c.id,
      name: c.clientName,
      kind: c.kind,
      uri: c.clientUri,
      logoUri: c.logoUri,
      softwareId: c.softwareId,
      redirectUri: p.redirectUri,
      redirectHost: hostOf(p.redirectUri),
      // MCP 2026-07-28, CIMD security: warn about localhost-only redirects
      localhostRedirect: loopbackOnly,
      registeredAt: c.createdAt,
    },
    human: { id: h.id, role: h.role, canCreateAgent: h.role === "admin" },
    basicScopes: [...BASIC_SCOPES],
    // There are more agents than fit on the screen: it is still chosen by id.
    moreAgents: agents.length > MAX_AGENTS_ON_SCREEN,
    agents: agents.slice(0, MAX_AGENTS_ON_SCREEN).map((a) => {
      const scopes = ((a.scopes as string[] | null) ?? []).filter((s) => typeof s === "string");
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        grantable: scopes.filter((s) => !isDenial(s) && humanCanDelegate(h.role, s)),
        notDelegable: scopes.filter((s) => !isDenial(s) && !humanCanDelegate(h.role, s)),
        denies: scopes.filter((s) => isDenial(s)),
        sponsorUserId: a.sponsorUserId ?? null,
      };
    }),
  };
}

export interface Decision {
  decision: "approve" | "deny";
  agentId?: string;
  newAgent?: { name: string; description?: string };
  scopes?: string[];
}

export async function decideConsent(
  requestId: string,
  h: Human,
  d: Decision
): Promise<{ redirectTo: string } | null> {
  const alive = await liveRequest(requestId);
  if (!alive) return null;
  const { p, c } = alive;

  if (d.decision === "deny") {
    const [marked] = await db
      .update(oauthAuthorizationRequests)
      .set({ decidedAt: now() })
      .where(
        and(eq(oauthAuthorizationRequests.id, p.id), isNull(oauthAuthorizationRequests.decidedAt))
      )
      .returning({ id: oauthAuthorizationRequests.id });
    if (!marked) return null;
    return {
      redirectTo: returnUrl(p.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the request",
        state: p.state,
      }),
    };
  }
  if (d.decision !== "approve")
    throw new ErrorOAuth("invalid_request", "decision must be approve or deny", 422);

  let scopes: string[];
  try {
    scopes = normalizeScopes(d.scopes ?? []);
  } catch (e) {
    throw new ErrorOAuth("invalid_scope", (e as Error).message, 422);
  }
  if (scopes.some(isDenial))
    throw new ErrorOAuth(
      "invalid_scope",
      "A grant cannot contain deny ('!') scopes: denies come from the agent",
      422
    );
  if (!concedeScope(scopes, "mcp:connect")) {
    throw new ErrorOAuth(
      "invalid_scope",
      "The grant must include mcp:connect (or a scope that covers it)",
      422
    );
  }
  const nondelegable = scopes.filter((s) => !humanCanDelegate(h.role, s));
  if (nondelegable.length) {
    throw new ErrorOAuth(
      "invalid_scope",
      `Your role cannot delegate: ${nondelegable.join(", ")}`,
      403
    );
  }

  const done = await db.transaction(async (tx) => {
    // First thing: the request is decided ONCE (two clicks, two tabs).
    const [marked] = await tx
      .update(oauthAuthorizationRequests)
      .set({ decidedAt: now() })
      .where(
        and(eq(oauthAuthorizationRequests.id, p.id), isNull(oauthAuthorizationRequests.decidedAt))
      )
      .returning({ id: oauthAuthorizationRequests.id });
    if (!marked)
      throw new ErrorOAuth(
        "invalid_request",
        "This authorization request was already decided",
        404
      );
    let agent: typeof agentIdentities.$inferSelect | undefined;
    if (d.newAgent) {
      if (h.role !== "admin")
        throw new ErrorOAuth("access_denied", "Only an admin can create an agent", 403);
      const name = text(d.newAgent.name, 100);
      if (!name) throw new ErrorOAuth("invalid_request", "newAgent.name is required", 422);
      [agent] = await tx
        .insert(agentIdentities)
        .values({
          name,
          description:
            text(d.newAgent.description, 500) ?? `Connected with OAuth from ${c.clientName}`,
          type: "oauth-client",
          scopes,
          sponsorUserId: h.id,
        })
        .returning();
    } else {
      agent = await eligibleAgent(h, d.agentId);
      if (!agent)
        throw new ErrorOAuth("access_denied", "Agent not found or not yours to delegate", 403);
      // It only NARROWS: each scope must already be covered by the agent.
      const ofTheAgent = (agent.scopes as string[] | null) ?? [];
      const extras = scopes.filter((s) => !concedeScope(ofTheAgent, s));
      if (extras.length) {
        throw new ErrorOAuth("invalid_scope", `The agent does not have: ${extras.join(", ")}`, 403);
      }
    }
    const signerBefore = agent!.sponsorUserId ?? null;
    if (signerBefore !== h.id) {
      // Whoever consents SIGNS what the agent creates: they become its signer.
      await tx
        .update(agentIdentities)
        .set({ sponsorUserId: h.id, updatedAt: now() })
        .where(eq(agentIdentities.id, agent!.id));
    }
    const [key] = await tx
      .insert(agentApiKeys)
      .values({
        agentId: agent!.id,
        keyId: null,
        // Marker: it is not the hash of anything, it never verifies (algorithm 'oauth')
        keyHash: `oauth:${randomUUID()}`,
        keyPrefix: "kitsuden_oat_",
        algorithm: "oauth",
        name: `OAuth · ${c.clientName}`.slice(0, 100),
      })
      .returning();
    const grantId = randomUUID();
    await tx.insert(oauthGrants).values({
      id: grantId,
      clientId: c.id,
      agentId: agent!.id,
      keyId: key!.id,
      userId: h.id,
      scopes,
      resource: p.resource,
    });
    const code = randomBytes(32).toString("base64url");
    await tx.insert(oauthCodes).values({
      codeHash: hashOf(code),
      grantId,
      clientId: c.id,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scopes,
      resource: p.resource,
      expiresAt: inSeconds(CODE_TTL_S),
    });
    return {
      redirectTo: returnUrl(p.redirectUri, { code, state: p.state }),
      audit: { agentId: agent!.id, keyId: key!.id, grantId, signerBefore },
    };
  });
  // Outside the transaction: the audit row points to the agent (FK), which
  // may be new and not exist until the COMMIT.
  logAgentAction({
    agentId: done.audit.agentId,
    keyId: done.audit.keyId,
    action: "config_change",
    resource: "oauth_grant",
    details: {
      grantId: done.audit.grantId,
      clientId: c.id,
      clientName: c.clientName,
      scopes,
      by: h.id,
      sponsorBefore: done.audit.signerBefore,
      sponsorAfter: h.id,
      createdAgent: !!d.newAgent,
    },
    success: true,
  });
  return { redirectTo: done.redirectTo };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN (POST /api/oauth/token)
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function emit(
  tx: Pick<typeof db, "insert">,
  data: {
    grantId: string;
    familyId: string;
    clientId: string;
    scopes: string[];
    resource: string;
    familyEnd: Date;
  }
): Promise<TokenResponse> {
  const access = newToken("access");
  const refreshing = newToken("refresh");
  const accessLifetime = accessTtl();
  const refreshEnd = new Date(Math.min(Date.now() + refreshTtl() * 1000, data.familyEnd.getTime()));
  const commonOnes = {
    grantId: data.grantId,
    familyId: data.familyId,
    clientId: data.clientId,
    scopes: data.scopes,
    resource: data.resource,
    familyExpiresAt: data.familyEnd,
  };
  await tx.insert(oauthTokens).values([
    {
      id: randomUUID(),
      tokenHash: access.hash,
      kind: "access",
      expiresAt: inSeconds(accessLifetime),
      ...commonOnes,
    },
    {
      id: randomUUID(),
      tokenHash: refreshing.hash,
      kind: "refresh",
      expiresAt: refreshEnd,
      ...commonOnes,
    },
  ]);
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: accessLifetime,
    refresh_token: refreshing.token,
    scope: data.scopes.join(" "),
  };
}

/** Revokes EVERYTHING in a family (reuse of a refresh or of a code). */
async function revokeFamily(familyId: string): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ revokedAt: now() })
    .where(and(eq(oauthTokens.familyId, familyId), isNull(oauthTokens.revokedAt)));
}

async function liveGrant(grantId: string) {
  const [g] = await db
    .select({ g: oauthGrants, k: agentApiKeys, a: agentIdentities, role: authUsers.role })
    .from(oauthGrants)
    .innerJoin(agentApiKeys, eq(agentApiKeys.id, oauthGrants.keyId))
    .innerJoin(agentIdentities, eq(agentIdentities.id, oauthGrants.agentId))
    .leftJoin(authUsers, eq(authUsers.id, oauthGrants.userId))
    .where(eq(oauthGrants.id, grantId))
    .limit(1);
  if (!g || g.g.revokedAt || g.k.revokedAt || !g.a.isActive) return null;
  // The human who consented must still be able to delegate this (see tokens.ts).
  if (!grantStillDelegable(g.role, g.g.scopes)) return null;
  return g;
}

export async function redeemCode(
  client: Client,
  p: Record<string, string>
): Promise<TokenResponse> {
  const code = p.code;
  if (!code) throw new ErrorOAuth("invalid_request", "code is required");
  const [row] = await db
    .select()
    .from(oauthCodes)
    .where(eq(oauthCodes.codeHash, hashOf(code)))
    .limit(1);
  if (!row || row.clientId !== client.id)
    throw new ErrorOAuth("invalid_grant", "Invalid authorization code");
  if (row.usedAt) {
    // OAuth 2.1 §4.1.3: a code used twice → what it issued is revoked.
    if (row.familyId) await revokeFamily(row.familyId);
    logAuthFailure(null, "OAuth authorization code reused", undefined, undefined, {
      grantId: row.grantId,
    });
    throw new ErrorOAuth("invalid_grant", "Authorization code already used");
  }
  if (row.expiresAt <= now()) throw new ErrorOAuth("invalid_grant", "Authorization code expired");
  if (p.redirect_uri !== row.redirectUri)
    throw new ErrorOAuth("invalid_grant", "redirect_uri does not match the authorization request");
  if (!pkceMatches(p.code_verifier, row.codeChallenge))
    throw new ErrorOAuth("invalid_grant", "PKCE verification failed");
  const resource = requestedResource(p.resource);
  if (resource && (!resource.ok || resource.resource !== row.resource)) {
    throw new ErrorOAuth("invalid_target", "resource does not match the authorization request");
  }
  const familyId = randomUUID();
  // A single exchange, even with two simultaneous requests
  const [flagged] = await db
    .update(oauthCodes)
    .set({ usedAt: now(), familyId })
    .where(and(eq(oauthCodes.codeHash, row.codeHash), isNull(oauthCodes.usedAt)))
    .returning({ codeHash: oauthCodes.codeHash });
  if (!flagged) throw new ErrorOAuth("invalid_grant", "Authorization code already used");
  const alive = await liveGrant(row.grantId);
  if (!alive) throw new ErrorOAuth("invalid_grant", "The grant was revoked");
  await db.update(oauthClients).set({ lastUsedAt: now() }).where(eq(oauthClients.id, client.id));
  return emit(db, {
    grantId: row.grantId,
    familyId,
    clientId: client.id,
    scopes: row.scopes,
    resource: row.resource,
    familyEnd: inSeconds(familyTtl()),
  });
}

export async function refresh(client: Client, p: Record<string, string>): Promise<TokenResponse> {
  const token = p.refresh_token;
  if (!token) throw new ErrorOAuth("invalid_request", "refresh_token is required");
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, hashOf(token)), eq(oauthTokens.kind, "refresh")))
    .limit(1);
  if (!row || row.clientId !== client.id)
    throw new ErrorOAuth("invalid_grant", "Invalid refresh token");
  if (row.usedAt || row.revokedAt) {
    // OAuth 2.1 §4.3.1: an already-rotated refresh comes back → someone stole it. The family goes.
    await revokeFamily(row.familyId);
    logAuthFailure(null, "OAuth refresh token reuse: family revoked", undefined, undefined, {
      grantId: row.grantId,
      familyId: row.familyId,
    });
    throw new ErrorOAuth(
      "invalid_grant",
      "Refresh token already used: all tokens of this authorization were revoked"
    );
  }
  if (row.expiresAt <= now() || row.familyExpiresAt <= now())
    throw new ErrorOAuth("invalid_grant", "Refresh token expired");
  const resource = requestedResource(p.resource);
  if (resource && (!resource.ok || resource.resource !== row.resource)) {
    throw new ErrorOAuth("invalid_target", "resource does not match the original authorization");
  }
  const requests = readScopes(p.scope);
  if (requests === null) throw new ErrorOAuth("invalid_scope", "Malformed scope parameter");
  // It can only be NARROWED (RFC 6749 §6): nothing that was not already there.
  const outside = requests.filter((s) => !row.scopes.includes(s));
  if (outside.length)
    throw new ErrorOAuth("invalid_scope", `Cannot add scopes on refresh: ${outside.join(", ")}`);
  const scopes = requests.length ? requests : row.scopes;

  return db.transaction(async (tx) => {
    const [spent] = await tx
      .update(oauthTokens)
      .set({ usedAt: now() })
      .where(
        and(eq(oauthTokens.id, row.id), isNull(oauthTokens.usedAt), isNull(oauthTokens.revokedAt))
      )
      .returning({ id: oauthTokens.id });
    if (!spent) throw new ErrorOAuth("invalid_grant", "Refresh token already used");
    const alive = await liveGrant(row.grantId);
    if (!alive) throw new ErrorOAuth("invalid_grant", "The grant was revoked");
    return emit(tx, {
      grantId: row.grantId,
      familyId: row.familyId,
      clientId: client.id,
      scopes,
      resource: row.resource,
      familyEnd: row.familyExpiresAt,
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REVOCATION (RFC 7009) and CONNECTIONS (panel)
// ═══════════════════════════════════════════════════════════════════════════

/** RFC 7009: always «ok» (it is not confirmed whether the token existed). */
export async function revokeToken(client: Client, token: string | undefined): Promise<void> {
  if (!token) throw new ErrorOAuth("invalid_request", "token is required");
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashOf(token)))
    .limit(1);
  if (!row || row.clientId !== client.id) return;
  if (row.kind === "refresh") await revokeFamily(row.familyId);
  else await db.update(oauthTokens).set({ revokedAt: now() }).where(eq(oauthTokens.id, row.id));
}

/** Cuts off a grant: its key, its tokens and the grant itself. */
export async function revokeGrant(
  grantId: string,
  by: string,
  reason = "revoked_by_user"
): Promise<boolean> {
  return db
    .transaction(async (tx) => {
      const [g] = await tx
        .update(oauthGrants)
        .set({ revokedAt: now(), revokedBy: by, revokedReason: reason })
        .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
        .returning();
      if (!g) return null;
      await tx
        .update(agentApiKeys)
        .set({ revokedAt: now(), revokedBy: by })
        .where(and(eq(agentApiKeys.id, g.keyId), isNull(agentApiKeys.revokedAt)));
      await tx
        .update(oauthTokens)
        .set({ revokedAt: now() })
        .where(and(eq(oauthTokens.grantId, g.id), isNull(oauthTokens.revokedAt)));
      return g;
    })
    .then((g) => {
      if (!g) return false;
      logAgentAction({
        agentId: g.agentId,
        keyId: g.keyId,
        action: "config_change",
        resource: "oauth_revoke",
        details: { grantId: g.id, clientId: g.clientId, by, reason },
        success: true,
      });
      return true;
    });
}

/** The connections a human sees: an admin, all of them; an editor, those they consented to. */
export async function listConnections(
  h: Human,
  options: { agentId?: string; includeRevoked?: boolean } = {}
) {
  const filters = [];
  if (h.role !== "admin") filters.push(eq(oauthGrants.userId, h.id));
  if (options.agentId) filters.push(eq(oauthGrants.agentId, options.agentId));
  if (!options.includeRevoked) filters.push(isNull(oauthGrants.revokedAt));
  const rows = await db
    .select({
      g: oauthGrants,
      c: oauthClients,
      a: { id: agentIdentities.id, name: agentIdentities.name },
      k: { lastUsedAt: agentApiKeys.lastUsedAt },
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .innerJoin(agentIdentities, eq(agentIdentities.id, oauthGrants.agentId))
    .innerJoin(agentApiKeys, eq(agentApiKeys.id, oauthGrants.keyId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(oauthGrants.createdAt))
    .limit(500);
  const users = [...new Set(rows.map((f) => f.g.userId))];
  const names = users.length
    ? await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(inArray(authUsers.id, users))
    : [];
  return rows.map(({ g, c, a, k }) => {
    const u = names.find((n) => n.id === g.userId);
    return {
      id: g.id,
      client: { id: c.id, name: c.clientName, kind: c.kind, uri: c.clientUri, logoUri: c.logoUri },
      agent: a,
      grantedBy: { id: g.userId, name: u?.name ?? null, email: u?.email ?? null },
      scopes: g.scopes,
      createdAt: g.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: g.revokedAt,
      revokedReason: g.revokedReason,
    };
  });
}

/** Can this human revoke this grant? (admin: all; editor: their own). */
export async function visibleGrant(h: Human, grantId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) return false;
  const filter =
    h.role === "admin"
      ? eq(oauthGrants.id, grantId)
      : and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, h.id));
  const [g] = await db.select({ id: oauthGrants.id }).from(oauthGrants).where(filter).limit(1);
  return !!g;
}

// ═══════════════════════════════════════════════════════════════════════════
// SWEEP of expired items and abandoned clients
// ═══════════════════════════════════════════════════════════════════════════

export interface Sweep {
  requests: number;
  codes: number;
  tokens: number;
  expiredGrants: number;
  clients: number;
}

const howMany = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;

/**
 * What is left over:
 *   · requests and codes expired more than an hour ago;
 *   · tokens expired more than a day ago (refreshes are kept until their
 *     expiry: they are needed to detect reuse);
 *   · grants with no live refresh and no use in `familyTtl()` →
 *     revoked as «stale» (their key too);
 *   · registered clients that nobody consented to in 7 days, clients whose
 *     grants are all revoked and unused in 90 days, and expired CIMD copies
 *     without grants.
 */
export async function sweepOAuth(): Promise<Sweep> {
  const requests = howMany(
    await db.execute(
      sql`DELETE FROM oauth_authorization_requests WHERE expires_at < now() - interval '1 hour'`
    )
  );
  const codes = howMany(
    await db.execute(sql`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`)
  );
  const tokens = howMany(
    await db.execute(
      sql`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day' OR family_expires_at < now() - interval '1 day'`
    )
  );
  const old = (await db.execute(sql`
    SELECT g.id FROM oauth_grants g
    JOIN agent_api_keys k ON k.id = g.key_id
    WHERE g.revoked_at IS NULL
      AND g.created_at < now() - make_interval(secs => ${familyTtl()})
      AND COALESCE(k.last_used_at, g.created_at) < now() - make_interval(secs => ${familyTtl()})
      AND NOT EXISTS (
        SELECT 1 FROM oauth_tokens t
        WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > now()
      )
    LIMIT 500
  `)) as unknown as { rows: { id: string }[] };
  let expiredGrants = 0;
  for (const { id } of old.rows) if (await revokeGrant(id, "system", "stale")) expiredGrants++;
  const clients = howMany(
    await db.execute(sql`
      DELETE FROM oauth_clients c
      WHERE (c.kind = 'dcr' AND c.created_at < now() - interval '7 days'
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id))
         OR (EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id AND g.revoked_at IS NULL)
             AND COALESCE(c.last_used_at, c.created_at) < now() - interval '90 days')
         OR (c.kind = 'cimd' AND c.metadata_expires_at < now()
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id))
    `)
  );
  return { requests, codes, tokens, expiredGrants, clients };
}

let sweep: ReturnType<typeof setInterval> | null = null;

export function startOAuthSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    sweepOAuth().catch(() => undefined);
  }, 60 * 60_000);
  (sweep as { unref?: () => void }).unref?.();
}
