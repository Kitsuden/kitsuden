/**
 * Agent safety and accountability (ROADMAP items 1, 3, 4 and 5)
 * ============================================================================
 * Against the REAL app and test Postgres (migrations 0064, 0066, 0067):
 *
 *   A. `kitsuden.effect()` in a panel-defined code action: the effect runs once
 *      across two executions of the same action, in `kitsuden_action_effects`
 *      under the action's scope.
 *   B. Deny with an alternative: in an unattended run a request that would be
 *      held is refused (403 KITSUDEN_E_DENIED_UNATTENDED + `alternative`) when
 *      the global or the agent's setting says `deny`; attended, or with `hold`
 *      (the default), it is still held (202). REST header, MCP, and a cron
 *      action's sandbox.
 *   C. Versioned agents: a version per distinct definition, every trace says
 *      which version ran, restore writes the old definition back as a new
 *      version, and only a person reaches those routes.
 *      Scopes and MCP settings are part of the version (migration 0074).
 *   D. Decisions: an agent records what it chose not to do (REST and MCP),
 *      reads only its own, is never held for approval; admins read them all,
 *      an editor those of the agents they do not sponsor.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import {
  actions,
  agentDecisions,
  agentIdentities,
  agentTraces,
  agentVersions,
  approvalSettings,
  dataEntries,
  dataSets,
} from "../db/schema";
import { app } from "../index";
import { executeAction } from "../lib/actions";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { invalidateApprovalsConfig } from "../lib/approvals";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let admin = { cookie: "", userId: "" };
const createdAgents: string[] = [];
const createdDatasets: string[] = [];
const createdActions: string[] = [];

async function newAgent(scopes: string[], systemPrompt?: string) {
  const { agent, plainApiKey } = await createAgent({
    name: `acc-${generateTestId()}`,
    scopes,
    systemPrompt,
    rateLimit: 100_000,
  });
  createdAgents.push(agent.id);
  return { id: agent.id, token: plainApiKey };
}

interface Options {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function request(method: string, path: string, o: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    app.request(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      })
    )
  );
}

const asAdmin = (method: string, path: string, body?: unknown) =>
  request(method, path, { cookie: admin.cookie, body });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies read in the test
async function json(r: Response): Promise<any> {
  return r.json();
}

async function configure(change: Record<string, unknown>) {
  const r = await asAdmin("PUT", "/api/approvals/settings", change);
  expect(r.status, await r.clone().text()).toBe(200);
  return json(r);
}

async function datasetWithRow(prefix: string, policyJson: unknown = null) {
  const slug = `${prefix}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [ds] = await db
    .insert(dataSets)
    .values({ name: slug, slug, schema: [{ key: "n", type: "text" }], policyJson } as never)
    .returning({ id: dataSets.id });
  createdDatasets.push(ds!.id);
  const [row] = await db
    .insert(dataEntries)
    .values({ dataSetId: ds!.id, title: "row", data: { n: "1" } } as never)
    .returning({ id: dataEntries.id });
  return { id: ds!.id, slug, rowId: row!.id };
}

async function rowExists(id: string): Promise<boolean> {
  return (
    (await db.select({ id: dataEntries.id }).from(dataEntries).where(eq(dataEntries.id, id)))
      .length > 0
  );
}

// ── MCP (Streamable HTTP: initialize opens the session) ──
async function mcpSession(token: string): Promise<{ token: string; sessionId: string }> {
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    })
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return { token, sessionId: sessionId! };
}

let rpcId = 1;
async function call(
  s: { token: string; sessionId: string },
  name: string,
  args: unknown,
  headers: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC read in the test
): Promise<any> {
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Type": "application/json",
        "mcp-session-id": s.sessionId,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  );
  return res.json();
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

describe("agent safety and accountability", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    clearQuotaMemory();
    admin = await enterAs(app, {
      email: `acc-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Accountable Admin",
      role: "admin",
    });
    await db.delete(approvalSettings);
    invalidateApprovalsConfig();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(approvalSettings);
    if (createdActions.length) {
      for (const id of createdActions) {
        await db.execute(sql`DELETE FROM kitsuden_action_effects WHERE scope = ${`action:${id}`}`);
      }
      await db.delete(actions).where(inArray(actions.id, createdActions));
    }
    if (createdDatasets.length)
      await db.delete(dataSets).where(inArray(dataSets.id, createdDatasets));
    if (createdAgents.length) {
      await db
        .update(agentIdentities)
        .set({ approvalMode: "inherit", unattendedApproval: null, unattendedAlternative: null })
        .where(inArray(agentIdentities.id, createdAgents));
    }
    invalidateApprovalsConfig();
  });

  // ── B. Deny with an alternative ──────────────────────────────────────────

  it("B: by default an unattended request is still held (202), as before", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true, unattended: "hold" });
    const a = await newAgent(["admin"]);
    const { slug, rowId } = await datasetWithRow("acc-hold");
    const r = await request("DELETE", `/api/items/${slug}/${rowId}`, {
      token: a.token,
      headers: { "Kitsuden-Unattended": "true" },
    });
    expect(r.status, await r.clone().text()).toBe(202);
    expect((await json(r)).code).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
    expect(await rowExists(rowId)).toBe(true);
  });

  it("B: global deny refuses the unattended request with the alternative; attended it is held", async () => {
    if (!dbAvailable) return;
    await configure({
      enabled: true,
      unattended: "deny",
      unattendedAlternative: null,
      legacyRules: [
        { method: "DELETE", path: "/api/**", alternative: "Archive it instead and tell Ana." },
      ],
    });
    const a = await newAgent(["admin"]);
    const { slug, rowId } = await datasetWithRow("acc-deny");

    const denied = await request("DELETE", `/api/items/${slug}/${rowId}`, {
      token: a.token,
      headers: { "Kitsuden-Unattended": "true" },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
    const body = await json(denied);
    expect(body.code).toBe("KITSUDEN_E_DENIED_UNATTENDED");
    expect(body.alternative).toBe("Archive it instead and tell Ana.");
    expect(body.retryable).toBe(false);
    expect(await rowExists(rowId)).toBe(true);

    // The same request, attended: held for a human as always.
    const held = await request("DELETE", `/api/items/${slug}/${rowId}`, { token: a.token });
    expect(held.status).toBe(202);

    // Audited for the panel's audit tab.
    const audit = await json(await asAdmin("GET", `/api/approvals/audit?agentId=${a.id}`));
    expect(audit.events.some((e: { action: string }) => e.action === "unattended_denied")).toBe(
      true
    );
  });

  it("B: the agent's own setting wins over the global one, with its own alternative", async () => {
    if (!dbAvailable) return;
    await configure({
      enabled: true,
      unattended: "hold",
      legacyRules: [{ method: "DELETE", path: "/api/**" }],
      unattendedAlternative: "Global text.",
    });
    const a = await newAgent(["admin"]);
    const set = await asAdmin("PUT", `/api/approvals/agents/${a.id}/unattended`, {
      mode: "deny",
      alternative: "Leave a note for the night shift.",
    });
    expect(set.status, await set.clone().text()).toBe(200);
    expect((await json(set)).mode).toBe("deny");

    const { slug, rowId } = await datasetWithRow("acc-agent");
    const r = await request("DELETE", `/api/items/${slug}/${rowId}`, {
      token: a.token,
      headers: { "Kitsuden-Unattended": "1" },
    });
    expect(r.status).toBe(403);
    expect((await json(r)).alternative).toBe("Leave a note for the night shift.");

    // Without its own text, the global one; with mode null, the global mode (hold).
    await asAdmin("PUT", `/api/approvals/agents/${a.id}/unattended`, { alternative: null });
    const r2 = await request("DELETE", `/api/items/${slug}/${rowId}`, {
      token: a.token,
      headers: { "Kitsuden-Unattended": "1" },
    });
    expect((await json(r2)).alternative).toBe("Global text.");
    await asAdmin("PUT", `/api/approvals/agents/${a.id}/unattended`, { mode: null });
    const r3 = await request("DELETE", `/api/items/${slug}/${rowId}`, {
      token: a.token,
      headers: { "Kitsuden-Unattended": "1" },
    });
    expect(r3.status).toBe(202);

    // Invalid values are a 422 (or the schema's 400), and an agent cannot set them.
    const bad = await asAdmin("PUT", `/api/approvals/agents/${a.id}/unattended`, { mode: "maybe" });
    expect([400, 422]).toContain(bad.status);
    const byAgent = await request("PUT", `/api/approvals/agents/${a.id}/unattended`, {
      token: a.token,
      body: { mode: "hold" },
    });
    expect(byAgent.status).toBe(403);
  });

  it("B: MCP — a held core tool is refused with the alternative when the POST says unattended", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true, unattended: "deny", unattendedAlternative: null });
    const { slug, rowId } = await datasetWithRow("acc-mcp", {
      readAccess: "authenticated",
      writeAccess: "authenticated",
    });
    const a = await newAgent(["mcp:connect", "mcp:read", "mcp:write"]);
    const s = await mcpSession(a.token);
    const r = await call(
      s,
      "kitsuden_delete_record",
      { collection: slug, id: rowId },
      { "Kitsuden-Unattended": "true" }
    );
    expect(r.result.isError, JSON.stringify(r)).toBe(true);
    expect(r.result.structuredContent.code).toBe("KITSUDEN_E_DENIED_UNATTENDED");
    expect(r.result.structuredContent.alternative).toContain("kitsuden_record_decision");
    expect(r.result.content[0].text).toContain("What to do instead:");
    expect(await rowExists(rowId)).toBe(true);
    // Attended: held as a proposal.
    const held = await call(s, "kitsuden_delete_record", { collection: slug, id: rowId });
    expect(held.result.structuredContent.code).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
  });

  it("A + B: a cron code action's sandbox is unattended, and its effect runs once", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true, unattended: "deny", unattendedAlternative: "Cron says no." });
    const { slug, rowId } = await datasetWithRow("acc-cron");
    const slugAction = `acc-cron-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const [action] = await db
      .insert(actions)
      .values({
        name: slugAction,
        slug: slugAction,
        type: "code",
        trigger: "cron",
        triggerConfig: { cronExpression: "0 * * * *" },
        createdById: admin.userId,
        config: {
          scopes: ["admin"],
          code: `
            const sent = await kitsuden.effect("notify:" + "${rowId}", async () => {
              console.log("SENT");
              return { at: "once" };
            });
            const r = await kitsuden.api.delete("/api/items/${slug}/${rowId}");
            return { sent, status: r.status, body: await r.json() };
          `,
        },
      } as never)
      .returning();
    createdActions.push(action!.id);

    const first = await executeAction(action!, { trigger: "cron" });
    expect(first.error, first.logs).toBeUndefined();
    const out = first.result as { sent: unknown; status: number; body: Record<string, unknown> };
    expect(out.sent).toEqual({ at: "once" });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("KITSUDEN_E_DENIED_UNATTENDED");
    expect(out.body.alternative).toBe("Cron says no.");
    expect(first.logs).toContain("SENT");
    expect(await rowExists(rowId)).toBe(true);

    // The second run of the same action finds the effect done: it does not send again.
    const second = await executeAction(action!, { trigger: "cron" });
    expect((second.result as { sent: unknown }).sent).toEqual({ at: "once" });
    expect(second.logs ?? "").not.toContain("SENT");
    const ledger = rows(
      await db.execute(
        sql`SELECT status, attempts FROM kitsuden_action_effects WHERE scope = ${`action:${action!.id}`} AND key = ${`notify:${rowId}`}`
      )
    );
    expect(ledger).toEqual([{ status: "done", attempts: 1 }]);
  }, 60_000);

  // ── C. Versioned agents ───────────────────────────────────────────────────

  it("C: a version per distinct definition; traces say which one ran; restore adds a version", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["mcp:connect"], "You are v1.");

    // The first listing creates the baseline of an agent born before any snapshot.
    const list1 = await json(await asAdmin("GET", `/api/v1/agents/${a.id}/versions`));
    expect(list1.current).toBe(1);
    expect(list1.versions[0].source).toBe("baseline");

    // Two saves, one change: one new version.
    const p1 = await asAdmin("PATCH", `/api/v1/agents/${a.id}`, { systemPrompt: "You are v2." });
    expect(p1.status, await p1.clone().text()).toBe(200);
    await asAdmin("PATCH", `/api/v1/agents/${a.id}`, { systemPrompt: "You are v2." });
    const put = await asAdmin("PUT", `/api/admin/agents/${a.id}`, {
      allowedTools: ["kitsuden_system_status"],
    });
    expect(put.status).toBe(200);
    const list2 = await json(await asAdmin("GET", `/api/v1/agents/${a.id}/versions`));
    expect(list2.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect(list2.versions[0].createdBy).toBe(admin.userId);
    expect(list2.versions[0].config.allowedTools).toEqual(["kitsuden_system_status"]);

    // A trace, inserted by any path, records the current version.
    const [t1] = await db
      .insert(agentTraces)
      .values({ agentId: a.id, name: "run", status: "running" } as never)
      .returning();
    const v3 = await json(await asAdmin("GET", `/api/v1/agents/${a.id}/versions/3`));
    expect(t1!.agentVersionId).toBe(v3.id);
    expect(v3.systemPrompt).toBe("You are v2.");

    // Changed behind the API's back: the next run snapshots it (`detected`).
    await db
      .update(agentIdentities)
      .set({ systemPrompt: "Edited by hand." })
      .where(eq(agentIdentities.id, a.id));
    const [t2] = await db
      .insert(agentTraces)
      .values({ agentId: a.id, name: "run", status: "running" } as never)
      .returning();
    const [v4] = await db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, a.id), eq(agentVersions.version, 4)));
    expect(v4!.source).toBe("detected");
    expect(t2!.agentVersionId).toBe(v4!.id);

    // Restore v1: the agent gets its definition back, as version 5.
    const restore = await asAdmin("POST", `/api/v1/agents/${a.id}/versions/1/restore`);
    expect(restore.status, await restore.clone().text()).toBe(200);
    const r = await json(restore);
    expect(r.restored).toBe(1);
    expect(r.current.version).toBe(5);
    expect(r.current.source).toBe("restore");
    expect(r.current.note).toBe("restored version 1");
    const [agentNow] = await db.select().from(agentIdentities).where(eq(agentIdentities.id, a.id));
    expect(agentNow!.systemPrompt).toBe("You are v1.");
    expect(agentNow!.allowedTools).toEqual([]);

    expect((await asAdmin("GET", `/api/v1/agents/${a.id}/versions/99`)).status).toBe(404);
  });

  it("C: scopes and MCP settings make a version, and restoring brings them back", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["mcp:connect"], "Scoped.");
    const v1 = await json(await asAdmin("GET", `/api/v1/agents/${a.id}/versions`));
    expect(v1.current).toBe(1);
    expect(v1.versions[0].config.scopes).toEqual(["mcp:connect"]);

    const scopes = await asAdmin("PUT", `/api/v1/agents/${a.id}/scopes`, {
      scopes: ["mcp:connect", "mcp:read"],
    });
    expect(scopes.status, await scopes.clone().text()).toBe(200);
    const mcp = await asAdmin("PUT", `/api/v1/agents/${a.id}/mcp-settings`, {
      untrustedWrap: "delimiters",
    });
    expect(mcp.status, await mcp.clone().text()).toBe(200);
    // Saving the same scopes again adds nothing.
    await asAdmin("PUT", `/api/v1/agents/${a.id}/scopes`, { scopes: ["mcp:connect", "mcp:read"] });

    const list = await json(await asAdmin("GET", `/api/v1/agents/${a.id}/versions`));
    expect(list.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect(list.versions[1]).toMatchObject({
      source: "update",
      note: "scopes",
      createdBy: admin.userId,
    });
    expect(list.versions[1].config.scopes).toEqual(["mcp:connect", "mcp:read"]);
    expect(list.versions[0]).toMatchObject({ source: "update", note: "MCP settings" });
    expect(list.versions[0].config.mcpSettings).toEqual({ untrustedWrap: "delimiters" });

    // Restoring v1 gives back the prompt AND the permissions of then.
    const restore = await asAdmin("POST", `/api/v1/agents/${a.id}/versions/1/restore`);
    expect(restore.status, await restore.clone().text()).toBe(200);
    const [now] = await db.select().from(agentIdentities).where(eq(agentIdentities.id, a.id));
    expect(now!.scopes).toEqual(["mcp:connect"]);
    expect(now!.mcpSettings).toEqual({});

    // A version recorded before 0074 (no scopes in it) leaves today's scopes alone.
    await db
      .update(agentVersions)
      .set({ config: { type: "custom", allowedTools: [], capabilities: [] } })
      .where(and(eq(agentVersions.agentId, a.id), eq(agentVersions.version, 2)));
    await asAdmin("POST", `/api/v1/agents/${a.id}/versions/2/restore`);
    const [after] = await db.select().from(agentIdentities).where(eq(agentIdentities.id, a.id));
    expect(after!.scopes).toEqual(["mcp:connect"]);
  });

  it("C: an agent, even with admin, cannot read or restore versions through these routes' writes", async () => {
    if (!dbAvailable) return;
    const target = await newAgent(["mcp:connect"], "Target.");
    const adminAgent = await newAgent(["admin"]);
    const restore = await request("POST", `/api/v1/agents/${target.id}/versions/1/restore`, {
      token: adminAgent.token,
    });
    expect(restore.status).toBe(403);
    const plain = await newAgent(["mcp:connect"]);
    const read = await request("GET", `/api/v1/agents/${target.id}/versions`, {
      token: plain.token,
    });
    expect([401, 403]).toContain(read.status);
  });

  // ── D. Decisions ──────────────────────────────────────────────────────────

  it("D: an agent records and reads its own decisions; never held; admins see all", async () => {
    if (!dbAvailable) return;
    // Approvals on and the agent in `propose`: even then a decision is not held.
    await configure({ enabled: true, unattended: "hold" });
    const a = await newAgent(["mcp:connect"], "Decider.");
    const b = await newAgent(["mcp:connect"]);
    await asAdmin("PUT", `/api/approvals/agents/${a.id}/mode`, { mode: "propose" });

    const created = await request("POST", "/api/agent/decisions", {
      token: a.token,
      body: {
        action: "refund order 1042",
        reason: "the order is disputed; a person must decide",
        alternatives: ["flagged it for support"],
        context: { orderId: 1042 },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const d = await json(created);
    expect(d.action).toBe("refund order 1042");
    expect(d.agentVersionId).toBeTruthy();

    await request("POST", "/api/agent/decisions", {
      token: b.token,
      body: { action: "b's action", reason: "b's reason" },
    });

    const mine = await json(await request("GET", "/api/agent/decisions", { token: a.token }));
    expect(mine.total).toBe(1);
    expect(mine.decisions[0].id).toBe(d.id);
    expect(mine.decisions[0].agentId).toBeUndefined();

    // Validation, secrets and who may write.
    const invalid = await request("POST", "/api/agent/decisions", {
      token: a.token,
      body: { action: "", reason: "x" },
    });
    expect(invalid.status).toBe(422);
    const secret = await request("POST", "/api/agent/decisions", {
      token: a.token,
      body: { action: "x", reason: "y", context: { password: "hunter22hunter22" } },
    });
    expect(secret.status).toBe(422);
    const human = await asAdmin("POST", "/api/agent/decisions", { action: "x", reason: "y" });
    expect(human.status).toBe(403);
    const anonymous = await request("GET", "/api/agent/decisions");
    expect(anonymous.status).toBe(401);

    // MCP: the same record, channel mcp.
    const s = await mcpSession(a.token);
    const viaMcp = await call(s, "kitsuden_record_decision", {
      action: "email the customer",
      reason: "no consent on file",
    });
    expect(viaMcp.result.structuredContent.channel, JSON.stringify(viaMcp)).toBe("mcp");

    // Admins read all of them; an agent does not reach the admin list.
    const all = await json(await asAdmin("GET", `/api/v1/agent-decisions?agentId=${a.id}`));
    expect(all.total).toBe(2);
    expect(all.decisions[0].agentName).toContain("acc-");
    expect(all.decisions.every((x: { version: number | null }) => x.version === 1)).toBe(true);
    const agentReads = await request("GET", "/api/v1/agent-decisions", { token: a.token });
    expect([401, 403]).toContain(agentReads.status);

    const stored = await db.select().from(agentDecisions).where(eq(agentDecisions.agentId, a.id));
    expect(stored.length).toBe(2);
  });

  it("D: an editor reads the decisions of the agents they do not sponsor; an admin agent reads none", async () => {
    if (!dbAvailable) return;
    const editor = await enterAs(app, {
      email: `acc-editor-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Accountable Editor",
      role: "editor",
    });
    const theirs = await newAgent(["mcp:connect"]);
    const other = await newAgent(["mcp:connect"]);
    await db
      .update(agentIdentities)
      .set({ sponsorUserId: editor.userId })
      .where(eq(agentIdentities.id, theirs.id));
    for (const x of [theirs, other]) {
      const r = await request("POST", "/api/agent/decisions", {
        token: x.token,
        body: { action: `skip ${x.id}`, reason: "not mine to do" },
      });
      expect(r.status, await r.clone().text()).toBe(201);
    }

    const read = (agentId: string) =>
      request("GET", `/api/v1/agent-decisions?agentId=${agentId}`, { cookie: editor.cookie });
    const ofOther = await read(other.id);
    expect(ofOther.status, await ofOther.clone().text()).toBe(200);
    expect((await json(ofOther)).total).toBe(1);
    const ofTheirs = await json(await read(theirs.id));
    expect(ofTheirs.total).toBe(0); // the agent they sponsor: like approving, not theirs to judge
    const everything = await json(
      await request("GET", "/api/v1/agent-decisions?limit=200", { cookie: editor.cookie })
    );
    expect(everything.decisions.some((d: { agentId: string }) => d.agentId === theirs.id)).toBe(
      false
    );

    // The admin sees both.
    expect(
      (await json(await asAdmin("GET", `/api/v1/agent-decisions?agentId=${theirs.id}`))).total
    ).toBe(1);

    // An agent with the `admin` scope does not get in as "staff".
    const adminAgent = await newAgent(["admin"]);
    const asAgent = await request("GET", "/api/v1/agent-decisions", { token: adminAgent.token });
    expect(asAgent.status).toBe(403);
  });
});
