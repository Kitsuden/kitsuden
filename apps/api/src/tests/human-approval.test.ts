/**
 * Human approval of what agents request
 * ============================================================================
 *
 * Against the REAL app (test Postgres, kons loaded), real agents and
 * real human accounts (admin and editor with a session):
 *
 *   · off (the default) → everything runs as before;
 *   · global on → what is sensitive from an agent in `inherit` is left as a
 *     proposal (202 + KITSUDEN_E_APPROVAL_REQUIRED + id + Location) and is NOT
 *     executed; non-sensitive goes straight through; a human is never held;
 *   · the global is the MASTER switch (off, not even `propose` holds);
 *   · per-agent modes: `propose` (writes, with selective or strict
 *     holding) and `direct` (never);
 *   · per-operation sensitivity changed by the admin and legacy rules;
 *   · approving executes ONCE with the agent's identity (and who
 *     approved is recorded); the agent sees the result; rejecting never executes;
 *   · idempotency: the same Idempotency-Key → the same proposal; another
 *     request with that key → 422; without a key, the pending one is not duplicated;
 *   · revalidation: key revoked or permission withdrawn in between → it is not
 *     executed;
 *   · an agent (not even with `admin`) does not approve or configure; an editor only
 *     approves what they could do themselves;
 *   · MCP: SDK and core tool held, `kitsuden_proposal_status`;
 *   · expiry, secrets and audit.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db } from "../db";
import {
  agentApiKeys,
  agentAuditLogs,
  agentIdentities,
  agentProposals,
  approvalSettings,
  authUsers,
  dataEntries,
  dataSets,
} from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { invalidateApprovalsConfig } from "../lib/approvals";
import { installedKon } from "../lib/installed-kons";
import { createAgent } from "../services/agent-auth";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

// kon-blog is an INSTALLABLE kon (kitsuden-kons repo): without it there are no routes to
// test. Anything that uses it is skipped in a clean clone of the core instead of failing.
const WITHOUT_BLOG = !installedKon("kon-blog")?.path;
// The blog categories table (the sample sensitive operation), if present.
// (specifier in a variable: that way the core compiles without the kon installed)
const BLOG_SCHEMA = "../../../../packages/kons/kon-blog/src/schema.local";
const { blogCategories } = (WITHOUT_BLOG ? {} : await import(BLOG_SCHEMA)) as {
  blogCategories: PgTable & { id: PgColumn };
};

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let admin = { cookie: "", userId: "" };
let editor = { cookie: "", userId: "" };
let authorId = "";
const createdAgents: string[] = [];

async function newAgent(scopes: string[]): Promise<{ id: string; token: string }> {
  const { agent, plainApiKey } = await createAgent({
    name: `approval-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  createdAgents.push(agent.id);
  return { id: agent.id, token: plainApiKey };
}

interface Options {
  token?: string | null;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function request(method: string, path: string, o: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
  );
}

const asAdmin = (method: string, path: string, body?: unknown) =>
  request(method, path, { cookie: admin.cookie, body });

async function configure(change: Record<string, unknown>) {
  const r = await asAdmin("PUT", "/api/approvals/settings", change);
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json();
}

async function mode(agentId: string, m: "inherit" | "propose" | "direct") {
  const r = await asAdmin("PUT", `/api/approvals/agents/${agentId}/mode`, { mode: m });
  expect(r.status, await r.clone().text()).toBe(200);
}

async function category(): Promise<string> {
  const slug = `approval-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [c] = await db
    .insert(blogCategories)
    .values({ name: slug, slug } as never)
    .returning({ id: blogCategories.id });
  return c!.id as string;
}

async function categoryExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: blogCategories.id })
    .from(blogCategories)
    .where(eq(blogCategories.id, id));
  return rows.length > 0;
}

async function datasetWithRow(
  prefix: string,
  policyJson: unknown = null
): Promise<{ id: string; slug: string; rowId: string }> {
  const slug = `${prefix}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [ds] = await db
    .insert(dataSets)
    .values({ name: slug, slug, schema: [{ key: "n", type: "text" }], policyJson } as never)
    .returning({ id: dataSets.id });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies read in the test
async function json(r: Response): Promise<any> {
  return r.json();
}

// ── MCP ──
interface Session {
  token: string;
  sessionId: string;
  close: () => Promise<void>;
}
const open: Session[] = [];
async function mcpSession(token: string): Promise<Session> {
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", { headers: { Authorization: `Bearer ${token}` } })
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const sessionId = text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!;
  const s = { token, sessionId, close: () => reader.cancel().catch(() => {}) };
  open.push(s);
  return s;
}
let rpcId = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC read in the test
async function rpc(s: Session, method: string, params: unknown): Promise<any> {
  const res = await app.request(
    new Request(`http://localhost:3000/api/mcp?sessionId=${s.sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    })
  );
  return res.json();
}
const call = (s: Session, name: string, args: unknown) =>
  rpc(s, "tools/call", { name, arguments: args });

describe.skipIf(WITHOUT_BLOG)("human approval — human approval", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    clearQuotaMemory();
    admin = await enterAs(app, {
      email: `approval-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Approver",
      role: "admin",
    });
    editor = await enterAs(app, {
      email: `approval-editor-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Editor",
      role: "editor",
    });
    authorId = admin.userId;
    await db.delete(approvalSettings);
    invalidateApprovalsConfig();
  });

  afterAll(async () => {
    for (const s of open) await s.close();
    if (!dbAvailable) return;
    // The defaults again: the other test files expect the usual API.
    await db.delete(approvalSettings);
    if (createdAgents.length) {
      await db
        .update(agentIdentities)
        .set({ approvalMode: "inherit" })
        .where(inArray(agentIdentities.id, createdAgents));
    }
    invalidateApprovalsConfig();
  });

  // ── 1. Off: as before ──
  it("by default (off) an agent deletes directly and no proposal is created", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const r = await request("DELETE", `/api/blog/categories/${id}`, { token: a.token });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    expect(await categoryExists(id)).toBe(false);
    const proposals = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.agentId, a.id));
    expect(proposals.length).toBe(0);
  });

  // ── 2. Global on ──
  it("global on: an agent's DELETE is left as a proposal (202) and is not executed", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const other = await newAgent(["blog:*"]);
    const id = await category();

    const r = await request("DELETE", `/api/blog/categories/${id}`, { token: a.token });
    expect(r.status).toBe(202);
    const body = await json(r);
    expect(body.code).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
    expect(body.proposal.status).toBe("pending");
    expect(body.proposal.reason).toBe("sensitive");
    expect(body.proposal.operation).toBe("kon:blog:delete-category");
    expect(r.headers.get("location")).toBe(`/api/proposals/${body.proposal.id}`);
    expect(await categoryExists(id)).toBe(true);

    // The agent queries it; another agent does not see it
    const status = await request("GET", `/api/proposals/${body.proposal.id}`, { token: a.token });
    expect(status.status, await status.clone().text()).toBe(200);
    expect((await json(status)).status).toBe("pending");
    expect(
      (await request("GET", `/api/proposals/${body.proposal.id}`, { token: other.token })).status
    ).toBe(404);

    // What is not sensitive runs: creating a category
    const slug = `ok-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const create = await request("POST", "/api/blog/categories", {
      token: a.token,
      body: { name: slug, slug },
    });
    expect(create.status, await create.clone().text()).toBe(201);

    // A human is never held
    const id2 = await category();
    const human = await asAdmin("DELETE", `/api/blog/categories/${id2}`);
    expect(human.status).toBeLessThan(300);
    expect(await categoryExists(id2)).toBe(false);
  });

  it("approving executes ONCE with the agent's identity; the agent sees the result; the audit counts it", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const p = await json(await request("DELETE", `/api/blog/categories/${id}`, { token: a.token }));
    const pid = p.proposal.id as string;

    // Inbox and counter
    const inbox = await json(await asAdmin("GET", "/api/approvals/proposals?status=pending"));
    expect(inbox.proposals.some((x: { id: string }) => x.id === pid)).toBe(true);
    expect(
      (await json(await asAdmin("GET", "/api/approvals/proposals/count"))).pending
    ).toBeGreaterThan(0);
    const detail = await json(await asAdmin("GET", `/api/approvals/proposals/${pid}`));
    expect(detail.canDecide).toBe(true);
    expect(detail.agentId).toBe(a.id);

    // Two approvals at once: one executes, the other 409
    const [r1, r2] = await Promise.all([
      asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, { comment: "ok" }),
      asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, { comment: "ok" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = await json(r1.status === 200 ? r1 : r2);
    expect(winner.proposal.status).toBe("executed");
    expect(winner.proposal.decidedBy).toBe(admin.userId);
    expect(winner.proposal.result.status).toBeLessThan(300);
    expect(await categoryExists(id)).toBe(false);

    // A third, already executed: 409 and nothing is repeated
    expect((await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {})).status).toBe(409);
    const executions = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentAuditLogs)
      .where(
        sql`${agentAuditLogs.resourceId} = ${pid} AND ${agentAuditLogs.action} = 'proposal_executed'`
      );
    expect(executions[0]!.n).toBe(1);

    // The agent sees the result
    const seen = await json(await request("GET", `/api/proposals/${pid}`, { token: a.token }));
    expect(seen.status).toBe("executed");
    expect(seen.result.status).toBeLessThan(300);
    expect(seen.comment).toBe("ok");

    // Audit: proposal, approval (with who) and execution
    const audit = await json(await asAdmin("GET", `/api/approvals/audit?proposalId=${pid}`));
    const actions = audit.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["proposal_created", "proposal_approved", "proposal_executed"])
    );
    const approved = audit.events.find((e: { action: string }) => e.action === "proposal_approved");
    expect(approved.by).toBe(admin.userId);
    expect(approved.byName).toBe("Approver");
  });

  it("reject: it never executes and the agent sees the comment", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const pid = (
      await json(await request("DELETE", `/api/blog/categories/${id}`, { token: a.token }))
    ).proposal.id;
    const r = await asAdmin("POST", `/api/approvals/proposals/${pid}/reject`, {
      comment: "is not deleted",
    });
    expect(r.status).toBe(200);
    expect((await json(r)).proposal.status).toBe("rejected");
    expect((await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {})).status).toBe(409);
    expect(await categoryExists(id)).toBe(true);
    const seen = await json(await request("GET", `/api/proposals/${pid}`, { token: a.token }));
    expect(seen.status).toBe("rejected");
    expect(seen.comment).toBe("is not deleted");
    expect(seen.result).toBeUndefined();
  });

  // ── 3. Idempotency ──
  it("same Idempotency-Key → the same proposal; another request with that key → 422; without a key it is not duplicated", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const key = `approval-${generateTestId()}`;
    const r1 = await request("DELETE", `/api/blog/categories/${id}`, {
      token: a.token,
      headers: { "Idempotency-Key": key },
    });
    const r2 = await request("DELETE", `/api/blog/categories/${id}`, {
      token: a.token,
      headers: { "Idempotency-Key": key },
    });
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    const p1 = (await json(r1)).proposal.id;
    expect((await json(r2)).proposal.id).toBe(p1);
    const other = await category();
    const r3 = await request("DELETE", `/api/blog/categories/${other}`, {
      token: a.token,
      headers: { "Idempotency-Key": key },
    });
    expect(r3.status).toBe(422);

    // Without a key: the same DELETE twice → a single pending one
    const s1 = await json(
      await request("DELETE", `/api/blog/categories/${other}`, { token: a.token })
    );
    const s2 = await json(
      await request("DELETE", `/api/blog/categories/${other}`, { token: a.token })
    );
    expect(s2.proposal.id).toBe(s1.proposal.id);
    const rows = await db.select().from(agentProposals).where(eq(agentProposals.agentId, a.id));
    expect(rows.length).toBe(2);
  });

  // ── 4. Per-agent modes and per-operation sensitivity ──
  it("propose mode: every write is a proposal (reads are not); direct mode: never, even if enabled", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true, proposeRetention: "selective" });
    const p = await newAgent(["blog:*"]);
    await mode(p.id, "propose");
    const slug = `pr-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const create = await request("POST", "/api/blog/categories", {
      token: p.token,
      body: { name: slug, slug },
    });
    expect(create.status).toBe(202);
    expect((await json(create)).proposal.reason).toBe("propose_only");
    expect((await request("GET", "/api/blog/categories", { token: p.token })).status).toBe(200);

    // Selective holding: a POST declared readOnly is not held; strict, it is.
    const seo = { title: "A test title" };
    expect(
      (await request("POST", "/api/blog/validate-seo", { token: p.token, body: seo })).status
    ).toBe(200);
    await configure({ proposeRetention: "strict" });
    const strictItem = await request("POST", "/api/blog/validate-seo", {
      token: p.token,
      body: seo,
    });
    expect(strictItem.status, await strictItem.clone().text()).toBe(202);
    await configure({ proposeRetention: "selective" });

    const d = await newAgent(["blog:*"]);
    await mode(d.id, "direct");
    const id = await category();
    const r = await request("DELETE", `/api/blog/categories/${id}`, { token: d.token });
    expect(r.status).toBeLessThan(300);
    expect(await categoryExists(id)).toBe(false);
  });

  it("the global is the MASTER switch: off, an agent in propose does not ask for approval either", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: false });
    const p = await newAgent(["blog:*"]);
    await mode(p.id, "propose");
    const slug = `pm-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const create = await request("POST", "/api/blog/categories", {
      token: p.token,
      body: { name: slug, slug },
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const id = await category();
    expect(
      (await request("DELETE", `/api/blog/categories/${id}`, { token: p.token })).status
    ).toBeLessThan(300);
    expect(await categoryExists(id)).toBe(false);
    const without = await db.select().from(agentProposals).where(eq(agentProposals.agentId, p.id));
    expect(without.length).toBe(0);
  });

  it("the admin changes an operation's sensitivity and the legacy rules, without restarting", async () => {
    if (!dbAvailable) return;
    await configure({
      enabled: true,
      operations: { "kon:blog:delete-category": false, "kon:blog:create-category": true },
    });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    expect(
      (await request("DELETE", `/api/blog/categories/${id}`, { token: a.token })).status
    ).toBeLessThan(300);
    const slug = `s-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    expect(
      (
        await request("POST", "/api/blog/categories", {
          token: a.token,
          body: { name: slug, slug },
        })
      ).status
    ).toBe(202);
    // Back to what is declared
    await configure({
      operations: { "kon:blog:delete-category": null, "kon:blog:create-category": null },
    });
    const settings = await json(await asAdmin("GET", "/api/approvals/settings"));
    const op = settings.operations.find(
      (o: { key: string }) => o.key === "kon:blog:delete-category"
    );
    expect(op).toMatchObject({ default: true, override: null, sensitive: true });
    expect(settings.config.legacyRules).toEqual([{ method: "DELETE", path: "/api/**" }]);
    // Validation
    expect(
      (
        await asAdmin("PUT", "/api/approvals/settings", {
          legacyRules: [{ method: "GET", path: "nope" }],
        })
      ).status
    ).toBe(422);
    expect((await asAdmin("PUT", "/api/approvals/settings", { ttlHours: 0 })).status).toBe(422);
  });

  it("a LEGACY route covered by the DELETE /api/** rule is also held", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["admin"]);
    const { slug, rowId } = await datasetWithRow("leg");
    const r = await request("DELETE", `/api/items/${slug}/${rowId}`, { token: a.token });
    expect(r.status, await r.clone().text()).toBe(202);
    const body = await json(r);
    expect(body.proposal.operation).toBeNull();
    expect(await rowExists(rowId)).toBe(true);
    // It is approved and executed through the legacy route
    const ok = await json(
      await asAdmin("POST", `/api/approvals/proposals/${body.proposal.id}/approve`, {})
    );
    expect(ok.proposal.status, JSON.stringify(ok.proposal.result)).toBe("executed");
    expect(await rowExists(rowId)).toBe(false);
  });

  it("the diff of a PATCH: what exists now versus what is proposed", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: false });
    const a = await newAgent(["blog:*"]);
    const before = `Before ${generateTestId()}`;
    const create = await request("POST", "/api/blog", {
      token: a.token,
      body: { title: before, authorId },
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const { id } = await json(create);
    // Published: an agent does not see a draft (blog rule), and the diff is
    // read WITH its identity (without a visible draft, the diff says it could not read).
    await db.execute(
      sql`UPDATE blog_posts SET status = 'published', published_at = now() - interval '1 hour' WHERE id = ${id}`
    );
    await mode(a.id, "propose");
    await configure({ enabled: true });
    const r = await request("PATCH", `/api/blog/${id}`, {
      token: a.token,
      body: { title: "After" },
    });
    expect(r.status).toBe(202);
    const detail = await json(
      await asAdmin("GET", `/api/approvals/proposals/${(await json(r)).proposal.id}`)
    );
    expect(detail.diff.kind).toBe("update");
    expect(detail.diff.changes).toEqual([{ field: "title", before, after: "After" }]);
    expect(detail.body).toEqual({ title: "After" });
  });

  // ── 5. Revalidation ──
  it("key revoked or permission withdrawn between the proposal and the approval → it is not executed", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const pid = (
      await json(await request("DELETE", `/api/blog/categories/${id}`, { token: a.token }))
    ).proposal.id;
    await db
      .update(agentApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(agentApiKeys.agentId, a.id));
    const r = await json(await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {}));
    expect(r.proposal.status).toBe("failed");
    expect(r.proposal.result.error).toContain("key_revoked");
    expect(await categoryExists(id)).toBe(true);

    const b = await newAgent(["blog:*"]);
    const id2 = await category();
    const pid2 = (
      await json(await request("DELETE", `/api/blog/categories/${id2}`, { token: b.token }))
    ).proposal.id;
    await db
      .update(agentIdentities)
      .set({ scopes: ["mcp:connect"] })
      .where(eq(agentIdentities.id, b.id));
    const r2 = await json(await asAdmin("POST", `/api/approvals/proposals/${pid2}/approve`, {}));
    expect(r2.proposal.status).toBe("failed");
    expect(await categoryExists(id2)).toBe(true);
  });

  it("expired: it cannot be approved and it is audited", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const pid = (
      await json(await request("DELETE", `/api/blog/categories/${id}`, { token: a.token }))
    ).proposal.id;
    await db
      .update(agentProposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentProposals.id, pid));
    const r = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {});
    expect(r.status).toBe(409);
    expect((await json(r)).proposal.status).toBe("expired");
    expect(await categoryExists(id)).toBe(true);
    const audit = await json(await asAdmin("GET", `/api/approvals/audit?proposalId=${pid}`));
    expect(audit.events.some((e: { action: string }) => e.action === "proposal_expired")).toBe(
      true
    );
  });

  it("a body with secrets is not stored: 403 KITSUDEN_E_APPROVAL_UNSUPPORTED", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    await mode(a.id, "propose");
    const r = await request("POST", "/api/blog/categories", {
      token: a.token,
      body: { name: "x", slug: "x", password: "hunter2-secret" },
    });
    expect(r.status).toBe(403);
    const body = await json(r);
    expect(body.code).toBe("KITSUDEN_E_APPROVAL_UNSUPPORTED");
    expect(body.reason).toBe("secret");
  });

  // ── 6. Who decides and who configures ──
  it("an agent, not even with admin, approves, rejects, configures or changes modes", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["blog:*"]);
    const id = await category();
    const pid = (
      await json(await request("DELETE", `/api/blog/categories/${id}`, { token: a.token }))
    ).proposal.id;
    const boss = await newAgent(["admin"]);
    for (const token of [a.token, boss.token]) {
      expect(
        (await request("POST", `/api/approvals/proposals/${pid}/approve`, { token, body: {} }))
          .status
      ).toBe(403);
      expect(
        (await request("POST", `/api/approvals/proposals/${pid}/reject`, { token, body: {} }))
          .status
      ).toBe(403);
      expect(
        (await request("PUT", "/api/approvals/settings", { token, body: { enabled: false } }))
          .status
      ).toBe(403);
      expect(
        (
          await request("PUT", `/api/approvals/agents/${a.id}/mode`, {
            token,
            body: { mode: "direct" },
          })
        ).status
      ).toBe(403);
      expect((await request("GET", "/api/approvals/proposals", { token })).status).toBe(403);
    }
    expect(await categoryExists(id)).toBe(true);
    const follows = await db.select().from(agentProposals).where(eq(agentProposals.id, pid));
    expect(follows[0]!.status).toBe("pending");
    const settings = await json(await asAdmin("GET", "/api/approvals/settings"));
    expect(settings.config.enabled).toBe(true);
  });

  it("an editor approves what their role can do, but does not configure or approve admin's items", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["admin"]);
    const id = await category();
    const pid = (
      await json(await request("DELETE", `/api/blog/categories/${id}`, { token: a.token }))
    ).proposal.id;
    const ok = await request("POST", `/api/approvals/proposals/${pid}/approve`, {
      cookie: editor.cookie,
      body: {},
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await json(ok)).proposal.status).toBe("executed");

    // DELETE on /api/items (legacy route, admin gate): the editor cannot
    const { slug, rowId } = await datasetWithRow("ed");
    const pid2 = (
      await json(await request("DELETE", `/api/items/${slug}/${rowId}`, { token: a.token }))
    ).proposal.id;
    const detail = await json(
      await request("GET", `/api/approvals/proposals/${pid2}`, { cookie: editor.cookie })
    );
    expect(detail.canDecide).toBe(false);
    expect(
      (
        await request("POST", `/api/approvals/proposals/${pid2}/approve`, {
          cookie: editor.cookie,
          body: {},
        })
      ).status
    ).toBe(403);
    expect(
      (
        await request("PUT", "/api/approvals/settings", {
          cookie: editor.cookie,
          body: { enabled: false },
        })
      ).status
    ).toBe(403);
    // An account without a role, out
    const normal = await enterAs(app, {
      email: `approval-user-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Normal",
    });
    expect(
      (await request("GET", "/api/approvals/proposals", { cookie: normal.cookie })).status
    ).toBe(403);
    expect((await request("GET", `/api/proposals/${pid2}`, { cookie: normal.cookie })).status).toBe(
      403
    );
    expect((await request("GET", `/api/proposals/${pid2}`)).status).toBe(401);
  });

  // ── 7. MCP ──
  it("MCP: SDK tool held → pending with id; kitsuden_proposal_status; approved → result", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    const a = await newAgent(["mcp:connect", "blog:*"]);
    const s = await mcpSession(a.token);
    const list = await rpc(s, "tools/list", {});
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("kitsuden_proposal_status");

    const id = await category();
    const r = await call(s, "blog__delete-category", { id });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent.code).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
    const pid = r.result.structuredContent.proposal.id as string;
    expect(await categoryExists(id)).toBe(true);

    const status = await call(s, "kitsuden_proposal_status", { proposal_id: pid });
    expect(status.result.structuredContent.status).toBe("pending");
    expect(status.result.structuredContent.channel).toBe("mcp");

    const ok = await json(await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {}));
    expect(ok.proposal.status, JSON.stringify(ok.proposal.result)).toBe("executed");
    expect(await categoryExists(id)).toBe(false);
    const fin = await call(s, "kitsuden_proposal_status", { proposal_id: pid });
    expect(fin.result.structuredContent.status).toBe("executed");

    // Another agent's: it does not exist for this one
    const b = await newAgent(["mcp:connect"]);
    const sb = await mcpSession(b.token);
    const foreign = await call(sb, "kitsuden_proposal_status", { proposal_id: pid });
    expect(foreign.error?.data?.code ?? foreign.result?.structuredContent?.code).toBe(
      "KITSUDEN_E_NOT_FOUND"
    );
  });

  it("MCP: core tool (kitsuden_delete_record) held and executed on approval", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    // Open to any session: the broad MCP scope does not open a dataset that
    // its policy closes.
    const {
      id: dsId,
      slug,
      rowId,
    } = await datasetWithRow("mcpn", {
      readAccess: "authenticated",
      writeAccess: "authenticated",
    });
    const row = { id: rowId };
    const ds = { id: dsId };
    const a = await newAgent(["mcp:connect", "mcp:read", "mcp:write"]);
    const s = await mcpSession(a.token);
    const r = await call(s, "kitsuden_delete_record", { collection: slug, id: row!.id });
    expect(r.result.structuredContent.code, JSON.stringify(r)).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
    const pid = r.result.structuredContent.proposal.id as string;
    expect((await db.select().from(dataEntries).where(eq(dataEntries.id, row!.id))).length).toBe(1);

    // An editor does not approve core tools
    expect(
      (
        await request("POST", `/api/approvals/proposals/${pid}/approve`, {
          cookie: editor.cookie,
          body: {},
        })
      ).status
    ).toBe(403);
    const ok = await json(await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {}));
    expect(ok.proposal.status, JSON.stringify(ok.proposal.result)).toBe("executed");
    expect((await db.select().from(dataEntries).where(eq(dataEntries.id, row!.id))).length).toBe(0);
    await db.delete(dataSets).where(eq(dataSets.id, ds!.id));
  });

  // ── 8. Configuration audit and turning off ──
  it("the configuration is audited (who and when) and when turned off everything runs directly again", async () => {
    if (!dbAvailable) return;
    await configure({ enabled: true });
    await configure({ enabled: false });
    const audit = await json(await asAdmin("GET", "/api/approvals/audit?limit=20"));
    const changes = audit.events.filter(
      (e: { action: string }) => e.action === "approval_settings_changed"
    );
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes[0].by).toBe(admin.userId);
    expect(changes[0].details.after.enabled).toBe(false);
    const settings = await json(await asAdmin("GET", "/api/approvals/settings"));
    expect(settings.updatedBy).toBe(admin.userId);

    const a = await newAgent(["blog:*"]);
    const id = await category();
    expect(
      (await request("DELETE", `/api/blog/categories/${id}`, { token: a.token })).status
    ).toBeLessThan(300);
    expect(await categoryExists(id)).toBe(false);
    const row = await db.select().from(authUsers).where(eq(authUsers.id, admin.userId));
    expect(row.length).toBe(1);
  });
});
