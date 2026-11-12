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

import { eq, and, desc, gte, lte, sql, count } from "drizzle-orm";

import { db } from "../db";
import { agentAuditLogs, agentIdentities } from "../db/schema";
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
  | "external_mcp_tool_changed";

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

/**
 * Records an agent action in the audit log
 * Runs asynchronously so as not to block the response
 */
export function logAgentAction(entry: AuditLogEntry): void {
  // Run in the background
  Promise.resolve().then(async () => {
    try {
      await db.insert(agentAuditLogs).values({
        agentId: entry.agentId,
        keyId: entry.keyId,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        details: entry.details || {},
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        durationMs: entry.durationMs,
        success: entry.success,
        errorMessage: entry.errorMessage,
      });
    } catch (error) {
      // Log the error but do not fail the main operation
      logger.error({ error, entry }, "Failed to write agent audit log");
    }
  });
}

/**
 * Same as `logAgentAction`, but WAITS until it is written. For what
 * cannot be lost silently (who turned approval on, who
 * approved or rejected): if the INSERT fails, it throws.
 */
export async function registerAgentAction(entry: AuditLogEntry): Promise<void> {
  await db.insert(agentAuditLogs).values({
    agentId: entry.agentId,
    keyId: entry.keyId,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    details: entry.details || {},
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    durationMs: entry.durationMs,
    success: entry.success,
    errorMessage: entry.errorMessage,
  });
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

/** Prunes once at start and then every hour (the OAuth and proposal sweeps' pattern). */
export function startAgentAuditSweep(): void {
  if (auditSweep) return;
  auditSweep = setInterval(() => void sweepAgentAuditLogs(), 60 * 60_000);
  (auditSweep as { unref?: () => void }).unref?.();
  void sweepAgentAuditLogs();
}

/**
 * Deletes the audit rows older than `retentionDays` (run hourly by
 * `startAgentAuditSweep`).
 */
export async function cleanupOldLogs(retentionDays = 90): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  const result = await db.delete(agentAuditLogs).where(lte(agentAuditLogs.createdAt, cutoffDate));

  const deleted = result.rowCount || 0;
  if (deleted > 0) logger.info({ deleted, retentionDays }, "Cleaned up old agent audit logs");

  return deleted;
}
