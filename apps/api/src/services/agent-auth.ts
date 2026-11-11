/**
 * Agent Authentication Service (NHI - Non-Human Identities)
 *
 * Authentication service for AI Agents (MCP, Workers, Automation)
 *
 * Features:
 * - API key validation with secure hashing (argon2)
 * - Scope verification (Zero Trust)
 * - Per-agent rate limiting (FinOps)
 * - Usage auditing
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

import { concedeScope, canSign, type AgentSigner } from "@kitsuden/shared";
import { verify as argon2Verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, agentApiKeys, authUsers } from "../db/schema";
import { readMcpSettings, type McpSettings } from "../lib/mcp-settings";
import {
  searchAccessToken,
  keyGrant,
  isOAuthAccessToken,
  effectiveScopes,
} from "../lib/oauth/tokens";
import { generateAgentApiKey as generateTypedAgentApiKey } from "../utils/id-generator";

import { logAuthSuccess, logAuthFailure } from "./agent-audit";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentAuthContext {
  agentId: string;
  agentName: string;
  scopes: string[];
  /** Requests per minute. */
  rateLimit: number;
  /** Writes per UTC day (null = unlimited). See lib/agent-quotas.ts. */
  writesPerDay: number | null;
  /** Budget units per UTC day (null = unlimited). */
  budgetUnitsPerDay: number | null;
  keyId: string;
  /**
   * MCP tools this agent can use (what is configured in the
   * panel). Empty = no list: only each tool's scope decides.
   */
  allowedTools: string[];
  /**
   * The human who SIGNS what the agent creates (`null` = no
   * signer). `valid: false` if the account no longer exists or is not on the team.
   * See @kitsuden/shared signer.ts.
   */
  sponsor?: AgentSigner | null;
  /**
   * MCP settings from the panel (migration 0052): default toolset and wrapper
   * for untrusted content. `{}` = the usual. See lib/mcp-settings.ts.
   */
  mcpSettings?: McpSettings;
  /**
   * OAuth for MCP (migration 0055): the connection it came in through, if it came in
   * with an OAuth token and not its static key. `keyId` is then the
   * `agent_api_keys` row (algorithm 'oauth') of that connection. See lib/oauth/.
   */
  oauth?: { clientId: string; grantId: string };
}

// ═══════════════════════════════════════════════════════════════════════════
// ARGON2 VERIFICATIONS ALREADY DONE (performance)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * argon2id costs ~31 ms of CPU per verification (m=19456, t=2) and it was done on
 * EVERY agent request —twice on `/api/mcp`—: measured on a copy of
 * production, an agent could not go past ~20 requests per second with the CPU at
 * 220%. It is the cost that whoever TRIES secrets has to pay, not whoever has already
 * shown they have one.
 *
 * Here we remember, per key, that a given secret already verified against a
 * given hash:
 *
 *   · An HMAC-SHA256 of the secret is stored with a random key of THIS
 *     process (never the secret, and useless outside the process), next to the
 *     row's `keyHash` it verified against.
 *   · It is only used if the row still has the SAME `keyHash` and the HMAC of the
 *     presented secret matches (constant-time comparison). A different
 *     secret, or a rotated key, goes back to argon2.
 *   · Failures are NOT remembered: each attempt with a wrong secret pays
 *     full argon2, as before.
 *   · Nothing changes in what is checked afterwards: the key's row and the
 *     agent's are still read from the database on EVERY request, so a
 *     revoked or expired key or a deactivated agent stops working on the
 *     next request, just as before.
 *   · It expires after `AGENT_KEY_VERIFY_CACHE_SECONDS` (300 s; 0 turns it off) and
 *     has an entry cap.
 */
const PROCESS_SECRET = randomBytes(32);

/** Days a new agent key lives when nobody says (security review 2026-11-03). */
export const DEFAULT_AGENT_KEY_EXPIRY_DAYS = 90;

/**
 * Days a new agent key lives when the request does not say:
 * `AGENT_KEY_DEFAULT_EXPIRY_DAYS` (90 by default, 1 to 3650; `0` = keys never
 * expire, the behaviour before 2026-11-04).
 */
export function defaultAgentKeyExpiryDays(): number | null {
  const raw = process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_KEY_EXPIRY_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AGENT_KEY_EXPIRY_DAYS;
  if (n === 0) return null;
  return Math.min(Math.floor(n), 3650) || 1;
}

/**
 * When a new agent key expires. A key without expiry is a credential that
 * outlives whoever forgot it in a CI variable, so it must be asked for:
 *
 *   · `undefined` (not given): the default above;
 *   · `null` (or the legacy `0`): never, because a human asked for it;
 *   · a positive number: that many days.
 */
export function agentKeyExpiresAt(
  expiresInDays: number | null | undefined,
  now: number = Date.now()
): Date | null {
  const days = expiresInDays === undefined ? defaultAgentKeyExpiryDays() : expiresInDays;
  if (days === null || !Number.isFinite(days) || days <= 0) return null;
  return new Date(now + days * 86_400_000);
}
const VERIFIED_LIFETIME_MS = (() => {
  const n = Number(process.env.AGENT_KEY_VERIFY_CACHE_SECONDS ?? 300);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3600) * 1000 : 300_000;
})();
const MAX_VERIFIED = 10_000;
const verified = new Map<string, { keyHash: string; fingerprint: Buffer; until: number }>();

function secretFingerprint(secret: string): Buffer {
  return createHmac("sha256", PROCESS_SECRET).update(secret).digest();
}

/** argon2 of key `keyRowId`, or the memory of a recent identical verification. */
async function verifyArgon2WithMemory(
  keyRowId: string,
  keyHash: string,
  secret: string
): Promise<boolean> {
  const fingerprint = secretFingerprint(secret);
  const now = Date.now();
  const memory = verified.get(keyRowId);
  if (
    memory &&
    memory.until > now &&
    memory.keyHash === keyHash &&
    timingSafeEqual(memory.fingerprint, fingerprint)
  ) {
    return true;
  }
  const valid = await argon2Verify(keyHash, secret);
  if (valid && VERIFIED_LIFETIME_MS > 0) {
    if (verified.size >= MAX_VERIFIED) {
      for (const [k, v] of verified) if (v.until <= now) verified.delete(k);
      if (verified.size >= MAX_VERIFIED) verified.delete(verified.keys().next().value as string);
    }
    verified.set(keyRowId, { keyHash, fingerprint, until: now + VERIFIED_LIFETIME_MS });
  }
  // A wrong secret does NOT erase what is remembered: if it did, anyone who
  // knew a key's public id would force its owner to pay argon2 on
  // every request. It is not needed: the memory only holds for the right secret.
  return valid;
}

/**
 * The authentication already done for THIS request (performance).
 *
 * `/api/mcp` goes through the global authentication (index.ts) and then its
 * own, with the SAME header: it authenticated twice (two argon2s, two
 * `auth_success` audit rows, two key and agent reads). The global one
 * leaves its result here, tied to the `Request` object and the exact token; the MCP one
 * reuses it only if the token matches. It is the same request and the same
 * database read from microseconds ago: nothing to revoke in between.
 */
const authenticatedInRequest = new WeakMap<object, { token: string; result: AgentAuthResult }>();

export function rememberRequestAuthentication(
  request: object,
  token: string,
  result: AgentAuthResult
): void {
  if (result.success) authenticatedInRequest.set(request, { token, result });
}

export function requestAuthentication(request: object, token: string): AgentAuthResult | null {
  const r = authenticatedInRequest.get(request);
  return r && r.token === token ? r.result : null;
}

/** For tests: forgets the remembered verifications. */
export function forgetKeyChecks(): void {
  verified.clear();
}

/**
 * An agent's signer, checked NOW (one primary-key query,
 * only if the agent has a signer): exists and is admin or editor.
 */
export async function agentSigner(
  sponsorUserId: string | null | undefined
): Promise<AgentSigner | null> {
  if (!sponsorUserId) return null;
  const [u] = await db
    .select({ role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, sponsorUserId))
    .limit(1);
  if (!u) return { userId: sponsorUserId, valid: false, reason: "not_found" };
  return canSign(u.role)
    ? { userId: sponsorUserId, valid: true }
    : { userId: sponsorUserId, valid: false, reason: "not_staff" };
}

export interface AgentAuthResult {
  success: boolean;
  context?: AgentAuthContext;
  error?: string;
  code?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// API KEY GENERATION (TYPED)
// ═══════════════════════════════════════════════════════════════════════════

/** Canonical prefix of Agent NHI keys. */
const API_KEY_PREFIX = "kitsuden_agent_";

/**
 * Legacy prefixes: NONE. `grm_agent_*` had a sunset of 2026-08-01 and was still being
 * accepted over REST (security audit); in addition a key with that
 * prefix was published. Removing it invalidates it even if it was not
 * revoked. No website or Inti used it.
 */
const LEGACY_API_KEY_PREFIXES = [] as const;

/** All the prefixes the parser accepts during the migration. */
export const ACCEPTED_API_KEY_PREFIXES = [API_KEY_PREFIX, ...LEGACY_API_KEY_PREFIXES] as const;

/** True if the token has the shape of an Agent NHI key (canonical or legacy). */
export function isAgentApiKey(token: string): boolean {
  return ACCEPTED_API_KEY_PREFIXES.some((p) => token.startsWith(p));
}

/**
 * True if the token is an agent credential: static key or OAuth
 * access token (`kitsuden_oat_*`, lib/oauth). `authenticateAgent` resolves both
 * to the SAME agent context.
 */
export function isAgentCredential(token: string): boolean {
  return isAgentApiKey(token) || isOAuthAccessToken(token);
}

// Re-export types and constants for convenience
export { AGENT_TYPES, type AgentType, getAgentTypeFromApiKey } from "../utils/id-generator";

/**
 * Generates a new API key for an agent
 * Returns the key in plain text (ONLY ONCE) and the hash to store
 *
 * @param type - Agent type (e.g. 'claude-desktop', 'scraper')
 * @returns Object with plainKey, keyHash and keyPrefix
 *
 * @example
 * ```typescript
 * const { plainKey, keyHash, keyPrefix } = await generateAgentApiKey('claude-desktop');
 * // plainKey: "kitsuden_agent_claude-desktop_a1b2c3..."
 * ```
 */
export async function generateAgentApiKey(type?: string): Promise<{
  plainKey: string;
  keyHash: string;
  keyId: string;
  algorithm: "argon2id";
  keyPrefix: string;
}> {
  // If a type is provided, use the typed generator
  if (type) {
    const result = await generateTypedAgentApiKey({ type });
    return {
      plainKey: result.plainKey,
      keyHash: result.keyHash,
      keyId: result.keyId,
      algorithm: result.algorithm,
      keyPrefix: result.keyPrefix,
    };
  }

  // Fallback: generate without a type (legacy format migrated to Argon2id)
  return generateTypedAgentApiKey({ type: "legacy" });
}

/**
 * Hashes a legacy API key with SHA-256 (only for backward compatibility).
 * New keys use the secret's Argon2id.
 */
export function hashApiKeyLegacy(plainKey: string): string {
  return createHash("sha256").update(plainKey).digest("hex");
}

/**
 * Parses an API key into its components.
 * New format: kitsuden_agent_{type}_{keyId}_{secret}
 * Legacy format: kitsuden_agent_{type}_{secret} or kitsuden_agent_{secret}
 *
 * Also accepts the `grm_agent_` prefix of keys issued before the rebrand
 * (sunset 2026-08-01); the rest of the parsing is identical because the prefix only
 * marks the start — the keyId and the secret go by position.
 */
export function parseAgentApiKey(
  apiKey: string
): { type: string; keyId?: string; secret: string; isLegacy: boolean } | null {
  const prefix = ACCEPTED_API_KEY_PREFIXES.find((p) => apiKey.startsWith(p));
  if (!prefix) return null;

  const rest = apiKey.slice(prefix.length);

  // New format: `{type}_{keyId}_{secret}`, with a 16-hex keyId.
  //
  // The secret is base64url and CAN contain `_`. Before, it was split on `_` and
  // the last part was taken as the secret and the second to last as the keyId: with a `_`
  // inside the secret (≈ half the issued keys: 43 characters, 1/64
  // each) neither the keyId nor the secret came out right and the key NEVER
  // authenticated. It is anchored on the first `_<16 hex>_` and the whole remainder is the
  // secret (security audit).
  const next = /^(.*?)_([a-f0-9]{16})_(.+)$/.exec(rest);
  if (next) {
    return { type: next[1]!, keyId: next[2]!, secret: next[3]!, isLegacy: false };
  }

  const parts = rest.split("_");
  const secret = parts[parts.length - 1];
  if (!secret) return null;

  // Legacy format
  const type = parts.slice(0, parts.length - 1).join("_");
  return { type, secret: rest.slice(type ? type.length + 1 : 0), isLegacy: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Authenticates an agent by its API key
 *
 * Flow:
 * 1. Validate the key's format
 * 2. Look up key_hash in the DB
 * 3. Check that it is not expired
 * 4. Check that the agent is active
 * 5. Get the agent and its scopes
 * 6. Check the rate limit
 * 7. Update last_used_at and log
 */
export async function authenticateAgent(
  apiKey: string,
  metadata?: {
    ipAddress?: string;
    userAgent?: string;
    /**
     * Path of the request. An OAuth token is only valid on the resource it
     * was issued for (`/api/mcp`, RFC 8707); with no path, it is rejected.
     */
    route?: string;
  }
): Promise<AgentAuthResult> {
  if (isOAuthAccessToken(apiKey)) return authenticateOAuthToken(apiKey, metadata);
  try {
    // 1. Validate and parse the key's format
    const parsed = parseAgentApiKey(apiKey);
    if (!parsed) {
      // With no known agent: `null`, not "unknown" (it violated the FK and the attempt
      // was not audited). See AuditLogEntry.agentId.
      logAuthFailure(null, "Invalid API key format", metadata?.ipAddress, metadata?.userAgent);
      return {
        success: false,
        error: "Invalid API key format",
        code: "INVALID_KEY_FORMAT",
      };
    }

    // 2. Look up the key in the DB according to the format
    let keyRow: typeof agentApiKeys.$inferSelect | undefined;
    if (!parsed.isLegacy && parsed.keyId) {
      // Argon2id format: look up by public keyId
      const [found] = await db
        .select()
        .from(agentApiKeys)
        .where(eq(agentApiKeys.keyId, parsed.keyId))
        .limit(1);
      keyRow = found;
    } else {
      // Legacy SHA-256 format: look up by the hash of the whole key
      const legacyHash = hashApiKeyLegacy(apiKey);
      const [found] = await db
        .select()
        .from(agentApiKeys)
        .where(eq(agentApiKeys.keyHash, legacyHash))
        .limit(1);
      keyRow = found;
    }

    // The PUBLIC id of the key that was tried (never the secret): it lets the audit show
    // that someone is probing a specific key.
    const attempt = parsed.keyId ? { attemptedKeyId: parsed.keyId } : undefined;

    // 3. Verify hash and expiration with a join to the agent
    if (!keyRow) {
      logAuthFailure(
        null,
        "Invalid or expired API key",
        metadata?.ipAddress,
        metadata?.userAgent,
        attempt
      );
      return {
        success: false,
        error: "Invalid or expired API key",
        code: "INVALID_KEY",
      };
    }

    const isValid =
      keyRow.algorithm === "argon2id"
        ? await verifyArgon2WithMemory(keyRow.id, keyRow.keyHash, parsed.secret)
        : keyRow.keyHash === hashApiKeyLegacy(apiKey);

    // The key exists: the attempt is against THAT agent, and it is recorded in its
    // name (a wrong secret for a real key is the most suspicious thing).
    if (!isValid) {
      logAuthFailure(
        keyRow.agentId,
        "Invalid or expired API key",
        metadata?.ipAddress,
        metadata?.userAgent,
        attempt
      );
      return {
        success: false,
        error: "Invalid or expired API key",
        code: "INVALID_KEY",
      };
    }

    // Revoked: it stops working on the NEXT request (the database is read on
    // each one; there is no cache to wait out). The row stays for auditing.
    if (keyRow.revokedAt) {
      logAuthFailure(
        keyRow.agentId,
        "API key revoked",
        metadata?.ipAddress,
        metadata?.userAgent,
        attempt
      );
      return {
        success: false,
        error: "API key revoked",
        code: "KEY_REVOKED",
      };
    }

    if (keyRow.expiresAt && keyRow.expiresAt < new Date()) {
      logAuthFailure(
        keyRow.agentId,
        "API key expired",
        metadata?.ipAddress,
        metadata?.userAgent,
        attempt
      );
      return {
        success: false,
        error: "API key expired",
        code: "INVALID_KEY",
      };
    }

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, keyRow.agentId))
      .limit(1);

    if (!agent) {
      // The agent no longer exists: its id would violate the FK just like "unknown".
      logAuthFailure(null, "Agent not found", metadata?.ipAddress, metadata?.userAgent, {
        ...attempt,
        missingAgentId: keyRow.agentId,
      });
      return {
        success: false,
        error: "Agent not found",
        code: "AGENT_NOT_FOUND",
      };
    }

    const key = keyRow;

    // 4. Check that the agent is active
    if (!agent.isActive) {
      logAuthFailure(agent.id, "Agent is deactivated", metadata?.ipAddress, metadata?.userAgent);
      return {
        success: false,
        error: "Agent is deactivated",
        code: "AGENT_DEACTIVATED",
      };
    }

    // 5. Quotas (minute, writes and the day's budget) are NOT counted
    // here: this function is called by the global authentication and the MCP one for
    // the SAME request, and it counted twice (and answered 401 instead of 429).
    // `agentQuotas` (lib/agent-quotas.ts) counts them just once.

    // 6. Update last_used_at (async, we do not block the response)
    markUsage(key.id);

    // 7. Log successful authentication
    logAuthSuccess(agent.id, key.id, metadata?.ipAddress, metadata?.userAgent);

    return {
      success: true,
      context: {
        agentId: agent.id,
        agentName: agent.name,
        scopes: (agent.scopes as string[] | null) ?? [],
        rateLimit: agent.rateLimit ?? 60,
        writesPerDay: agent.writesPerDay ?? null,
        budgetUnitsPerDay: agent.budgetUnitsPerDay ?? null,
        keyId: key.id,
        allowedTools: Array.isArray(agent.allowedTools)
          ? (agent.allowedTools as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
        sponsor: await agentSigner(agent.sponsorUserId),
        mcpSettings: readMcpSettings(agent.mcpSettings),
      },
    };
  } catch (error) {
    console.error("[AgentAuth] Authentication error:", error);
    return {
      success: false,
      error: "Authentication failed",
      code: "AUTH_ERROR",
    };
  }
}

/**
 * OAuth for MCP: the access token → the SAME context the agent's static
 * key would give, with the scopes narrowed by the grant (lib/oauth/
 * tokens.ts `effectiveScopes`). Everything else (quotas, denials,
 * approvals, RLS, signer, audit) is applied by whoever receives the context,
 * as always.
 */
async function authenticateOAuthToken(
  token: string,
  metadata?: { ipAddress?: string; userAgent?: string; route?: string }
): Promise<AgentAuthResult> {
  try {
    const r = await searchAccessToken(token, metadata?.route);
    if (!r.ok) {
      logAuthFailure(r.agentId ?? null, r.error, metadata?.ipAddress, metadata?.userAgent, {
        via: "oauth",
      });
      return { success: false, error: r.error, code: r.code };
    }
    const agent = r.agent;
    if (!agent.isActive) {
      logAuthFailure(agent.id, "Agent is deactivated", metadata?.ipAddress, metadata?.userAgent, {
        via: "oauth",
      });
      return { success: false, error: "Agent is deactivated", code: "AGENT_DEACTIVATED" };
    }
    markUsage(r.key.id);
    logAuthSuccess(agent.id, r.key.id, metadata?.ipAddress, metadata?.userAgent);
    return {
      success: true,
      context: {
        agentId: agent.id,
        agentName: agent.name,
        scopes: r.scopes,
        rateLimit: agent.rateLimit ?? 60,
        writesPerDay: agent.writesPerDay ?? null,
        budgetUnitsPerDay: agent.budgetUnitsPerDay ?? null,
        keyId: r.key.id,
        allowedTools: Array.isArray(agent.allowedTools)
          ? (agent.allowedTools as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
        sponsor: await agentSigner(agent.sponsorUserId),
        mcpSettings: readMcpSettings(agent.mcpSettings),
        oauth: { clientId: r.clientId, grantId: r.grantId },
      },
    };
  } catch (error) {
    console.error("[AgentAuth] OAuth authentication error:", error);
    return { success: false, error: "Authentication failed", code: "AUTH_ERROR" };
  }
}

/**
 * An agent's identity WITHOUT its secret, to run a
 * proposal a human approved (lib/approvals.ts). EVERYTHING is re-read from the
 * database at that moment: if the agent was deactivated, or the key it
 * proposed with was revoked or expired, there is no context and the proposal is not run.
 * The scopes are those of NOW, not those of when it was proposed.
 */
export async function agentContextForApproval(
  agentId: string,
  keyId: string | null
): Promise<{ ok: true; context: AgentAuthContext } | { ok: false; reason: string }> {
  const [agent] = await db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.id, agentId))
    .limit(1);
  if (!agent) return { ok: false, reason: "agent_not_found" };
  if (!agent.isActive) return { ok: false, reason: "agent_deactivated" };
  let scopes = (agent.scopes as string[] | null) ?? [];
  if (keyId) {
    const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, keyId)).limit(1);
    if (!key || key.agentId !== agentId) return { ok: false, reason: "key_not_found" };
    if (key.revokedAt) return { ok: false, reason: "key_revoked" };
    if (key.expiresAt && key.expiresAt < new Date()) return { ok: false, reason: "key_expired" };
    // Proposal made by an OAuth connection: it runs with what that
    // connection allows TODAY (narrowed by the grant), not with the whole agent.
    if (key.algorithm === "oauth") {
      const grant = await keyGrant(key.id);
      if (!grant || grant.revoked) return { ok: false, reason: "oauth_grant_revoked" };
      scopes = effectiveScopes(scopes, grant.scopes);
    }
  }
  return {
    ok: true,
    context: {
      agentId: agent.id,
      agentName: agent.name,
      scopes,
      rateLimit: agent.rateLimit ?? 60,
      writesPerDay: agent.writesPerDay ?? null,
      budgetUnitsPerDay: agent.budgetUnitsPerDay ?? null,
      keyId: keyId ?? "",
      allowedTools: Array.isArray(agent.allowedTools)
        ? (agent.allowedTools as unknown[]).filter((t): t is string => typeof t === "string")
        : [],
      sponsor: await agentSigner(agent.sponsorUserId),
      mcpSettings: readMcpSettings(agent.mcpSettings),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compatibility (does nothing): the per-minute counter used to live here, in memory.
 * It is now in lib/agent-quotas.ts (Valkey, with an in-memory and
 * Postgres fallback), which cleans its own windows. Not imported here: tests that
 * replace `../db/schema` must not drag in the quotas module.
 */
export function cleanupRateLimitCache(): void {
  /* nothing to clean up */
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `last_used_at` at most once per minute and key in this process
 * (performance).
 *
 * It was an UPDATE (with its COMMIT and its pool connection) on EVERY agent
 * request, for a column the panel shows as a date ("last used"). The real
 * audit —one `auth_success` row per request in
 * `agent_audit_logs`— does not change: it is still written every time.
 */
const MARK_USAGE_EVERY_MS = 60_000;
const lastUsageMark = new Map<string, number>();

function markUsage(keyId: string): void {
  const now = Date.now();
  const earlier = lastUsageMark.get(keyId);
  if (earlier !== undefined && now - earlier < MARK_USAGE_EVERY_MS) return;
  if (lastUsageMark.size >= 10_000) lastUsageMark.clear();
  lastUsageMark.set(keyId, now);
  updateLastUsed(keyId).catch(() => {
    // Silence audit errors; the next attempt does not wait for the minute
    lastUsageMark.delete(keyId);
  });
}

async function updateLastUsed(keyId: string): Promise<void> {
  await db.update(agentApiKeys).set({ lastUsedAt: new Date() }).where(eq(agentApiKeys.id, keyId));
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE VERIFICATION (Zero Trust)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Checks whether an agent has a specific scope
 */
export function hasScope(agentContext: AgentAuthContext, requiredScope: string): boolean {
  // The single rule (wildcards and `!pattern` denials): @kitsuden/shared,
  // agent-permission.ts. See docs/agents/permissions.md.
  return concedeScope(agentContext.scopes || [], requiredScope);
}

/**
 * Checks multiple scopes (requires ALL)
 */
export function hasAllScopes(agentContext: AgentAuthContext, requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => hasScope(agentContext, scope));
}

/**
 * Checks multiple scopes (requires AT LEAST ONE)
 */
export function hasAnyScope(agentContext: AgentAuthContext, requiredScopes: string[]): boolean {
  return requiredScopes.some((scope) => hasScope(agentContext, scope));
}

// ═══════════════════════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a new agent with its API key
 *
 * @param params - Parameters to create the agent
 * @returns Created agent and plain-text API key
 *
 * @example
 * ```typescript
 * const { agent, plainApiKey } = await createAgent({
 *   name: "Claude Desktop",
 *   type: "claude-desktop",
 *   capabilities: ["web-search", "code-generation"],
 *   systemPrompt: "You are a development assistant...",
 *   allowedTools: ["read_dataset", "write_post"]
 * });
 * ```
 */
export async function createAgent(params: {
  name: string;
  description?: string;
  type?: string;
  capabilities?: string[];
  systemPrompt?: string;
  allowedTools?: string[];
  scopes?: string[];
  rateLimit?: number;
  /** Omitted: `AGENT_KEY_DEFAULT_EXPIRY_DAYS` (90). `null`: the key never expires. */
  expiresInDays?: number | null;
}): Promise<{
  agent: typeof agentIdentities.$inferSelect;
  plainApiKey: string;
}> {
  const {
    name,
    description,
    type = "custom",
    capabilities = [],
    systemPrompt,
    allowedTools = [],
    scopes = [],
    rateLimit = 60,
    expiresInDays,
  } = params;

  // Generate API key with the type included (Argon2id)
  const { plainKey, keyHash, keyId, algorithm, keyPrefix } = await generateAgentApiKey(type);

  // Create agent with new persona fields
  const [agent] = await db
    .insert(agentIdentities)
    .values({
      name,
      description,
      type,
      capabilities,
      systemPrompt,
      allowedTools,
      scopes,
      rateLimit,
    })
    .returning();

  // Create API key (with the default expiry unless the caller says otherwise)
  const expiresAt = agentKeyExpiresAt(expiresInDays);

  await db.insert(agentApiKeys).values({
    agentId: agent.id,
    keyId,
    keyHash,
    keyPrefix,
    algorithm,
    expiresAt,
  });

  return { agent, plainApiKey: plainKey };
}

/**
 * Revokes an API key: it stops authenticating on the next request. The row
 * stays (with `revoked_at` and who) for the audit.
 */
export async function revokeApiKey(keyId: string, revokedBy?: string): Promise<void> {
  await db
    .update(agentApiKeys)
    .set({ revokedAt: new Date(), revokedBy: revokedBy ?? null })
    .where(eq(agentApiKeys.id, keyId));
}

/**
 * Deactivates an agent (removes all its keys)
 */
export async function deactivateAgent(agentId: string): Promise<void> {
  await db.delete(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
  // Optional: we could also mark the agent as inactive
}

/**
 * Gets all agents with their keys
 */
export async function listAgents() {
  const agents = await db.select().from(agentIdentities);

  const agentsWithKeys = await Promise.all(
    agents.map(async (agent) => {
      const keys = await db
        .select({
          id: agentApiKeys.id,
          keyPrefix: agentApiKeys.keyPrefix,
          createdAt: agentApiKeys.createdAt,
          lastUsedAt: agentApiKeys.lastUsedAt,
          expiresAt: agentApiKeys.expiresAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, agent.id));

      return {
        ...agent,
        keys,
      };
    })
  );

  return agentsWithKeys;
}

// ═══════════════════════════════════════════════════════════════════════════
// MIDDLEWARE FACTORY
// ═══════════════════════════════════════════════════════════════════════════

import type { MiddlewareHandler, Context, Next } from "hono";

/**
 * Extends the Hono context with the agent
 */
declare module "hono" {
  interface ContextVariableMap {
    agent: AgentAuthContext;
  }
}

/**
 * Middleware factory to require agent authentication
 */
export function requireAgentAuth(options?: {
  scopes?: string[];
  requireAll?: boolean;
}): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // 1. Get the API key from the header
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return c.json(
        {
          error: "Authorization header required",
          code: "MISSING_AUTH",
        },
        401
      );
    }

    // Format: "Bearer kitsuden_agent_xxxxx"
    const [scheme, apiKey] = authHeader.split(" ");

    if (scheme !== "Bearer" || !apiKey) {
      return c.json(
        {
          error: "Invalid authorization format. Use: Bearer <api-key>",
          code: "INVALID_AUTH_FORMAT",
        },
        401
      );
    }

    // 2. Authenticate
    const result = await authenticateAgent(apiKey);

    if (!result.success || !result.context) {
      return c.json(
        {
          error: result.error,
          code: result.code,
        },
        401
      );
    }

    // 3. Check scopes if required
    if (options?.scopes && options.scopes.length > 0) {
      const hasScopes =
        options.requireAll !== false
          ? hasAllScopes(result.context, options.scopes)
          : hasAnyScope(result.context, options.scopes);

      if (!hasScopes) {
        return c.json(
          {
            error: "Insufficient permissions",
            code: "FORBIDDEN",
            required: options.scopes,
            granted: result.context.scopes,
          },
          403
        );
      }
    }

    // 4. Store in context
    c.set("agent", result.context);

    // 5. Add rate limit headers to the response
    c.header("X-Agent-Id", result.context.agentId);
    c.header("X-RateLimit-Limit", result.context.rateLimit.toString());

    await next();
  };
}

/**
 * Optional middleware: authenticates if there is a key, but does not require one
 */
export function optionalAgentAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader) {
      const [scheme, apiKey] = authHeader.split(" ");

      if (scheme === "Bearer" && apiKey) {
        const result = await authenticateAgent(apiKey);

        if (result.success && result.context) {
          c.set("agent", result.context);
        }
      }
    }

    await next();
  };
}
