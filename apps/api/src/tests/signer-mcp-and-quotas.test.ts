/**
 * Three design decisions
 * ============================================================================
 *
 * Against the REAL app (test Postgres, kons loaded). Each block fails
 * without its change:
 *
 *   1. A human SIGNER per agent: what the agent creates (blog author,
 *      owner of dataset entries via REST, the lite API and MCP) is signed by its
 *      responsible human; `created_by_id` is the agent; another author only with
 *      `admin`; signer without a role → 403 KITSUDEN_E_AGENT_SPONSOR_INVALID; without a
 *      signer, as before; when a proposal is approved, agent + signer
 *      + approver are recorded.
 *   2. Hardened MCP: `mcp:read`/`mcp:write` open the tool, not a
 *      dataset that its `policyJson` closes; `datasets:<slug>:*` does; the
 *      `rlsRules` are applied as in REST; an agent with only `content:edit`
 *      (Inti) does not change.
 *   3. Idempotency replays (`Idempotent-Replayed: true`) do not
 *      spend quota, via REST or MCP.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import {
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
const itWithBlog = WITHOUT_BLOG ? it.skip : it;

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let admin = { cookie: "", userId: "" };
let signer = { cookie: "", userId: "" };
const agents: string[] = [];
const datasets: string[] = [];

async function newAgent(
  scopes: string[],
  extra: Partial<typeof agentIdentities.$inferInsert> = {}
) {
  const { agent, plainApiKey } = await createAgent({
    name: `signer-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  agents.push(agent.id);
  if (Object.keys(extra).length)
    await db.update(agentIdentities).set(extra).where(eq(agentIdentities.id, agent.id));
  return { id: agent.id, token: plainApiKey };
}

async function request(
  method: string,
  path: string,
  o: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
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
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, headers: res.headers };
}

async function dataset(prefix: string, policyJson: unknown) {
  const slug = `${prefix}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [ds] = await db
    .insert(dataSets)
    .values({ name: slug, slug, schema: [{ key: "n", type: "text" }], policyJson } as never)
    .returning({ id: dataSets.id, slug: dataSets.slug });
  datasets.push(ds!.id);
  return ds!;
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
  const s = {
    token,
    sessionId: text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!,
    close: () => reader.cancel().catch(() => {}),
  };
  open.push(s);
  return s;
}
let rpcId = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC read in the test
async function call(s: Session, name: string, args: unknown): Promise<any> {
  const res = await app.request(
    new Request(`http://localhost:3000/api/mcp?sessionId=${s.sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
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
const isError = (r: { result?: { isError?: boolean }; error?: unknown }) =>
  Boolean(r.error) || r.result?.isError === true;
const textOf = (r: { result?: { content?: { text: string }[] }; error?: { message?: string } }) =>
  r.result?.content?.[0]?.text ?? r.error?.message ?? "";

const uniqueSlug = (p: string) =>
  `${p}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

describe("human approval — signer, hardened MCP and replays without quota", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    clearQuotaMemory();
    admin = await enterAs(app, {
      email: `signer-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Admin Signer",
      role: "admin",
    });
    signer = await enterAs(app, {
      email: `signer-ed-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Signer",
      role: "editor",
    });
    await db.delete(approvalSettings);
    invalidateApprovalsConfig();
  });

  afterAll(async () => {
    for (const s of open) await s.close();
    if (!dbAvailable) return;
    await db.delete(approvalSettings);
    invalidateApprovalsConfig();
    if (datasets.length) await db.delete(dataSets).where(inArray(dataSets.id, datasets));
  });

  // ══ 1. Signer ══════════════════════════════════════════════════════════

  itWithBlog(
    "without a signer, the blog works as before; with a signer, the agent writes AS its signer",
    async () => {
      if (!dbAvailable) return;
      const a = await newAgent(["blog:*"]);
      // As before: without authorId, 400; with any, it works
      expect(
        (
          await request("POST", "/api/blog", {
            token: a.token,
            body: { title: uniqueSlug("without") },
          })
        ).status
      ).toBe(400);
      const free = await request("POST", "/api/blog", {
        token: a.token,
        body: { title: uniqueSlug("free"), authorId: admin.userId },
      });
      expect(free.status, JSON.stringify(free.body)).toBe(201);

      // The admin chooses the signer in /api/v1 (what the panel does)
      const slot = await request("PUT", `/api/v1/agents/${a.id}/sponsor`, {
        cookie: admin.cookie,
        body: { userId: signer.userId },
      });
      expect(slot.status, JSON.stringify(slot.body)).toBe(200);
      expect(slot.body.sponsor).toMatchObject({
        userId: signer.userId,
        valid: true,
        role: "editor",
      });
      expect(slot.body.candidates.some((c: { id: string }) => c.id === signer.userId)).toBe(true);

      const signed = await request("POST", "/api/blog", {
        token: a.token,
        body: { title: uniqueSlug("signed") },
      });
      expect(signed.status, JSON.stringify(signed.body)).toBe(201);
      expect(signed.body.authorId).toBe(signer.userId);
      const same = await request("POST", "/api/blog", {
        token: a.token,
        body: { title: uniqueSlug("same"), authorId: signer.userId },
      });
      expect(same.status).toBe(201);
      const foreign = await request("POST", "/api/blog", {
        token: a.token,
        body: { title: uniqueSlug("foreign"), authorId: admin.userId },
      });
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe("KITSUDEN_E_FORBIDDEN");

      // With `admin`, it can name another author
      const boss = await newAgent(["admin"], { sponsorUserId: signer.userId });
      const other = await request("POST", "/api/blog", {
        token: boss.token,
        body: { title: uniqueSlug("boss"), authorId: admin.userId },
      });
      expect(other.status, JSON.stringify(other.body)).toBe(201);
      expect(other.body.authorId).toBe(admin.userId);

      // Only an admin or editor can be a signer
      const normal = await enterAs(app, {
        email: `signer-u-${generateTestId()}@example.com`,
        password: "TestPassword123!",
        name: "Normal",
      });
      expect(
        (
          await request("PUT", `/api/v1/agents/${a.id}/sponsor`, {
            cookie: admin.cookie,
            body: { userId: normal.userId },
          })
        ).status
      ).toBe(422);
      // Remove it: back to how it was
      expect(
        (
          await request("PUT", `/api/v1/agents/${a.id}/sponsor`, {
            cookie: admin.cookie,
            body: { userId: null },
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request("POST", "/api/blog", {
            token: a.token,
            body: { title: uniqueSlug("again") },
          })
        ).status
      ).toBe(400);
    }
  );

  it("dataset entries created by the agent belong to the signer (REST, lite API and MCP); created_by_id is the agent", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("signer-ds", null);
    const a = await newAgent(
      ["mcp:connect", `datasets:${ds.slug}:write`, `datasets:${ds.slug}:read`],
      { sponsorUserId: signer.userId }
    );

    const rest = await request("POST", `/api/datasets/${ds.id}/entries`, {
      token: a.token,
      body: { title: "rest", data: { n: "1" } },
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    const lite = await request("POST", `/api/data-sets/${ds.id}/entries`, {
      token: a.token,
      body: { title: "lite", n: "2" },
    });
    expect(lite.status, JSON.stringify(lite.body)).toBe(201);
    const s = await mcpSession(a.token);
    const mcp = await call(s, "kitsuden_insert_record", {
      datasetId: ds.id,
      data: { title: "mcp", n: "3" },
    });
    expect(isError(mcp), textOf(mcp)).toBe(false);

    const rows = await db
      .select({ title: dataEntries.title, owner: dataEntries.ownerId, by: dataEntries.createdById })
      .from(dataEntries)
      .where(eq(dataEntries.dataSetId, ds.id));
    expect(rows.length).toBe(3);
    for (const f of rows) {
      expect(f.owner, f.title).toBe(signer.userId);
      expect(f.by, f.title).toBe(a.id);
    }

    // Without a signer: no owner, as before (and a foreign ownerId from an agent without admin does not get through)
    const b = await newAgent(["mcp:connect", `datasets:${ds.slug}:write`]);
    const sb = await mcpSession(b.token);
    const withoutSignature = await call(sb, "kitsuden_insert_record", {
      datasetId: ds.id,
      data: { title: "unsigned", ownerId: admin.userId },
    });
    expect(isError(withoutSignature), textOf(withoutSignature)).toBe(false);
    const [row] = await db
      .select({ owner: dataEntries.ownerId })
      .from(dataEntries)
      .where(sql`${dataEntries.dataSetId} = ${ds.id} AND ${dataEntries.title} = 'unsigned'`);
    expect(row!.owner).toBeNull();
  });

  itWithBlog(
    "if the signer loses their role, the agent does not create signed content until it is reassigned",
    async () => {
      if (!dbAvailable) return;
      const who = await enterAs(app, {
        email: `signer-removed-${generateTestId()}@example.com`,
        password: "TestPassword123!",
        name: "Removed",
        role: "editor",
      });
      const ds = await dataset("signer-removed", null);
      const a = await newAgent(["blog:*", `datasets:${ds.slug}:write`], {
        sponsorUserId: who.userId,
      });
      expect(
        (
          await request("POST", "/api/blog", {
            token: a.token,
            body: { title: uniqueSlug("before") },
          })
        ).status
      ).toBe(201);

      await db.update(authUsers).set({ role: "user" }).where(eq(authUsers.id, who.userId));
      const blog = await request("POST", "/api/blog", {
        token: a.token,
        body: { title: uniqueSlug("after") },
      });
      expect(blog.status).toBe(403);
      expect(blog.body.code).toBe("KITSUDEN_E_AGENT_SPONSOR_INVALID");
      const input = await request("POST", `/api/datasets/${ds.id}/entries`, {
        token: a.token,
        body: { title: "x", data: { n: "1" } },
      });
      expect(input.status).toBe(403);
      expect(input.body.code).toBe("KITSUDEN_E_AGENT_SPONSOR_INVALID");
      const view = await request("GET", `/api/v1/agents/${a.id}/sponsor`, { cookie: admin.cookie });
      expect(view.body.sponsor).toMatchObject({
        userId: who.userId,
        valid: false,
        reason: "not_staff",
      });

      // Reassigned: it signs again
      await request("PUT", `/api/v1/agents/${a.id}/sponsor`, {
        cookie: admin.cookie,
        body: { userId: signer.userId },
      });
      expect(
        (
          await request("POST", "/api/blog", {
            token: a.token,
            body: { title: uniqueSlug("reassigned") },
          })
        ).status
      ).toBe(201);
    }
  );

  itWithBlog(
    "when approving a proposal, the agent, the signer and the approver are recorded",
    async () => {
      if (!dbAvailable) return;
      await request("PUT", "/api/approvals/settings", {
        cookie: admin.cookie,
        body: { enabled: true },
      });
      try {
        const a = await newAgent(["blog:*"], { sponsorUserId: signer.userId });
        const slug = uniqueSlug("cat");
        const p = await request("POST", "/api/blog/categories", {
          token: a.token,
          body: { name: slug, slug },
        });
        // Creating a category is not sensitive: it is forced for the test
        if (p.status !== 202) {
          await request("PUT", "/api/approvals/settings", {
            cookie: admin.cookie,
            body: { operations: { "kon:blog:create-category": true } },
          });
        }
        const r =
          p.status === 202
            ? p
            : await request("POST", "/api/blog/categories", {
                token: a.token,
                body: { name: `${slug}-b`, slug: `${slug}-b` },
              });
        expect(r.status).toBe(202);
        const pid = r.body.proposal.id;
        const ok = await request("POST", `/api/approvals/proposals/${pid}/approve`, {
          cookie: admin.cookie,
          body: {},
        });
        expect(ok.body.proposal.status).toBe("executed");
        expect(ok.body.proposal.agentId).toBe(a.id);
        expect(ok.body.proposal.sponsorUserId).toBe(signer.userId);
        expect(ok.body.proposal.decidedBy).toBe(admin.userId);
        const [row] = await db.select().from(agentProposals).where(eq(agentProposals.id, pid));
        expect(row!.sponsorUserId).toBe(signer.userId);
        const audit = await request("GET", `/api/approvals/audit?proposalId=${pid}`, {
          cookie: admin.cookie,
        });
        const approved = audit.body.events.find(
          (e: { action: string }) => e.action === "proposal_approved"
        );
        expect(approved.details).toMatchObject({ by: admin.userId, sponsor: signer.userId });
      } finally {
        await request("PUT", "/api/approvals/settings", {
          cookie: admin.cookie,
          body: { enabled: false, operations: { "kon:blog:create-category": null } },
        });
      }
    }
  );

  // ══ 2. Hardened MCP ═══════════════════════════════════════════════════

  it("mcp:read/mcp:write open the tool, not a dataset that its policy closes", async () => {
    if (!dbAvailable) return;
    const closed = await dataset("mcp-closed", null);
    const open = await dataset("mcp-open", {
      readAccess: "authenticated",
      writeAccess: "authenticated",
    });
    const readOnly = await dataset("mcp-read-only", { readAccess: "public", writeAccess: "admin" });
    await db.insert(dataEntries).values([
      { dataSetId: closed.id, title: "top-secret-row", data: { n: "1" } },
      { dataSetId: open.id, title: "visible", data: { n: "1" } },
    ] as never);

    const a = await newAgent(["mcp:connect", "mcp:read", "mcp:write"]);
    const s = await mcpSession(a.token);
    const q1 = await call(s, "kitsuden_query_collection", { collection: closed.slug });
    expect(isError(q1)).toBe(true);
    expect(textOf(q1)).not.toContain("top-secret-row");
    expect(isError(await call(s, "kitsuden_query_dataset", { datasetId: closed.id }))).toBe(true);
    expect(
      isError(await call(s, "kitsuden_describe_collection", { collection: closed.slug }))
    ).toBe(true);
    expect(
      isError(
        await call(s, "kitsuden_insert_record", { datasetId: closed.id, data: { title: "no" } })
      )
    ).toBe(true);
    const list = textOf(await call(s, "kitsuden_list_datasets", {}));
    expect(list).not.toContain(closed.slug);
    expect(list).toContain(open.slug);
    expect(textOf(await call(s, "kitsuden_query_collection", { collection: open.slug }))).toContain(
      "visible"
    );
    expect(
      isError(
        await call(s, "kitsuden_insert_record", { datasetId: open.id, data: { title: "si" } })
      )
    ).toBe(false);
    // Read yes, write no
    expect(isError(await call(s, "kitsuden_query_dataset", { datasetId: readOnly.id }))).toBe(
      false
    );
    expect(
      isError(
        await call(s, "kitsuden_insert_record", { datasetId: readOnly.id, data: { title: "no" } })
      )
    ).toBe(true);

    // The per-dataset scope still opens it; `admin` too
    const fine = await newAgent(["mcp:connect", `datasets:${closed.slug}:read`]);
    const sf = await mcpSession(fine.token);
    expect(
      textOf(await call(sf, "kitsuden_query_collection", { collection: closed.slug }))
    ).toContain("top-secret-row");
    const boss = await newAgent(["mcp:connect", "admin"]);
    const sj = await mcpSession(boss.token);
    expect(isError(await call(sj, "kitsuden_query_collection", { collection: closed.slug }))).toBe(
      false
    );
  });

  it("the policy's rlsRules are applied via MCP as in REST", async () => {
    if (!dbAvailable) return;
    const byOwner = await dataset("mcp-owner", {
      readAccess: "authenticated",
      writeAccess: "authenticated",
      rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
    });
    await db.insert(dataEntries).values({
      dataSetId: byOwner.id,
      title: "someone-elses",
      data: { n: "1", ownerId: admin.userId },
      ownerId: admin.userId,
    } as never);
    const a = await newAgent(["mcp:connect", "mcp:read"]);
    const s = await mcpSession(a.token);
    const r = await call(s, "kitsuden_query_collection", { collection: byOwner.slug });
    expect(isError(r), textOf(r)).toBe(false);
    expect(textOf(r)).not.toContain("someone-elses");
    const rest = await request("GET", `/api/datasets/${byOwner.id}/entries`, { token: a.token });
    expect(JSON.stringify(rest.body)).not.toContain("someone-elses");
  });

  it("Inti (only content:edit) does not change: no MCP, and its editorial writing still goes in", async () => {
    if (!dbAvailable) return;
    const inti = await newAgent(["content:edit"]);
    const mcp = await app.request(
      new Request("http://localhost:3000/api/mcp", {
        headers: { Authorization: `Bearer ${inti.token}` },
      })
    );
    expect(mcp.status).toBe(403);
    const page = await request("POST", "/api/page-builder/pages", {
      token: inti.token,
      body: { title: uniqueSlug("inti") },
    });
    expect([401, 403]).not.toContain(page.status);
  });

  // ══ 3. Replays without quota ═══════════════════════════════════════════

  itWithBlog("REST: an idempotency replay does not spend the day's writes", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const a = await newAgent(["blog:*"], { writesPerDay: 2 });
    const slug = uniqueSlug("idem");
    const key = `quota-${generateTestId()}`;
    const first = await request("POST", "/api/blog/categories", {
      token: a.token,
      body: { name: slug, slug },
      headers: { "Idempotency-Key": key },
    });
    expect(first.status).toBe(201);
    for (let i = 0; i < 3; i++) {
      const other = await request("POST", "/api/blog/categories", {
        token: a.token,
        body: { name: slug, slug },
        headers: { "Idempotency-Key": key },
      });
      expect(other.status, `repetition ${i}`).toBe(201);
      expect(other.headers.get("idempotent-replayed")).toBe("true");
    }
    // Only ONE write was spent: another fits, and the third does not
    const s2 = uniqueSlug("idem2");
    expect(
      (
        await request("POST", "/api/blog/categories", {
          token: a.token,
          body: { name: s2, slug: s2 },
        })
      ).status
    ).toBe(201);
    const s3 = uniqueSlug("idem3");
    const third = await request("POST", "/api/blog/categories", {
      token: a.token,
      body: { name: s3, slug: s3 },
    });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("KITSUDEN_E_QUOTA_EXCEEDED");
    const usage = await request("GET", `/api/v1/agents/${a.id}/quotas`, { cookie: admin.cookie });
    expect(usage.body.usage.writesToday).toBe(2);
  });

  itWithBlog("MCP: a replay with the same idempotency_key does not spend", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const a = await newAgent(["mcp:connect", "blog:*"], { writesPerDay: 1 });
    const s = await mcpSession(a.token);
    const slug = uniqueSlug("mcp-idem");
    const args = { body: { name: slug, slug }, idempotency_key: `mcp-${generateTestId()}` };
    const r1 = await call(s, "blog__create-category", args);
    expect(isError(r1), textOf(r1)).toBe(false);
    const r2 = await call(s, "blog__create-category", args);
    expect(isError(r2), textOf(r2)).toBe(false);
    expect(r2.result.structuredContent.idempotentReplayed).toBe(true);
    // The quota (1 per day) was spent only by the first: a different one no longer fits
    const s3 = uniqueSlug("mcp-other");
    const r3 = await call(s, "blog__create-category", { body: { name: s3, slug: s3 } });
    expect(textOf(r3)).toContain("KITSUDEN_E_QUOTA_EXCEEDED");
  });
});
