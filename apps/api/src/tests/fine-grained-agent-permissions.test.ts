/**
 * Broad + fine-grained permissions + denials, keys and quotas per agent
 * ============================================================================
 *
 * Against the REAL app (test Postgres, kons loaded) and real agents:
 *
 *   · prefix gates accept the operation's fine-grained scope, and ONLY
 *     that one (`kon:blog:create-post` opens `POST /api/blog`, not `PATCH`);
 *   · union: a fine-grained scope does not take anything from a broad one;
 *   · denial wins (over `admin` too), in SDK operations and in the
 *     legacy routes of an entirely denied kon;
 *   · per-dataset scopes in REST (kon-datasets and /api/data-sets), in the
 *     core MCP tools and in the generated ones;
 *   · keys: create, rotate without downtime, revoke instantly, expire, last use;
 *   · quotas: per minute (KITSUDEN_E_RATE_LIMITED), writes and daily
 *     budget (KITSUDEN_E_QUOTA_EXCEEDED) with `retry_after`.
 */

import { patternCovers } from "@kitsuden/shared";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { agentApiKeys, agentIdentities, authUsers, dataSets, dataEntries } from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { installedKon } from "../lib/installed-kons";
import { createAgent } from "../services/agent-auth";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

// kon-blog is an INSTALLABLE kon (kitsuden-kons repo): without it there are no routes to
// test. Anything that uses it is skipped in a clean clone of the core instead of failing.
const WITHOUT_BLOG = !installedKon("kon-blog")?.path;
const itWithBlog = WITHOUT_BLOG ? it.skip : it;

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";

async function newAgent(
  scopes: string[],
  extra: { rateLimit?: number } = {}
): Promise<{ id: string; token: string }> {
  const { agent, plainApiKey } = await createAgent({
    name: `fine-${scopes.join("+").slice(0, 60)}-${generateTestId()}`,
    scopes,
    rateLimit: extra.rateLimit ?? 100_000,
  });
  return { id: agent.id, token: plainApiKey };
}

/**
 * Agent administration (keys, scopes, quotas) belongs to PEOPLE (security audit
 * 2026-11-04, F5): an agent with `admin` gets 403 when it writes there. The tests that
 * exercise it sign in with a human admin's cookie.
 */
let adminCookie = "";
let adminId = "";
async function humanAdmin(): Promise<{ id: string; token: { cookie: string } }> {
  if (!adminCookie) {
    ({ cookie: adminCookie, userId: adminId } = await enterAs(app, {
      email: `fine-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Human admin",
      role: "admin",
    }));
  }
  return { id: adminId, token: { cookie: adminCookie } };
}

async function request(
  token: string | { cookie: string } | null,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (typeof token === "string") headers.Authorization = `Bearer ${token}`;
  else if (token) headers.Cookie = token.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
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

// ── Test datasets ──
let privateOne: { id: string; slug: string };
/** A human account: an agent writes blog entries ON THEIR BEHALF (authorId). */
let authorId = "";
let other: { id: string; slug: string };
/** Open to any session (read and write): the one a broad MCP scope does reach. */
let openValue: { id: string; slug: string };

async function createDataset(prefix: string, policyJson: unknown = null) {
  const slug = `${prefix}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  // policyJson null = admin only: neither anonymous nor an account sees it.
  const [ds] = await db
    .insert(dataSets)
    .values({ name: slug, slug, schema: [{ key: "n", type: "text" }], policyJson } as never)
    .returning({ id: dataSets.id, slug: dataSets.slug });
  await db
    .insert(dataEntries)
    .values({ dataSetId: ds!.id, title: "row", data: { n: "1" } } as never);
  return ds!;
}

describe("agent permissions — fine-grained agent permissions", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    authorId = `author-${generateTestId()}`;
    await db
      .insert(authUsers)
      .values({ id: authorId, name: "Author", email: `${authorId}@example.test` } as never);
    privateOne = await createDataset("fine-priv");
    other = await createDataset("fine-other");
    openValue = await createDataset("fine-open", {
      readAccess: "authenticated",
      writeAccess: "authenticated",
    });
  });
  afterAll(async () => {
    for (const s of open) await s.close();
    if (dbAvailable) {
      for (const ds of [privateOne, other, openValue])
        if (ds) await db.delete(dataSets).where(eq(dataSets.id, ds.id));
      // The author's blog entries stay (author_id SET NULL does not
      // apply: it is NOT NULL); the test account too. Test database.
    }
  });

  // ── 1. Prefix gates with fine-grained permissions ──
  itWithBlog("kon:blog:create-post opens POST /api/blog and nothing else in the blog", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["kon:blog:create-post"]);
    // Without authorId: an agent is not an account and the entry needs an author
    const withoutAuthor = await request(a.token, "POST", "/api/blog", {
      title: `Without ${generateTestId()}`,
    });
    expect(withoutAuthor.status).toBe(400);
    expect(await withoutAuthor.text()).toContain("authorId");
    const create = await request(a.token, "POST", "/api/blog", {
      title: `Fine ${generateTestId()}`,
      authorId,
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const { id } = (await create.json()) as { id: string };

    expect((await request(a.token, "PATCH", `/api/blog/${id}`, { title: "x" })).status).toBe(403);
    expect((await request(a.token, "DELETE", `/api/blog/${id}`)).status).toBe(403);
    expect((await request(a.token, "POST", "/api/page-builder/pages", { title: "p" })).status).toBe(
      403
    );

    const without = await newAgent(["mcp:connect"]);
    expect((await request(without.token, "POST", "/api/blog", { title: "no" })).status).toBe(403);
  });

  itWithBlog("union: a fine-grained scope takes nothing from a broad one", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["content:edit", "kon:blog:create-post"]);
    const slug = `u-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    expect(
      (await request(a.token, "POST", "/api/page-builder/pages", { title: "U", slug })).status
    ).toBe(201);
    expect(
      (await request(a.token, "POST", "/api/blog", { title: `U ${generateTestId()}`, authorId }))
        .status
    ).toBe(201);
  });

  // ── 2. Denials ──
  it("denial wins over the broad scope: content:edit − create-page", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["content:edit", "!kon:blocks:create-page"]);
    const res = await request(a.token, "POST", "/api/page-builder/pages", {
      title: "D",
      slug: `d-${Date.now()}`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("!kon:blocks:create-page");
    // The rest of the broad scope remains: creating a template
    const t = await request(a.token, "POST", "/api/page-builder/templates", {
      name: `T ${generateTestId()}`,
      blocks: [],
    });
    expect([200, 201, 400, 422]).toContain(t.status);
  });

  itWithBlog("denial wins over admin, also on public routes and legacy routes", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["admin", "!kon:blog:*", "!crm:*"]);
    expect((await request(a.token, "POST", "/api/blog", { title: "no" })).status).toBe(403);
    // Public for everyone… except THIS key
    expect((await request(a.token, "GET", "/api/blog")).status).toBe(403);
    expect((await request(null, "GET", "/api/blog")).status).toBe(200);
    // The rest of admin remains
    expect((await request(a.token, "GET", "/api/page-builder/pages")).status).toBe(200);
    // Legacy route of an entirely denied kon (if the CRM is mounted)
    const crm = await request(a.token, "GET", "/api/crm/contacts");
    if (crm.status !== 404) expect(crm.status).toBe(403);
  });

  // ── 3. Datasets ──
  it("REST: datasets:<slug>:read opens THAT dataset (and only to read)", async () => {
    if (!dbAvailable) return;
    const reader = await newAgent([`datasets:${privateOne.slug}:read`]);
    const r = await request(reader.token, "GET", `/api/datasets/${privateOne.id}/entries`);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { docs: unknown[] }).docs.length).toBe(1);
    // The lite API too
    expect(
      (await request(reader.token, "GET", `/api/data-sets/${privateOne.id}/entries`)).status
    ).toBe(200);
    // Another dataset: it does not see it (404, existence is not confirmed)
    expect((await request(reader.token, "GET", `/api/datasets/${other.id}/entries`)).status).toBe(
      404
    );
    // Write: no
    const w = await request(reader.token, "POST", `/api/datasets/${privateOne.id}/entries`, {
      title: "x",
      data: { n: "2" },
    });
    expect([401, 403]).toContain(w.status);
    // No scope: it does not see it
    const nobody = await newAgent(["mcp:connect"]);
    // 403 since the audit: a key without any scope of the family does not act
    // as a user (middleware/agent-as-user.ts). It arrives the same for
    // any id, so it does not say whether the dataset exists either.
    expect([403, 404]).toContain(
      (await request(nobody.token, "GET", `/api/datasets/${privateOne.id}/entries`)).status
    );
  });

  it("REST: datasets:<slug>:write writes; denial closes it even with a wildcard", async () => {
    if (!dbAvailable) return;
    const writer = await newAgent([`datasets:${privateOne.slug}:write`]);
    const w = await request(writer.token, "POST", `/api/datasets/${privateOne.id}/entries`, {
      title: "new",
      data: { n: "3" },
    });
    expect(w.status, await w.clone().text()).toBe(201);

    const banned = await newAgent(["datasets:*:read", `!datasets:${privateOne.slug}:*`]);
    expect(
      (await request(banned.token, "GET", `/api/datasets/${privateOne.id}/entries`)).status
    ).toBe(404);
    expect((await request(banned.token, "GET", `/api/datasets/${other.id}/entries`)).status).toBe(
      200
    );
  });

  it("core MCP: query/insert/delete respect the per-dataset scope and the denial", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["mcp:connect", `datasets:${privateOne.slug}:read`]);
    const s = await mcpSession(a.token);
    const q = await call(s, "kitsuden_query_collection", { collection: privateOne.slug });
    expect(isError(q), textOf(q)).toBe(false);
    expect(textOf(q)).toContain("row");
    const q2 = await call(s, "kitsuden_query_collection", { collection: other.slug });
    expect(isError(q2)).toBe(true);
    const ins = await call(s, "kitsuden_insert_record", {
      datasetId: privateOne.id,
      data: { title: "no" },
    });
    expect(isError(ins)).toBe(true);
    const list = await call(s, "kitsuden_list_datasets", {});
    expect(textOf(list)).toContain(privateOne.slug);
    expect(textOf(list)).not.toContain(other.slug);

    // broad mcp:read/mcp:write − denied on one dataset
    const b = await newAgent([
      "mcp:connect",
      "mcp:read",
      "mcp:write",
      `!datasets:${privateOne.slug}:*`,
    ]);
    const sb = await mcpSession(b.token);
    expect(
      isError(await call(sb, "kitsuden_query_collection", { collection: privateOne.slug }))
    ).toBe(true);
    // The broad scope opens the tool, not a dataset that its policy closes
    // (`other`: no policy = admin only); but one open to any session, yes.
    expect(isError(await call(sb, "kitsuden_query_collection", { collection: other.slug }))).toBe(
      true
    );
    expect(
      isError(await call(sb, "kitsuden_query_collection", { collection: openValue.slug }))
    ).toBe(false);
    expect(
      isError(
        await call(sb, "kitsuden_insert_record", {
          datasetId: privateOne.id,
          data: { title: "no" },
        })
      )
    ).toBe(true);
    expect(textOf(await call(sb, "kitsuden_list_datasets", {}))).not.toContain(privateOne.slug);

    // delete with delete and without
    const [row] = await db
      .select({ id: dataEntries.id })
      .from(dataEntries)
      .where(eq(dataEntries.dataSetId, other.id))
      .limit(1);
    const c = await newAgent(["mcp:connect", `datasets:${other.slug}:write`]);
    const sc = await mcpSession(c.token);
    expect(
      isError(await call(sc, "kitsuden_delete_record", { collection: other.slug, id: row!.id }))
    ).toBe(true);
    const d = await newAgent(["mcp:connect", `datasets:${other.slug}:delete`]);
    const sd = await mcpSession(d.token);
    const deleted = await call(sd, "kitsuden_delete_record", {
      collection: other.slug,
      id: row!.id,
    });
    expect(isError(deleted), textOf(deleted)).toBe(false);
  });

  it("generated MCP: datasets__list-entries inherits the per-dataset scope", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["mcp:connect", `datasets:${privateOne.slug}:read`]);
    const s = await mcpSession(a.token);
    const r = await call(s, "datasets__list-entries", { id: privateOne.id });
    expect(isError(r), textOf(r)).toBe(false);
    expect(r.result.structuredContent.status).toBe(200);
  });

  itWithBlog("RLS: the SQL rule (kitsuden_pattern_covers) is the same as shared's", async () => {
    if (!dbAvailable) return;
    const cases: [string, string][] = [
      ["crm:*", "crm:a"],
      ["crm:*", "crm:a:b"],
      ["crm:*", "crmx:a"],
      ["crm:*", "crm"],
      ["*:read", "x:read"],
      ["*:read", "datasets:c:read"],
      ["*:read", "x:write"],
      ["datasets:*:read", "datasets:c:read"],
      ["datasets:*:read", "datasets:c:write"],
      ["datasets:*:read", "datasets:a:b:read"],
      ["kon:*", "kon:blog:x"],
      ["*:*", "a:b"],
      ["*", "a:b"],
      ["esports", "esports:manage"],
      ["a:b", "a:b"],
      ["datasets:*", "datasets:x:read"],
    ];
    for (const [pattern, req] of cases) {
      const rows = (await db.execute(
        sql`SELECT kitsuden_pattern_covers(${pattern}, ${req}) AS r`
      )) as unknown as {
        rows: { r: boolean }[];
      };
      expect(rows.rows[0]!.r, `${pattern} → ${req}`).toBe(patternCovers(pattern, req));
    }
  });

  // ── 4. Keys ──
  itWithBlog("keys: rotate without downtime, revoke instantly, expire and last use", async () => {
    if (!dbAvailable) return;
    const admin = await humanAdmin();
    const target = await newAgent(["mcp:connect"]);
    // An `admin` agent does not mint keys (not even for another agent): F5
    const adminAgent = await newAgent(["admin"]);
    expect(
      (await request(adminAgent.token, "POST", `/api/v1/agents/${target.id}/keys`, {})).status
    ).toBe(403);

    const next = await request(admin.token, "POST", `/api/v1/agents/${target.id}/keys`, {
      name: "ci",
      expiresInDays: 30,
    });
    expect(next.status).toBe(201);
    const { apiKey: k1, key } = (await next.json()) as {
      apiKey: string;
      key: { id: string; expiresAt: string };
    };
    expect(new Date(key.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect((await request(k1, "GET", "/api/blog")).status).toBe(200);

    // Rotate with a 1 h grace period: BOTH are valid
    const rot = await request(
      admin.token,
      "POST",
      `/api/v1/agents/${target.id}/keys/${key.id}/rotate`,
      { graceHours: 1 }
    );
    expect(rot.status).toBe(201);
    const {
      apiKey: k2,
      key: k2row,
      previous,
    } = (await rot.json()) as {
      apiKey: string;
      key: { id: string; rotatedFrom: string };
      previous: { expiresAt: string };
    };
    expect(k2row.rotatedFrom).toBe(key.id);
    expect(new Date(previous.expiresAt).getTime()).toBeLessThan(Date.now() + 2 * 3_600_000);
    expect((await request(k1, "GET", "/api/blog")).status).toBe(200);
    expect((await request(k2, "GET", "/api/blog")).status).toBe(200);

    // Revoke k2: the next request is no longer valid
    const rev = await request(
      admin.token,
      "POST",
      `/api/v1/agents/${target.id}/keys/${k2row.id}/revoke`,
      {}
    );
    expect(rev.status).toBe(200);
    expect((await request(k2, "GET", "/api/blog")).status).toBe(401);
    // Rotate with grace 0: the old one dies right away
    const rot0 = await request(
      admin.token,
      "POST",
      `/api/v1/agents/${target.id}/keys/${key.id}/rotate`,
      { graceHours: 0 }
    );
    expect(rot0.status).toBe(201);
    const { apiKey: k3 } = (await rot0.json()) as { apiKey: string };
    expect((await request(k1, "GET", "/api/blog")).status).toBe(401);
    expect((await request(k3, "GET", "/api/blog")).status).toBe(200);
    // Rotate a revoked one: 409
    expect(
      (
        await request(
          admin.token,
          "POST",
          `/api/v1/agents/${target.id}/keys/${k2row.id}/rotate`,
          {}
        )
      ).status
    ).toBe(409);

    // Last use and the list (without secrets)
    await new Promise((r) => setTimeout(r, 200));
    const list = (await (
      await request(admin.token, "GET", `/api/v1/agents/${target.id}/keys`)
    ).json()) as {
      keys: { id: string; status: string; lastUsedAt: string | null }[];
    };
    const statuses = Object.fromEntries(list.keys.map((k) => [k.id, k.status]));
    expect(statuses[k2row.id]).toBe("revoked");
    expect(statuses[key.id]).toBe("expired");
    expect(list.keys.some((k) => k.lastUsedAt)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(k3);

    // The revoked row stays in the database (audit), with who did it
    const [row] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, k2row.id));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedBy).toBe(admin.id);
  });

  // ── 5. Scopes through the panel ──
  itWithBlog("PUT scopes validates, and /access merges what it can do", async () => {
    if (!dbAvailable) return;
    const admin = await humanAdmin();
    const obj = await newAgent([]);
    // An `admin` agent with denies cannot erase them by rewriting its own scopes: F5
    const trimmed = await newAgent(["admin", "!datasets:payroll:*"]);
    expect(
      (
        await request(trimmed.token, "PUT", `/api/v1/agents/${trimmed.id}/scopes`, {
          scopes: ["admin"],
        })
      ).status
    ).toBe(403);
    // No fine-grained scope opens agent administration: it is not registered among
    // the mounted operations (an agent cannot give itself permissions).
    const ready = await newAgent(["kon:*", "agents:*", "kon:agents:*"]);
    expect((await request(ready.token, "GET", "/api/v1/agent-access/catalog")).status).toBe(403);
    expect(
      (
        await request(ready.token, "PUT", `/api/v1/agents/${ready.id}/scopes`, {
          scopes: ["admin"],
        })
      ).status
    ).toBe(403);
    const bad = await request(admin.token, "PUT", `/api/v1/agents/${obj.id}/scopes`, {
      scopes: ["!admin"],
    });
    expect(bad.status).toBe(422);
    const good = await request(admin.token, "PUT", `/api/v1/agents/${obj.id}/scopes`, {
      scopes: ["content:edit", "!kon:blocks:delete-page", `datasets:${privateOne.slug}:read`],
    });
    expect(good.status).toBe(200);
    const acc = (await good.json()) as {
      operations: { scope: string; state: string; by: string | null }[];
      datasets: { slug: string; read: { state: string } }[];
      denies: string[];
    };
    const opFor = (s: string) => acc.operations.find((o) => o.scope === s);
    expect(opFor("kon:blocks:delete-page")?.state).toBe("denied");
    expect(opFor("kon:blocks:create-page")?.state).toBe("policy"); // content:edit via the kon's policy
    expect(acc.datasets.find((d) => d.slug === privateOne.slug)?.read.state).toBe("granted");
    expect(acc.denies).toEqual(["!kon:blocks:delete-page"]);

    const cat = (await (
      await request(admin.token, "GET", "/api/v1/agent-access/catalog")
    ).json()) as {
      presets: { id: string }[];
      broad: { scope: string; operations: string[] }[];
      kons: { kon: string; operations: { scope: string }[] }[];
    };
    expect(cat.presets.map((p) => p.id)).toContain("read-only");
    expect(cat.broad.find((b) => b.scope === "blog:*")?.operations).toContain(
      "kon:blog:create-post"
    );
    expect(cat.kons.find((k) => k.kon === "blog")?.operations.length).toBeGreaterThan(10);
  });

  // ── 6. Quotas ──
  itWithBlog(
    "quotas: minute → RATE_LIMITED; writes and budget → QUOTA_EXCEEDED with retry_after",
    async () => {
      if (!dbAvailable) return;
      clearQuotaMemory();
      const admin = await humanAdmin();

      const slow = await newAgent(["mcp:connect"], { rateLimit: 3 });
      for (let i = 0; i < 3; i++)
        expect((await request(slow.token, "GET", "/api/blog")).status).toBe(200);
      const r429 = await request(slow.token, "GET", "/api/blog");
      expect(r429.status).toBe(429);
      const p = (await r429.json()) as { code: string; retry_after: number; quota: string };
      expect(p.code).toBe("KITSUDEN_E_RATE_LIMITED");
      expect(p.retry_after).toBeGreaterThan(0);
      expect(p.retry_after).toBeLessThanOrEqual(60);
      expect(r429.headers.get("retry-after")).toBe(String(p.retry_after));

      const writer = await newAgent(["kon:blog:create-post"]);
      const put = await request(admin.token, "PUT", `/api/v1/agents/${writer.id}/quotas`, {
        writesPerDay: 2,
      });
      expect(put.status).toBe(200);
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await request(writer.token, "POST", "/api/blog", {
              title: `Q ${generateTestId()}`,
              authorId,
            })
          ).status
        ).toBe(201);
      }
      const q = await request(writer.token, "POST", "/api/blog", { title: "third", authorId });
      expect(q.status).toBe(429);
      const pq = (await q.json()) as {
        code: string;
        retry_after: number;
        quota: string;
        limit: number;
      };
      expect(pq.code).toBe("KITSUDEN_E_QUOTA_EXCEEDED");
      expect(pq.quota).toBe("writes_per_day");
      expect(pq.limit).toBe(2);
      expect(pq.retry_after).toBeGreaterThan(0);
      expect(pq.retry_after).toBeLessThanOrEqual(86_400);
      // Reading is not writing
      expect((await request(writer.token, "GET", "/api/blog")).status).toBe(200);

      const budget = await newAgent(["mcp:connect"]);
      await request(admin.token, "PUT", `/api/v1/agents/${budget.id}/quotas`, {
        budgetUnitsPerDay: 2,
      });
      expect((await request(budget.token, "GET", "/api/blog")).status).toBe(200);
      expect((await request(budget.token, "GET", "/api/blog")).status).toBe(200);
      const b = await request(budget.token, "GET", "/api/blog");
      expect(b.status).toBe(429);
      expect(((await b.json()) as { quota: string }).quota).toBe("budget_units_per_day");

      // The panel sees the consumption
      const usage = (await (
        await request(admin.token, "GET", `/api/v1/agents/${writer.id}/quotas`)
      ).json()) as {
        limits: { writesPerDay: number };
        usage: { writesToday: number; store: string };
      };
      expect(usage.limits.writesPerDay).toBe(2);
      expect(usage.usage.writesToday).toBe(2);
      expect(["valkey", "postgres"]).toContain(usage.usage.store);

      // And via MCP: the tool pays for its write
      const m = await newAgent(["mcp:connect", "mcp:write", "mcp:read"]);
      await request(admin.token, "PUT", `/api/v1/agents/${m.id}/quotas`, { writesPerDay: 1 });
      const sm = await mcpSession(m.token);
      expect(
        isError(
          await call(sm, "kitsuden_insert_record", {
            datasetId: openValue.id,
            data: { title: "1" },
          })
        )
      ).toBe(false);
      const second = await call(sm, "kitsuden_insert_record", {
        datasetId: openValue.id,
        data: { title: "2" },
      });
      expect(isError(second)).toBe(true);
      expect(textOf(second)).toContain("KITSUDEN_E_QUOTA_EXCEEDED");
      // Reading via MCP continues (it is not a write)
      expect(
        isError(await call(sm, "kitsuden_query_collection", { collection: openValue.slug }))
      ).toBe(false);

      await db.delete(agentIdentities).where(eq(agentIdentities.id, m.id));
    }
  );
});
