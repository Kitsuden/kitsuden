/**
 * Permissions, keys and quotas of each agent — what the panel uses
 * ============================================================================
 *
 * Mounted at `/api/v1` (admin only: `ADMIN_ONLY_ROUTES` covers `/api/v1`).
 *
 *   GET  /agent-access/catalog                  what can be granted: presets,
 *                                               broad scopes (and what each
 *                                               one opens), SDK operations per kon
 *                                               and datasets
 *   GET  /agents/:id/access                     what THIS agent can do,
 *                                               merged (broad + fine − denied)
 *   PUT  /agents/:id/scopes                     replaces the list of scopes
 *   GET  /agents/:id/keys                       keys (without secret)
 *   POST /agents/:id/keys                       new key (the secret, once)
 *   POST /agents/:id/keys/:keyId/rotate         new key; the old one is valid until
 *                                               the grace period ends (no downtime)
 *   POST /agents/:id/keys/:keyId/revoke         stops being valid NOW
 *   GET  /agents/:id/quotas                     limits, today's usage and
 *                                               savings from the `auto` format
 *   PUT  /agents/:id/quotas                     changes the limits
 *   GET  /agents/:id/mcp-settings               default toolset and wrapper
 *                                               for untrusted content
 *   PUT  /agents/:id/mcp-settings               changes them (audited)
 *   GET  /agents/:id/sponsor                    its human signer and
 *                                               the accounts that can be one
 *   PUT  /agents/:id/sponsor                    chooses or removes the signer
 *
 * These are kon SDK operations (OpenAPI 3.1 with schemas; outside MCP with
 * their reason) of a core "kon", `kon-agents`, which is NOT registered among
 * the mounted operations: so no fine-grained scope (`kon:*`, `kon:agents:*`)
 * opens the /api/v1 gate — an agent cannot grant itself permissions.
 * In addition each operation requires admin (`before: [requireAdminRole]`).
 *
 * The permission rule is that of `@kitsuden/shared` (agent-permission.ts):
 * union of grants, a `!pattern` denial wins. See
 * docs/agents/permissions.md.
 */

import {
  DATASET_ACTIONS,
  defineOperation,
  AGENT_PRESETS,
  SIGNER_ROLES,
  BROAD_CORE_SCOPES,
  accessToDataset,
  checkReadAccess,
  checkWriteAccess,
  grantsByScopes,
  operationCost,
  operationDenial,
  isSensitive,
  exclusionMcp,
  konShortName,
  toolName,
  normalizeScopes,
  splitScopes,
  scopeCovers,
  operationFineScope,
  type DatasetAction,
  type PolicyJson,
} from "@kitsuden/shared";
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import {
  grantsOperation,
  mountedOperations,
  operationsRouter,
  type AnyOperation,
} from "../../../../packages/engine/src/operations";
import { db } from "../db";
import {
  agentApiKeys,
  agentAuditLogs,
  agentIdentities,
  agentProposals,
  authUsers,
  dataSets,
} from "../db/schema";
import { listDecisions } from "../lib/agent-decisions";
import { frictionReport } from "../lib/agent-friction";
import { agentUsage } from "../lib/agent-quotas";
import { snapshotAgent } from "../lib/agent-versions";
import { registerCoreOperations } from "../lib/core-operations";
import { agentSavings } from "../lib/format-savings";
import { mountedKons } from "../lib/kon-routes";
import { logger } from "../lib/logger";
import {
  McpSettingsSchema,
  readMcpSettings,
  WRAPPER_MODES,
  parseToolset,
  FIXED_TOOLSETS,
} from "../lib/mcp-settings";
import { requireAuth, optionalAuth } from "../middleware/auth";
import {
  noAgentsInAgentManagement,
  requireAdminRole,
  requireStaff,
} from "../middleware/auth-guard";
import { logAgentAction } from "../services/agent-audit";
import { agentKeyExpiresAt, agentSigner, generateAgentApiKey } from "../services/agent-auth";

import {
  getAgentVersionHandler,
  listAgentVersionsHandler,
  restoreAgentVersionHandler,
} from "./agents-v1";

type Agent = typeof agentIdentities.$inferSelect;

async function agentById(id: string): Promise<Agent | null> {
  const [a] = await db.select().from(agentIdentities).where(eq(agentIdentities.id, id)).limit(1);
  return a ?? null;
}

const scopesOf = (a: Agent): string[] =>
  Array.isArray(a.scopes)
    ? (a.scopes as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

function who(c: Context): string | null {
  const u = (c.get as (k: string) => unknown)("user") as { id?: string } | null;
  return u?.id ?? null;
}

/** Leaves a trace in the agent audit (who changed what). */
function audit(c: Context, agentId: string, that: string, details: Record<string, unknown>) {
  logAgentAction({
    agentId,
    action: "config_change",
    resource: that,
    details: { ...details, by: who(c) },
    success: true,
  });
}

// ── Catalog ─────────────────────────────────────────────────────────────────

interface CatalogOperation {
  konId: string;
  kon: string;
  id: string;
  scope: string;
  method: string;
  path: string;
  summary: string;
  sensitive: boolean;
  cost: number;
  write: boolean;
  public: boolean;
}

function catalogOperations(): CatalogOperation[] {
  const list: CatalogOperation[] = [];
  for (const { konId, mountPath, operations: operations } of mountedOperations()) {
    for (const op of operations) {
      list.push({
        konId,
        kon: konShortName(konId),
        id: op.id,
        scope: operationFineScope(konId, op.id),
        method: op.method,
        path: op.route === "/" ? mountPath : `${mountPath}${op.route}`,
        summary: op.summary,
        sensitive: isSensitive(op),
        cost: operationCost(op),
        write: op.method !== "GET",
        public: !op.permission && op.access !== "session",
      });
    }
  }
  return list;
}

function opOf(konId: string, opId: string) {
  return mountedOperations()
    .find((k) => k.konId === konId)
    ?.operations.find((o) => o.id === opId);
}

/** The broad scopes the panel offers: the core's and the `<kon>:*` of each mounted kon. */
function broadScopes(): string[] {
  const fromKons = mountedKons()
    .map((k) => `${konShortName(k.konId)}:*`)
    .sort();
  return [...new Set([...BROAD_CORE_SCOPES, ...fromKons])];
}

async function catalog(c: Context): Promise<Response> {
  const ops = catalogOperations();
  const datasets = await db
    .select({ slug: dataSets.slug, name: dataSets.name })
    .from(dataSets)
    .orderBy(dataSets.name);

  const broad = broadScopes().map((scope) => {
    const opens = ops
      .filter((o) => {
        const op = opOf(o.konId, o.id);
        return op ? grantsByScopes([scope], o.konId, op).granted : false;
      })
      .map((o) => o.scope);
    const datasetsItOpens = DATASET_ACTIONS.flatMap((action) =>
      datasets
        .filter((d) => accessToDataset([scope], d.slug, action) === "granted")
        .map((d) => `datasets:${d.slug}:${action}`)
    );
    return { scope, operations: opens, datasets: datasetsItOpens };
  });

  const sdk = new Set(mountedOperations().map((k) => k.konId));
  return c.json({
    presets: AGENT_PRESETS,
    broad,
    kons: [...new Set(ops.map((o) => o.konId))].map((konId) => ({
      konId,
      kon: konShortName(konId),
      operations: ops.filter((o) => o.konId === konId),
    })),
    legacyKons: mountedKons()
      .filter((k) => !sdk.has(k.konId))
      .map((k) => ({ konId: k.konId, kon: konShortName(k.konId), mountPath: k.mountPath })),
    datasets,
    datasetActions: DATASET_ACTIONS,
  });
}

// ── What an agent can do ────────────────────────────────────────────────────

type Status = "granted" | "denied" | "open" | "policy" | "none";

async function agentAccess(a: Agent) {
  const scopes = scopesOf(a);
  const { grants, denials } = splitScopes(scopes);
  const user = { id: a.id, role: "agent", scopes };

  const operations = [];
  for (const o of catalogOperations()) {
    const op = opOf(o.konId, o.id);
    if (!op) continue;
    const denied = operationDenial(scopes, o.konId, op);
    const byScope = grantsByScopes(scopes, o.konId, op);
    let state: Status;
    let by: string | null = null;
    if (denied) {
      state = "denied";
      by = denied;
    } else if (byScope.granted) {
      state = "granted";
      by = byScope.by ?? null;
    } else if (!op.permission) {
      state = "open";
    } else if (op.permission.policy?.inHandler) {
      state = "policy";
    } else {
      state = (await grantsOperation(o.konId, op, user)) ? "policy" : "none";
    }
    operations.push({ ...o, state, by });
  }

  const rows = await db
    .select({ slug: dataSets.slug, name: dataSets.name, policyJson: dataSets.policyJson })
    .from(dataSets)
    .orderBy(dataSets.name);
  const asRls = { id: a.id, role: "agent" };
  const datasets = rows.map((d) => {
    const actions = {} as Record<DatasetAction, { state: Status; by: string | null }>;
    for (const action of DATASET_ACTIONS) {
      const access = accessToDataset(scopes, d.slug, action);
      const required = `datasets:${d.slug}:${action}`;
      if (access === "denied") {
        actions[action] = {
          state: "denied",
          by: `!${denials.find((x) => scopeCovers(x, required)) ?? ""}`,
        };
      } else if (access === "granted") {
        actions[action] = {
          state: "granted",
          by: grants.find((x) => scopeCovers(x, required)) ?? null,
        };
      } else {
        const policy = (d.policyJson ?? null) as PolicyJson | null;
        const byPolicy =
          action === "read" ? checkReadAccess(policy, asRls) : checkWriteAccess(policy, asRls);
        actions[action] = { state: byPolicy ? "policy" : "none", by: null };
      }
    }
    return { slug: d.slug, name: d.name, ...actions };
  });

  // The broad ones it has (to explain them) and the ones that are not recognized.
  const known = new Set(broadScopes());
  const broad = grants
    .filter((s) => !s.startsWith("kon:") || s === "kon:*")
    .filter((s) => !/^datasets:[^:*]+:/.test(s));
  return {
    agentId: a.id,
    scopes,
    grants,
    denies: denials.map((d) => `!${d}`),
    broad: broad.map((s) => ({ scope: s, known: known.has(s) })),
    operations,
    datasets,
  };
}

async function access(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  return c.json(await agentAccess(a));
}

async function saveScopes(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { scopes?: unknown } | null;
  let scopes: string[];
  try {
    scopes = normalizeScopes(body?.scopes);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 422);
  }
  const before = scopesOf(a);
  const [updated] = await db
    .update(agentIdentities)
    .set({ scopes, updatedAt: new Date() })
    .where(eq(agentIdentities.id, a.id))
    .returning();
  audit(c, a.id, "scopes", {
    added: scopes.filter((s) => !before.includes(s)),
    removed: before.filter((s) => !scopes.includes(s)),
  });
  // Scopes are part of the agent's version (migration 0074).
  await snapshotAgent(a.id, { createdBy: who(c), source: "update", note: "scopes" });
  logger.info({ agentId: a.id }, "[agents] scopes updated");
  return c.json(await agentAccess(updated!));
}

// ── Keys ────────────────────────────────────────────────────────────────────

const GRACE_MAX_HOURS = 24 * 30;

function keyStatus(k: typeof agentApiKeys.$inferSelect, now = Date.now()) {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && k.expiresAt.getTime() <= now) return "expired";
  if (k.expiresAt && k.expiresAt.getTime() - now < 7 * 86_400_000) return "expiring";
  return "active";
}

const keyView = (k: typeof agentApiKeys.$inferSelect) => ({
  id: k.id,
  name: k.name,
  prefix: k.keyPrefix,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  expiresAt: k.expiresAt,
  revokedAt: k.revokedAt,
  revokedBy: k.revokedBy,
  rotatedFrom: k.rotatedFrom,
  status: keyStatus(k),
  // OAuth for MCP (0055): the row of an OAuth connection (it has no secret of its own)
  kind: k.algorithm === "oauth" ? "oauth" : "static",
});

async function listKeys(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const keys = await db
    .select()
    .from(agentApiKeys)
    .where(eq(agentApiKeys.agentId, a.id))
    .orderBy(desc(agentApiKeys.createdAt));
  return c.json({ keys: keys.map(keyView) });
}

const NewKey = z
  .object({
    name: z.string().trim().max(100).optional(),
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

async function issueKey(
  a: Agent,
  options: { name?: string | null; expiresInDays?: number | null; rotatedFrom?: string | null }
) {
  const { plainKey, keyHash, keyPrefix, keyId, algorithm } = await generateAgentApiKey(
    a.type ?? undefined
  );
  // Omitted: the default expiry (AGENT_KEY_DEFAULT_EXPIRY_DAYS, 90); null: never.
  const expiresAt = agentKeyExpiresAt(options.expiresInDays);
  const [row] = await db
    .insert(agentApiKeys)
    .values({
      agentId: a.id,
      keyId,
      keyHash,
      keyPrefix,
      algorithm,
      expiresAt,
      name: options.name || null,
      rotatedFrom: options.rotatedFrom ?? null,
    })
    .returning();
  return { row: row!, plainKey };
}

async function createKey(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const r = NewKey.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) return c.json({ error: "Validation failed", issues: r.error.issues }, 422);
  const { row: row, plainKey } = await issueKey(a, r.data);
  audit(c, a.id, "key_created", { keyId: row.id, expiresAt: row.expiresAt });
  // The secret comes out ONCE, here. It is never stored in plain text.
  return c.json({ key: keyView(row), apiKey: plainKey }, 201);
}

const Rotation = z
  .object({
    /** How long the old key stays valid. 0 = stops being valid now. */
    graceHours: z.number().int().min(0).max(GRACE_MAX_HOURS).default(24),
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
    name: z.string().trim().max(100).optional(),
  })
  .strict();

async function agentKey(agentId: string, keyId: string) {
  const [k] = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, agentId)))
    .limit(1);
  return k ?? null;
}

async function rotateKey(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const old = await agentKey(a.id, c.req.param("keyId") ?? "");
  if (!old) return c.json({ error: "Key not found" }, 404);
  const status = keyStatus(old);
  if (status === "revoked" || status === "expired") {
    return c.json({ error: `Cannot rotate a ${status} key: create a new one instead` }, 409);
  }
  // An OAuth connection is not rotated: its tokens already rotate by themselves. It is revoked and the
  // client asks for permission again (docs/agents/oauth.md).
  if (old.algorithm === "oauth") {
    return c.json(
      { error: "OAuth connections cannot be rotated: revoke it and reconnect the client" },
      409
    );
  }
  const r = Rotation.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) return c.json({ error: "Validation failed", issues: r.error.issues }, 422);

  // The new one first (if something fails, the old one stays intact), then the old one is shortened.
  const { row: row, plainKey } = await issueKey(a, {
    name: r.data.name ?? old.name,
    expiresInDays: r.data.expiresInDays,
    rotatedFrom: old.id,
  });
  const graceEnd = new Date(Date.now() + r.data.graceHours * 3_600_000);
  const newExpiry = old.expiresAt && old.expiresAt < graceEnd ? old.expiresAt : graceEnd;
  const [oldUpdated] = await db
    .update(agentApiKeys)
    .set({ expiresAt: newExpiry })
    .where(eq(agentApiKeys.id, old.id))
    .returning();
  audit(c, a.id, "key_rotated", {
    oldKeyId: old.id,
    newKeyId: row.id,
    oldKeyValidUntil: newExpiry,
  });
  return c.json({ key: keyView(row), apiKey: plainKey, previous: keyView(oldUpdated!) }, 201);
}

async function revokeKey(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const k = await agentKey(a.id, c.req.param("keyId") ?? "");
  if (!k) return c.json({ error: "Key not found" }, 404);
  if (k.revokedAt) return c.json({ key: keyView(k) });
  const [revoked] = await db
    .update(agentApiKeys)
    .set({ revokedAt: new Date(), revokedBy: who(c) })
    .where(eq(agentApiKeys.id, k.id))
    .returning();
  audit(c, a.id, "key_revoked", { keyId: k.id });
  return c.json({ key: keyView(revoked!) });
}

// ── Quotas ──────────────────────────────────────────────────────────────────

const limitsOf = (a: Agent) => ({
  requestsPerMinute: a.rateLimit ?? null,
  writesPerDay: a.writesPerDay ?? null,
  budgetUnitsPerDay: a.budgetUnitsPerDay ?? null,
});

async function readQuotas(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  return c.json({
    limits: limitsOf(a),
    usage: await agentUsage(a.id),
    formatSavings: await savingsWithoutBreaking(a.id),
  });
}

/**
 * What the `auto` format saved it (lib/format-savings.ts). If the table
 * does not exist yet (migration 0052 not applied), quotas can still be seen.
 */
async function savingsWithoutBreaking(agentId: string) {
  try {
    return await agentSavings(agentId);
  } catch (err) {
    logger.warn({ err, agentId }, "[agents] could not read the format savings");
    return null;
  }
}

const Limit = (max: number) => z.number().int().min(1).max(max).nullable().optional();
const Quotas = z
  .object({
    // There is always a per-minute limit (without it, an agent's loop takes the API down).
    requestsPerMinute: z.number().int().min(1).max(100_000).optional(),
    writesPerDay: Limit(10_000_000),
    budgetUnitsPerDay: Limit(100_000_000),
  })
  .strict();

async function saveQuotas(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const r = Quotas.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) return c.json({ error: "Validation failed", issues: r.error.issues }, 422);
  const changes: Partial<typeof agentIdentities.$inferInsert> = { updatedAt: new Date() };
  if (r.data.requestsPerMinute !== undefined) changes.rateLimit = r.data.requestsPerMinute;
  if (r.data.writesPerDay !== undefined) changes.writesPerDay = r.data.writesPerDay;
  if (r.data.budgetUnitsPerDay !== undefined) changes.budgetUnitsPerDay = r.data.budgetUnitsPerDay;
  const [updated] = await db
    .update(agentIdentities)
    .set(changes)
    .where(eq(agentIdentities.id, a.id))
    .returning();
  audit(c, a.id, "quotas", { before: limitsOf(a), after: limitsOf(updated!) });
  return c.json({
    limits: limitsOf(updated!),
    usage: await agentUsage(a.id),
    formatSavings: await savingsWithoutBreaking(a.id),
  });
}

// ── MCP settings (toolset and wrapper) ─────────────────────────────────────

/** What the panel shows: what is set and what can be chosen. */
function mcpSettingsView(a: Agent) {
  const settings = readMcpSettings(a.mcpSettings);
  return {
    settings: {
      toolset: settings.toolset ?? null,
      untrustedWrap: settings.untrustedWrap ?? "none",
    },
    options: {
      toolsets: [...FIXED_TOOLSETS],
      // Kons with SDK operations: they are the ones that have tools
      kons: [
        ...new Set(mountedOperations().map((o) => `kon:${o.konId.replace(/^kon-/, "")}`)),
      ].sort(),
      untrustedWrap: [...WRAPPER_MODES],
    },
  };
}

async function readAgentMcpSettings(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  return c.json(mcpSettingsView(a));
}

async function saveAgentMcpSettings(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const r = McpSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) return c.json({ error: "Validation failed", issues: r.error.issues }, 422);
  const actual = readMcpSettings(a.mcpSettings);
  const next: Record<string, unknown> = { ...actual };
  if (r.data.toolset !== undefined) {
    const text = (r.data.toolset ?? "").trim();
    const t = parseToolset(text);
    if (!t.ok) return c.json({ error: "Validation failed", message: t.error }, 422);
    if (text === "" || text === "all") delete next.toolset;
    else next.toolset = text;
  }
  if (r.data.untrustedWrap !== undefined) {
    if (r.data.untrustedWrap === "none") delete next.untrustedWrap;
    else next.untrustedWrap = r.data.untrustedWrap;
  }
  const [updated] = await db
    .update(agentIdentities)
    .set({ mcpSettings: next, updatedAt: new Date() })
    .where(eq(agentIdentities.id, a.id))
    .returning();
  audit(c, a.id, "mcp_settings", { before: actual, after: next });
  // So are the MCP settings (migration 0074).
  await snapshotAgent(a.id, { createdBy: who(c), source: "update", note: "MCP settings" });
  return c.json(mcpSettingsView(updated!));
}

// ── Human signer ───────────────────────────────

/** What the panel shows about an agent's signer and whom it can choose. */
async function signerView(a: Agent) {
  const signer = await agentSigner(a.sponsorUserId);
  const candidates = await db
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      role: authUsers.role,
    })
    .from(authUsers)
    .where(inArray(authUsers.role, [...SIGNER_ROLES]))
    .orderBy(authUsers.name)
    .limit(500);
  const account = signer
    ? (
        await db
          .select({
            id: authUsers.id,
            name: authUsers.name,
            email: authUsers.email,
            role: authUsers.role,
          })
          .from(authUsers)
          .where(eq(authUsers.id, signer.userId))
          .limit(1)
      )[0]
    : undefined;
  return {
    sponsor: signer
      ? {
          userId: signer.userId,
          valid: signer.valid,
          reason: signer.reason ?? null,
          name: account?.name ?? null,
          email: account?.email ?? null,
          role: account?.role ?? null,
        }
      : null,
    candidates,
  };
}

async function readSigner(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  return c.json(await signerView(a));
}

const Signer = z.object({ userId: z.string().min(1).max(200).nullable() }).strict();

async function saveSigner(c: Context): Promise<Response> {
  const a = await agentById(c.req.param("id") ?? "");
  if (!a) return c.json({ error: "Agent not found" }, 404);
  const r = Signer.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) return c.json({ error: "Validation failed", issues: r.error.issues }, 422);
  const userId = r.data.userId;
  if (userId) {
    const f = await agentSigner(userId);
    if (!f?.valid) {
      return c.json(
        {
          error: "Validation failed",
          message: "The signer must be an existing admin or editor account.",
          reason: f?.reason ?? null,
        },
        422
      );
    }
  }
  const [updated] = await db
    .update(agentIdentities)
    .set({ sponsorUserId: userId, updatedAt: new Date() })
    .where(eq(agentIdentities.id, a.id))
    .returning();
  audit(c, a.id, "sponsor", { before: a.sponsorUserId ?? null, after: userId });
  return c.json(await signerView(updated!));
}

// ── Friction: where agents get stuck with the MCP tools ─────────────────────

/** At most this many calls are read by the report (the most recent ones). */
const MAX_CALLS_IN_REPORT = 50_000;

/**
 * Failures by code, invented keys and rejected proposals per
 * tool, with what to change in each operation's guide (see
 * lib/agent-friction.ts). Reads `tool_call` from `agent_audit_logs` (the MCP
 * ones, `details.origin = 'mcp'`) and the rejected proposals.
 */
async function friction(days: number, agentId: string | undefined) {
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      tool: agentAuditLogs.resource,
      agentId: agentAuditLogs.agentId,
      success: agentAuditLogs.success,
      details: agentAuditLogs.details,
    })
    .from(agentAuditLogs)
    .where(
      and(
        eq(agentAuditLogs.action, "tool_call"),
        gte(agentAuditLogs.createdAt, from),
        sql`${agentAuditLogs.details}->>'origin' = 'mcp'`,
        agentId ? eq(agentAuditLogs.agentId, agentId) : undefined
      )
    )
    .orderBy(desc(agentAuditLogs.createdAt))
    .limit(MAX_CALLS_IN_REPORT);

  const rejections = await db
    .select({ tool: agentProposals.tool, n: count() })
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.status, "rejected"),
        isNotNull(agentProposals.tool),
        gte(agentProposals.createdAt, from),
        agentId ? eq(agentProposals.agentId, agentId) : undefined
      )
    )
    .groupBy(agentProposals.tool);

  return {
    days,
    agentId: agentId ?? null,
    calls: rows.length,
    truncated: rows.length === MAX_CALLS_IN_REPORT,
    tools: frictionReport(
      rows.map((f) => ({ ...f, tool: f.tool ?? "(no name)" })),
      new Map(rejections.map((r) => [r.tool!, Number(r.n)])),
      { withGuide: toolsWithGuide() }
    ),
  };
}

/** The MCP tools of the mounted operations that declare `guide`. */
function toolsWithGuide(): Set<string> {
  const names = new Set<string>();
  for (const { konId, operations: operations } of mountedOperations()) {
    for (const op of operations) {
      if (op.guide && exclusionMcp(op) === null) names.add(toolName(konId, op));
    }
  }
  return names;
}

// ── The operations (kon SDK) ────────────────────────────────────────────────

const AgentParam = z.object({ id: z.string().min(1) });
const KeyParam = z.object({ id: z.string().min(1), keyId: z.string().min(1) });
const VersionParam = z.object({ id: z.string().min(1), version: z.coerce.number().int().min(1) });
const Obj = z.record(z.string(), z.unknown());
const WITHOUT_MCP = {
  exclude:
    "Admin configuration of agents (permissions, keys, quotas): kept out of MCP so no agent can change agent permissions; use the admin panel or REST with an admin session.",
};
/**
 * An agent NEVER writes here, not even with `admin`: it could rewrite its own
 * scopes (erasing its `!denials`), mint itself keys or raise its quotas. Reads
 * keep the usual admin gate.
 */
const ADMIN_ONLY: MiddlewareHandler[] = [
  noAgentsInAgentManagement as unknown as MiddlewareHandler,
  requireAdminRole as unknown as MiddlewareHandler,
];

/**
 * People of the team (admin or editor), never an agent: `requireStaff` alone
 * lets an agent with the `admin` scope through, and what agents discarded is
 * read by people.
 */
const peopleOfTheTeam: MiddlewareHandler = async (c, next) => {
  const user = (c.get as (k: string) => unknown)("user") as { id?: string; role?: string } | null;
  if (
    (c.get as (k: string) => unknown)("agent") ||
    user?.role === "agent" ||
    user?.id?.startsWith("machine-")
  ) {
    return c.json({ error: "Forbidden", message: "People read what agents discarded" }, 403);
  }
  await next();
};
const TEAM: MiddlewareHandler[] = [peopleOfTheTeam, requireStaff as unknown as MiddlewareHandler];
const PERMISSION = { roles: ["admin"] };

const common = {
  access: "session" as const,
  permission: PERMISSION,
  before: ADMIN_ONLY,
  mcp: WITHOUT_MCP,
  tags: ["agents"],
};

export const agentOperations: AnyOperation[] = [
  defineOperation({
    ...common,
    id: "permission-catalog",
    method: "GET",
    route: "/agent-access/catalog",
    summary: "What can be granted to an agent",
    description:
      "Presets, broad scopes (with the SDK operations and dataset permissions each one opens), SDK operations by kon, legacy kons and datasets.",
    output: { schema: Obj },
    handle: (_e, { c }) => catalog(c),
  }),
  defineOperation({
    ...common,
    id: "agent-friction",
    method: "GET",
    route: "/agent-friction",
    summary: "Where agents get stuck with the MCP tools",
    description:
      "Per tool, over the last `days` (1-90, default 7): calls, failures by error code, keys agents invent, rejected proposals, and what to change in the operation's `guide`. Reads the audited MCP tool calls; argument values are never stored, only their names.",
    input: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        agentId: z.string().min(1).optional(),
      }),
    },
    output: { schema: Obj },
    handle: (e) => friction(e.query.days, e.query.agentId),
  }),
  defineOperation({
    ...common,
    id: "agent-decisions",
    method: "GET",
    route: "/agent-decisions",
    permission: { roles: ["admin", "editor"] },
    before: TEAM,
    summary: "What agents chose not to do, and why",
    description:
      "Decisions agents recorded themselves (MCP kitsuden_record_decision, POST /api/agent/decisions): the action they discarded, the reason, the alternatives and the version of the agent that decided, newest first, over the last `days` (1-365, default 30). Read-only: nobody edits a decision. Admins see every agent; an editor sees the agents whose proposals they may decide, so not the ones they sponsor.",
    input: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        agentId: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    output: { schema: Obj },
    handle: (e, { c }) => {
      const user = (c.get as (k: string) => unknown)("user") as {
        id?: string;
        role?: string;
      } | null;
      return listDecisions({
        days: e.query.days,
        agentId: e.query.agentId ?? null,
        limit: e.query.limit,
        offset: e.query.offset,
        // Same rule as approving (lib/approvals.ts, `own_agent`).
        notSponsoredBy: user?.role === "admin" ? null : (user?.id ?? null),
      });
    },
  }),
  defineOperation({
    ...common,
    id: "agent-access",
    method: "GET",
    route: "/agents/:id/access",
    summary: "What an agent can do",
    description:
      "The merged view (broad ∪ fine-grained − denied) of the agent's saved scopes: every SDK operation and every dataset action with its state and the scope that decided it.",
    input: { params: AgentParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => access(c),
  }),
  defineOperation({
    ...common,
    id: "save-scopes",
    method: "PUT",
    route: "/agents/:id/scopes",
    summary: "Replace an agent's scopes",
    description:
      "Replaces the whole scope list (broad, fine-grained, wildcards and !denies). Invalid scopes are rejected with the reason. Returns the merged view.",
    input: {
      params: AgentParam,
      body: z.object({ scopes: z.array(z.string()) }),
      validatesHandler: true,
    },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => saveScopes(c),
  }),
  defineOperation({
    ...common,
    id: "list-keys",
    method: "GET",
    route: "/agents/:id/keys",
    summary: "List an agent's API keys",
    description:
      "Keys without secrets: name, prefix, status, created, last used, expiry, revocation and rotation origin.",
    input: { params: AgentParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => listKeys(c),
  }),
  defineOperation({
    ...common,
    id: "create-key",
    method: "POST",
    route: "/agents/:id/keys",
    summary: "Create an API key",
    description:
      "Creates a key with an optional name and expiry. Without expiresInDays the key expires after the server default (AGENT_KEY_DEFAULT_EXPIRY_DAYS, 90 days); expiresInDays: null asks for a key that never expires. The secret is returned once.",
    input: { params: AgentParam, body: NewKey, validatesHandler: true },
    output: { status: 201, schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => createKey(c),
  }),
  defineOperation({
    ...common,
    id: "rotate-key",
    method: "POST",
    route: "/agents/:id/keys/:keyId/rotate",
    summary: "Rotate an API key without downtime",
    description:
      "Creates a new key and shortens the old one to now + graceHours, so both work during the grace period. The new secret is returned once.",
    input: { params: KeyParam, body: Rotation, validatesHandler: true },
    output: { status: 201, schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: (_e, { c }) => rotateKey(c),
  }),
  defineOperation({
    ...common,
    id: "revoke-key",
    method: "POST",
    route: "/agents/:id/keys/:keyId/revoke",
    summary: "Revoke an API key",
    description: "The key stops working on its next request. The record stays for auditing.",
    idempotent: true,
    input: { params: KeyParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => revokeKey(c),
  }),
  defineOperation({
    ...common,
    id: "read-quotas",
    method: "GET",
    route: "/agents/:id/quotas",
    summary: "An agent's quotas and today's usage",
    description:
      "Requests per minute, writes and budget units per day (UTC), what was spent today, and formatSavings: bytes and estimated tokens the 'auto' format saved against compact JSON (per day, no personal data).",
    input: { params: AgentParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => readQuotas(c),
  }),
  defineOperation({
    ...common,
    id: "save-quotas",
    method: "PUT",
    route: "/agents/:id/quotas",
    summary: "Change an agent's quotas",
    description:
      "requestsPerMinute (≥ 1), writesPerDay and budgetUnitsPerDay (null = no daily limit).",
    input: { params: AgentParam, body: Quotas, validatesHandler: true },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => saveQuotas(c),
  }),
  defineOperation({
    ...common,
    id: "read-mcp-settings",
    method: "GET",
    route: "/agents/:id/mcp-settings",
    summary: "An agent's MCP settings",
    description:
      "Default toolset for its MCP sessions (narrows tools/list; never grants anything) and how text written by others is wrapped in results (none | delimiters | object).",
    input: { params: AgentParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => readAgentMcpSettings(c),
  }),
  defineOperation({
    ...common,
    id: "save-mcp-settings",
    method: "PUT",
    route: "/agents/:id/mcp-settings",
    summary: "Change an agent's MCP settings",
    description:
      "{ toolset } (comma-separated: all, read, data, core, actions, kons, kon:<id>; null or 'all' = no restriction) and { untrustedWrap } (none | delimiters | object). Audited; takes effect on the agent's next MCP message.",
    input: { params: AgentParam, body: McpSettingsSchema, validatesHandler: true },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => saveAgentMcpSettings(c),
  }),
  defineOperation({
    ...common,
    id: "read-signer",
    method: "GET",
    route: "/agents/:id/sponsor",
    summary: "An agent's human signer",
    description:
      "The admin or editor account that signs what the agent creates (blog post author, dataset entry owner), whether it is still valid, and the accounts that can be chosen.",
    input: { params: AgentParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => readSigner(c),
  }),
  defineOperation({
    ...common,
    id: "save-signer",
    method: "PUT",
    route: "/agents/:id/sponsor",
    summary: "Set or remove an agent's human signer",
    description:
      "{ userId } sets the signer (an existing admin or editor); { userId: null } removes it (the agent goes back to the behaviour without a signer). Audited.",
    input: { params: AgentParam, body: Signer, validatesHandler: true },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => saveSigner(c),
  }),
  defineOperation({
    ...common,
    id: "agent-versions",
    method: "GET",
    route: "/agents/:id/versions",
    summary: "An agent's versions",
    description:
      "Each distinct definition of the agent (system prompt, tools, capabilities, type), newest first, without the prompt text. An agent created before versions existed gets its first version on this call. `limit` caps the list (default 100).",
    input: {
      params: AgentParam,
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
    },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => listAgentVersionsHandler(c),
  }),
  defineOperation({
    ...common,
    id: "agent-version",
    method: "GET",
    route: "/agents/:id/versions/:version",
    summary: "One version of an agent",
    description: "The version's system prompt and configuration, who made it and when.",
    input: { params: VersionParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => getAgentVersionHandler(c),
  }),
  defineOperation({
    ...common,
    id: "restore-agent-version",
    method: "POST",
    route: "/agents/:id/versions/:version/restore",
    summary: "Restore an earlier version of an agent",
    description:
      "Writes that version's definition back to the agent, as a new version (the history is never rewritten). Audited.",
    input: { params: VersionParam },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (_e, { c }) => restoreAgentVersionHandler(c),
  }),
];

/**
 * Like an SDK kon for the inventory (OpenAPI, coverage), but the core
 * mounts it itself at /api/v1 and does NOT register it among the mounted
 * operations (see the header).
 */
export const agentsKon = {
  id: "kon-agents",
  name: "Agent access",
  version: "1.0.0",
  mountPath: "/api/v1",
  operations: agentOperations,
};

registerCoreOperations({
  konId: "kon-agents",
  mountPath: "/api/v1",
  description: "Agent permissions, keys and quotas (admin only).",
  operations: agentOperations,
});

export const agentPermissionsRoutes = operationsRouter("kon-agents", agentOperations, {
  auth: { requireAuth, optionalAuth },
} as never);
