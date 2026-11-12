/**
 * GET /api/history/:collection/:id — the change history of a row of any table
 * ============================================================================
 *
 * Who created, changed or deleted a row, when, and which fields: what
 * `record_changes` (core migration 0076) keeps for it, newest first. The row is
 * named as the data explorer names it (`/api/explorer/:collection`): the
 * collection passes the same gate (a table that cannot be explored is a 404),
 * and the route is for administrators, like the explorer. A deleted row keeps
 * its history: it is what says who deleted it.
 *
 * A dataset entry also has its own route with the entry's visibility:
 * `GET /api/datasets/:id/entries/:entryId/history` (kon-datasets).
 *
 * It is an operation of the CORE SDK (`kon-record-history`), not of a kon: no
 * `kon:*` scope opens it.
 */

import {
  defineOperation,
  messageOf,
  operationsRouter,
  pruneRecordHistory,
  readRecordHistory,
  recordHistoryRetentionDays,
  type AnyOperation,
} from "@kitsuden/engine";
import { z } from "zod";

import { db } from "../db";
import { registerCoreOperations } from "../lib/core-operations";
import { logger } from "../lib/logger";
import { optionalAuth, requireAuth } from "../middleware/auth";

import { explorerHistoryEntity } from "./data-explorer";

export const RECORD_HISTORY_ROUTE = "/api/history";

const RecordChange = z.object({
  id: z.string(),
  action: z.enum(["create", "update", "delete"]),
  at: z.string().describe("ISO timestamp"),
  actor: z.object({
    type: z.enum(["user", "agent", "system"]),
    id: z.string().nullable(),
    name: z.string().nullable().describe("The name it had when it made the change"),
  }),
  changes: z.array(
    z.object({
      field: z.string().describe("The column (or `data.<key>` for a dataset entry)"),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
      redacted: z.literal(true).optional().describe("A secret column: values are not kept"),
    })
  ),
  truncated: z.boolean().describe("Some value or the list was cut to its size limit"),
  proposalId: z.string().nullable().describe("The approved proposal this write executed"),
  approvedBy: z.string().nullable(),
});

export const recordHistoryOperations: AnyOperation[] = [
  defineOperation({
    id: "record-history",
    method: "GET",
    route: "/:collection/:id",
    summary: "Change history of a row",
    description:
      "Who created, changed or deleted a row of a table, when, and which fields, newest first: the actor (a person, an agent or the system), the action and each changed field's value before and after. `collection` and `id` name the row as the data explorer does. Secret columns (token, password, hash) are listed as `redacted` with no values; long values are cut to a preview. Changes made before the history existed are not listed. Admin only.",
    tags: ["history"],
    input: {
      params: z.object({
        collection: z.string().describe("The table, as /api/explorer names it"),
        id: z.string().describe("The row's primary key"),
      }),
      query: z
        .object({
          limit: z.string().optional().describe("1-200, default 50"),
          offset: z.string().optional().describe("Entries to skip, default 0"),
        })
        .passthrough(),
    },
    output: {
      schema: z.object({
        history: z.array(RecordChange),
        total: z.number().int(),
        limit: z.number().int(),
        offset: z.number().int(),
      }),
    },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    access: "session",
    permission: { roles: ["admin"] },
    mcp: {
      exclude:
        "Panel read for administrators. A dataset entry's history is the datasets__entry-history tool.",
    },
    handle: async ({ params, query }, { c }) => {
      const { collection, id } = params as { collection: string; id: string };
      const entity = await explorerHistoryEntity(collection);
      if (!entity) return c.json({ error: `Collection '${collection}' not found.` }, 404);
      const q = (query ?? {}) as { limit?: string; offset?: string };
      return readRecordHistory(db, entity, id, {
        limit: Number(q.limit),
        offset: Number(q.offset),
      });
    },
  }),
];

export const recordHistoryKon = {
  id: "kon-record-history",
  name: "Record history",
  version: "1.0.0",
  mountPath: RECORD_HISTORY_ROUTE,
  operations: recordHistoryOperations,
};

registerCoreOperations({
  konId: "kon-record-history",
  mountPath: RECORD_HISTORY_ROUTE,
  description: "The change history of the rows of any explorable table (for the admin panel).",
  operations: recordHistoryOperations,
});

// ── Retention ───────────────────────────────────────────────────────────────────

/**
 * Deletes the history rows older than `RECORD_HISTORY_RETENTION_DAYS` (365 by
 * default, `0` = keep forever). On the global connection: only the system may
 * delete `record_changes`. Never throws.
 */
export async function sweepRecordHistory(): Promise<number> {
  try {
    const deleted = await pruneRecordHistory(db, recordHistoryRetentionDays());
    if (deleted > 0) logger.info({ deleted }, "[record-history] pruned old history rows");
    return deleted;
  } catch (err) {
    logger.warn({ err: messageOf(err) }, "[record-history] prune failed");
    return 0;
  }
}

let sweep: ReturnType<typeof setInterval> | null = null;

/** Prunes once at start and then every hour, the way the OAuth and proposal sweeps run. */
export function startRecordHistorySweep(): void {
  if (sweep) return;
  sweep = setInterval(() => void sweepRecordHistory(), 60 * 60_000);
  (sweep as { unref?: () => void }).unref?.();
  void sweepRecordHistory();
}

const context = { auth: { requireAuth, optionalAuth } } as never;
export const recordHistoryRoutes = operationsRouter(
  "kon-record-history",
  recordHistoryOperations,
  context
);
