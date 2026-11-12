/**
 * Per-record change history (core migration 0076, packages/engine/src/record-history.ts)
 * ============================================================================
 *
 * Against the REAL app (test Postgres):
 *
 *   · a dataset entry created, changed and deleted over REST leaves one history
 *     row per write, newest first, with the actor (person or agent), the action
 *     and only the fields that changed;
 *   · a secret field (`data.api_token`) is listed as `redacted`, never with a value;
 *   · the history has the visibility of the entry: an account that cannot read
 *     the entry gets 404 from the route and zero rows from the table under RLS;
 *     nobody but the system writes the table;
 *   · an agent's write is recorded as the agent;
 *   · a write through the data explorer is recorded and read back at
 *     GET /api/history/:collection/:id (admin only).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, dataEntries, dataSets, recordChanges, siteSettings } from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { createAgent } from "../services/agent-auth";

import { enterAs, ensureAppRole, generateTestId, isDatabaseAvailable } from "./setup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies read in the test
type Json = any;

const ORIGIN = "http://localhost:4321";
let ready = false;
let appRole = false;
let admin = { cookie: "", userId: "" };
let editor = { cookie: "", userId: "" };
let outsider = { cookie: "", userId: "" };
let agentId = "";
let agentToken = "";
let datasetId = "";
let slug = "";
const entryIds: string[] = [];

async function request(
  method: string,
  path: string,
  o: { cookie?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
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

/** Rows of `record_changes` for a row, read as the app role with a request context. */
async function countAs(role: string, userId: string, rowId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);
    const r = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM record_changes WHERE row_id = ${rowId}`
    )) as unknown as { rows?: Array<{ n: number }> };
    return Number(r.rows?.[0]?.n ?? 0);
  });
}

async function asApp(role: string, userId: string, query: SQL): Promise<unknown> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);
    return tx.execute(query);
  });
}

describe("per-record change history", () => {
  beforeAll(async () => {
    ready = await isDatabaseAvailable();
    if (!ready) return;
    appRole = await ensureAppRole();
    clearQuotaMemory();
    const password = "TestPassword123!";
    admin = await enterAs(app, {
      email: `history-admin-${generateTestId()}@example.com`,
      password,
      name: "History Admin",
      role: "admin",
    });
    editor = await enterAs(app, {
      email: `history-editor-${generateTestId()}@example.com`,
      password,
      name: "History Editor",
      role: "editor",
    });
    outsider = await enterAs(app, {
      email: `history-user-${generateTestId()}@example.com`,
      password,
      name: "History Outsider",
    });
    slug = `history-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    // Readable by accounts, but each one only sees its own rows.
    const [ds] = await db
      .insert(dataSets)
      .values({
        name: slug,
        slug,
        schema: [
          { key: "name", type: "text" },
          { key: "api_token", type: "text" },
        ],
        policyJson: {
          readAccess: "authenticated",
          writeAccess: "authenticated",
          enableRLS: true,
          rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
        },
      } as never)
      .returning({ id: dataSets.id });
    datasetId = ds!.id;

    const { agent, plainApiKey } = await createAgent({
      name: `History Agent ${generateTestId()}`,
      scopes: [`datasets:${slug}:read`, `datasets:${slug}:write`],
      rateLimit: 100_000,
    });
    agentId = agent.id;
    agentToken = plainApiKey;
    // Writes at once, whatever the instance's approval settings are.
    const mode = await request("PUT", `/api/approvals/agents/${agentId}/mode`, {
      cookie: admin.cookie,
      body: { mode: "direct" },
    });
    expect(mode.status, JSON.stringify(mode.body)).toBe(200);
  });

  afterAll(async () => {
    if (!ready) return;
    if (entryIds.length) {
      await db.delete(recordChanges).where(inArray(recordChanges.rowId, entryIds));
      await db.delete(dataEntries).where(inArray(dataEntries.id, entryIds));
    }
    if (datasetId) await db.delete(dataSets).where(eq(dataSets.id, datasetId));
    if (agentId) await db.delete(agentIdentities).where(eq(agentIdentities.id, agentId));
  });

  it("records create, update and delete of an entry, with field diffs and the actor", async () => {
    if (!ready) return;
    const created = await request("POST", `/api/datasets/${datasetId}/entries`, {
      cookie: editor.cookie,
      body: { title: "Acme", data: { name: "Acme", api_token: "tok-one" } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    entryIds.push(id);

    const patched = await request("PATCH", `/api/datasets/${datasetId}/entries/${id}`, {
      cookie: editor.cookie,
      body: { data: { name: "Acme Corp", api_token: "tok-two" } },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    // A PATCH that changes nothing writes no history row.
    const same = await request("PATCH", `/api/datasets/${datasetId}/entries/${id}`, {
      cookie: editor.cookie,
      body: { data: { name: "Acme Corp", api_token: "tok-two" } },
    });
    expect(same.status).toBe(200);

    const r = await request("GET", `/api/datasets/${datasetId}/entries/${id}/history`, {
      cookie: editor.cookie,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.total).toBe(2);
    const [update, create] = r.body.history;
    expect(update.action).toBe("update");
    expect(update.actor).toEqual({ type: "user", id: editor.userId, name: "History Editor" });
    expect(update.changes).toContainEqual({
      field: "data.name",
      before: "Acme",
      after: "Acme Corp",
    });
    expect(create.action).toBe("create");
    expect(create.changes).toContainEqual({ field: "title", after: "Acme" });

    // The secret field is listed, never its value.
    for (const e of r.body.history) {
      const secret = e.changes.find((c: Json) => c.field === "data.api_token");
      expect(secret).toEqual({ field: "data.api_token", redacted: true });
    }
    expect(JSON.stringify(r.body)).not.toContain("tok-one");
    expect(JSON.stringify(r.body)).not.toContain("tok-two");
    const [stored] = await db
      .select({ changes: recordChanges.changes })
      .from(recordChanges)
      .where(eq(recordChanges.rowId, id))
      .limit(1);
    expect(JSON.stringify(stored?.changes)).not.toContain("tok-");

    const del = await request("DELETE", `/api/datasets/${datasetId}/entries/${id}`, {
      cookie: editor.cookie,
    });
    expect(del.status).toBe(200);
    const rows = await db
      .select({ action: recordChanges.action })
      .from(recordChanges)
      .where(eq(recordChanges.rowId, id));
    expect(rows.map((x) => x.action).sort()).toEqual(["create", "delete", "update"]);
  });

  it("history has the visibility of the entry", async () => {
    if (!ready) return;
    const created = await request("POST", `/api/datasets/${datasetId}/entries`, {
      cookie: admin.cookie,
      body: { title: "Private", data: { name: "Mine" }, ownerId: admin.userId },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    entryIds.push(id);

    const theirs = await request("GET", `/api/datasets/${datasetId}/entries/${id}/history`, {
      cookie: outsider.cookie,
    });
    expect(theirs.status).toBe(404);
    const anonymous = await request("GET", `/api/datasets/${datasetId}/entries/${id}/history`);
    // `/api/datasets/*` asks for a session before the route runs.
    expect([401, 404]).toContain(anonymous.status);

    if (!appRole) return;
    // The second wall: the table's own policy, as the API's role.
    expect(await countAs("admin", admin.userId, id)).toBe(1);
    expect(await countAs("editor", editor.userId, id)).toBe(1);
    expect(await countAs("user", outsider.userId, id)).toBe(0);
    expect(await countAs("anonymous", "", id)).toBe(0);
    expect(await countAs("agent", agentId, id)).toBe(0);
    // Nobody writes it but the system, not even an admin with a request context.
    const refused = await asApp(
      "admin",
      admin.userId,
      sql`INSERT INTO record_changes (entity, row_id, action) VALUES ('dataset_entry', ${id}, 'update')`
    ).then(
      () => null,
      (err: { cause?: { message?: string }; message?: string }) => err
    );
    expect(refused?.cause?.message ?? refused?.message ?? "").toMatch(/row-level security/);
  });

  it("an agent's write is recorded as the agent", async () => {
    if (!ready) return;
    const created = await request("POST", `/api/datasets/${datasetId}/entries`, {
      token: agentToken,
      body: { title: "By agent", data: { name: "Robo" } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    entryIds.push(id);
    const r = await request("GET", `/api/datasets/${datasetId}/entries/${id}/history`, {
      cookie: admin.cookie,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.history[0].action).toBe("create");
    expect(r.body.history[0].actor.type).toBe("agent");
    expect(r.body.history[0].actor.id).toBe(agentId);
  });

  it("explorer writes are recorded and read back, admin only", async () => {
    if (!ready) return;
    let [row] = await db.select({ id: siteSettings.id }).from(siteSettings).limit(1);
    if (!row) [row] = await db.insert(siteSettings).values({}).returning({ id: siteSettings.id });
    const id = String(row!.id);
    entryIds.push(id);
    const name = `History site ${generateTestId()}`;

    const patched = await request("PATCH", `/api/explorer/settings/${id}`, {
      cookie: admin.cookie,
      body: { siteName: name },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const r = await request("GET", `/api/history/settings/${id}`, {
      cookie: admin.cookie,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const last = r.body.history[0];
    expect(last.action).toBe("update");
    expect(last.actor.type).toBe("user");
    expect(last.changes.some((c: Json) => c.after === name)).toBe(true);

    const asEditor = await request("GET", `/api/history/settings/${id}`, {
      cookie: editor.cookie,
    });
    expect([401, 403]).toContain(asEditor.status);

    const hidden = await request("GET", `/api/history/kitsuden_secrets/x`, {
      cookie: admin.cookie,
    });
    expect(hidden.status).toBe(404);
  });
});
