/**
 * Per-record change history: retention and the write paths added after 0076
 * ============================================================================
 *
 * Against the REAL app (test Postgres). Each path writes, then the history is
 * read back (over the route where there is one):
 *
 *   · retention: `pruneRecordHistory` deletes rows older than the limit and keeps
 *     the rest; `RECORD_HISTORY_RETENTION_DAYS=0` (forever) deletes nothing;
 *   · imports: `POST /api/datasets/import` records each created and updated entry,
 *     as the admin who imported;
 *   · GraphQL: a dataset mutation and a native-table mutation are recorded with
 *     the caller as the actor;
 *   · MCP: `kitsuden_create/update/delete_record` on a native table and
 *     `kitsuden_insert_record` are recorded as the agent;
 *   · the kons' shared repository (`repo(table)`): create, update and delete are
 *     recorded once, with the request's user; `history: false` records nothing;
 *   · /api/items POST, PATCH and DELETE, on a native table and on a dataset;
 *   · batches: POST /api/datasets/batch (as dataset entries) and the batch-api
 *     processor; a batch that touches more than BULK_HISTORY_CAP rows records none;
 *   · an import that names another dataset's entry neither changes nor moves it;
 *   · the agent audit log is pruned past AGENT_AUDIT_RETENTION_DAYS (0 = forever).
 */

import {
  BatchProcessor,
  BULK_HISTORY_CAP,
  pruneRecordHistory,
  readRecordHistory,
  recordHistoryRetentionDays,
  repo,
  runInRequestScope,
} from "@kitsuden/engine";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { BatchProcessor as BatchApiProcessor } from "../../../../packages/engine/src/batch-api";
import { db } from "../db";
import {
  agentAuditLogs,
  agentIdentities,
  dataEntries,
  dataSets,
  datasetKpis,
  recordChanges,
} from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { agentAuditRetentionDays, sweepAgentAuditLogs } from "../services/agent-audit";
import { createAgent } from "../services/agent-auth";
import { executeHardcodedTool } from "../services/mcp-tools";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies read in the test
type Json = any;

const ORIGIN = "http://localhost:4321";
const RUN = `rhc-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
let ready = false;
let admin = { cookie: "", userId: "" };
let datasetId = "";
let agentId = "";
const rowIds: string[] = [];

async function request(
  method: string,
  path: string,
  o: { cookie?: string; body?: unknown } = {}
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
  );
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** The stored history of a row, oldest first. */
async function historyOf(rowId: string) {
  return db
    .select()
    .from(recordChanges)
    .where(eq(recordChanges.rowId, rowId))
    .orderBy(recordChanges.createdAt);
}

async function graphql(query: string, variables: Record<string, unknown> = {}) {
  return request("POST", "/api/graphql", { cookie: admin.cookie, body: { query, variables } });
}

describe("record history: retention and more write paths", () => {
  beforeAll(async () => {
    ready = await isDatabaseAvailable();
    if (!ready) return;
    clearQuotaMemory();
    admin = await enterAs(app, {
      email: `${RUN}-admin@example.com`,
      password: "TestPassword123!",
      name: "Coverage Admin",
      role: "admin",
    });
    const [ds] = await db
      .insert(dataSets)
      .values({
        name: RUN,
        slug: RUN,
        schema: [{ key: "name", fieldName: "name", type: "text", fieldType: "text" }],
        policyJson: { readAccess: "authenticated", writeAccess: "authenticated" },
      } as never)
      .returning({ id: dataSets.id });
    datasetId = ds!.id;
    const { agent } = await createAgent({
      name: `Coverage Agent ${generateTestId()}`,
      scopes: ["mcp:write", "admin", `datasets:${RUN}:write`, `datasets:${RUN}:read`],
      rateLimit: 100_000,
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    if (!ready) return;
    if (rowIds.length) await db.delete(recordChanges).where(inArray(recordChanges.rowId, rowIds));
    await db.delete(recordChanges).where(like(recordChanges.rowId, `${RUN}%`));
    if (datasetId) {
      await db.delete(dataEntries).where(eq(dataEntries.dataSetId, datasetId));
      await db.delete(dataSets).where(eq(dataSets.id, datasetId));
    }
    await db.delete(datasetKpis).where(like(datasetKpis.kpiName, `${RUN}%`));
    if (agentId) await db.delete(agentIdentities).where(eq(agentIdentities.id, agentId));
  });

  // ── Retention ──────────────────────────────────────────────────────────────

  it("RECORD_HISTORY_RETENTION_DAYS: empty is 365, 0 is forever, junk is the default", () => {
    expect(recordHistoryRetentionDays({})).toBe(365);
    expect(recordHistoryRetentionDays({ RECORD_HISTORY_RETENTION_DAYS: "" })).toBe(365);
    expect(recordHistoryRetentionDays({ RECORD_HISTORY_RETENTION_DAYS: "0" })).toBeNull();
    expect(recordHistoryRetentionDays({ RECORD_HISTORY_RETENTION_DAYS: "30" })).toBe(30);
    expect(recordHistoryRetentionDays({ RECORD_HISTORY_RETENTION_DAYS: "-4" })).toBe(365);
    expect(recordHistoryRetentionDays({ RECORD_HISTORY_RETENTION_DAYS: "soon" })).toBe(365);
  });

  it("prunes the rows older than the limit and keeps the rest", async () => {
    if (!ready) return;
    const old = `${RUN}-old`;
    const recent = `${RUN}-recent`;
    await db.execute(sql`
      INSERT INTO record_changes (entity, row_id, action, created_at) VALUES
        ('table:retention_probe', ${old}, 'update', now() - interval '40 days'),
        ('table:retention_probe', ${old}, 'create', now() - interval '400 days'),
        ('table:retention_probe', ${recent}, 'update', now() - interval '5 days')
    `);
    // Forever: nothing goes.
    expect(await pruneRecordHistory(db, null)).toBe(0);
    expect((await historyOf(old)).length).toBe(2);

    expect(await pruneRecordHistory(db, 30)).toBeGreaterThanOrEqual(2);
    expect((await historyOf(old)).length).toBe(0);
    expect((await historyOf(recent)).length).toBe(1);
  });

  // ── Imports ────────────────────────────────────────────────────────────────

  it("an import records each created and updated entry, as the importer", async () => {
    if (!ready) return;
    const created = await request("POST", "/api/datasets/import", {
      cookie: admin.cookie,
      body: {
        datasetId,
        data: [{ name: "Imported A" }, { name: "Imported B" }],
        config: { strategy: "insert" },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.stats.created).toBe(2);
    const entries = await db.select().from(dataEntries).where(eq(dataEntries.dataSetId, datasetId));
    const a = entries.find((e) => (e.data as Json).name === "Imported A")!;
    rowIds.push(...entries.map((e) => e.id));

    const upsert = await request("POST", "/api/datasets/import", {
      cookie: admin.cookie,
      body: {
        datasetId,
        data: [{ id: a.id, name: "Imported A2" }],
        config: { strategy: "upsert", idField: "id" },
      },
    });
    expect(upsert.status, JSON.stringify(upsert.body)).toBe(200);
    expect(upsert.body.stats.updated).toBe(1);

    const r = await request("GET", `/api/datasets/${datasetId}/entries/${a.id}/history`, {
      cookie: admin.cookie,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.history.map((h: Json) => h.action)).toEqual(["update", "create"]);
    expect(r.body.history[0].actor).toMatchObject({ type: "user", id: admin.userId });
    expect(r.body.history[0].changes).toContainEqual({
      field: "data.name",
      before: "Imported A",
      after: "Imported A2",
    });
  });

  // ── GraphQL ────────────────────────────────────────────────────────────────

  it("GraphQL mutations on a dataset and on a native table are recorded", async () => {
    if (!ready) return;
    const invalidated = await request("POST", "/api/graphql/invalidate", { cookie: admin.cookie });
    expect(invalidated.status).toBe(200);
    const schema = await graphql(`
      {
        __schema {
          mutationType {
            fields {
              name
            }
          }
        }
      }
    `);
    expect(schema.status, JSON.stringify(schema.body)).toBe(200);
    const names: string[] = schema.body.data.__schema.mutationType.fields.map((f: Json) => f.name);
    const pascal = RUN.split(/[_-]+/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("");
    const createEntry = `createDataset_${pascal}`;
    expect(names).toContain(createEntry);

    const made = await graphql(
      `mutation($input: JSON!) { e: ${createEntry}(input: $input) { id } }`,
      { input: { name: "From GraphQL" } }
    );
    expect(made.body.errors, JSON.stringify(made.body)).toBeUndefined();
    const entryId = made.body.data.e.id as string;
    rowIds.push(entryId);
    const changed = await graphql(
      `mutation($id: String!, $input: JSON!) { e: updateDataset_${pascal}(id: $id, input: $input) { id } }`,
      { id: entryId, input: { name: "From GraphQL 2" } }
    );
    expect(changed.body.errors, JSON.stringify(changed.body)).toBeUndefined();
    const entryHistory = await request(
      "GET",
      `/api/datasets/${datasetId}/entries/${entryId}/history`,
      { cookie: admin.cookie }
    );
    expect(entryHistory.body.history.map((h: Json) => h.action)).toEqual(["update", "create"]);
    expect(entryHistory.body.history[0].actor).toMatchObject({ type: "user", id: admin.userId });

    // A native table: the mutation is named after the table's export key.
    const createKpi = names.find((n) => /^create.*kpi/i.test(n) && !n.startsWith("createDataset_"));
    expect(createKpi).toBeDefined();
    const updateKpi = createKpi!.replace(/^create/, "update");
    const deleteKpi = createKpi!.replace(/^create/, "delete");
    const kpi = await graphql(`mutation($input: JSON!) { k: ${createKpi}(input: $input) { id } }`, {
      input: { kpiName: `${RUN}-gql`, expression: "1 + 1" },
    });
    expect(kpi.body.errors, JSON.stringify(kpi.body)).toBeUndefined();
    const kpiId = kpi.body.data.k.id as string;
    rowIds.push(kpiId);
    await graphql(
      `mutation($id: String!, $input: JSON!) { k: ${updateKpi}(id: $id, input: $input) { id } }`,
      { id: kpiId, input: { expression: "2 + 2" } }
    );
    await graphql(`mutation($id: String!) { k: ${deleteKpi}(id: $id) { success } }`, {
      id: kpiId,
    });
    // `dataset_kpis` is not an explorer collection: read it the way the route does.
    const r = { body: await readRecordHistory(db, "table:dataset_kpis", kpiId) };
    expect(r.body.history.map((h: Json) => h.action)).toEqual(["delete", "update", "create"]);
    // Column names, as the explorer and models record them.
    expect(r.body.history[1].changes).toContainEqual({
      field: "expression",
      before: "1 + 1",
      after: "2 + 2",
    });
    expect(r.body.history[2].changes).toContainEqual({ field: "kpi_name", after: `${RUN}-gql` });
    expect(r.body.history[0].actor).toMatchObject({ type: "user", id: admin.userId });
  });

  // ── MCP on native tables ───────────────────────────────────────────────────

  it("MCP record tools on a native table, and kitsuden_insert_record, are recorded as the agent", async () => {
    if (!ready) return;
    const session = {
      agentId,
      scopes: ["mcp:write", "admin", `datasets:${RUN}:write`, `datasets:${RUN}:read`],
    } as never;
    const created = await executeHardcodedTool(
      "kitsuden_create_record",
      { collection: "datasetKpis", data: { kpiName: `${RUN}-mcp`, expression: "a" } },
      session
    );
    expect(created).toMatch(/^Created native record: /);
    const id = created.slice(created.lastIndexOf(" ") + 1);
    rowIds.push(id);
    const updated = await executeHardcodedTool(
      "kitsuden_update_record",
      { collection: "datasetKpis", id, data: { expression: "b" } },
      session
    );
    expect(updated).toMatch(/^Updated native record: /);
    const deleted = await executeHardcodedTool(
      "kitsuden_delete_record",
      { collection: "datasetKpis", id },
      session
    );
    expect(deleted).toMatch(/^Deleted native record: /);

    const r = { body: await readRecordHistory(db, "table:dataset_kpis", id) };
    expect(r.body.history.map((h: Json) => h.action)).toEqual(["delete", "update", "create"]);
    expect(r.body.history[1].changes).toContainEqual({
      field: "expression",
      before: "a",
      after: "b",
    });
    for (const h of r.body.history) expect(h.actor).toMatchObject({ type: "agent", id: agentId });

    const inserted = await executeHardcodedTool(
      "kitsuden_insert_record",
      { datasetId, data: { title: "By insert", name: "Inserted" } },
      session
    );
    expect(inserted).toMatch(/^Record created: /);
    const entryId = inserted.slice(inserted.lastIndexOf(" ") + 1);
    rowIds.push(entryId);
    const rows = await historyOf(entryId);
    expect(rows.map((x) => x.action)).toEqual(["create"]);
    expect(rows[0]!.actorType).toBe("agent");
    expect(rows[0]!.actorId).toBe(agentId);
  });

  // ── The kons' shared repository ────────────────────────────────────────────

  it("repo(table) records create, update and delete once, with the request's user", async () => {
    if (!ready) return;
    const user = { id: admin.userId, role: "admin" };
    const id = await runInRequestScope({ user }, async () => {
      const row = await repo(datasetKpis).create({ kpiName: `${RUN}-repo`, expression: "x" });
      await repo(datasetKpis).filter({ id: row.id }).update({ expression: "y" });
      // Nothing changed: no row.
      await repo(datasetKpis).filter({ id: row.id }).update({ expression: "y" });
      await repo(datasetKpis).filter({ id: row.id }).delete();
      return row.id;
    });
    rowIds.push(id);
    const rows = await historyOf(id);
    expect(rows.map((x) => x.action)).toEqual(["create", "update", "delete"]);
    expect(rows.every((x) => x.entity === "table:dataset_kpis")).toBe(true);
    expect(rows[0]!.actorId).toBe(admin.userId);
    expect(rows[1]!.changes).toContainEqual({ field: "expression", before: "x", after: "y" });

    // Outside a request: the system.
    const [made] = await repo(datasetKpis).createMany([
      { kpiName: `${RUN}-repo-many`, expression: "z" },
    ]);
    rowIds.push(made!.id);
    const sys = await historyOf(made!.id);
    expect(sys.map((x) => [x.action, x.actorType])).toEqual([["create", "system"]]);

    // Turned off for a table written too often to keep.
    const quiet = await repo(datasetKpis, { history: false }).create({
      kpiName: `${RUN}-repo-quiet`,
      expression: "q",
    });
    rowIds.push(quiet.id);
    expect((await historyOf(quiet.id)).length).toBe(0);
  });
  // ── The generic items API ──────────────────────────────────────────────────

  it("/api/items POST, PATCH and DELETE are recorded, on a native table and a dataset", async () => {
    if (!ready) return;
    const made = await request("POST", "/api/items/datasetKpis", {
      cookie: admin.cookie,
      body: { kpiName: `${RUN}-items`, expression: "m" },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    rowIds.push(id);
    const changed = await request("PATCH", `/api/items/datasetKpis/${id}`, {
      cookie: admin.cookie,
      body: { expression: "n" },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const gone = await request("DELETE", `/api/items/datasetKpis/${id}`, { cookie: admin.cookie });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const native = await readRecordHistory(db, "table:dataset_kpis", id);
    expect(native.history.map((h) => h.action)).toEqual(["delete", "update", "create"]);
    expect(native.history[1]!.changes).toContainEqual({
      field: "expression",
      before: "m",
      after: "n",
    });
    expect(native.history[0]!.actor).toMatchObject({ type: "user", id: admin.userId });

    const entry = await request("POST", `/api/items/${RUN}`, {
      cookie: admin.cookie,
      body: { name: "Via items" },
    });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    const entryId = entry.body.id as string;
    rowIds.push(entryId);
    const entryPatch = await request("PATCH", `/api/items/${RUN}/${entryId}`, {
      cookie: admin.cookie,
      body: { name: "Via items 2" },
    });
    expect(entryPatch.status, JSON.stringify(entryPatch.body)).toBe(200);
    const r = await request("GET", `/api/datasets/${datasetId}/entries/${entryId}/history`, {
      cookie: admin.cookie,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.history.map((h: Json) => h.action)).toEqual(["update", "create"]);
    expect(r.body.history[0].changes).toContainEqual({
      field: "data.name",
      before: "Via items",
      after: "Via items 2",
    });
  });

  // ── Batch ──────────────────────────────────────────────────────────────────

  it("POST /api/datasets/batch records each entry it writes, as dataset entries", async () => {
    if (!ready) return;
    const r = await request("POST", "/api/datasets/batch", {
      cookie: admin.cookie,
      body: {
        operations: [
          {
            op: "create",
            table: "dataEntries",
            alias: "a",
            data: { dataSetId: datasetId, title: "Batch A", data: { name: "Batch A" } },
          },
          {
            op: "update",
            table: "dataEntries",
            id: "@ref:a.id",
            data: { data: { name: "Batch A2" } },
          },
        ],
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.results[0].id as string;
    rowIds.push(id);
    const h = await request("GET", `/api/datasets/${datasetId}/entries/${id}/history`, {
      cookie: admin.cookie,
    });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body.history.map((x: Json) => x.action).sort()).toEqual(["create", "update"]);
    const update = h.body.history.find((x: Json) => x.action === "update");
    expect(update.changes).toContainEqual({
      field: "data.name",
      before: "Batch A",
      after: "Batch A2",
    });
    expect(update.actor).toMatchObject({ type: "user", id: admin.userId });
  });

  it("the batch-api processor records its writes, and a batch over the cap records none", async () => {
    if (!ready) return;
    const done = await new BatchApiProcessor().execute([
      {
        table: datasetKpis,
        action: "insert",
        data: { kpiName: `${RUN}-bapi`, expression: "p" },
        key: "k",
      },
    ]);
    expect(done.success, JSON.stringify(done.errors)).toBe(true);
    const id = done.results![0]!.id as string;
    rowIds.push(id);
    const second = await new BatchApiProcessor().execute([
      { table: datasetKpis, action: "update", id, data: { expression: "q" } },
      { table: datasetKpis, action: "upsert", id, data: { expression: "r" } },
      { table: datasetKpis, action: "delete", id, data: {} },
    ]);
    expect(second.success, JSON.stringify(second.errors)).toBe(true);
    const h = await readRecordHistory(db, "table:dataset_kpis", id);
    expect(h.history.map((x) => x.action).sort()).toEqual(["create", "delete", "update", "update"]);
    expect(h.history.every((x) => x.actor.type === "system")).toBe(true);

    // One batch update that touches 501 rows: a bulk job, no history.
    const bulk = `${RUN}-bulk`;
    const seeded = await db
      .insert(datasetKpis)
      .values(
        Array.from({ length: BULK_HISTORY_CAP + 1 }, (_, i) => ({
          kpiName: `${bulk}-${i}`,
          expression: bulk,
        }))
      )
      .returning({ id: datasetKpis.id });
    const many = await new BatchProcessor().execute([
      { op: "update", table: datasetKpis, where: { expression: bulk }, data: { description: "x" } },
    ]);
    expect(many.success).toBe(true);
    const ids = seeded.map((x) => x.id);
    const recorded = await db
      .select({ id: recordChanges.id })
      .from(recordChanges)
      .where(inArray(recordChanges.rowId, ids));
    expect(recorded.length).toBe(0);
  });

  // ── Imports never touch another dataset's entry ────────────────────────────

  it("an import naming another dataset's entry does not change or move it", async () => {
    if (!ready) return;
    const [other] = await db
      .insert(dataSets)
      .values({ name: `${RUN}-other`, slug: `${RUN}-other`, schema: [] } as never)
      .returning({ id: dataSets.id });
    try {
      const [foreign] = await db
        .insert(dataEntries)
        .values({ dataSetId: other!.id, title: "Foreign", data: { name: "Foreign" } })
        .returning();
      for (const strategy of ["upsert", "replace", "merge"]) {
        const r = await request("POST", "/api/datasets/import", {
          cookie: admin.cookie,
          body: {
            datasetId,
            data: [{ id: foreign!.id, name: "Hijacked" }],
            config: { strategy, idField: "id", skipInvalid: true },
          },
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.stats.updated, strategy).toBe(0);
        expect(r.body.stats.created, strategy).toBe(0);
        expect(r.body.errors[0].error, strategy).toContain("another dataset");
      }
      const [after] = await db.select().from(dataEntries).where(eq(dataEntries.id, foreign!.id));
      expect(after!.dataSetId).toBe(other!.id);
      expect((after!.data as Json).name).toBe("Foreign");
      expect((await historyOf(foreign!.id)).length).toBe(0);
    } finally {
      await db.delete(dataEntries).where(eq(dataEntries.dataSetId, other!.id));
      await db.delete(dataSets).where(eq(dataSets.id, other!.id));
    }
  });

  // ── Agent audit log retention ──────────────────────────────────────────────

  it("the agent audit sweep prunes past AGENT_AUDIT_RETENTION_DAYS; 0 keeps everything", async () => {
    if (!ready) return;
    expect(agentAuditRetentionDays({})).toBe(90);
    expect(agentAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: "" })).toBe(90);
    expect(agentAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: "0" })).toBeNull();
    expect(agentAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: "7" })).toBe(7);
    expect(agentAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: "x" })).toBe(90);

    const old = `${RUN}-audit-old`;
    const recent = `${RUN}-audit-recent`;
    await db.execute(sql`
      INSERT INTO agent_audit_logs (agent_id, action, resource_id, created_at) VALUES
        (${agentId}, 'retention_probe', ${old}, now() - interval '200 days'),
        (${agentId}, 'retention_probe', ${recent}, now() - interval '10 days')
    `);
    const count = async (resourceId: string) =>
      (
        await db
          .select({ id: agentAuditLogs.id })
          .from(agentAuditLogs)
          .where(eq(agentAuditLogs.resourceId, resourceId))
      ).length;
    expect(await sweepAgentAuditLogs({ AGENT_AUDIT_RETENTION_DAYS: "0" })).toBe(0);
    expect(await count(old)).toBe(1);
    expect(await sweepAgentAuditLogs({})).toBeGreaterThanOrEqual(1);
    expect(await count(old)).toBe(0);
    expect(await count(recent)).toBe(1);
    await db.delete(agentAuditLogs).where(eq(agentAuditLogs.resourceId, recent));
  });
});
