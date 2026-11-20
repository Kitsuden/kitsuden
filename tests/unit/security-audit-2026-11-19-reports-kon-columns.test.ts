/**
 * Security audit 2026-11-19: reports_aggregate honours the kon that owns a table.
 *
 * kon-crm keeps notes (and, per grant, amounts) from agents in its own
 * responses, but the core aggregate read its tables with only `reports:read`
 * and returned `GROUP BY id, notes` row by row. Now, for an agent:
 *
 *   · a kon table needs a scope of its kon (kon.json `reportAccess.agentScope`,
 *     or any grant in the kon's namespace);
 *   · the columns the kon lists in `reportAccess.restricted` cannot be read
 *     through the result, unless the agent holds `reportAccess.restrictedScope`.
 *
 * No database: `execute` is faked; a refused query never reaches it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executed = vi.hoisted(() => ({ statements: 0 }));

vi.mock("../../apps/api/src/db", () => ({
  db: {
    execute: vi.fn(async (q: unknown) => {
      const text = JSON.stringify(q);
      if (text.includes("information_schema")) {
        return {
          rows: [
            { column_name: "id", data_type: "uuid" },
            { column_name: "notes", data_type: "text" },
            { column_name: "status", data_type: "text" },
            { column_name: "value", data_type: "numeric" },
          ],
        };
      }
      executed.statements++;
      return { rows: [] };
    }),
  },
  isLiteMode: false,
}));

vi.mock("../../apps/api/src/lib/explorable-tables", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  tableIsExplorable: async () => ({ allowed: true }),
}));

vi.mock("../../apps/api/src/lib/customer-data-catalog", () => ({
  loadSensitivityCatalog: async () => ({ datasets: new Map(), global: new Map() }),
}));

vi.mock("../../apps/api/src/lib/installed-kons", () => ({
  listInstalledKons: () => [
    {
      id: "kon-crm",
      source: "config",
      path: "/kons/kon-crm",
      declaredOne: {},
      manifest: {
        id: "kon-crm",
        tables: ["crm_contacts", "crm_deals"],
        reportAccess: {
          agentScope: "crm:view",
          restricted: { crm_contacts: ["notes"], crm_deals: ["value", "notes"] },
          restrictedScope: "crm:read-all",
        },
      },
    },
    {
      id: "kon-tasks",
      source: "config",
      path: "/kons/kon-tasks",
      declaredOne: {},
      manifest: { id: "kon-tasks", tables: ["tasks_items"] },
    },
  ],
}));

const { runAggregate, AggregateError, konReportAccess, agentOpensKonForReports } =
  await import("../../apps/api/src/lib/aggregate");

const notesDump = {
  source: { table: "crm_contacts" },
  groupBy: [{ field: "id" }, { field: "notes" }],
  measures: [{ fn: "count" }],
  limit: 1000,
};

async function status(query: unknown, options: Parameters<typeof runAggregate>[1]) {
  try {
    await runAggregate(query, options);
    return 200;
  } catch (err) {
    if (err instanceof AggregateError) return err.status;
    throw err;
  }
}

beforeEach(() => {
  executed.statements = 0;
});

describe("an agent aggregating a kon's table", () => {
  it("needs the kon's scope: reports:read alone is refused before any query", async () => {
    const s = await status(
      { source: { table: "crm_contacts" }, measures: [{ fn: "count" }] },
      { restrictSensitive: true, agentScopes: ["reports:read"] }
    );
    expect(s).toBe(403);
    expect(executed.statements).toBe(0);
  });

  it("cannot group by, max or filter on a restricted column (the notes dump)", async () => {
    const agent = { restrictSensitive: true, agentScopes: ["reports:read", "crm:view"] };
    expect(await status(notesDump, agent)).toBe(403);
    expect(
      await status(
        {
          source: { table: "crm_deals" },
          groupBy: [{ field: "id" }],
          measures: [{ fn: "max", field: "value" }],
        },
        agent
      )
    ).toBe(403);
    expect(
      await status(
        {
          source: { table: "crm_contacts" },
          measures: [{ fn: "count" }],
          filters: [{ field: "notes", op: "contains", value: "x" }],
        },
        agent
      )
    ).toBe(403);
    expect(executed.statements).toBe(0);
    // Unrestricted columns, and counting, still work.
    expect(
      await status(
        {
          source: { table: "crm_contacts" },
          groupBy: [{ field: "status" }],
          measures: [{ fn: "count" }, { fn: "count", field: "notes" }],
        },
        agent
      )
    ).toBe(200);
  });

  it("the kon's lifting scope, and a person, can read restricted columns", async () => {
    expect(
      await status(notesDump, {
        restrictSensitive: true,
        agentScopes: ["reports:read", "crm:view", "crm:read-all"],
      })
    ).toBe(200);
    expect(await status(notesDump, { restrictSensitive: false })).toBe(200);
  });

  it("a denial of the kon beats admin", async () => {
    expect(
      await status(notesDump, { restrictSensitive: true, agentScopes: ["admin", "!crm:view"] })
    ).toBe(403);
  });

  it("without a declared agentScope, any grant in the kon's namespace opens it", () => {
    const none = konReportAccess({});
    expect(agentOpensKonForReports(["reports:read"], "kon-tasks", none)).toBe(false);
    expect(agentOpensKonForReports(["reports:read", "tasks:read"], "kon-tasks", none)).toBe(true);
    expect(agentOpensKonForReports(["kon:tasks:list"], "kon-tasks", none)).toBe(true);
    expect(agentOpensKonForReports(["admin"], "kon-tasks", none)).toBe(true);
    expect(agentOpensKonForReports(["admin", "!tasks:*"], "kon-tasks", none)).toBe(false);
  });

  it("a malformed reportAccess block is ignored", () => {
    const a = konReportAccess({
      reportAccess: {
        agentScope: 42,
        restricted: { t: "notes", u: ["", "x"] },
        restrictedScope: "!x",
      },
    });
    expect(a.agentScope).toBeNull();
    expect(a.restrictedScope).toBeNull();
    expect([...a.restricted.keys()]).toEqual(["u"]);
  });
});
