/**
 * Versioned agents: definition, version, trigger and run as separate records
 * ============================================================================
 *
 *   definition  `agent_identities` (system prompt, allowed tools, capabilities,
 *               type, scopes, MCP settings): what an admin edits. Scopes and
 *               MCP settings joined in migration 0074.
 *   version     `agent_versions`: one numbered row per DISTINCT definition.
 *               `kitsuden_agent_snapshot()` (migration 0066) decides whether a
 *               save made a new one (the hash changed) or not.
 *   trigger     what started a run: an action (`actions`, its execution in
 *               `action_executions`), the playground, MCP.
 *   run         `agent_traces`, with `agent_version_id`: a trigger on insert
 *               stamps the version that was current, whoever inserts the
 *               trace. If the definition changed through a path that did not
 *               snapshot it, the trigger does (`source = detected`).
 *
 * Restoring an old version writes its fields back to the agent and snapshots
 * again (`source = restore`): history only grows, and a run after the restore
 * points at the new row, which says which version it restored.
 *
 * The routes are in routes/agents-v1.ts (`/api/v1/agents/:id/versions`), admin
 * only; docs/agents/versions.md.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, agentVersions } from "../db/schema";
import { registerAgentAction } from "../services/agent-audit";

import { logger } from "./logger";

export type AgentVersion = typeof agentVersions.$inferSelect;
export type VersionSource = "create" | "update" | "restore" | "baseline" | "detected";

function firstValue(result: unknown): unknown {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows;
  const row = (rows?.[0] ?? null) as Record<string, unknown> | null;
  return row ? Object.values(row)[0] : null;
}

/**
 * The agent's current version, creating one if its definition changed. `null`
 * if the agent does not exist, or if the database has no migration 0066 yet
 * (then versions are simply not recorded: an update never fails for it).
 */
export async function snapshotAgent(
  agentId: string,
  p: { createdBy: string | null; source: VersionSource; note?: string | null }
): Promise<string | null> {
  try {
    const id = firstValue(
      await db.execute(
        sql`SELECT kitsuden_agent_snapshot(${agentId}, ${p.createdBy}, ${p.source}, ${p.note ?? null}) AS id`
      )
    );
    return typeof id === "string" ? id : null;
  } catch (err) {
    logger.warn({ err, agentId }, "[agent-versions] could not snapshot the agent");
    return null;
  }
}

/** The versions of an agent, newest first (without the prompt: the list is a summary). */
export async function listAgentVersions(agentId: string, limit = 100) {
  return db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      hash: agentVersions.hash,
      source: agentVersions.source,
      note: agentVersions.note,
      createdBy: agentVersions.createdBy,
      createdAt: agentVersions.createdAt,
      model: agentVersions.model,
      config: agentVersions.config,
      promptLength: sql<number>`coalesce(length(${agentVersions.systemPrompt}), 0)::int`,
    })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/** One version, complete. */
export async function agentVersion(agentId: string, version: number): Promise<AgentVersion | null> {
  if (!Number.isInteger(version) || version < 1) return null;
  const [v] = await db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)))
    .limit(1);
  return v ?? null;
}

/** The latest version of an agent (the one a run would record now). */
export async function latestAgentVersion(agentId: string): Promise<AgentVersion | null> {
  const [v] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .limit(1);
  return v ?? null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Writes an old version's definition back to the agent and records it as a
 * new version (`restore`). `null` if the agent or the version does not exist.
 */
export async function restoreAgentVersion(
  agentId: string,
  version: number,
  who: string
): Promise<{ restored: AgentVersion; current: AgentVersion } | null> {
  const old = await agentVersion(agentId, version);
  if (!old) return null;
  const config = (old.config ?? {}) as Record<string, unknown>;
  const updated = await db
    .update(agentIdentities)
    .set({
      systemPrompt: old.systemPrompt,
      allowedTools: texts(config.allowedTools),
      capabilities: texts(config.capabilities),
      ...(typeof config.type === "string" ? { type: config.type } : {}),
      // Recorded since migration 0074; an older version leaves today's as they are.
      ...(Array.isArray(config.scopes) ? { scopes: texts(config.scopes) } : {}),
      ...(isPlainObject(config.mcpSettings) ? { mcpSettings: config.mcpSettings } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentIdentities.id, agentId))
    .returning({ id: agentIdentities.id });
  if (updated.length === 0) return null;
  await snapshotAgent(agentId, {
    createdBy: who,
    source: "restore",
    note: `restored version ${old.version}`,
  });
  const current = await latestAgentVersion(agentId);
  if (!current) return null;
  await registerAgentAction({
    agentId,
    action: "agent_version_restored",
    resource: "agent_versions",
    resourceId: current.id,
    details: { by: who, restored: old.version, version: current.version },
    success: true,
  }).catch((err: unknown) => logger.warn({ err }, "[agent-versions] audit failed"));
  return { restored: old, current };
}
