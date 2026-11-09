/**
 * OAuth for MCP — what AUTHENTICATION needs (services/agent-auth.ts)
 * ============================================================================
 *
 * Without importing agent-auth (it imports this): generating tokens, looking them up
 * by their hash and the effective scopes rule.
 *
 * ── EFFECTIVE SCOPES: consent only NARROWS ─────────────────────────────────
 *
 *   effective = the agent's denials (`!pattern`) TODAY
 *             + each scope of the grant that the agent TODAY still covers
 *
 * Removing a scope from the agent removes it from its OAuth connections on the next
 * request; adding it back does NOT add it (consent is needed again). An
 * agent denial always wins (agent-permission.ts).
 */

import { randomBytes } from "crypto";

import { concedeScope, isDenial, splitScopes } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { agentApiKeys, agentIdentities, authUsers } from "../../db/schema-core";
import { oauthGrants, oauthTokens } from "../../db/schema-oauth";

import { ACCESS_PREFIX, REFRESH_PREFIX, MCP_ROUTE, mcpResource } from "./config";
import { hashOf } from "./uris";

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_PREFIX);
}

export function isOAuthRefreshToken(token: string): boolean {
  return token.startsWith(REFRESH_PREFIX);
}

export function newToken(type: "access" | "refresh"): { token: string; hash: string } {
  const token = `${type === "access" ? ACCESS_PREFIX : REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashOf(token) };
}

export function effectiveScopes(
  ofTheAgent: readonly string[] | null | undefined,
  ofTheGrant: readonly string[]
): string[] {
  const agent = (ofTheAgent ?? []).filter((s): s is string => typeof s === "string");
  const { denials } = splitScopes(agent);
  const grantedItems = ofTheGrant.filter((s) => !isDenial(s) && concedeScope(agent, s));
  return [...denials.map((d) => `!${d}`), ...grantedItems];
}

/** Is this path the resource the tokens are issued for? */
export function resourceRoute(route: string | undefined): boolean {
  if (!route) return false;
  const cleans = route.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return cleans === MCP_ROUTE || cleans.startsWith(`${MCP_ROUTE}/`);
}

/**
 * What a human CANNOT delegate even if the agent has it: an `editor`
 * does not give `admin`, `admin:*` or `mcp:admin` (nor a pattern that covers them), which
 * are more than they can do. An `admin` delegates everything the agent has.
 */
const ADMIN_ONLY_DELEGATES = ["admin", "admin:*", "mcp:admin"];

export function humanCanDelegate(role: string, scope: string): boolean {
  if (role === "admin") return true;
  if (role !== "editor") return false;
  return !ADMIN_ONLY_DELEGATES.some((f) => scope === f || concedeScope([scope], f));
}

/**
 * A grant lasts as long as its human can still give it: every token check reads
 * the role of whoever consented. Deleted, moved out of the team, or an editor
 * holding a scope only an admin can delegate (a demoted admin): dead.
 */
export function grantStillDelegable(
  humanRole: string | null | undefined,
  scopes: readonly string[] | null | undefined
): boolean {
  if (humanRole !== "admin" && humanRole !== "editor") return false;
  return (scopes ?? []).every((s) => humanCanDelegate(humanRole, s));
}

export type AccessToken =
  | {
      ok: true;
      tokenId: string;
      grantId: string;
      clientId: string;
      scopes: string[];
      agent: typeof agentIdentities.$inferSelect;
      key: typeof agentApiKeys.$inferSelect;
    }
  | { ok: false; code: string; error: string; agentId?: string | null };

/**
 * Looks up an access token and checks EVERYTHING that invalidates it: that it exists,
 * is neither revoked nor expired, that the audience is this resource (and the
 * request goes to it), and that the grant, its key and the agent are still alive.
 * It is read from the database on every request: revoking takes effect on the next one.
 */
export async function searchAccessToken(
  token: string,
  route: string | undefined
): Promise<AccessToken> {
  const [row] = await db
    .select({
      t: oauthTokens,
      g: oauthGrants,
      k: agentApiKeys,
      a: agentIdentities,
      role: authUsers.role,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(agentApiKeys, eq(agentApiKeys.id, oauthGrants.keyId))
    .innerJoin(agentIdentities, eq(agentIdentities.id, oauthGrants.agentId))
    .leftJoin(authUsers, eq(authUsers.id, oauthGrants.userId))
    .where(and(eq(oauthTokens.tokenHash, hashOf(token)), eq(oauthTokens.kind, "access")))
    .limit(1);
  if (!row)
    return { ok: false, code: "INVALID_TOKEN", error: "Invalid OAuth access token", agentId: null };
  const { t, g, k, a, role: role } = row;
  const now = Date.now();
  if (t.revokedAt || g.revokedAt)
    return { ok: false, code: "TOKEN_REVOKED", error: "OAuth access token revoked", agentId: a.id };
  if (!grantStillDelegable(role, t.scopes)) {
    return {
      ok: false,
      code: "TOKEN_REVOKED",
      error: "The human who authorized this connection can no longer delegate it",
      agentId: a.id,
    };
  }
  if (t.expiresAt.getTime() <= now)
    return { ok: false, code: "TOKEN_EXPIRED", error: "OAuth access token expired", agentId: a.id };
  // RFC 8707 / MCP: the token was issued for THIS resource and is only valid there.
  if (t.resource !== mcpResource() || !resourceRoute(route)) {
    return {
      ok: false,
      code: "INVALID_AUDIENCE",
      error: "OAuth access token was not issued for this resource",
      agentId: a.id,
    };
  }
  if (k.revokedAt)
    return { ok: false, code: "KEY_REVOKED", error: "OAuth connection revoked", agentId: a.id };
  if (k.expiresAt && k.expiresAt.getTime() <= now) {
    return { ok: false, code: "INVALID_KEY", error: "OAuth connection expired", agentId: a.id };
  }
  return {
    ok: true,
    tokenId: t.id,
    grantId: g.id,
    clientId: g.clientId,
    scopes: effectiveScopes(a.scopes as string[] | null, t.scopes),
    agent: a,
    key: k,
  };
}

/** For approvals (lib/approvals.ts → agent-auth): the grant behind an OAuth key. */
export async function keyGrant(
  keyId: string
): Promise<{ scopes: string[]; revoked: boolean } | null> {
  const [g] = await db
    .select({ scopes: oauthGrants.scopes, revokedAt: oauthGrants.revokedAt, role: authUsers.role })
    .from(oauthGrants)
    .leftJoin(authUsers, eq(authUsers.id, oauthGrants.userId))
    .where(eq(oauthGrants.keyId, keyId))
    .limit(1);
  return g
    ? { scopes: g.scopes ?? [], revoked: !!g.revokedAt || !grantStillDelegable(g.role, g.scopes) }
    : null;
}
