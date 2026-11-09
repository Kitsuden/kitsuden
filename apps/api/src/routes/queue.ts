/**
 * /api/admin/queue — the Postgres queue seen from the panel
 * ============================================================================
 *
 *   GET    /api/admin/queue              count per queue and state + the
 *                                        dead jobs ("dead letter")
 *   POST   /api/admin/queue/:id/retry    re-enqueues a dead job
 *   DELETE /api/admin/queue/:id          discards a dead job
 *
 * Core SDK operations (`kon-queue`): OpenAPI and typed SDK, outside
 * MCP. Administrators only (`/api/admin/*` also goes through `requireAdminRole`,
 * which re-reads the role from the database). Dead jobs are listed WITHOUT payload (it may
 * carry email addresses or other personal data).
 */

import { defineOperation } from "@kitsuden/shared";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { registerCoreOperations } from "../lib/core-operations";
import { discardJob, queueStatus, retryJob, deadJobs } from "../lib/queue";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { requireAdminRole } from "../middleware/auth-guard";

const fromAdmin = {
  access: "session" as const,
  permission: { roles: ["admin"] },
  before: [requireAdminRole as unknown as MiddlewareHandler],
  mcp: {
    exclude: "Operations panel for administrators: a human inspects and retries background jobs.",
  },
  tags: ["queue"],
};
const ParamId = z.object({ id: z.guid() });
const Obj = z.record(z.string(), z.unknown());

export const queueOperations: AnyOperation[] = [
  defineOperation({
    ...fromAdmin,
    id: "queue-status",
    method: "GET",
    route: "/",
    summary: "Queue status (admin)",
    description:
      "Counts per queue and status (pending, running, done, dead), whether the worker and LISTEN are up, and the dead jobs (without payload) with their last error.",
    input: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    output: { schema: Obj },
    handle: async ({ query }) => {
      const limit = (query as { limit: number }).limit;
      const [status, deadOnes] = [await queueStatus(), await deadJobs(limit)];
      return { ...status, dead: deadOnes };
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "retry-job",
    method: "POST",
    route: "/:id/retry",
    summary: "Retry a dead job (admin)",
    description:
      "Puts a dead job back to pending with its attempts reset. 404 if there is no dead job with that id.",
    input: { params: ParamId },
    output: { schema: z.object({ success: z.literal(true) }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async ({ params }, { c }) => {
      const ok = await retryJob((params as { id: string }).id);
      return ok
        ? { success: true as const }
        : c.json({ error: "Dead job not found", code: "KITSUDEN_E_NOT_FOUND" }, 404);
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "discard-job",
    method: "DELETE",
    route: "/:id",
    summary: "Discard a dead job (admin)",
    description: "Deletes a dead job. 404 if there is no dead job with that id.",
    input: { params: ParamId },
    output: { schema: z.object({ success: z.literal(true) }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    sensitive: false,
    handle: async ({ params }, { c }) => {
      const ok = await discardJob((params as { id: string }).id);
      return ok
        ? { success: true as const }
        : c.json({ error: "Dead job not found", code: "KITSUDEN_E_NOT_FOUND" }, 404);
    },
  }),
];

export const queueKon = {
  id: "kon-queue",
  name: "Background jobs",
  version: "1.0.0",
  mountPath: "/api/admin/queue",
  operations: queueOperations,
};

registerCoreOperations({
  konId: "kon-queue",
  mountPath: "/api/admin/queue",
  description: "The Postgres queue: status and dead jobs (administrators only).",
  operations: queueOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const queueRoutes = operationsRouter("kon-queue", queueOperations, context);
