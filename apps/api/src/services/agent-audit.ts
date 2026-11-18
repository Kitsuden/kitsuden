/**
 * Agent Audit Service
 *
 * Detailed log of all NHI agent actions
 *
 * Features:
 * - Asynchronous logging (does not block responses)
 * - Configurable retention
 * - Analytical queries
 * - Security alerts
 */

import { randomUUID } from "node:crypto";

import { eq, and, desc, gte, lte, sql, count } from "drizzle-orm";

import { db } from "../db";
import { agentAuditLogs, agentIdentities } from "../db/schema";
import {
  AUDIT_CHAIN_LOCK,
  GENESIS_HASH,
  auditChainHead,
  currentAuditKey,
  macOf,
  rowHash,
  storedInteger,
  storedText,
  toStoredJson,
  type AuditedFields,
} from "../lib/audit-chain";
import { logger } from "../lib/logger";

import {
  notifyAuthSuccess,
  notifyAuthFailure,
  notifyRateLimited,
  notifyPermissionDenied,
} from "./agent-webhooks";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type AuditAction =
  | "auth_success"
  | "auth_failure"
  | "mcp_connect"
  | "mcp_disconnect"
  | "tool_call"
  | "data_read"
  | "data_write"
  | "data_delete"
  | "permission_denied"
  | "rate_limited"
  /** An admin changed the agent's scopes, keys or quotas. */
  | "config_change"
  /** See lib/approvals.ts. */
  | "approval_settings_changed"
  | "approval_mode_changed"
  /** Unattended runs: a held write refused with an alternative, and its setting. */
  | "unattended_denied"
  | "unattended_setting_changed"
  /** An admin restored an earlier version of the agent's definition. */
  | "agent_version_restored"
  | "proposal_created"
  | "proposal_approved"
  | "proposal_rejected"
  | "proposal_executed"
  | "proposal_failed"
  | "proposal_expired"
  /** An approved proposal NOT executed: its row or approval no longer matched (lib/operation-hash.ts). */
  | "proposal_integrity_failed"
  /** Agent data ledger (lib/ledger.ts): a later review of a decided proposal. */
  | "proposal_review_scheduled"
  | "proposal_review_due"
  | "proposal_review_done"
  /** A job queued by the agent found its daily budget spent (lib/queue.ts). */
  | "job_budget_exhausted"
  /** See lib/promotion.ts and docs/agents/promotion.md. */
  | "promotion_submitted"
  | "promotion_activated"
  | "promotion_activation_blocked"
  | "promotion_activation_failed"
  | "promotion_rejected"
  | "promotion_rolled_back"
  | "promotion_manual_edit"
  | "promotion_watch_passed"
  | "promotion_settings_changed"
  | "promotion_mode_changed"
  /** An execution tried to send customer data to a host not allowed for it (lib/customer-data.ts). */
  | "customer_data_blocked"
  /** External MCP servers: a person approved a tool's fingerprint (lib/external-mcp.ts). */
  | "external_mcp_tool_approved"
  /** An agent called an approved external MCP tool (lib/external-mcp-bridge.ts). */
  | "external_mcp_tool_called"
  /** At call time the tool no longer matched its approved fingerprint: back to review. */
  | "external_mcp_tool_changed"
  /** An agent exchanged its key for a short-lived token (routes/agent-token.ts). */
  | "short_token_issued"
  /** A run's credential was refused before a tool call (services/agent-short-tokens.ts). */
  | "run_credential_refused";

export interface AuditLogEntry {
  /**
   * `null` when it is not known which agent it is: a failed authentication with a
   * key that does not exist, is malformed or belongs to a deleted agent. Before, the
   * string "unknown" was written, which violates the FK to `agent_identities` (23503): the
   * INSERT failed, "Failed to write agent audit log" was logged and the attempt
   * —precisely the one most worth auditing— was not recorded. Since
   * migration 0044 the column allows NULL.
   */
  agentId: string | null;
  keyId?: string;
  action: AuditAction;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
}

export interface AuditQueryFilters {
  agentId?: string;
  action?: AuditAction;
  resource?: string;
  success?: boolean;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════

// The log is a hash chain (migration 0088, lib/audit-chain.ts,
// docs/agents/audit-chain.md). Each row's seq, prev_hash, row_hash and MAC
// depend on the row before it, so rows are appended by ONE writer at a time:
// calls are queued here and written in batches, one transaction per batch
// under the chain's advisory lock (which also orders several API processes).
// `logAgentAction` still returns at once; the request never waits for the lock.

interface PendingAudit {
  entry: AuditLogEntry;
  createdAt: Date;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const pendingAudit: PendingAudit[] = [];
let auditFlush: Promise<void> | null = null;
/** Rows per INSERT. A burst larger than this is written in several transactions. */
const AUDIT_BATCH = 200;

function enqueueAudit(entry: AuditLogEntry, createdAt: Date = new Date()): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingAudit.push({ entry, createdAt, resolve, reject });
    auditFlush ??= drainAudit();
  });
}

async function drainAudit(): Promise<void> {
  try {
    // One turn of the event loop: whatever is logged at the same time joins the batch.
    await new Promise<void>((r) => setImmediate(r));
    while (pendingAudit.length > 0) {
      await writeAuditBatch(pendingAudit.splice(0, AUDIT_BATCH));
    }
  } finally {
    auditFlush = null;
    if (pendingAudit.length > 0) auditFlush = drainAudit();
  }
}

/** Waits until every queued audit row is written (or failed). For tests and shutdown. */
export async function flushAgentAudit(): Promise<void> {
  while (auditFlush) await auditFlush;
}

/**
 * Appends entries with an explicit `createdAt` (tests, imports). The time is
 * part of the hashed row; normal callers use `logAgentAction`, which stamps now.
 */
export async function appendAuditEntries(
  entries: Array<AuditLogEntry & { createdAt?: Date }>
): Promise<void> {
  await Promise.all(entries.map((e) => enqueueAudit(e, e.createdAt ?? new Date())));
}

type PreparedRow = Omit<AuditedFields, "seq" | "prevHash">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsOfResult(r: unknown): Record<string, unknown>[] {
  return Array.isArray(r)
    ? (r as Record<string, unknown>[])
    : ((r as { rows?: Record<string, unknown>[] } | null)?.rows ?? []);
}

/**
 * user → agent → approval → resource: a `proposal_*` row gets, under
 * `details.approvalContext`, what the proposal row says about who asked and who
 * decided: its id, the operation hash (if that column exists), the approver,
 * the sponsor and the key it was proposed with. One read by primary key,
 * outside the chain lock; if it fails the row is written without it.
 */
async function withApprovalContext(
  details: Record<string, unknown>,
  proposalId: string
): Promise<Record<string, unknown>> {
  if (!UUID.test(proposalId) || "approvalContext" in details) return details;
  try {
    const [p] = rowsOfResult(
      await db.execute(
        sql`SELECT p.id, p.key_id, p.decided_by, p.sponsor_user_id, p.operation_key, p.status,
                   to_jsonb(p) ->> 'operation_hash' AS operation_hash
              FROM agent_proposals p WHERE p.id = ${proposalId}::uuid LIMIT 1`
      )
    );
    if (!p) return details;
    const context: Record<string, unknown> = { proposalId: String(p.id) };
    const add = (k: string, v: unknown) => {
      if (v !== null && v !== undefined && v !== "") context[k] = String(v);
    };
    add("operationHash", p.operation_hash);
    add("operationKey", p.operation_key);
    add("decidedBy", p.decided_by);
    add("sponsorUserId", p.sponsor_user_id);
    add("proposalKeyId", p.key_id);
    add("status", p.status);
    return { ...details, approvalContext: context };
  } catch {
    return details;
  }
}

async function prepareAudit(p: PendingAudit): Promise<PreparedRow> {
  const e = p.entry;
  let details = toStoredJson(e.details);
  if (typeof e.action === "string" && e.action.startsWith("proposal_") && e.resourceId) {
    details = toStoredJson(await withApprovalContext(details, e.resourceId));
  }
  return {
    id: randomUUID(),
    createdAt: p.createdAt,
    agentId: storedText(e.agentId),
    keyId: storedText(e.keyId),
    action: storedText(e.action) ?? "",
    resource: storedText(e.resource),
    resourceId: storedText(e.resourceId),
    details,
    ipAddress: storedText(e.ipAddress),
    userAgent: storedText(e.userAgent),
    durationMs: storedInteger(e.durationMs),
    success: e.success !== false,
    errorMessage: storedText(e.errorMessage),
  };
}

/** pg-mem (the in-memory test database) has no advisory locks nor the 0088 objects. */
async function onPgMem(): Promise<boolean> {
  try {
    const mod = (await import("../db")) as { isPgMem?: boolean };
    return mod.isPgMem === true;
  } catch {
    return false;
  }
}

/** Appends `rows` after the current head, in one transaction under the chain lock. */
async function appendChained(rows: PreparedRow[]): Promise<void> {
  const key = currentAuditKey();
  const pgMem = await onPgMem();
  await db.transaction(async (tx) => {
    if (!pgMem) await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`));
    const [last] = rowsOfResult(
      await tx.execute(
        sql`SELECT seq, row_hash FROM agent_audit_logs WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1`
      )
    );
    let seq = last ? Number(last.seq) : 0;
    let prev = last ? String(last.row_hash) : GENESIS_HASH;
    if (!pgMem) {
      const [cp] = rowsOfResult(
        await tx.execute(
          sql`SELECT seq, row_hash FROM agent_audit_checkpoints ORDER BY seq DESC LIMIT 1`
        )
      );
      if (cp && Number(cp.seq) > seq) {
        seq = Number(cp.seq);
        prev = String(cp.row_hash);
      }
    }
    const values = rows.map((r) => {
      seq += 1;
      const fields: AuditedFields = { ...r, seq, prevHash: prev };
      const hash = rowHash(fields);
      prev = hash;
      return { ...fields, rowHash: hash, mac: macOf(key.key, hash), keyVersion: key.version };
    });
    await tx.insert(agentAuditLogs).values(values);
  });
}

async function writeAuditBatch(batch: PendingAudit[]): Promise<void> {
  const prepared = await Promise.all(batch.map(prepareAudit));
  try {
    await appendChained(prepared);
    for (const p of batch) p.resolve();
  } catch (err) {
    if (batch.length === 1) {
      batch[0]!.reject(err);
      return;
    }
    // One bad entry must not sink the others: one by one.
    for (let i = 0; i < batch.length; i++) {
      try {
        await appendChained([prepared[i]!]);
        batch[i]!.resolve();
      } catch (e) {
        batch[i]!.reject(e);
      }
    }
  }
}

/** The fields of an audit entry that are safe to put in the process log. */
function entrySummary(entry: AuditLogEntry) {
  return {
    agentId: entry.agentId,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    success: entry.success,
  };
}

/**
 * Records an agent action in the audit log
 * Runs asynchronously so as not to block the response
 */
export function logAgentAction(entry: AuditLogEntry): void {
  enqueueAudit(entry).catch((error) => {
    // Log the error but do not fail the main operation. Only what identifies the
    // lost row: not the key id, the details or the client (CodeQL js/clear-text-logging).
    logger.error({ error, entry: entrySummary(entry) }, "Failed to write agent audit log");
  });
}

/**
 * Same as `logAgentAction`, but WAITS until it is written. For what
 * cannot be lost silently (who turned approval on, who
 * approved or rejected): if the INSERT fails, it throws.
 */
export async function registerAgentAction(entry: AuditLogEntry): Promise<void> {
  await enqueueAudit(entry);
}

/**
 * Helper to log a successful authentication
 */
export function logAuthSuccess(
  agentId: string,
  keyId: string,
  ipAddress?: string,
  userAgent?: string
): void {
  logAgentAction({
    agentId,
    keyId,
    action: "auth_success",
    ipAddress,
    userAgent,
    success: true,
  });

  // Notify webhook
  notifyAuthSuccess(agentId, "", { ipAddress, userAgent });
}

/**
 * Helper to log an authentication failure.
 *
 * `agentId` is `null` if the attempt does not correspond to an existing agent.
 * Whatever is known about the key that was tried (its public id, never the secret)
 * goes in `details`.
 */
export function logAuthFailure(
  agentId: string | null,
  errorMessage: string,
  ipAddress?: string,
  userAgent?: string,
  details?: Record<string, unknown>
): void {
  logAgentAction({
    agentId,
    action: "auth_failure",
    details,
    ipAddress,
    userAgent,
    success: false,
    errorMessage,
  });

  // Notify webhook (its contract asks for a text id)
  notifyAuthFailure(agentId ?? "unknown", "", errorMessage, { ipAddress, userAgent });
}

/**
 * Helper to log a tool call
 */
export function logToolCall(
  agentId: string,
  keyId: string,
  toolName: string,
  /** The argument NAMES; never their values. */
  args: string[],
  durationMs: number,
  success: boolean,
  error?: string
): void {
  logAgentAction({
    agentId,
    keyId,
    action: "tool_call",
    resource: toolName,
    details: { args },
    durationMs,
    success,
    errorMessage: error,
  });
}

/**
 * Helper to log denied access
 */
export function logPermissionDenied(
  agentId: string,
  keyId: string,
  resource: string,
  requiredScope: string,
  ipAddress?: string
): void {
  logAgentAction({
    agentId,
    keyId,
    action: "permission_denied",
    resource,
    details: { requiredScope },
    ipAddress,
    success: false,
    errorMessage: `Missing required scope: ${requiredScope}`,
  });

  // Notify webhook
  notifyPermissionDenied(agentId, "", resource, requiredScope, { ipAddress });
}

/**
 * Helper to log a rate limit
 */
export function logRateLimited(agentId: string, limit: number, ipAddress?: string): void {
  logAgentAction({
    agentId,
    action: "rate_limited",
    details: { limit, window: "1m" },
    ipAddress,
    success: false,
    errorMessage: `Rate limit exceeded: ${limit} requests per minute`,
  });

  // Notify webhook
  notifyRateLimited(agentId, "", limit, { ipAddress });
}

// ═══════════════════════════════════════════════════════════════════════════
// QUERIES AND ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets audit logs with filters
 */
export async function queryAuditLogs(filters: AuditQueryFilters = {}) {
  const {
    agentId,
    action,
    resource,
    success,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
  } = filters;

  // Build where conditions array
  const whereConditions = [];

  if (agentId) {
    whereConditions.push(eq(agentAuditLogs.agentId, agentId));
  }
  if (action) {
    whereConditions.push(eq(agentAuditLogs.action, action));
  }
  if (resource) {
    whereConditions.push(eq(agentAuditLogs.resource, resource));
  }
  if (success !== undefined) {
    whereConditions.push(eq(agentAuditLogs.success, success));
  }
  if (startDate) {
    whereConditions.push(gte(agentAuditLogs.createdAt, startDate));
  }
  if (endDate) {
    whereConditions.push(lte(agentAuditLogs.createdAt, endDate));
  }

  // Build base query with conditions
  const baseQuery = db
    .select({
      log: agentAuditLogs,
      agentName: agentIdentities.name,
    })
    .from(agentAuditLogs)
    .leftJoin(agentIdentities, eq(agentAuditLogs.agentId, agentIdentities.id))
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined);

  // Count total (with same conditions)
  const countResult = await db
    .select({ count: count() })
    .from(agentAuditLogs)
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined);

  const total = countResult[0]?.count || 0;

  // Get paginated results
  const results = await baseQuery
    .orderBy(desc(agentAuditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    logs: results.map((r) => ({
      ...r.log,
      agentName: r.agentName,
    })),
    total,
    limit,
    offset,
  };
}

/**
 * Gets an agent's usage statistics
 */
export async function getAgentStats(agentId: string, days = 7) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const logs = await db
    .select({
      action: agentAuditLogs.action,
      success: agentAuditLogs.success,
      count: count(),
    })
    .from(agentAuditLogs)
    .where(and(eq(agentAuditLogs.agentId, agentId), gte(agentAuditLogs.createdAt, startDate)))
    .groupBy(agentAuditLogs.action, agentAuditLogs.success);

  const totalCalls = logs.reduce((sum, log) => sum + Number(log.count), 0);
  const successfulCalls = logs
    .filter((log) => log.success)
    .reduce((sum, log) => sum + Number(log.count), 0);
  const failedCalls = totalCalls - successfulCalls;

  // Group by action
  const actionsByType = logs.reduce(
    (acc, log) => {
      const key = log.action;
      if (!acc[key]) acc[key] = { count: 0, success: 0, failed: 0 };
      acc[key].count += Number(log.count);
      if (log.success) {
        acc[key].success += Number(log.count);
      } else {
        acc[key].failed += Number(log.count);
      }
      return acc;
    },
    {} as Record<string, { count: number; success: number; failed: number }>
  );

  return {
    period: `${days}d`,
    totalCalls,
    successfulCalls,
    failedCalls,
    successRate: totalCalls > 0 ? ((successfulCalls / totalCalls) * 100).toFixed(2) + "%" : "0%",
    actionsByType,
  };
}

/**
 * Detects suspicious activity
 */
export async function detectSuspiciousActivity(hours = 24) {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  // Multiple authentication failures
  const authFailures = await db
    .select({
      agentId: agentAuditLogs.agentId,
      count: count(),
    })
    .from(agentAuditLogs)
    .where(and(eq(agentAuditLogs.action, "auth_failure"), gte(agentAuditLogs.createdAt, since)))
    .groupBy(agentAuditLogs.agentId)
    .having(sql`count(*) >= 5`);

  // Multiple rate limits
  const rateLimits = await db
    .select({
      agentId: agentAuditLogs.agentId,
      count: count(),
    })
    .from(agentAuditLogs)
    .where(and(eq(agentAuditLogs.action, "rate_limited"), gte(agentAuditLogs.createdAt, since)))
    .groupBy(agentAuditLogs.agentId)
    .having(sql`count(*) >= 3`);

  // Denied accesses
  const permissionDenials = await db
    .select({
      agentId: agentAuditLogs.agentId,
      count: count(),
    })
    .from(agentAuditLogs)
    .where(
      and(eq(agentAuditLogs.action, "permission_denied"), gte(agentAuditLogs.createdAt, since))
    )
    .groupBy(agentAuditLogs.agentId)
    .having(sql`count(*) >= 5`);

  return {
    authFailures: authFailures.map((r) => ({
      agentId: r.agentId,
      count: Number(r.count),
      severity: Number(r.count) > 10 ? "high" : "medium",
    })),
    rateLimits: rateLimits.map((r) => ({
      agentId: r.agentId,
      count: Number(r.count),
      severity: Number(r.count) > 5 ? "high" : "low",
    })),
    permissionDenials: permissionDenials.map((r) => ({
      agentId: r.agentId,
      count: Number(r.count),
      severity: Number(r.count) > 10 ? "high" : "medium",
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════

/** Days an agent audit row is kept when `AGENT_AUDIT_RETENTION_DAYS` does not say. */
export const DEFAULT_AGENT_AUDIT_RETENTION_DAYS = 90;

/**
 * Days `agent_audit_logs` rows are kept: `AGENT_AUDIT_RETENTION_DAYS`. Unset,
 * empty or not a number = 90; `0` = kept forever (the convention of
 * `AGENT_KEY_DEFAULT_EXPIRY_DAYS`). Returns `null` for "forever".
 */
export function agentAuditRetentionDays(
  env: Record<string, string | undefined> = process.env
): number | null {
  const raw = env.AGENT_AUDIT_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_AUDIT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AGENT_AUDIT_RETENTION_DAYS;
  if (n === 0) return null;
  return Math.max(1, Math.floor(n));
}

/**
 * The hourly prune: deletes the rows older than `agentAuditRetentionDays()`.
 * On the global connection (the system). Never throws.
 */
export async function sweepAgentAuditLogs(
  env: Record<string, string | undefined> = process.env
): Promise<number> {
  const days = agentAuditRetentionDays(env);
  if (days === null) return 0;
  try {
    return await cleanupOldLogs(days);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Agent audit prune failed"
    );
    return 0;
  }
}

let auditSweep: ReturnType<typeof setInterval> | null = null;

let headLog: ReturnType<typeof setInterval> | null = null;

/**
 * Prunes once at start and then every hour (the OAuth and proposal sweeps'
 * pattern), and prints the chain head at start and once a day.
 */
export function startAgentAuditSweep(): void {
  if (auditSweep) return;
  const sweep = () => {
    void sweepAgentAuditLogs();
    // Expired short-lived and run credentials (services/agent-short-tokens.ts).
    void import("./agent-short-tokens").then((m) => m.sweepShortTokens()).catch(() => {});
  };
  auditSweep = setInterval(sweep, 60 * 60_000);
  (auditSweep as { unref?: () => void }).unref?.();
  sweep();
  headLog = setInterval(() => void logAuditChainHead(), 24 * 60 * 60_000);
  (headLog as { unref?: () => void }).unref?.();
  void logAuditChainHead();
}

/**
 * Deletes the audit rows older than `retentionDays` (run hourly by
 * `startAgentAuditSweep`). The log is append-only (0088): the only way to
 * remove rows is `kitsuden_audit_prune()`, which drops a PREFIX of the chain
 * and records a checkpoint first, so what remains still verifies. The cutoff
 * must be at least a day old.
 */
export async function cleanupOldLogs(retentionDays = 90): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - Math.max(1, retentionDays));

  const result = await db.execute(
    sql`SELECT rows_pruned, legacy_rows_pruned, checkpoint_seq
          FROM kitsuden_audit_prune(${cutoffDate.toISOString()}::timestamptz)`
  );
  const [row] = rowsOfResult(result);
  const deleted = Number(row?.rows_pruned ?? 0) + Number(row?.legacy_rows_pruned ?? 0);
  if (deleted > 0) {
    logger.info(
      { deleted, retentionDays, checkpointSeq: row?.checkpoint_seq ?? null },
      "Cleaned up old agent audit logs"
    );
  }

  return deleted;
}

/**
 * Prints the chain head (seq, row_hash) in the log, at start and once a day:
 * an operator who ships logs elsewhere gets an external anchor for free. See
 * docs/agents/audit-chain.md ("Anchoring the head").
 */
export async function logAuditChainHead(): Promise<void> {
  try {
    const head = await auditChainHead();
    if (head) {
      logger.info(
        { auditChainHead: { seq: head.seq, rowHash: head.rowHash, at: head.createdAt } },
        "Agent audit chain head (anchor it outside the database)"
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not read the agent audit chain head"
    );
  }
}
