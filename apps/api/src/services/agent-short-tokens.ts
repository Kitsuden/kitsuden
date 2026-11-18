/**
 * Short-lived agent credentials (`kitsuden_ast_*`) and per-run credentials
 * ============================================================================
 *
 * Migration 0086, table `agent_short_tokens`. Guide:
 * docs/agents/dpop-and-short-tokens.md.
 *
 * ── EXCHANGED TOKENS ───────────────────────────────────────────────────────
 *
 * `POST /api/v1/agents/token/exchange` (routes/agents-v1.ts): an agent holding
 * its long-lived key (or an OAuth token) gets a token of minutes with a SUBSET
 * of its scopes and, optionally, a path prefix it is valid on. It never
 * outlives its parent: revoking or expiring the parent key (or the OAuth
 * grant), or deactivating the agent, kills it on its next request. It cannot be
 * exchanged again (no chaining).
 *
 * ── RUN CREDENTIALS ────────────────────────────────────────────────────────
 *
 * `runAgent` (services/agent-engine.ts) mints one row per in-process run
 * (`run_id`, no secret ever leaves the process: only a random hash is stored),
 * checks it before EVERY tool call, records its id as the run's `keyId` (audit
 * and proposals' `key_id`), and revokes it when the run ends.
 *
 * ── APPROVALS ──────────────────────────────────────────────────────────────
 *
 * A proposal made under a short credential is executed after a human approves
 * it even if that credential has expired or was revoked at the end of its run:
 * the human approval is the authority then. What still stops it: the agent
 * deactivated, or the PARENT key revoked or expired (the same rule as a
 * proposal made with a key). Scopes are those of the agent NOW narrowed by the
 * credential's. The sweep keeps a row while a pending proposal refers to it.
 *
 * Imports `schema-core` directly (not `../db/schema`): unit tests that replace
 * `../db/schema` must not break on this table.
 */

import { createHash, randomBytes } from "node:crypto";

import { concedeScope, isDenial, splitScopes } from "@kitsuden/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db";
import { agentApiKeys, agentIdentities, agentShortTokens } from "../db/schema-core";
import { effectiveScopes, keyGrant } from "../lib/oauth/tokens";

export const SHORT_TOKEN_PREFIX = "kitsuden_ast_";

export function isShortToken(token: string): boolean {
  return token.startsWith(SHORT_TOKEN_PREFIX);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Default lifetime of an exchanged token (seconds). */
export const SHORT_TOKEN_DEFAULT_TTL = 300;

/** The longest an exchanged token may live: `AGENT_SHORT_TOKEN_MAX_TTL` (900; 60–3600). */
export const shortTokenMaxTtl = () => intFromEnv("AGENT_SHORT_TOKEN_MAX_TTL", 900, 60, 3600);

/**
 * How long a run credential lives: `AGENT_RUN_CREDENTIAL_TTL` (600; 60–3600).
 * Runs have no other maximum duration: a tool call after this is refused.
 */
export const runCredentialTtl = () => intFromEnv("AGENT_RUN_CREDENTIAL_TTL", 600, 60, 3600);

/** A path prefix as stored: one leading slash, no trailing slash, no `..`. */
export function normalizeAudience(raw: string): string | null {
  const a = raw
    .trim()
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (!a.startsWith("/") || a.length > 300 || /(^|\/)\.\.?(\/|$)/.test(a) || /[?#\s]/.test(a))
    return null;
  return a || null;
}

/** Is `route` inside `audience` (same path or below it)? */
export function routeInAudience(route: string | undefined, audience: string | null): boolean {
  if (!audience) return true;
  if (!route) return false;
  const r = route.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return r === audience || r.startsWith(`${audience}/`);
}

/**
 * The scopes of an exchanged token: each requested scope must be one the
 * caller holds (`concedeScope`), and the caller's denials always carry over.
 * `null` requested = everything the caller holds.
 */
export function narrowScopes(
  held: readonly string[],
  requested: readonly string[] | null | undefined
): { ok: true; scopes: string[] } | { ok: false; outside: string[] } {
  if (!requested) return { ok: true, scopes: [...held] };
  const { denials } = splitScopes([...held]);
  const outside = requested.filter((s) => !isDenial(s) && !concedeScope(held, s));
  if (outside.length) return { ok: false, outside };
  const own = [...new Set(requested)];
  const carried = denials.map((d) => `!${d}`).filter((d) => !own.includes(d));
  return { ok: true, scopes: [...carried, ...own] };
}

export interface MintOptions {
  agentId: string;
  parentKeyId: string | null;
  scopes: string[];
  ttlSeconds: number;
  audience?: string | null;
  dpopJkt?: string | null;
  runId?: string | null;
}

/** Creates a short credential. The plain token is returned ONCE (never stored). */
export async function mintShortToken(
  o: MintOptions
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = `${SHORT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + o.ttlSeconds * 1000);
  const [row] = await db
    .insert(agentShortTokens)
    .values({
      agentId: o.agentId,
      parentKeyId: o.parentKeyId,
      tokenHash: sha256(token),
      scopes: o.scopes,
      audience: o.audience ?? null,
      dpopJkt: o.dpopJkt ?? null,
      runId: o.runId ?? null,
      expiresAt,
    })
    .returning({ id: agentShortTokens.id });
  return { token, id: row!.id, expiresAt };
}

type Agent = typeof agentIdentities.$inferSelect;
type Key = typeof agentApiKeys.$inferSelect;
type Row = typeof agentShortTokens.$inferSelect;

/** Is the parent key (and its OAuth grant) still alive? The scopes it allows TODAY. */
async function parentAlive(
  parentKeyId: string,
  agent: Agent
): Promise<{ ok: true; key: Key; scopes: string[] } | { ok: false; code: string; error: string }> {
  const [key] = await db
    .select()
    .from(agentApiKeys)
    .where(eq(agentApiKeys.id, parentKeyId))
    .limit(1);
  if (!key || key.agentId !== agent.id)
    return {
      ok: false,
      code: "KEY_REVOKED",
      error: "The key this token came from no longer exists",
    };
  if (key.revokedAt)
    return { ok: false, code: "KEY_REVOKED", error: "The key this token came from was revoked" };
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now())
    return { ok: false, code: "INVALID_KEY", error: "The key this token came from expired" };
  let scopes = (agent.scopes as string[] | null) ?? [];
  if (key.algorithm === "oauth") {
    const grant = await keyGrant(key.id);
    if (!grant || grant.revoked)
      return { ok: false, code: "TOKEN_REVOKED", error: "The OAuth connection was revoked" };
    scopes = effectiveScopes(scopes, grant.scopes);
  }
  return { ok: true, key, scopes };
}

export type ShortTokenLookup =
  | { ok: true; row: Row; agent: Agent; scopes: string[] }
  | { ok: false; code: string; error: string; agentId: string | null };

/**
 * Resolves an exchanged token presented over HTTP and checks EVERYTHING that
 * invalidates it, on every request: revoked, expired, a run credential (never
 * valid over HTTP), the audience, the parent key and its grant. The agent's
 * `isActive` is left to the caller (it audits it like the other credentials).
 */
export async function lookupShortToken(
  token: string,
  route: string | undefined
): Promise<ShortTokenLookup> {
  const [found] = await db
    .select({ t: agentShortTokens, a: agentIdentities })
    .from(agentShortTokens)
    .innerJoin(agentIdentities, eq(agentIdentities.id, agentShortTokens.agentId))
    .where(eq(agentShortTokens.tokenHash, sha256(token)))
    .limit(1);
  if (!found)
    return { ok: false, code: "INVALID_KEY", error: "Invalid short-lived token", agentId: null };
  const { t, a } = found;
  if (t.runId || !t.parentKeyId)
    return { ok: false, code: "INVALID_KEY", error: "Invalid short-lived token", agentId: a.id };
  if (t.revokedAt)
    return { ok: false, code: "KEY_REVOKED", error: "Short-lived token revoked", agentId: a.id };
  if (t.expiresAt.getTime() <= Date.now())
    return { ok: false, code: "INVALID_KEY", error: "Short-lived token expired", agentId: a.id };
  if (!routeInAudience(route, t.audience))
    return {
      ok: false,
      code: "INVALID_AUDIENCE",
      error: "Short-lived token was not issued for this path",
      agentId: a.id,
    };
  const parent = await parentAlive(t.parentKeyId, a);
  if (!parent.ok) return { ...parent, agentId: a.id };
  return { ok: true, row: t, agent: a, scopes: effectiveScopes(parent.scopes, t.scopes) };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN CREDENTIALS
// ═══════════════════════════════════════════════════════════════════════════

/** One credential for one in-process run (no token leaves the process). */
export async function mintRunCredential(
  agentId: string,
  scopes: string[],
  runId: string
): Promise<{ id: string; expiresAt: Date }> {
  const { id, expiresAt } = await mintShortToken({
    agentId,
    parentKeyId: null,
    scopes,
    ttlSeconds: runCredentialTtl(),
    runId,
  });
  return { id, expiresAt };
}

/**
 * Is the run credential still good for ONE more tool call? Not revoked, not
 * expired, the agent still active. The scopes for that call: the agent's NOW
 * narrowed by the credential's (removing a scope mid-run takes effect).
 */
export async function runCredentialStatus(
  id: string,
  agentId: string
): Promise<{ ok: true; scopes: string[] } | { ok: false; reason: string }> {
  const [found] = await db
    .select({ t: agentShortTokens, a: agentIdentities })
    .from(agentShortTokens)
    .innerJoin(agentIdentities, eq(agentIdentities.id, agentShortTokens.agentId))
    .where(eq(agentShortTokens.id, id))
    .limit(1);
  if (!found || found.t.agentId !== agentId || !found.t.runId)
    return { ok: false, reason: "run credential not found" };
  if (found.t.revokedAt) return { ok: false, reason: "run credential revoked" };
  if (found.t.expiresAt.getTime() <= Date.now())
    return { ok: false, reason: "run credential expired" };
  if (!found.a.isActive) return { ok: false, reason: "agent deactivated" };
  return { ok: true, scopes: effectiveScopes(found.a.scopes as string[] | null, found.t.scopes) };
}

/** Revokes a short credential (a run's at its end). Idempotent. */
export async function revokeShortToken(id: string): Promise<void> {
  await db
    .update(agentShortTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentShortTokens.id, id), isNull(agentShortTokens.revokedAt)));
}

// ═══════════════════════════════════════════════════════════════════════════
// APPROVALS AND THE SWEEP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For `agentContextForApproval`: a proposal's `key_id` that is a short
 * credential. `null` = it is not one. Its own expiry and revocation are NOT
 * checked (see the header); the parent key's are.
 */
export async function shortCredentialForApproval(
  id: string,
  agent: Agent
): Promise<{ ok: true; scopes: string[] } | { ok: false; reason: string } | null> {
  const [t] = await db.select().from(agentShortTokens).where(eq(agentShortTokens.id, id)).limit(1);
  if (!t) return null;
  if (t.agentId !== agent.id) return { ok: false, reason: "key_not_found" };
  let scopes = (agent.scopes as string[] | null) ?? [];
  if (t.parentKeyId) {
    const parent = await parentAlive(t.parentKeyId, agent);
    if (!parent.ok) {
      const reason =
        parent.code === "KEY_REVOKED"
          ? "key_revoked"
          : parent.code === "TOKEN_REVOKED"
            ? "oauth_grant_revoked"
            : "key_expired";
      return { ok: false, reason };
    }
    scopes = parent.scopes;
  }
  return { ok: true, scopes: effectiveScopes(scopes, t.scopes) };
}

/**
 * Deletes short credentials expired more than a day ago, unless a pending
 * proposal still refers to one (it must stay executable once approved). Run
 * by the hourly agent-audit sweep. Never throws.
 */
export async function sweepShortTokens(): Promise<number> {
  try {
    const r = await db.execute(sql`
      DELETE FROM agent_short_tokens t
       WHERE t.expires_at < now() - interval '1 day'
         AND NOT EXISTS (
           SELECT 1 FROM agent_proposals p WHERE p.key_id = t.id AND p.status IN ('pending', 'approved')
         )`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  } catch {
    return 0;
  }
}
