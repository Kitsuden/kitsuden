/**
 * External MCP servers: the scheduled refresh (docs/agents/external-mcp.md)
 * ============================================================================
 *
 * A tool that changes after review is already never called: every call
 * recomputes the fingerprint and refuses on a mismatch (external-mcp-bridge.ts).
 * What was missing is FINDING OUT. Until now a change was noticed only when a
 * person pressed "Read tools" or when an agent's call failed, so the first
 * anyone heard of a rewritten tool was a broken run.
 *
 * This reads every enabled server again on a schedule, exactly as the button
 * does (`refreshServer`): a tool that is new, changed or gone goes to
 * `needs_review`, and each one flagged for the first time is written to the
 * audit log (`external_mcp_tool_changed`, origin `sweep`) and to the log, so
 * the panel's "needs review" count and whoever watches the audit see it before
 * an agent trips over it.
 *
 * ── SEVERAL API PROCESSES ──────────────────────────────────────────────────
 *
 * Each process runs the timer, but a server is CLAIMED with one UPDATE that
 * only succeeds when its last refresh is older than the interval. Two
 * processes ticking together refresh each server once.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It approves nothing and calls no tool: it only reads `tools/list`, over the
 * same transport as the review (public addresses, origin pinned, 15 s).
 */

import { sql } from "drizzle-orm";

import { db } from "../db";
import { logAgentAction } from "../services/agent-audit";

import { refreshServer, type ToolChange } from "./external-mcp";
import { logger } from "./logger";

const DEFAULT_MINUTES = 360;
const MIN_MINUTES = 5;
/** How often the timer looks for servers that are due. */
const TICK_MS = 5 * 60_000;

/**
 * Minutes between refreshes of a server (`KITSUDEN_EXTERNAL_MCP_REFRESH_MINUTES`).
 * Default 360 (six hours); `0` switches the scheduled refresh off; anything
 * below 5 is raised to 5, so a typo cannot hammer someone else's server.
 */
export function externalMcpRefreshMinutes(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.KITSUDEN_EXTERNAL_MCP_REFRESH_MINUTES?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_MINUTES;
  if (minutes === 0) return 0;
  return Math.max(MIN_MINUTES, Math.floor(minutes));
}

function rows<T = Record<string, unknown>>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface SweptServer {
  serverId: string;
  ok: boolean;
  error?: string;
  /** Tools this pass sent to review that were not waiting for one already. */
  newlyFlagged: Array<{ name: string; change: ToolChange | null }>;
}

async function waitingForReview(serverId: string): Promise<Map<string, string | null>> {
  const found = rows<{ name: string; change: string | null }>(
    await db.execute(sql`
      SELECT name, change FROM external_mcp_tools
       WHERE server_id = ${serverId}::uuid AND status = 'needs_review'`)
  );
  return new Map(found.map((t) => [t.name, t.change]));
}

/**
 * Refreshes every enabled server whose last refresh is older than
 * `intervalMinutes`. Returns what it did, server by server. Never throws: one
 * server that fails must not stop the others.
 */
export async function sweepExternalMcpServers(
  intervalMinutes = externalMcpRefreshMinutes()
): Promise<SweptServer[]> {
  if (intervalMinutes <= 0) return [];
  const done: SweptServer[] = [];
  let claimed: Array<{ id: string }>;
  try {
    // The claim: moving `last_refreshed_at` forward is what stops a second process (or the next
    // tick) from taking the same server. `refreshServer` sets it again when it finishes.
    claimed = rows<{ id: string }>(
      await db.execute(sql`
        UPDATE external_mcp_servers
           SET last_refreshed_at = now()
         WHERE enabled
           AND (last_refreshed_at IS NULL
                OR last_refreshed_at < now() - make_interval(mins => ${intervalMinutes}))
        RETURNING id::text AS id`)
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[external-mcp] the scheduled refresh could not read the servers"
    );
    return [];
  }

  for (const { id } of claimed) {
    try {
      const before = await waitingForReview(id);
      const result = await refreshServer(id);
      if (!result) continue;
      // Only what this pass found: a tool already waiting for review, for the same reason, was
      // reported when it was first seen.
      const newlyFlagged = result.needsReview.filter(
        (t) => !before.has(t.name) || before.get(t.name) !== t.change
      );
      for (const tool of newlyFlagged) {
        logAgentAction({
          agentId: null,
          action: "external_mcp_tool_changed",
          resource: "external_mcp_tool",
          resourceId: id,
          details: { serverId: id, tool: tool.name, change: tool.change, origin: "sweep" },
          success: true,
        });
      }
      if (newlyFlagged.length > 0) {
        logger.warn(
          { serverId: id, server: result.server.name, tools: newlyFlagged },
          "[external-mcp] the scheduled refresh found tools that need review"
        );
      }
      done.push({ serverId: id, ok: result.ok, error: result.error, newlyFlagged });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ serverId: id, err: message }, "[external-mcp] the scheduled refresh failed");
      done.push({ serverId: id, ok: false, error: message, newlyFlagged: [] });
    }
  }
  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Looks every five minutes for servers that are due. Not started in tests
 * (they register servers on 127.0.0.1 and refresh them by hand; a timer
 * reading them in the middle would change what a test is asserting), nor when
 * `KITSUDEN_EXTERNAL_MCP_REFRESH_MINUTES=0`.
 */
export function startExternalMcpSweep(env: Record<string, string | undefined> = process.env): void {
  if (timer || env.NODE_ENV === "test" || externalMcpRefreshMinutes(env) <= 0) return;
  timer = setInterval(() => void sweepExternalMcpServers(), TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  void sweepExternalMcpServers();
}

/** Stops the timer (tests, shutdown). */
export function stopExternalMcpSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
