/**
 * Where the customer-data marks come from, and where blocks are recorded
 * ============================================================================
 *
 * The marks (lib/customer-data.ts) live in two places:
 *
 *   · dataset fields: `sensitivity` in `data_sets.schema` (Postgres);
 *   · kon columns: the `sensitivity` block of each installed kon's manifest.
 *
 * Both are read here and cached for a few seconds (and dropped when a dataset
 * changes), so an execution pays one lookup at most. Each block is written to
 * the agent audit log (`customer_data_blocked`) and to the log.
 */

import { konSensitivity, markedDatasetFields } from "@kitsuden/shared";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { logAgentAction } from "../services/agent-audit";

import {
  buildCatalog,
  customerDataHosts,
  MarkedValues,
  type CustomerDataGuard,
  type EgressBlock,
  type MarkedDataset,
  type MarkedKon,
  type SensitivityCatalog,
} from "./customer-data";
import { events } from "./events";
import { listInstalledKons } from "./installed-kons";
import { logger } from "./logger";

const TTL_MS = 15_000;
let cached: { at: number; catalog: SensitivityCatalog } | null = null;
let listening = false;

export function invalidateSensitivityCatalog(): void {
  cached = null;
}

function listen(): void {
  if (listening) return;
  listening = true;
  for (const name of ["dataset:created", "dataset:updated", "dataset:deleted"]) {
    events.on(name, invalidateSensitivityCatalog);
  }
}

function markedKons(): MarkedKon[] {
  const out: MarkedKon[] = [];
  for (const kon of listInstalledKons()) {
    const tables = konSensitivity(kon.manifest);
    if (Object.keys(tables).length) out.push({ id: kon.id, tables });
  }
  return out;
}

async function markedDatasets(): Promise<MarkedDataset[]> {
  // Only the schemas that mention the word: most installations have none.
  const r = await db.execute(
    sql`SELECT id::text AS id, slug, schema FROM data_sets WHERE schema::text LIKE '%"sensitivity"%'`
  );
  const rows = ((r as { rows?: unknown[] }).rows ?? r) as Array<{
    id: string;
    slug: string;
    schema: unknown;
  }>;
  return rows
    .map((row) => ({ id: row.id, slug: row.slug, fields: markedDatasetFields(row.schema) }))
    .filter((d) => Object.keys(d.fields).length > 0);
}

/** The current marks. Throws if the database cannot be read (callers fail closed). */
export async function loadSensitivityCatalog(): Promise<SensitivityCatalog> {
  listen();
  if (cached && Date.now() - cached.at < TTL_MS) return cached.catalog;
  const catalog = buildCatalog(await markedDatasets(), markedKons());
  cached = { at: Date.now(), catalog };
  return catalog;
}

/** Records a block: audit log (best effort) and a warning line. Values never appear. */
export function recordEgressBlock(block: EgressBlock): void {
  logger.warn(
    {
      channel: block.channel,
      decision: block.decision,
      host: block.host,
      fields: block.fields,
      where: block.where,
      actionId: block.actionId,
      executionId: block.executionId,
    },
    "[customer-data] egress blocked"
  );
  logAgentAction({
    agentId: block.agentId ?? null,
    action: "customer_data_blocked",
    resource: block.channel,
    resourceId: block.actionId ?? block.executionId,
    details: {
      decision: block.decision,
      host: block.host,
      fields: block.fields,
      where: block.where,
      executionId: block.executionId,
    },
    success: false,
    errorMessage: `${block.decision}: customer data to ${block.host}`,
  });
}

/**
 * The guard for one execution. If the marks cannot be read it is `strict`:
 * nothing goes to a host that is not allowed for customer data.
 */
export async function guardForExecution(input: {
  actionHosts?: unknown;
  actionId?: string;
  executionId?: string;
  agentId?: string | null;
}): Promise<CustomerDataGuard> {
  const allowedHosts = customerDataHosts(input.actionHosts);
  const onBlock = (b: EgressBlock) =>
    recordEgressBlock({
      ...b,
      actionId: b.actionId ?? input.actionId,
      executionId: b.executionId ?? input.executionId,
      agentId: b.agentId ?? input.agentId ?? null,
    });
  try {
    return { marked: new MarkedValues(await loadSensitivityCatalog()), allowedHosts, onBlock };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[customer-data] could not load the marks: outgoing requests are refused unless allowed"
    );
    return { marked: new MarkedValues(), allowedHosts, onBlock, strict: true };
  }
}
