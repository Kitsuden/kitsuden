/**
 * /api/admin/requests — the "glass box" from the panel
 * ============================================================================
 *
 *   GET /api/admin/requests?hours=24&limit=200&blocked=1&errors=1&actor=<id>
 *       The recorded requests, from newest to oldest.
 *   GET /api/admin/requests/summary?hours=24
 *       By kon and operation: requests, 5xx errors, blocks, p95, average
 *       time in the database and rows written.
 *
 * Core SDK operations (`kon-traces`), outside MCP. Administrators
 * only. Traces carry no bodies or parameters; the route is
 * normalized (lib/traces.ts). (`/api/admin/traces` was already the AGENTS'
 * traces: observability.ts.)
 */

import { defineOperation } from "@kitsuden/shared";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { registerCoreOperations } from "../lib/core-operations";
import { listTraces, traceSummary, tracesEnabled } from "../lib/traces";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { requireAdminRole } from "../middleware/auth-guard";

const fromAdmin = {
  access: "session" as const,
  permission: { roles: ["admin"] },
  before: [requireAdminRole as unknown as MiddlewareHandler],
  mcp: { exclude: "Operations panel for administrators: request traces are read by a human." },
  tags: ["traces"],
};
const Hours = z.coerce
  .number()
  .int()
  .min(1)
  .max(24 * 31)
  .default(24);
const from = (hours: number) => new Date(Date.now() - hours * 3600_000);

export const traceOperations: AnyOperation[] = [
  defineOperation({
    ...fromAdmin,
    id: "list-requests",
    method: "GET",
    route: "/",
    summary: "Request traces (admin)",
    description:
      "Recorded requests, newest first: actor, kon, operation, duration, database time, rows written and blocked writes (owner filter or RLS). Writes, errors and blocks are always recorded; reads are sampled.",
    input: {
      query: z.object({
        hours: Hours,
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        blocked: z.enum(["0", "1"]).optional(),
        errors: z.enum(["0", "1"]).optional(),
        actor: z.string().max(200).optional(),
      }),
    },
    output: {
      schema: z.object({
        enabled: z.boolean(),
        requests: z.array(z.record(z.string(), z.unknown())),
      }),
    },
    handle: async ({ query }) => {
      const q = query as {
        hours: number;
        limit: number;
        blocked?: string;
        errors?: string;
        actor?: string;
      };
      if (!tracesEnabled()) return { enabled: false, requests: [] };
      const requests = await listTraces({
        from: from(q.hours),
        limit: q.limit,
        onlyBlockers: q.blocked === "1",
        onlyErrors: q.errors === "1",
        actor: q.actor || null,
      });
      return { enabled: true, requests };
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "requests-summary",
    method: "GET",
    route: "/summary",
    summary: "Request traces by operation (admin)",
    description:
      "Per kon, operation and route: requests, 5xx errors, blocked writes, p95 duration, mean database time and rows written.",
    input: { query: z.object({ hours: Hours }) },
    output: {
      schema: z.object({
        enabled: z.boolean(),
        operations: z.array(z.record(z.string(), z.unknown())),
      }),
    },
    handle: async ({ query }) => {
      if (!tracesEnabled()) return { enabled: false, operations: [] };
      return {
        enabled: true,
        operations: await traceSummary(from((query as { hours: number }).hours)),
      };
    },
  }),
];

export const tracesKon = {
  id: "kon-traces",
  name: "Request traces",
  version: "1.0.0",
  mountPath: "/api/admin/requests",
  operations: traceOperations,
};

registerCoreOperations({
  konId: "kon-traces",
  mountPath: "/api/admin/requests",
  description: "The glass box: one trace per request, in Postgres (administrators only).",
  operations: traceOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const tracesRoutes = operationsRouter("kon-traces", traceOperations, context);
