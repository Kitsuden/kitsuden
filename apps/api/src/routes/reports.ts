/**
 * Reports as SDK operations: REST + OpenAPI + MCP from ONE declaration
 * (docs/reports.md)
 * ============================================================================
 *
 * Mounted by the core at `/api/reports` (index.ts) inside the request's RLS
 * transaction, and registered among the MOUNTED operations, so that:
 *
 *   · `aggregate`, `list-reports` and `run-report` are MCP tools
 *     (`reports_aggregate`, `reports_list`, `reports_run`);
 *   · the `/api/reports` gate (admin only) lets through an agent whose scopes
 *     open THAT operation;
 *   · what a report counts is decided by the row policies of the table it
 *     reads, as whoever runs it (lib/aggregate.ts).
 *
 * Three kinds of thing live here:
 *
 *   aggregate    an ad hoc query: nothing is stored.
 *   reports      queries a person saved (table `reports`), listed together
 *                with the ones kons ship (`defineKon({ reports })`), which are
 *                read-only and addressed as `kon:<kon id>/<report id>`.
 *   dashboards   ordered tiles, each pointing at a report of either kind.
 *
 * Scopes: `reports:read` (aggregate, list, run, read dashboards) and
 * `reports:write` (everything). Also `admin`, and the fine ones
 * (`kon:reports:<operation>`), as for any SDK operation.
 */

import {
  defineOperation,
  reportChartProblem,
  type AggregateQuery,
  type ReportChart,
} from "@kitsuden/shared";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

// Deep imports, not the facade: the facade reaches the loader, which reaches the routes.
import { AppError } from "../../../../packages/engine/src/errors";
import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { resolveExecutor } from "../../../../packages/engine/src/request-scope";
import { db } from "../db";
import { dashboards, reports } from "../db/schema";
import {
  AggregateError,
  aggregateProblem,
  runAggregate,
  type AggregateResult,
} from "../lib/aggregate";
import { registerCoreOperations } from "../lib/core-operations";
import { konReport, listKonReports } from "../lib/kon-contributions";
import { requireAuth, optionalAuth } from "../middleware/auth";

export const REPORTS_KON = "kon-reports";
export const REPORTS_ROUTE = "/api/reports";
export const SCOPE_REPORTS_READ = "reports:read";
export const SCOPE_REPORTS_WRITE = "reports:write";

const read = {
  access: "session" as const,
  permission: { scopes: [SCOPE_REPORTS_READ, SCOPE_REPORTS_WRITE], roles: ["admin"] },
  tags: ["reports"],
};
const write = {
  access: "session" as const,
  permission: { scopes: [SCOPE_REPORTS_WRITE], roles: ["admin"] },
  tags: ["reports"],
};

/** The request's RLS transaction (or the global db outside a request). */
function ex(): typeof db {
  return resolveExecutor(db) as typeof db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KON_REPORT = /^kon:[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TILES = 40;

// ── Schemas ─────────────────────────────────────────────────────────────────

/** The query is checked by `aggregateQueryProblem`, which says WHICH part is wrong; here, only that it is an object. */
const Query = z.record(z.string(), z.unknown());
const Chart = z.record(z.string(), z.unknown());

const Result = z.object({
  columns: z.array(z.object({ name: z.string(), role: z.enum(["dimension", "measure"]) })),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});

const Report = z.object({
  id: z.string(),
  /** `saved`: a person wrote it and it can be changed. `kon`: a kon ships it; read-only. */
  source: z.enum(["saved", "kon"]),
  konId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  query: Query,
  chart: Chart.nullable(),
  updatedAt: z.string().nullable(),
});

const Tile = z.object({
  report: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  width: z.number().int().min(1).max(12).optional(),
});

const Dashboard = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  tiles: z.array(Tile),
  updatedAt: z.string(),
});

const ParamId = z.object({ id: z.string().regex(UUID, "must be a uuid") });

type ReportView = z.infer<typeof Report>;
type DashboardView = z.infer<typeof Dashboard>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function savedView(row: typeof reports.$inferSelect): ReportView {
  return {
    id: row.id,
    source: "saved",
    konId: null,
    name: row.name,
    description: row.description,
    query: row.query as Record<string, unknown>,
    chart: (row.chart as Record<string, unknown> | null) ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function konViews(): ReportView[] {
  return listKonReports().map((r) => ({
    id: r.id,
    source: "kon" as const,
    konId: r.konId,
    name: r.definition.name,
    description: r.definition.description ?? null,
    query: r.definition.query as unknown as Record<string, unknown>,
    chart: (r.definition.chart as unknown as Record<string, unknown> | undefined) ?? null,
    updatedAt: null,
  }));
}

function dashboardView(row: typeof dashboards.$inferSelect): DashboardView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tiles: row.tiles ?? [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A saved report by uuid, or a kon's by `kon:<kon id>/<id>`. `null` when there is none. */
async function findReport(id: string): Promise<ReportView | null> {
  if (KON_REPORT.test(id)) {
    const found = konReport(id);
    return found ? (konViews().find((r) => r.id === found.id) ?? null) : null;
  }
  if (!UUID.test(id)) return null;
  const [row] = await ex().select().from(reports).where(eq(reports.id, id)).limit(1);
  return row ? savedView(row) : null;
}

/**
 * Is the caller an agent? Agents cannot read the values of columns marked as customer or personal
 * data through a report (lib/aggregate.ts); a person with the administrator role can.
 */
function callerIsAgent(c: unknown): boolean {
  return Boolean((c as { get?: (key: string) => unknown }).get?.("agent"));
}

async function aggregate(query: unknown, agent: boolean): Promise<AggregateResult> {
  try {
    return await runAggregate(query, { restrictSensitive: agent });
  } catch (err: unknown) {
    if (err instanceof AggregateError) {
      if (err.status === 403) throw AppError.forbidden(err.message);
      if (err.status === 404) throw AppError.notFound(err.message);
      throw AppError.badRequest(err.message);
    }
    throw err;
  }
}

/** A report must be runnable when it is saved: a broken one is found here, not on a dashboard. */
async function requireValid(query: unknown, chart: unknown): Promise<void> {
  const problem = (await aggregateProblem(query)) ?? reportChartProblem(chart);
  if (problem) throw AppError.badRequest(problem);
}

function requireTiles(tiles: Array<{ report: string }>): void {
  if (tiles.length > MAX_TILES)
    throw AppError.badRequest(`A dashboard takes at most ${MAX_TILES} tiles.`);
  for (const [index, tile] of tiles.entries()) {
    if (!UUID.test(tile.report) && !KON_REPORT.test(tile.report)) {
      throw AppError.badRequest(
        `tile ${index + 1}: report must be the id of a saved report or "kon:<kon id>/<report id>".`
      );
    }
  }
}

function userId(user: unknown): string | null {
  const id = (user as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

// ── Operations ──────────────────────────────────────────────────────────────

export const reportOperations: AnyOperation[] = [
  defineOperation({
    ...read,
    id: "aggregate",
    method: "POST",
    route: "/aggregate",
    readOnly: true,
    summary: "Run an aggregate query",
    description:
      "Computes count, count_distinct, sum, avg, min or max over a table an installed kon declares, or over a dataset, optionally grouped (with day/week/month/quarter/year buckets for dates) and filtered. Runs as you: row policies decide which rows are counted. Columns that hold secrets are refused. Returns one row per group, at most `limit` (default 100, max 1000); `truncated` says there were more.",
    input: { body: z.object({ query: Query }) },
    output: { schema: Result },
    errors: ["KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    mcp: { name: "reports_aggregate" },
    cost: 2,
    guide: {
      whenToUse:
        "To answer 'how many / how much, grouped by what'. Use it instead of listing rows and adding them up.",
      examples: [
        {
          title: "Deals won per month",
          args: {
            body: {
              query: {
                source: { table: "crm_deals" },
                measures: [{ fn: "sum", field: "amount", as: "total" }, { fn: "count" }],
                groupBy: [{ field: "closed_at", bucket: "month", as: "month" }],
                filters: [{ field: "status", op: "eq", value: "won" }],
                orderBy: [{ by: "month", dir: "asc" }],
              },
            },
          },
        },
      ],
    },
    handle: async (e, { c }) => aggregate((e.body as { query: unknown }).query, callerIsAgent(c)),
  }),
  defineOperation({
    ...read,
    id: "list-reports",
    method: "GET",
    route: "/",
    summary: "List reports",
    description:
      "The reports people saved (`source: saved`) and the ones installed kons ship (`source: kon`, read-only, id `kon:<kon id>/<report id>`), each with its query.",
    // It stopped at 500 saved reports with no sign. The kons' reports (not in the
    // table) come with the first page.
    input: {
      query: z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(500)
          .default(500)
          .describe(
            "Rows per page (1-500). The default is the maximum, what the list always returned."
          ),
        offset: z.coerce.number().int().min(0).default(0).describe("Rows to skip."),
      }),
    },
    output: { schema: z.object({ reports: z.array(Report), hasMore: z.boolean() }) },
    mcp: { name: "reports_list" },
    handle: async (input) => {
      const { limit, offset } = input.query as { limit: number; offset: number };
      const rows = await ex()
        .select()
        .from(reports)
        .orderBy(desc(reports.updatedAt), desc(reports.id))
        .limit(limit + 1)
        .offset(offset);
      return {
        reports: [...rows.slice(0, limit).map(savedView), ...(offset === 0 ? konViews() : [])],
        hasMore: rows.length > limit,
      };
    },
  }),
  defineOperation({
    ...read,
    id: "run-report",
    method: "POST",
    route: "/run",
    readOnly: true,
    summary: "Run a report",
    description:
      "Runs a saved report (by id) or a kon's (`kon:<kon id>/<report id>`) and returns its result and its chart hint. Runs as you, like `aggregate`.",
    input: { body: z.object({ report: z.string().min(1).max(200) }) },
    output: { schema: z.object({ report: Report, result: Result }) },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_FORBIDDEN"],
    mcp: { name: "reports_run" },
    cost: 2,
    handle: async (e, { c }) => {
      const report = await findReport((e.body as { report: string }).report);
      if (!report) throw AppError.notFound("There is no such report.");
      return { report, result: await aggregate(report.query, callerIsAgent(c)) };
    },
  }),
  defineOperation({
    ...write,
    id: "create-report",
    method: "POST",
    route: "/",
    summary: "Save a report",
    description:
      "Stores an aggregate query under a name, with an optional chart hint (`type`: table, number, bar, line, donut; `x`; `y`). The query is checked against the real tables first: a report that could not run is not saved.",
    input: {
      body: z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        query: Query,
        chart: Chart.optional(),
      }),
    },
    output: { schema: z.object({ report: Report }), status: 201 },
    errors: ["KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    mcp: {
      exclude: "Saving a report is a panel task; an agent runs queries with reports_aggregate.",
    },
    handle: async (e, { user }) => {
      const body = e.body as unknown as {
        name: string;
        description?: string;
        query: AggregateQuery;
        chart?: ReportChart;
      };
      await requireValid(body.query, body.chart);
      const [row] = await ex()
        .insert(reports)
        .values({
          name: body.name,
          description: body.description ?? null,
          query: body.query,
          chart: body.chart ?? null,
          createdById: userId(user),
        })
        .returning();
      return { report: savedView(row) };
    },
  }),
  defineOperation({
    ...read,
    id: "list-dashboards",
    method: "GET",
    route: "/dashboards",
    summary: "List dashboards",
    description:
      "Every dashboard with its tiles. Each tile points at a report; run them with run-dashboard.",
    // It stopped at 200 with no sign: page through it, `hasMore` says when to stop.
    input: {
      query: z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .default(200)
          .describe(
            "Rows per page (1-200). The default is the maximum, what the list always returned."
          ),
        offset: z.coerce.number().int().min(0).default(0).describe("Rows to skip."),
      }),
    },
    output: { schema: z.object({ dashboards: z.array(Dashboard), hasMore: z.boolean() }) },
    mcp: {
      exclude: "Dashboards are a layout for the panel; an agent uses reports_list and reports_run.",
    },
    handle: async (input) => {
      const { limit, offset } = input.query as { limit: number; offset: number };
      const rows = await ex()
        .select()
        .from(dashboards)
        .orderBy(desc(dashboards.updatedAt), desc(dashboards.id))
        .limit(limit + 1)
        .offset(offset);
      return { dashboards: rows.slice(0, limit).map(dashboardView), hasMore: rows.length > limit };
    },
  }),
  defineOperation({
    ...write,
    id: "create-dashboard",
    method: "POST",
    route: "/dashboards",
    summary: "Create a dashboard",
    description:
      "An ordered list of tiles. Each tile names a report (a saved report's id, or `kon:<kon id>/<report id>`), with an optional title and a width from 1 to 12.",
    input: {
      body: z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        tiles: z.array(Tile).optional(),
      }),
    },
    output: { schema: z.object({ dashboard: Dashboard }), status: 201 },
    errors: ["KITSUDEN_E_BAD_REQUEST"],
    mcp: { exclude: "Dashboards are a layout for the panel." },
    handle: async (e, { user }) => {
      const body = e.body as { name: string; description?: string; tiles?: z.infer<typeof Tile>[] };
      const tiles = body.tiles ?? [];
      requireTiles(tiles);
      const [row] = await ex()
        .insert(dashboards)
        .values({
          name: body.name,
          description: body.description ?? null,
          tiles,
          createdById: userId(user),
        })
        .returning();
      return { dashboard: dashboardView(row) };
    },
  }),
  defineOperation({
    ...read,
    id: "get-dashboard",
    method: "GET",
    route: "/dashboards/:id",
    summary: "Read a dashboard",
    description: "One dashboard with its tiles.",
    input: { params: ParamId },
    output: { schema: z.object({ dashboard: Dashboard }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { exclude: "Dashboards are a layout for the panel." },
    handle: async (e) => {
      const { id } = e.params as { id: string };
      const [row] = await ex().select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
      if (!row) throw AppError.notFound("There is no such dashboard.");
      return { dashboard: dashboardView(row) };
    },
  }),
  defineOperation({
    ...read,
    id: "run-dashboard",
    method: "POST",
    route: "/dashboards/:id/run",
    readOnly: true,
    summary: "Run every report of a dashboard",
    description:
      "Runs each tile's report and returns the results in tile order. A tile whose report is gone or fails carries `error` instead of `result`; the others still come back.",
    input: { params: ParamId },
    output: {
      schema: z.object({
        dashboard: Dashboard,
        tiles: z.array(
          z.object({
            report: z.string(),
            title: z.string().nullable(),
            width: z.number().nullable(),
            chart: Chart.nullable(),
            result: Result.nullable(),
            error: z.string().nullable(),
          })
        ),
      }),
    },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { exclude: "Dashboards are a layout for the panel." },
    cost: 5,
    handle: async (e, { c }) => {
      const { id } = e.params as { id: string };
      const [row] = await ex().select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
      if (!row) throw AppError.notFound("There is no such dashboard.");
      const tiles = [];
      // One after another: they share the request's connection.
      for (const tile of row.tiles ?? []) {
        const report = await findReport(tile.report);
        let result: AggregateResult | null = null;
        let error: string | null = null;
        if (!report) {
          error = "The report no longer exists.";
        } else {
          try {
            result = await runAggregate(report.query, { restrictSensitive: callerIsAgent(c) });
          } catch (err: unknown) {
            // A failed statement would poison the request's transaction for the next tile; only
            // errors found BEFORE the statement runs are tolerated here.
            if (!(err instanceof AggregateError)) throw err;
            error = err.message;
          }
        }
        tiles.push({
          report: tile.report,
          title: tile.title ?? report?.name ?? null,
          width: tile.width ?? null,
          chart: report?.chart ?? null,
          result,
          error,
        });
      }
      return { dashboard: dashboardView(row), tiles };
    },
  }),
  defineOperation({
    ...write,
    id: "update-dashboard",
    method: "PATCH",
    route: "/dashboards/:id",
    summary: "Change a dashboard",
    description: "Changes the name, the description or the whole list of tiles.",
    input: {
      params: ParamId,
      body: z.object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        tiles: z.array(Tile).optional(),
      }),
    },
    output: { schema: z.object({ dashboard: Dashboard }) },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
    mcp: { exclude: "Dashboards are a layout for the panel." },
    handle: async (e) => {
      const { id } = e.params as { id: string };
      const body = e.body as {
        name?: string;
        description?: string | null;
        tiles?: z.infer<typeof Tile>[];
      };
      if (body.tiles) requireTiles(body.tiles);
      const [row] = await ex()
        .update(dashboards)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.tiles !== undefined ? { tiles: body.tiles } : {}),
          updatedAt: new Date(),
        })
        .where(eq(dashboards.id, id))
        .returning();
      if (!row) throw AppError.notFound("There is no such dashboard.");
      return { dashboard: dashboardView(row) };
    },
  }),
  defineOperation({
    ...write,
    id: "delete-dashboard",
    method: "DELETE",
    route: "/dashboards/:id",
    summary: "Delete a dashboard",
    description: "Deletes the dashboard. Its reports are kept.",
    input: { params: ParamId },
    output: { schema: z.object({ deleted: z.boolean() }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { exclude: "Dashboards are a layout for the panel." },
    handle: async (e) => {
      const { id } = e.params as { id: string };
      const removed = await ex()
        .delete(dashboards)
        .where(eq(dashboards.id, id))
        .returning({ id: dashboards.id });
      if (removed.length === 0) throw AppError.notFound("There is no such dashboard.");
      return { deleted: true };
    },
  }),
  defineOperation({
    ...read,
    id: "get-report",
    method: "GET",
    route: "/:id",
    summary: "Read a saved report",
    description:
      "One saved report with its query and chart hint. Kon reports are read from list-reports.",
    input: { params: ParamId },
    output: { schema: z.object({ report: Report }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { exclude: "reports_list already returns every report with its query." },
    handle: async (e) => {
      const report = await findReport((e.params as { id: string }).id);
      if (!report) throw AppError.notFound("There is no such report.");
      return { report };
    },
  }),
  defineOperation({
    ...write,
    id: "update-report",
    method: "PATCH",
    route: "/:id",
    summary: "Change a saved report",
    description:
      "Changes the name, the description, the query or the chart hint. A new query is checked like a new report.",
    input: {
      params: ParamId,
      body: z.object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        query: Query.optional(),
        chart: Chart.nullable().optional(),
      }),
    },
    output: { schema: z.object({ report: Report }) },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_FORBIDDEN"],
    mcp: { exclude: "Saving a report is a panel task." },
    handle: async (e) => {
      const { id } = e.params as { id: string };
      const body = e.body as {
        name?: string;
        description?: string | null;
        query?: AggregateQuery;
        chart?: ReportChart | null;
      };
      const [current] = await ex().select().from(reports).where(eq(reports.id, id)).limit(1);
      if (!current) throw AppError.notFound("There is no such report.");
      if (body.query !== undefined || body.chart !== undefined) {
        await requireValid(
          body.query ?? current.query,
          body.chart === undefined ? current.chart : body.chart
        );
      }
      const [row] = await ex()
        .update(reports)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.query !== undefined ? { query: body.query } : {}),
          ...(body.chart !== undefined ? { chart: body.chart } : {}),
          updatedAt: new Date(),
        })
        .where(eq(reports.id, id))
        .returning();
      return { report: savedView(row) };
    },
  }),
  defineOperation({
    ...write,
    id: "delete-report",
    method: "DELETE",
    route: "/:id",
    summary: "Delete a saved report",
    description:
      "Deletes the report. A dashboard tile that pointed at it shows that the report is gone.",
    input: { params: ParamId },
    output: { schema: z.object({ deleted: z.boolean() }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { exclude: "Saving a report is a panel task." },
    handle: async (e) => {
      const { id } = e.params as { id: string };
      const removed = await ex()
        .delete(reports)
        .where(eq(reports.id, id))
        .returning({ id: reports.id });
      if (removed.length === 0) throw AppError.notFound("There is no such report.");
      return { deleted: true };
    },
  }),
];

export const reportsKon = {
  id: REPORTS_KON,
  name: "Reports",
  version: "1.0.0",
  mountPath: REPORTS_ROUTE,
  operations: reportOperations,
};

registerCoreOperations({
  konId: REPORTS_KON,
  mountPath: REPORTS_ROUTE,
  description:
    "Aggregate queries over kon tables and datasets, saved reports, kon-shipped reports and dashboards.",
  operations: reportOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const reportsRoutes = operationsRouter(REPORTS_KON, reportOperations, context);
