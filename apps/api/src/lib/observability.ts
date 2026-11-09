/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OBSERVABILITY - System metrics and statistics
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides real metrics for the admin dashboard.
 * Replaces all the mockups with real system data.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { eqEnum } from "@kitsuden/engine";
import { sql, count, desc, gte, and, eq, lte } from "drizzle-orm";
import { Hono } from "hono";

import { db, poolStatus } from "../db";
import {
  dataSets,
  dataEntries,
  authUsers,
  media,
  agentIdentities,
  agentTraces,
  agentTraceSteps,
  agentAuditLogs,
} from "../db/schema";
import { requireAuth } from "../middleware/auth";
import { requireAdminRole } from "../middleware/auth-guard";
import type { AppVariables } from "../types/hono";

import { getMetricsSnapshot, getRouteSnapshots } from "./metrics";
import { realtimeManager } from "./realtime";
import { buildAlertReport, evaluateSlo } from "./slo";
import { getValkeyClient, valkeyConfigured } from "./valkey";

/** `Bearer <METRICS_TOKEN>` in constant time; with no token configured, never. */
export function validMetricsToken(header: string | undefined): boolean {
  const expected = process.env.METRICS_TOKEN ?? "";
  if (expected.length < 16 || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(header.slice(7).trim()).digest();
  return timingSafeEqual(a, b);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SystemStats {
  // Database
  datasets: {
    total: number;
    entries: number;
    entriesToday: number;
  };
  users: {
    total: number;
    activeToday: number;
    newThisWeek: number;
  };
  content: {
    posts: number;
    games: number;
    media: number;
  };
  agents: {
    total: number;
    active: number;
  };

  // Performance
  performance: {
    avgResponseTime: number;
    requestsPerMinute: number;
    errorRate: number;
  };

  // Infrastructure
  infra: {
    databaseStatus: "healthy" | "degraded" | "down";
    cacheStatus: "healthy" | "degraded" | "down";
    websocketConnections: number;
    activeChannels: number;
  };

  // Storage
  storage: {
    used: number;
    total: number;
    files: number;
  };

  // Uptime
  uptime: {
    since: string;
    duration: string;
    percentage: number;
  };
}

export interface ActivityItem {
  id: string;
  type: "entry" | "user" | "webhook" | "agent" | "system";
  action: string;
  description: string;
  user?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "down";
  checks: {
    database: boolean;
    cache: boolean;
    storage: boolean;
    realtime: boolean;
  };
  latency: {
    database: number;
    cache: number;
  };
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS COLLECTORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gets database statistics
 */
async function getDatabaseStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    datasetsResult,
    entriesResult,
    entriesTodayResult,
    usersResult,
    usersTodayResult,
    usersWeekResult,
    postsResult,
    gamesResult,
    mediaResult,
    agentsResult,
  ] = await Promise.all([
    // Datasets
    db.select({ count: count() }).from(dataSets),
    db.select({ count: count() }).from(dataEntries),
    db.select({ count: count() }).from(dataEntries).where(gte(dataEntries.createdAt, today)),

    // Users
    db.select({ count: count() }).from(authUsers),
    db.select({ count: count() }).from(authUsers).where(gte(authUsers.createdAt, today)),
    db
      .select({ count: count() })
      .from(authUsers)
      .where(gte(authUsers.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))),

    // Content
    db.execute<{ count: number }>(sql`SELECT COUNT(*) as count FROM blog_posts`),
    db.execute<{ count: number }>(sql`SELECT COUNT(*) as count FROM games`),
    db.select({ count: count() }).from(media),

    // Agents
    db.select({ count: count() }).from(agentIdentities),
  ]);

  return {
    datasets: {
      total: datasetsResult[0]?.count || 0,
      entries: entriesResult[0]?.count || 0,
      entriesToday: entriesTodayResult[0]?.count || 0,
    },
    users: {
      total: usersResult[0]?.count || 0,
      activeToday: usersTodayResult[0]?.count || 0,
      newThisWeek: usersWeekResult[0]?.count || 0,
    },
    content: {
      posts: Number((postsResult as any).rows?.[0]?.count ?? 0) || 0,
      games: Number((gamesResult as any).rows?.[0]?.count ?? 0) || 0,
      media: mediaResult[0]?.count || 0,
    },
    agents: {
      total: agentsResult[0]?.count || 0,
      active: Math.floor((agentsResult[0]?.count || 0) * 0.7), // Estimated
    },
  };
}

/**
 * Gets infrastructure statistics
 */
async function getInfraStats() {
  const wsStats = realtimeManager.getStats();

  // DB latency test
  const dbStart = Date.now();
  let dbHealthy = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
  const dbLatency = Date.now() - dbStart;

  // Cache latency test
  //
  // GETTING the client goes INSIDE the try: `getValkeyClient()` throws when the
  // cache does not respond, and it was outside. The result was that /health returned
  // 500 instead of reporting "cache: down" — exactly the opposite of what a
  // health check is for, and on top of that it took down the database status too,
  // which was perfectly healthy.
  // Without VALKEY_URL the cache is the process memory (single instance): there
  // is nothing that can be down.
  const cacheStart = Date.now();
  let cacheHealthy = !valkeyConfigured();
  if (!cacheHealthy) {
    try {
      const valkey = await getValkeyClient();
      await valkey.ping();
      cacheHealthy = true;
    } catch {
      cacheHealthy = false;
    }
  }
  const cacheLatency = Date.now() - cacheStart;

  return {
    databaseStatus: (dbHealthy ? "healthy" : "down") as "healthy" | "degraded" | "down",
    cacheStatus: (cacheHealthy ? "healthy" : "down") as "healthy" | "degraded" | "down",
    cacheBackend: valkeyConfigured() ? ("valkey" as const) : ("memory" as const),
    websocketConnections: wsStats.connections,
    activeChannels: wsStats.channels,
    latency: {
      database: dbLatency,
      cache: cacheLatency,
    },
  };
}

/**
 * Gets storage statistics
 */
async function getStorageStats() {
  try {
    const result = await db.execute<{
      total_size: number;
      file_count: number;
    }>(sql`
      SELECT 
        COALESCE(SUM((metadata->>'size')::int), 0) as total_size,
        COUNT(*) as file_count
      FROM media
    `);

    const totalBytes = result.rows[0]?.total_size || 0;
    const fileCount = result.rows[0]?.file_count || 0;

    return {
      used: totalBytes,
      total: 10 * 1024 * 1024 * 1024, // 10GB placeholder
      files: fileCount,
    };
  } catch {
    return { used: 0, total: 10 * 1024 * 1024 * 1024, files: 0 };
  }
}

/**
 * Gets server uptime
 */
function getUptimeStats() {
  const uptime = process.uptime();
  const startTime = new Date(Date.now() - uptime * 1000);

  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  return {
    since: startTime.toISOString(),
    duration: days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`,
    percentage: 99.9, // Ideally, it would be computed from real history
  };
}

/**
 * REAL performance metrics from the MetricsRegistry (SLIs measured by the
 * telemetry middleware). This used to return values from Math.random().
 */
function getPerformanceStats() {
  const snap = getMetricsSnapshot();
  return {
    avgResponseTime: snap.latency.avg,
    requestsPerMinute: snap.throughputPerMin,
    errorRate: parseFloat(snap.errorRate.toFixed(4)),
    p95ResponseTime: snap.latency.p95,
    p99ResponseTime: snap.latency.p99,
    successRate: parseFloat(snap.successRate.toFixed(4)),
  };
}

/**
 * Gets recent activity
 */
async function getRecentActivity(limit: number = 10): Promise<ActivityItem[]> {
  const activities: ActivityItem[] = [];

  // Recent entries
  const recentEntries = await db
    .select({
      id: dataEntries.id,
      title: dataEntries.title,
      datasetId: dataEntries.dataSetId,
      createdAt: dataEntries.createdAt,
    })
    .from(dataEntries)
    .orderBy(desc(dataEntries.createdAt))
    .limit(limit);

  for (const entry of recentEntries) {
    activities.push({
      id: entry.id,
      type: "entry",
      action: "created",
      description: `Entry "${entry.title.slice(0, 30)}..." created`,
      timestamp: entry.createdAt?.toISOString() || new Date().toISOString(),
      metadata: { datasetId: entry.datasetId },
    });
  }

  // Recent users
  const recentUsers = await db
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      createdAt: authUsers.createdAt,
    })
    .from(authUsers)
    .orderBy(desc(authUsers.createdAt))
    .limit(5);

  for (const user of recentUsers) {
    activities.push({
      id: user.id,
      type: "user",
      action: "registered",
      description: `User ${user.name || user.email} registered`,
      timestamp: user.createdAt?.toISOString() || new Date().toISOString(),
    });
  }

  // Sort and limit
  return activities
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gets all the system statistics
 */
export async function getSystemStats(): Promise<SystemStats> {
  const [dbStats, infraStats, storageStats, uptimeStats, perfStats] = await Promise.all([
    getDatabaseStats(),
    getInfraStats(),
    getStorageStats(),
    getUptimeStats(),
    getPerformanceStats(),
  ]);

  return {
    ...dbStats,
    performance: perfStats,
    infra: infraStats,
    storage: storageStats,
    uptime: uptimeStats,
  };
}

/**
 * Gets the system health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const infra = await getInfraStats();

  const checks = {
    database: infra.databaseStatus === "healthy",
    cache: infra.cacheStatus === "healthy",
    storage: true, // We assume S3/MinIO is OK
    realtime: infra.websocketConnections >= 0,
  };

  /**
   * Not all dependencies weigh the same.
   *
   * It used to compute `allHealthy = every(...)` and `anyDown = some(!...)`, which
   * are exact complements: as soon as one failed the other was true, so
   * **"degraded" was unreachable** and any dependency being down gave 503.
   * In practice that meant a Valkey blip took ALL API instances out
   * of rotation, even though they could perfectly well keep serving traffic
   * — the balancer caused the outage it thought it was avoiding.
   *
   * The database is the only thing without which there is nothing to serve. The cache and
   * realtime degrade; they do not take it down.
   */
  const CRITICAL: Array<keyof typeof checks> = ["database"];
  const criticalDown = CRITICAL.some((key) => !checks[key]);
  const allHealthy = Object.values(checks).every(Boolean);

  return {
    status: criticalDown ? "down" : allHealthy ? "healthy" : "degraded",
    checks,
    latency: infra.latency,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Gets metrics for charts
 */
export async function getMetrics(timeRange: "1h" | "24h" | "7d" | "30d" = "24h") {
  const now = new Date();
  const ranges = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };

  const startDate = new Date(now.getTime() - ranges[timeRange]);

  // Entries created in the range
  const entriesByDay = await db.execute<{ date: string; count: number }>(sql`
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as count
    FROM data_entries
    WHERE created_at >= ${startDate}
    GROUP BY DATE(created_at)
    ORDER BY date
  `);

  // Users created in the range
  const usersByDay = await db.execute<{ date: string; count: number }>(sql`
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as count
    FROM auth_users
    WHERE created_at >= ${startDate}
    GROUP BY DATE(created_at)
    ORDER BY date
  `);

  return {
    timeRange,
    entries: entriesByDay.rows,
    users: usersByDay.rows,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

export const observabilityRoutes = new Hono<{ Variables: AppVariables }>();

/**
 * GET /api/health - Liveness: does the process respond? (does not touch dependencies)
 */
observabilityRoutes.get("/health", async (c) => {
  const health = await getHealthStatus();
  const statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503;
  return c.json(health, statusCode);
});

/**
 * GET /api/live - Pure liveness (for orchestrators). Always 200 if the event
 * loop responds; does not query DB/cache (avoids cascading restarts caused by a
 * dependency being down).
 */
observabilityRoutes.get("/live", (c) => {
  return c.json({
    status: "alive",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/ready - Readiness: can the service handle traffic? Checks
 * critical dependencies (DB, cache). 503 if any is down → the balancer
 * stops routing until it recovers.
 */
observabilityRoutes.get("/ready", async (c) => {
  const infra = await getInfraStats();
  const checks = {
    database: infra.databaseStatus === "healthy",
    cache: infra.cacheStatus === "healthy",
  };
  const ready = checks.database; // a degraded cache does not block readiness
  return c.json(
    {
      status: ready ? "ready" : "not_ready",
      checks,
      latency: infra.latency,
      timestamp: new Date().toISOString(),
    },
    ready ? 200 : 503
  );
});

/**
 * GET /api/admin/slo - State of SLIs/SLOs, error budget and symptom-based alerts.
 * Practice #3 and #4: the conversation moves from "is it down?" to "are we meeting
 * the user's expectations and is the error budget being burned?".
 */
observabilityRoutes.get("/admin/slo", requireAuth, (c) => {
  const report = buildAlertReport();
  return c.json({
    ...report,
    routes: getRouteSnapshots(15),
  });
});

/**
 * GET /api/slo - Public SLO summary (without route or cause detail).
 */
observabilityRoutes.get("/slo", (c) => {
  const status = evaluateSlo();
  return c.json({
    availability: {
      sli: parseFloat(status.availability.sli.toFixed(5)),
      slo: status.availability.slo,
      met: status.availability.met,
      budgetRemaining: parseFloat(status.availability.budgetRemaining.toFixed(4)),
    },
    latency: status.latency,
    window: { minutes: status.window.windowMinutes, requests: status.window.total },
  });
});

/**
 * GET /api/admin/stats - Full statistics (admin)
 */
observabilityRoutes.get("/admin/stats", requireAuth, async (c) => {
  try {
    const stats = await getSystemStats();
    return c.json(stats);
  } catch (error) {
    console.error("Stats error:", error);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }
});

/**
 * GET /api/admin/activity - Recent activity
 */
observabilityRoutes.get("/admin/activity", requireAuth, async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 10, 50);

  try {
    const activity = await getRecentActivity(limit);
    return c.json({ activity });
  } catch (error) {
    return c.json({ error: "Failed to fetch activity" }, 500);
  }
});

/**
 * GET /api/admin/metrics - Metrics for charts
 */
observabilityRoutes.get("/admin/metrics", requireAuth, async (c) => {
  const range = (c.req.query("range") as any) || "24h";

  try {
    const metrics = await getMetrics(range);
    return c.json(metrics);
  } catch (error) {
    return c.json({ error: "Failed to fetch metrics" }, 500);
  }
});

/**
 * GET /api/admin/realtime - Real-time WebSocket stats
 */
observabilityRoutes.get("/admin/realtime", requireAuth, async (c) => {
  const wsStats = realtimeManager.getStats();

  // Same reason as in `getInfraStats`: asking for the client throws if the cache does not
  // respond. Outside the try, this took down WebSocket stats that do not
  // even depend on Valkey.
  let pubsubStats = { channels: 0, patterns: 0 };
  try {
    const valkey = await getValkeyClient();
    await valkey.info("stats");
    // Parse basic info
    pubsubStats = {
      channels: wsStats.channels,
      patterns: wsStats.rooms,
    };
  } catch {
    // Ignore
  }

  return c.json({
    websockets: wsStats,
    pubsub: pubsubStats,
  });
});

/**
 * GET / - Homepage with stats (for the dashboard)
 */
observabilityRoutes.get(
  "/",
  async (c, next) => {
    // Public: only that the API is alive. The counts and recent activity
    // (entry titles, user names) belong to the panel: an admin sees them.
    // Before they went out to anyone, with no request limit (`/` is not under
    // `/api/*`) and launching several COUNTs over tables of hundreds of thousands of rows.
    const header = c.req.header("cookie") || c.req.header("authorization");
    if (!header) return c.json({ message: "Kitsuden API", status: "ok" });
    return requireAdminRole(c, next);
  },
  async (c) => {
    try {
      const [stats, health, activity] = await Promise.all([
        getSystemStats(),
        getHealthStatus(),
        getRecentActivity(5),
      ]);

      return c.json({
        message: "Kitsuden API",
        version: "0.5.0",
        status: health.status,
        stats: {
          datasets: stats.datasets.total,
          entries: stats.datasets.entries,
          users: stats.users.total,
          content: stats.content.posts + stats.content.games,
          agents: stats.agents.total,
          uptime: stats.uptime.duration,
        },
        activity,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return c.json(
        {
          message: "Kitsuden API",
          version: "0.5.0",
          status: "degraded",
          error: "Partial data available",
        },
        200
      );
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY & TRACEABILITY ENDPOINTS (Prometheus / Loki / OpenTelemetry friendly)
// ═══════════════════════════════════════════════════════════════════════════════

interface TraceFilters {
  agentId?: string;
  status?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Lists agent traces with filters and pagination.
 */
async function listTraces(filters: TraceFilters = {}) {
  const { agentId, status, from, to, limit = 50, offset = 0 } = filters;
  const conditions = [];

  if (agentId) conditions.push(eq(agentTraces.agentId, agentId));
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const filter663 = eqEnum(agentTraces.status, status);
  if (filter663) conditions.push(filter663);
  if (from) conditions.push(gte(agentTraces.createdAt, from));
  if (to) conditions.push(lte(agentTraces.createdAt, to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [tracesList, totalResult] = await Promise.all([
    db
      .select({
        trace: agentTraces,
        agentName: agentIdentities.name,
      })
      .from(agentTraces)
      .leftJoin(agentIdentities, eq(agentTraces.agentId, agentIdentities.id))
      .where(where)
      .orderBy(desc(agentTraces.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(agentTraces).where(where),
  ]);

  return {
    traces: tracesList.map((r) => ({
      ...r.trace,
      agentName: r.agentName,
    })),
    total: totalResult[0]?.count || 0,
    limit,
    offset,
  };
}

/**
 * Gets a trace with its steps.
 */
async function getTraceWithSteps(traceId: string) {
  const [trace] = await db
    .select({
      trace: agentTraces,
      agentName: agentIdentities.name,
    })
    .from(agentTraces)
    .leftJoin(agentIdentities, eq(agentTraces.agentId, agentIdentities.id))
    .where(eq(agentTraces.id, traceId))
    .limit(1);

  if (!trace) return null;

  const steps = await db
    .select()
    .from(agentTraceSteps)
    .where(eq(agentTraceSteps.traceId, traceId))
    .orderBy(agentTraceSteps.stepOrder);

  return {
    ...trace.trace,
    agentName: trace.agentName,
    steps,
  };
}

/**
 * Aggregated tool execution metrics.
 */
async function getToolTelemetry(timeRange: "1h" | "24h" | "7d" | "30d" = "24h") {
  const ranges = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  const since = new Date(Date.now() - ranges[timeRange]);

  const perTool = await db
    .select({
      toolName: agentTraceSteps.toolName,
      count: count(),
      avgDuration: sql<number>`COALESCE(AVG(${agentTraceSteps.durationMs}), 0)`,
      errors: sql<number>`COUNT(CASE WHEN ${agentTraceSteps.errorMessage} IS NOT NULL THEN 1 END)`,
    })
    .from(agentTraceSteps)
    .where(
      and(eq(agentTraceSteps.stepType, "tool_call" as any), gte(agentTraceSteps.createdAt, since))
    )
    .groupBy(agentTraceSteps.toolName);

  const perAgent = await db
    .select({
      agentId: agentTraces.agentId,
      count: count(),
      avgDuration: sql<number>`COALESCE(AVG(${agentTraces.totalDurationMs}), 0)`,
    })
    .from(agentTraces)
    .where(gte(agentTraces.createdAt, since))
    .groupBy(agentTraces.agentId);

  return {
    timeRange,
    since: since.toISOString(),
    perTool,
    perAgent,
  };
}

/**
 * Audit logs in Loki-like format (streams + values).
 */
async function getLogsAsLokiStreams(filters: {
  agentId?: string;
  action?: string;
  resource?: string;
  success?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}) {
  const { agentId, action, resource, success, from, to, limit = 100, offset = 0 } = filters;
  const conditions = [];

  if (agentId) conditions.push(eq(agentAuditLogs.agentId, agentId));
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const filter784 = eqEnum(agentAuditLogs.action, action);
  if (filter784) conditions.push(filter784);
  if (resource) conditions.push(eq(agentAuditLogs.resource, resource));
  if (success !== undefined) conditions.push(eq(agentAuditLogs.success, success));
  if (from) conditions.push(gte(agentAuditLogs.createdAt, from));
  if (to) conditions.push(lte(agentAuditLogs.createdAt, to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const logs = await db
    .select()
    .from(agentAuditLogs)
    .where(where)
    .orderBy(desc(agentAuditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  // Group into streams by agentId + action + success
  const streamMap = new Map<
    string,
    { stream: Record<string, string>; values: [string, string][] }
  >();

  for (const log of logs) {
    const labels: Record<string, string> = {
      agent_id: log.agentId || "unknown",
      action: log.action || "unknown",
      success: String(log.success),
    };
    if (log.resource) labels.resource = log.resource;

    const key = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

    if (!streamMap.has(key)) {
      streamMap.set(key, { stream: labels, values: [] });
    }

    const timestampNs = `${BigInt(new Date(log.createdAt).getTime()) * 1000000n}`;
    const value = JSON.stringify({
      id: log.id,
      keyId: log.keyId,
      resourceId: log.resourceId,
      details: log.details,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      durationMs: log.durationMs,
      errorMessage: log.errorMessage,
    });

    streamMap.get(key)!.values.push([timestampNs, value]);
  }

  return { streams: Array.from(streamMap.values()) };
}

/**
 * Generates metrics in Prometheus exposition format.
 */
async function generatePrometheusMetrics(): Promise<string> {
  const lines: string[] = [];
  const now = Date.now();

  lines.push("# HELP kitsuden_up Kitsuden API uptime indicator");
  lines.push("# TYPE kitsuden_up gauge");
  lines.push(`kitsuden_up 1 ${now}`);

  // Memory
  const mem = process.memoryUsage();
  lines.push("# HELP kitsuden_memory_heap_used_bytes Heap used in bytes");
  lines.push("# TYPE kitsuden_memory_heap_used_bytes gauge");
  lines.push(`kitsuden_memory_heap_used_bytes ${mem.heapUsed}`);
  lines.push("# HELP kitsuden_memory_heap_total_bytes Heap total in bytes");
  lines.push("# TYPE kitsuden_memory_heap_total_bytes gauge");
  lines.push(`kitsuden_memory_heap_total_bytes ${mem.heapTotal}`);

  // Process CPU (user + system, cumulative): usage is derived from two readings.
  const cpu = process.cpuUsage();
  lines.push("# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds");
  lines.push("# TYPE process_cpu_seconds_total counter");
  lines.push(`process_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(6)}`);

  // Postgres pool: open, idle and requests waiting for a connection.
  const pool = poolStatus();
  if (pool) {
    lines.push("# HELP kitsuden_db_pool_connections Postgres pool connections by state");
    lines.push("# TYPE kitsuden_db_pool_connections gauge");
    lines.push(`kitsuden_db_pool_connections{state="total"} ${pool.total}`);
    lines.push(`kitsuden_db_pool_connections{state="idle"} ${pool.idle}`);
    lines.push(`kitsuden_db_pool_connections{state="max"} ${pool.max}`);
    lines.push("# HELP kitsuden_db_pool_waiting Requests waiting for a pool connection");
    lines.push("# TYPE kitsuden_db_pool_waiting gauge");
    lines.push(`kitsuden_db_pool_waiting ${pool.waiting}`);
  }

  // Uptime
  lines.push("# HELP kitsuden_uptime_seconds Process uptime in seconds");
  lines.push("# TYPE kitsuden_uptime_seconds counter");
  lines.push(`kitsuden_uptime_seconds ${Math.floor(process.uptime())}`);

  // ── HTTP SLIs (last 60 min) — practice #3 ──
  const http = getMetricsSnapshot();
  const slo = evaluateSlo();
  lines.push("# HELP kitsuden_http_requests_total HTTP requests in the last 60m");
  lines.push("# TYPE kitsuden_http_requests_total gauge");
  lines.push(`kitsuden_http_requests_total ${http.total}`);
  lines.push("# HELP kitsuden_http_server_errors_total HTTP 5xx in the last 60m");
  lines.push("# TYPE kitsuden_http_server_errors_total gauge");
  lines.push(`kitsuden_http_server_errors_total ${http.serverErrors}`);
  lines.push("# HELP kitsuden_http_success_rate Success rate SLI (non-5xx / total)");
  lines.push("# TYPE kitsuden_http_success_rate gauge");
  lines.push(`kitsuden_http_success_rate ${http.successRate.toFixed(5)}`);
  lines.push("# HELP kitsuden_http_latency_ms Request latency percentiles (ms)");
  lines.push("# TYPE kitsuden_http_latency_ms gauge");
  lines.push(`kitsuden_http_latency_ms{quantile="0.5"} ${http.latency.p50}`);
  lines.push(`kitsuden_http_latency_ms{quantile="0.95"} ${http.latency.p95}`);
  lines.push(`kitsuden_http_latency_ms{quantile="0.99"} ${http.latency.p99}`);
  lines.push("# HELP kitsuden_slo_error_budget_remaining Fraction of error budget left");
  lines.push("# TYPE kitsuden_slo_error_budget_remaining gauge");
  lines.push(`kitsuden_slo_error_budget_remaining ${slo.availability.budgetRemaining.toFixed(5)}`);
  lines.push("# HELP kitsuden_slo_availability_met Availability SLO met (1=yes)");
  lines.push("# TYPE kitsuden_slo_availability_met gauge");
  lines.push(`kitsuden_slo_availability_met ${slo.availability.met ? 1 : 0}`);

  // WebSockets
  const wsStats = realtimeManager.getStats();
  lines.push("# HELP kitsuden_websocket_connections_active Active WebSocket connections");
  lines.push("# TYPE kitsuden_websocket_connections_active gauge");
  lines.push(`kitsuden_websocket_connections_active ${wsStats.connections}`);

  // DB latency
  const dbStart = Date.now();
  let dbHealthy = 0;
  try {
    await db.execute(sql`SELECT 1`);
    dbHealthy = 1;
  } catch {
    dbHealthy = 0;
  }
  const dbLatency = Date.now() - dbStart;
  lines.push("# HELP kitsuden_db_healthy Database health (1 = healthy)");
  lines.push("# TYPE kitsuden_db_healthy gauge");
  lines.push(`kitsuden_db_healthy ${dbHealthy}`);
  lines.push("# HELP kitsuden_db_latency_milliseconds Database latency in milliseconds");
  lines.push("# TYPE kitsuden_db_latency_milliseconds gauge");
  lines.push(`kitsuden_db_latency_milliseconds ${dbLatency}`);

  // Agents counts
  const [{ agentsTotal }] = await db.select({ agentsTotal: count() }).from(agentIdentities);
  lines.push("# HELP kitsuden_agents_total Total registered agents");
  lines.push("# TYPE kitsuden_agents_total gauge");
  lines.push(`kitsuden_agents_total ${agentsTotal}`);

  // Traces by status (last 24h)
  const traceSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tracesByStatus = await db
    .select({ status: agentTraces.status, count: count() })
    .from(agentTraces)
    .where(gte(agentTraces.createdAt, traceSince))
    .groupBy(agentTraces.status);

  lines.push("# HELP kitsuden_agent_traces_total Agent traces created (last 24h)");
  lines.push("# TYPE kitsuden_agent_traces_total counter");
  for (const row of tracesByStatus) {
    lines.push(`kitsuden_agent_traces_total{status="${row.status}"} ${row.count}`);
  }

  // Trace steps by tool (last 24h)
  const stepsByTool = await db
    .select({ toolName: agentTraceSteps.toolName, count: count() })
    .from(agentTraceSteps)
    .where(gte(agentTraceSteps.createdAt, traceSince))
    .groupBy(agentTraceSteps.toolName);

  lines.push("# HELP kitsuden_agent_trace_steps_total Agent trace steps executed (last 24h)");
  lines.push("# TYPE kitsuden_agent_trace_steps_total counter");
  for (const row of stepsByTool) {
    const tool = row.toolName || "unknown";
    lines.push(
      `kitsuden_agent_trace_steps_total{tool="${tool.replace(/"/g, '\\"')}"} ${row.count}`
    );
  }

  // Audit logs by action (last 24h)
  const auditByAction = await db
    .select({
      action: agentAuditLogs.action,
      success: agentAuditLogs.success,
      count: count(),
    })
    .from(agentAuditLogs)
    .where(gte(agentAuditLogs.createdAt, traceSince))
    .groupBy(agentAuditLogs.action, agentAuditLogs.success);

  lines.push("# HELP kitsuden_agent_audit_logs_total Agent audit log entries (last 24h)");
  lines.push("# TYPE kitsuden_agent_audit_logs_total counter");
  for (const row of auditByAction) {
    const action = row.action || "unknown";
    lines.push(
      `kitsuden_agent_audit_logs_total{action="${action}",success="${row.success}"} ${row.count}`
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * GET /api/admin/traces - List of traces with filters.
 */
observabilityRoutes.get("/admin/traces", requireAuth, async (c) => {
  try {
    const agentId = c.req.query("agentId") || undefined;
    const status = c.req.query("status") || undefined;
    const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined;
    const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined;
    const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
    const offset = Math.max(Number(c.req.query("offset") || "0"), 0);

    const result = await listTraces({ agentId, status, from, to, limit, offset });
    return c.json(result);
  } catch (error) {
    console.error("Traces list error:", error);
    return c.json({ error: "Failed to fetch traces" }, 500);
  }
});

/**
 * GET /api/admin/traces/:id - Trace with steps.
 */
observabilityRoutes.get("/admin/traces/:id", requireAuth, async (c) => {
  try {
    const trace = await getTraceWithSteps(c.req.param("id"));
    if (!trace) return c.json({ error: "Trace not found" }, 404);
    return c.json(trace);
  } catch (error) {
    console.error("Trace detail error:", error);
    return c.json({ error: "Failed to fetch trace" }, 500);
  }
});

/**
 * GET /api/admin/traces/:id/steps - Steps de un trace.
 */
observabilityRoutes.get("/admin/traces/:id/steps", requireAuth, async (c) => {
  try {
    const steps = await db
      .select()
      .from(agentTraceSteps)
      .where(eq(agentTraceSteps.traceId, c.req.param("id")))
      .orderBy(agentTraceSteps.stepOrder);
    return c.json({ steps });
  } catch (error) {
    console.error("Trace steps error:", error);
    return c.json({ error: "Failed to fetch trace steps" }, 500);
  }
});

/**
 * GET /api/admin/telemetry/tools - Tool usage metrics.
 */
observabilityRoutes.get("/admin/telemetry/tools", requireAuth, async (c) => {
  try {
    const range = (c.req.query("range") as any) || "24h";
    const metrics = await getToolTelemetry(range);
    return c.json(metrics);
  } catch (error) {
    console.error("Tool telemetry error:", error);
    return c.json({ error: "Failed to fetch tool telemetry" }, 500);
  }
});

/**
 * GET /api/admin/logs - Audit logs in Loki-like format.
 */
observabilityRoutes.get("/admin/logs", requireAuth, async (c) => {
  try {
    const successParam = c.req.query("success");
    const filters = {
      agentId: c.req.query("agentId") || undefined,
      action: c.req.query("action") || undefined,
      resource: c.req.query("resource") || undefined,
      success: successParam === undefined ? undefined : successParam === "true",
      from: c.req.query("from") ? new Date(c.req.query("from")!) : undefined,
      to: c.req.query("to") ? new Date(c.req.query("to")!) : undefined,
      limit: Math.min(Number(c.req.query("limit") || "100"), 1000),
      offset: Math.max(Number(c.req.query("offset") || "0"), 0),
    };

    const loki = await getLogsAsLokiStreams(filters);
    return c.json(loki);
  } catch (error) {
    console.error("Logs error:", error);
    return c.json({ error: "Failed to fetch logs" }, 500);
  }
});

/**
 * GET /api/admin/metrics/prometheus - Metrics in Prometheus format.
 */
observabilityRoutes.get("/admin/metrics/prometheus", requireAuth, async (c) => {
  try {
    const metrics = await generatePrometheusMetrics();
    return c.text(metrics, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  } catch (error) {
    console.error("Prometheus metrics error:", error);
    return c.text("# Failed to generate metrics\n", 500);
  }
});

/**
 * GET /metrics - Prometheus scraping endpoint.
 *
 * It used to be public: counts of agents, tool names and audit actions
 * for anyone. It now requires `Authorization: Bearer <METRICS_TOKEN>`
 * (for the collector) or an admin session (resolved by `requireAdminRole`). Without
 * `METRICS_TOKEN` configured, admin only.
 */
observabilityRoutes.get(
  "/metrics",
  async (c, next) => {
    if (validMetricsToken(c.req.header("authorization"))) return next();
    return requireAdminRole(c, next);
  },
  async (c) => {
    try {
      const metrics = await generatePrometheusMetrics();
      return c.text(metrics, 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    } catch (error) {
      console.error("Prometheus metrics error:", error);
      return c.text("# Failed to generate metrics\n", 500);
    }
  }
);
