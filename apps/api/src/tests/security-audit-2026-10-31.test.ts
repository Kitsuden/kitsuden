/**
 * Regression tests for the security audit of 2026-10-31, on real Postgres and
 * through the real app. What needs no database is in
 * tests/unit/security-audit-2026-10-31.test.ts.
 *
 * The first-run tests demote every admin of the test database and put them back
 * afterwards, so nothing else may use this database at the same moment.
 */
import { randomUUID } from "node:crypto";

import {
  addClaim,
  captureSource,
  lintClaims,
  reverifyClaim,
  writeMemoryNote,
} from "@kitsuden/engine";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { db } from "../db";
import {
  agentApiKeys,
  agentAuditLogs,
  agentIdentities,
  agentProposals,
  approvalSettings,
  authAccounts,
  authUsers,
  brainNotes,
  dataEntries,
  dataSets,
} from "../db/schema";
import { oauthClients, oauthGrants, oauthTokens } from "../db/schema-oauth";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { invalidateApprovalsConfig } from "../lib/approvals";
import { auth } from "../lib/auth";
import { ensureSetupToken, forgetSetupToken } from "../lib/first-run";
import { mcpResource } from "../lib/oauth/config";
import { recentPendingClients, registerRange, refresh } from "../lib/oauth/service";
import { searchAccessToken, newToken } from "../lib/oauth/tokens";
import { MAX_SEARCH_QUERY_CHARS, searchVector } from "../lib/search";
import * as store from "../lib/store";
import { stopTraces, dump } from "../lib/traces";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, testIp, isDatabaseAvailable } from "./setup";

setDefaultTimeout(30_000);

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";

interface Opts {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, o: Opts = {}): Promise<Response> {
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

const agents: string[] = [];
const datasets: string[] = [];
const users: string[] = [];

async function agent(scopes: string[]): Promise<{ id: string; token: string }> {
  const { agent: a, plainApiKey } = await createAgent({
    name: `audit-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  agents.push(a.id);
  return { id: a.id, token: plainApiKey };
}

async function dataset(policyJson: unknown): Promise<{ id: string; slug: string }> {
  const slug = `audit-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [ds] = await db
    .insert(dataSets)
    .values({ name: slug, slug, schema: [], policyJson } as never)
    .returning({ id: dataSets.id, slug: dataSets.slug });
  datasets.push(ds!.id);
  return ds as { id: string; slug: string };
}

async function entry(
  dataSetId: string,
  values: { title: string; status?: string; ownerId?: string | null }
): Promise<string> {
  const [e] = await db
    .insert(dataEntries)
    .values({ dataSetId, data: { n: "1" }, status: "published", ...values } as never)
    .returning({ id: dataEntries.id });
  return e!.id;
}

async function human(
  role: "admin" | "editor" | "user" = "user"
): Promise<{ cookie: string; userId: string }> {
  const email = `audit-${generateTestId()}@example.com`;
  const s = await enterAs(app, { email, password: "TestPassword123!", name: "Audit", role });
  users.push(s.userId);
  return s;
}

/** MCP session of an agent (same shape as the other MCP suites). */
async function mcp(token: string) {
  // Its own client: this route's limit is shared with every other MCP suite in the process.
  const ip = testIp();
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", {
      headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": ip },
    })
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
  let id = 1;
  return {
    close: () => reader.cancel().catch(() => {}),
    tool: async (name: string, args: unknown) => {
      const r = await app.request(
        new Request(`http://localhost:3000/api/mcp?sessionId=${sessionId}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: id++,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        })
      );
      const j = (await r.json()) as {
        result?: { content?: { text: string }[]; isError?: boolean };
        error?: { message?: string };
      };
      return {
        text: j.result?.content?.[0]?.text ?? j.error?.message ?? "",
        isError: !!j.error || !!j.result?.isError,
      };
    },
  };
}

/**
 * Fails an INSERT that runs with no RLS context: on the global pool nobody has
 * set `app.current_user_id`, so this tells the request's transaction from the
 * pool even though the test connection is a superuser that ignores the policies.
 */
const PROBE = "rls-context-probe";
async function installContextProbe(): Promise<void> {
  await db.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION audit_context_probe() RETURNS trigger LANGUAGE plpgsql AS $FN$
    BEGIN
      IF NEW.title = '${PROBE}' AND COALESCE(current_setting('app.current_user_id', true), '') = '' THEN
        RAISE EXCEPTION 'insert without RLS context';
      END IF;
      RETURN NEW;
    END $FN$`)
  );
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS audit_context_probe ON data_entries`));
  await db.execute(
    sql.raw(`
    CREATE TRIGGER audit_context_probe BEFORE INSERT ON data_entries
    FOR EACH ROW EXECUTE FUNCTION audit_context_probe()`)
  );
}

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  await installContextProbe();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS audit_context_probe ON data_entries`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS audit_context_probe()`));
  if (datasets.length) {
    await db.delete(dataEntries).where(inArray(dataEntries.dataSetId, datasets));
    await db.delete(dataSets).where(inArray(dataSets.id, datasets));
  }
  if (agents.length) await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
  if (users.length) await db.delete(authUsers).where(inArray(authUsers.id, users));
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 1: /api/datasets/batch
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/datasets/batch", () => {
  it("refuses every table but the dataset ones, also for an admin-scope agent", async () => {
    if (!dbAvailable) return;
    const { token } = await agent(["admin"]);
    const victim = await human("admin");
    for (const operation of [
      {
        op: "update",
        table: "approvalSettings",
        id: "global",
        data: { value: { enabled: false } },
      },
      { op: "update", table: "authUsers", where: { role: "admin" }, data: { role: "admin" } },
      { op: "update", table: "authusers", id: victim.userId, data: { name: "pwned" } },
      {
        op: "update",
        table: "authAccounts",
        where: { userId: victim.userId },
        data: { password: "x" },
      },
      { op: "create", table: "agentApiKeys", data: { agentId: "x", keyHash: "y", keyPrefix: "z" } },
      { op: "delete", table: "agentAuditLogs", where: { success: true } },
      { op: "update", table: "__proto__", id: "1", data: {} },
    ]) {
      const res = await call("POST", "/api/datasets/batch", {
        token,
        body: { operations: [operation] },
      });
      expect(res.status, operation.table).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "TABLE_NOT_ALLOWED"
      );
    }
    const [row] = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, victim.userId));
    expect(row!.name).toBe("Audit");
  });

  it("still writes dataset tables, and rolls back as a unit", async () => {
    if (!dbAvailable) return;
    const admin = await human("admin");
    const ds = await dataset({ readAccess: "admin", writeAccess: "admin" });
    const ok = await call("POST", "/api/datasets/batch", {
      cookie: admin.cookie,
      body: {
        operations: [
          {
            op: "create",
            table: "dataEntries",
            data: { dataSetId: ds.id, title: "one", data: {} },
            alias: "a",
          },
          { op: "update", table: "dataEntries", id: "@ref:a.id", data: { title: "two" } },
        ],
      },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const rolled = await call("POST", "/api/datasets/batch", {
      cookie: admin.cookie,
      body: {
        operations: [
          {
            op: "create",
            table: "dataEntries",
            data: { dataSetId: ds.id, title: "three", data: {} },
          },
          { op: "create", table: "dataEntries", data: { dataSetId: ds.id, data: {} } },
        ],
      },
    });
    expect(rolled.status).toBe(400);
    const titles = await db
      .select({ t: dataEntries.title })
      .from(dataEntries)
      .where(eq(dataEntries.dataSetId, ds.id));
    expect(titles.map((r) => r.t)).toEqual(["two"]);
  });

  it("runs on the request's RLS transaction, not on the global pool", async () => {
    if (!dbAvailable) return;
    const { token } = await agent(["admin"]);
    const ds = await dataset({ readAccess: "authenticated", writeAccess: "authenticated" });
    const res = await call("POST", "/api/datasets/batch", {
      token,
      body: {
        operations: [
          {
            op: "create",
            table: "dataEntries",
            data: { dataSetId: ds.id, title: PROBE, data: {} },
          },
        ],
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  describe("with approvals on", () => {
    let admin = { cookie: "", userId: "" };
    beforeAll(async () => {
      if (!dbAvailable) return;
      admin = await human("admin");
      const r = await call("PUT", "/api/approvals/settings", {
        cookie: admin.cookie,
        body: { enabled: true },
      });
      expect(r.status).toBe(200);
      invalidateApprovalsConfig();
    });
    afterAll(async () => {
      if (!dbAvailable) return;
      await call("PUT", "/api/approvals/settings", {
        cookie: admin.cookie,
        body: { enabled: false },
      });
      invalidateApprovalsConfig();
    });

    it("a batch delete is held like any DELETE; a batch without one is not", async () => {
      if (!dbAvailable) return;
      const { id, token } = await agent(["admin"]);
      const ds = await dataset({ readAccess: "admin", writeAccess: "admin" });
      const rowId = await entry(ds.id, { title: "keep me" });

      const held = await call("POST", "/api/datasets/batch", {
        token,
        body: { operations: [{ op: "delete", table: "dataEntries", id: rowId }] },
      });
      expect(held.status, await held.clone().text()).toBe(202);
      expect((await db.select().from(dataEntries).where(eq(dataEntries.id, rowId))).length).toBe(1);

      const free = await call("POST", "/api/datasets/batch", {
        token,
        body: {
          operations: [
            { op: "update", table: "dataEntries", id: rowId, data: { title: "changed" } },
          ],
        },
      });
      expect(free.status, await free.clone().text()).toBe(200);
      await db.delete(agentProposals).where(eq(agentProposals.agentId, id));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Findings 2 and 7: the first administrator and sign-up
// ═══════════════════════════════════════════════════════════════════════════

describe("first run", () => {
  let admins: string[] = [];
  const setupEmails: string[] = [];
  const env = { ...process.env };

  const setup = (extra: Record<string, unknown> = {}) => {
    const email = `audit-setup-${generateTestId()}@example.com`;
    setupEmails.push(email);
    return call("POST", "/api/system/setup", {
      body: { name: "Owner", email, password: "TestPassword123!", ...extra },
    });
  };
  const signUp = () =>
    call("POST", "/api/auth/sign-up/email", {
      headers: { "X-Forwarded-For": testIp() },
      body: {
        name: "Stranger",
        email: `audit-su-${generateTestId()}@example.com`,
        password: "TestPassword123!",
      },
    });
  const removeNewAdmins = async () => {
    if (setupEmails.length) await db.delete(authUsers).where(inArray(authUsers.email, setupEmails));
  };

  beforeAll(async () => {
    if (!dbAvailable) return;
    const rows = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.role, "admin"));
    admins = rows.map((r) => r.id);
    if (admins.length)
      await db.update(authUsers).set({ role: "editor" }).where(inArray(authUsers.id, admins));
  });
  // Each test starts with no administrator, whatever the previous one did.
  beforeEach(async () => {
    if (dbAvailable) await removeNewAdmins();
  });
  afterAll(async () => {
    process.env = { ...env };
    if (!dbAvailable) return;
    await removeNewAdmins();
    if (admins.length)
      await db.update(authUsers).set({ role: "admin" }).where(inArray(authUsers.id, admins));
    await db.delete(authUsers).where(like(authUsers.email, "audit-su-%@example.com"));
  });

  it("counts admins: users without one are not an initialized system", async () => {
    if (!dbAvailable) return;
    await human("user");
    const res = await call("GET", "/api/system/init-check");
    expect(await res.json()).toEqual({ initialized: false, setupTokenRequired: false });
  });

  it("in public mode the token is mandatory, tells the panel so, and is one-time", async () => {
    if (!dbAvailable) return;
    process.env.KITSUDEN_PUBLIC = "true";
    try {
      expect(await (await call("GET", "/api/system/init-check")).json()).toEqual({
        initialized: false,
        setupTokenRequired: true,
      });
      expect((await setup()).status).toBe(403);
      expect((await setup({ setupToken: "wrong" })).status).toBe(403);
      expect((await setup({ setupToken: 12345 })).status).toBe(403);
      const noOne = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.role, "admin"));
      expect(noOne).toEqual([]);
    } finally {
      delete process.env.KITSUDEN_PUBLIC;
    }
  });

  // Security review 2026-11-03: outside production with KITSUDEN_PUBLIC unset,
  // setup was open to whoever reached the port first, even on HOST=0.0.0.0.
  it("a development API listening beyond loopback requires the token too", async () => {
    if (!dbAvailable) return;
    const before = process.env.HOST;
    try {
      for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
        process.env.HOST = host;
        expect(await (await call("GET", "/api/system/init-check")).json()).toEqual({
          initialized: false,
          setupTokenRequired: true,
        });
        expect((await setup()).status).toBe(403);
      }
      process.env.HOST = "127.0.0.1";
      expect(await (await call("GET", "/api/system/init-check")).json()).toEqual({
        initialized: false,
        setupTokenRequired: false,
      });
    } finally {
      if (before === undefined) delete process.env.HOST;
      else process.env.HOST = before;
    }
  });

  it("the token from the log creates a verified admin that can sign in, with sign-up closed", async () => {
    if (!dbAvailable) return;
    const options = auth.options.emailAndPassword as { disableSignUp?: boolean };
    process.env.NODE_ENV = "production";
    options.disableSignUp = true;
    let email = "";
    try {
      // Printed once per token: a new process would read it in its log.
      const token = captureToken();
      const res = await setup({ setupToken: token });
      expect(res.status, await res.clone().text()).toBe(200);
      email = ((await res.json()) as { user: { email: string } }).user.email;
      const [row] = await db
        .select({ role: authUsers.role, verified: authUsers.emailVerified })
        .from(authUsers)
        .where(eq(authUsers.email, email));
      expect(row).toEqual({ role: "admin", verified: true });
      const [cred] = await db
        .select({ p: authAccounts.providerId })
        .from(authAccounts)
        .innerJoin(authUsers, eq(authUsers.id, authAccounts.userId))
        .where(eq(authUsers.email, email));
      expect(cred!.p).toBe("credential");

      // Used: an admin exists, so it answers "already initialized" whatever is sent.
      const again = await setup({ setupToken: token });
      expect(again.status).toBe(403);
      expect(((await again.json()) as { error: string }).error).toBe("System already initialized");
    } finally {
      process.env.NODE_ENV = "test";
      options.disableSignUp = false;
    }
    const signIn = await call("POST", "/api/auth/sign-in/email", {
      headers: { "X-Forwarded-For": testIp() },
      body: { email, password: "TestPassword123!" },
    });
    expect(signIn.status, await signIn.clone().text()).toBe(200);
    await removeNewAdmins();
  });

  it("serialises concurrent calls: only one wins", async () => {
    if (!dbAvailable) return;
    const results = await Promise.all(Array.from({ length: 5 }, () => setup()));
    expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403, 403, 403]);
    const created = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.role, "admin"));
    expect(created.length).toBe(1);
    await removeNewAdmins();
  });

  it("validates what it creates", async () => {
    if (!dbAvailable) return;
    expect((await setup({ password: "short" })).status).toBe(400);
    expect((await setup({ email: "not-an-email" })).status).toBe(400);
    expect((await setup({ name: undefined })).status).toBe(400);
    const taken = await human("user");
    const [row] = await db
      .select({ email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, taken.userId));
    expect((await setup({ email: row!.email })).status).toBe(409);
  });

  it("no public sign-up while there is no admin; once there is one, it opens", async () => {
    if (!dbAvailable) return;
    process.env.KITSUDEN_TEST_SIGNUP_GATE = "on";
    try {
      const refused = await signUp();
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toContain("first administrator");
      expect((await setup()).status).toBe(200);
      expect((await signUp()).status).toBe(200);
    } finally {
      delete process.env.KITSUDEN_TEST_SIGNUP_GATE;
      await removeNewAdmins();
    }
  });

  it("KITSUDEN_SIGNUP=closed reaches better-auth", async () => {
    if (!dbAvailable) return;
    const options = auth.options.emailAndPassword as { disableSignUp?: boolean };
    expect(options.disableSignUp).toBe(false);
    options.disableSignUp = true;
    try {
      expect((await signUp()).status).toBe(400);
    } finally {
      options.disableSignUp = false;
    }
  });

  /** The token, from where an operator reads it: the log. */
  function captureToken(): string {
    const lines: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(
      (...a: unknown[]) => void lines.push(a.join(" "))
    );
    forgetSetupToken();
    ensureSetupToken();
    warn.mockRestore();
    const m = /\n\s{4}(\S{40,})\n/.exec(lines.join("\n"));
    expect(m, "the token is printed").toBeTruthy();
    return m![1]!;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 4: tables that only their own route writes
// ═══════════════════════════════════════════════════════════════════════════

describe("agent tables through the generic routes", () => {
  it("items, explorer and MCP refuse to write them, with any scope", async () => {
    if (!dbAvailable) return;
    const { id, token } = await agent(["admin", "mcp:connect", "mcp:write", "mcp:read"]);
    const admin = await human("admin");

    const [proposal] = await db
      .insert(agentProposals)
      .values({
        agentId: id,
        channel: "rest",
        method: "DELETE",
        path: "/api/x",
        status: "pending",
        reason: "sensitive",
        fingerprint: "h",
        expiresAt: new Date(Date.now() + 60_000),
      } as never)
      .returning({ id: agentProposals.id, path: agentProposals.path });

    const items: [string, string, unknown][] = [
      ["PATCH", `/api/items/agentIdentities/${id}`, { approvalMode: "direct" }],
      ["PATCH", `/api/items/agentProposals/${proposal!.id}`, { path: "/api/rewritten" }],
      ["DELETE", `/api/items/agentProposals/${proposal!.id}`, undefined],
      ["POST", "/api/items/agentAuditLogs", { agentId: id, action: "x", resource: "y" }],
      ["POST", "/api/items/agentProposalFiles", { proposalId: proposal!.id }],
    ];
    for (const [method, path, body] of items) {
      const asAgent = await call(method, path, { token, body });
      expect(asAgent.status, `${method} ${path}`).toBe(403);
      const asHuman = await call(method, path, { cookie: admin.cookie, body });
      expect(asHuman.status, `${method} ${path} as admin`).toBe(403);
    }

    const explorer = await call("PATCH", `/api/explorer/agent_identities/${id}`, {
      cookie: admin.cookie,
      body: { approvalMode: "direct" },
    });
    expect([403, 404]).toContain(explorer.status);

    const s = await mcp(token);
    const r = await s.tool("kitsuden_update_record", {
      collection: "agentIdentities",
      id,
      data: { approvalMode: "direct" },
    });
    expect(r.isError || /cannot be written/.test(r.text), r.text).toBe(true);
    await s.close();

    const [me] = await db.select().from(agentIdentities).where(eq(agentIdentities.id, id));
    expect(me!.approvalMode).not.toBe("direct");
    const [same] = await db
      .select({ path: agentProposals.path })
      .from(agentProposals)
      .where(eq(agentProposals.id, proposal!.id));
    expect(same!.path).toBe("/api/x");
    await db.delete(agentProposals).where(eq(agentProposals.id, proposal!.id));
    await db.delete(agentAuditLogs).where(eq(agentAuditLogs.agentId, id));
  });

  it("GraphQL offers no mutation for them", async () => {
    if (!dbAvailable) return;
    const admin = await human("admin");
    const res = await call("POST", "/api/graphql", {
      cookie: admin.cookie,
      body: { query: "{ __schema { mutationType { fields { name } } } }" },
    });
    const body = (await res.json()) as {
      data?: { __schema?: { mutationType?: { fields: { name: string }[] } } };
    };
    const names = body.data?.__schema?.mutationType?.fields.map((f) => f.name) ?? [];
    expect(
      names.filter((n) => /agent(Identities|Proposals|ProposalFiles|AuditLogs)/i.test(n))
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Findings 5 and 7: writing through the lite datasets route
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/data-sets/:id/entries", () => {
  const open = { readAccess: "authenticated", writeAccess: "authenticated" };

  it("a read-only agent key does not write, on the lite route or the kon route", async () => {
    if (!dbAvailable) return;
    const ds = await dataset(open);
    for (const scopes of [
      ["mcp:connect", "mcp:read", "datasets:*:read"],
      [`datasets:${ds.slug}:read`],
    ]) {
      const { token } = await agent(scopes);
      const lite = await call("POST", `/api/data-sets/${ds.id}/entries`, {
        token,
        body: { title: "no", data: {} },
      });
      expect(lite.status, scopes.join(",")).toBe(403);
      const kon = await call("POST", `/api/datasets/${ds.id}/entries`, {
        token,
        body: { title: "no", data: {} },
      });
      expect(kon.status, scopes.join(",")).toBe(403);
    }
    expect(
      (await db.select().from(dataEntries).where(eq(dataEntries.dataSetId, ds.id))).length
    ).toBe(0);
  });

  it("a key with a write scope writes, on the request's RLS transaction", async () => {
    if (!dbAvailable) return;
    const ds = await dataset({ readAccess: "admin", writeAccess: "admin" });
    const { token } = await agent([`datasets:${ds.slug}:write`]);
    const res = await call("POST", `/api/data-sets/${ds.id}/entries`, {
      token,
      body: { title: PROBE, data: {} },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("mcp:write and a dataset open to sessions: the rule of the SQL policy", async () => {
    if (!dbAvailable) return;
    const ds = await dataset(open);
    const { token } = await agent(["mcp:write", `datasets:${ds.slug}:read`]);
    const res = await call("POST", `/api/data-sets/${ds.id}/entries`, {
      token,
      body: { title: "yes", data: {} },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("an account still writes where the policy lets it, and owns the row", async () => {
    if (!dbAvailable) return;
    const ds = await dataset(open);
    const u = await human("user");
    const res = await call("POST", `/api/data-sets/${ds.id}/entries`, {
      cookie: u.cookie,
      body: { title: PROBE, data: {} },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const [row] = (await res.json()) as { ownerId: string }[];
    expect(row!.ownerId).toBe(u.userId);
  });

  it("a new dataset through the lite route is closed by default", async () => {
    if (!dbAvailable) return;
    const editor = await human("editor");
    const slug = `audit-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const res = await call("POST", "/api/data-sets", {
      cookie: editor.cookie,
      body: { name: slug, slug },
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      id: string;
      policyJson: { readAccess: string; writeAccess: string };
    };
    datasets.push(row.id);
    expect(row.policyJson.readAccess).toBe("admin");
    expect(row.policyJson.writeAccess).toBe("admin");
    const stranger = await human("user");
    const write = await call("POST", `/api/data-sets/${row.id}/entries`, {
      cookie: stranger.cookie,
      body: { title: "x", data: {} },
    });
    expect([403, 404]).toContain(write.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 6: drafts
// ═══════════════════════════════════════════════════════════════════════════

describe("draft entries", () => {
  const unique = `zzqx${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const publishedTitle = `${unique} published`;
  const draftTitle = `${unique} draft secret`;
  const ownDraftTitle = `${unique} own draft`;
  let ds = { id: "", slug: "" };
  let reader = { cookie: "", userId: "" };
  let draftId = "";
  let ownId = "";
  let publishedId = "";

  beforeAll(async () => {
    if (!dbAvailable) return;
    ds = await dataset({ readAccess: "public", writeAccess: "admin" });
    reader = await human("user");
    const author = await human("editor");
    publishedId = await entry(ds.id, {
      title: publishedTitle,
      status: "published",
      ownerId: author.userId,
    });
    draftId = await entry(ds.id, { title: draftTitle, status: "draft", ownerId: author.userId });
    ownId = await entry(ds.id, { title: ownDraftTitle, status: "draft", ownerId: reader.userId });
  });

  const titles = (rows: { title?: string }[]) => rows.map((r) => r.title);

  it("GET /:id/search, with or without ?status=draft", async () => {
    if (!dbAvailable) return;
    for (const qs of ["", "?status=draft"]) {
      const res = await call("GET", `/api/datasets/${ds.id}/search${qs}`, {
        cookie: reader.cookie,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { data?: { title: string }[]; docs?: { title: string }[] };
      const found = titles(body.data ?? body.docs ?? []);
      expect(found, qs).not.toContain(draftTitle);
      expect(found, qs).toContain(ownDraftTitle);
    }
  });

  it("POST /:id/compare", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", `/api/datasets/${ds.id}/compare`, {
      cookie: reader.cookie,
      body: { entryIds: [publishedId, draftId] },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("draft secret");
    const fine = await call("POST", `/api/datasets/${ds.id}/compare`, {
      cookie: reader.cookie,
      body: { entryIds: [publishedId, ownId] },
    });
    expect(fine.status).toBe(200);
  });

  it("POST /:id/query, whatever `where` asks for", async () => {
    if (!dbAvailable) return;
    for (const where of [
      undefined,
      { status: { eq: "draft" } },
      { OR: [{ status: { eq: "draft" } }, { title: { contains: unique } }] },
    ]) {
      const res = await call("POST", `/api/datasets/${ds.id}/query`, {
        cookie: reader.cookie,
        body: where ? { where } : {},
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const found = titles(((await res.json()) as { data: { title: string }[] }).data);
      expect(found).not.toContain(draftTitle);
      expect(found).toContain(ownDraftTitle);
    }
  });

  it("the team still sees them", async () => {
    if (!dbAvailable) return;
    const editor = await human("editor");
    const res = await call("POST", `/api/datasets/${ds.id}/query`, {
      cookie: editor.cookie,
      body: {},
    });
    expect(titles(((await res.json()) as { data: { title: string }[] }).data)).toContain(
      draftTitle
    );
  });

  it("MCP query_dataset and query_collection; an agent with admin stands for the team", async () => {
    if (!dbAvailable) return;
    const { token } = await agent(["mcp:connect", "mcp:read"]);
    const s = await mcp(token);
    for (const [tool, args] of [
      ["kitsuden_query_dataset", { datasetId: ds.id, format: "json" }],
      ["kitsuden_query_dataset", { datasetId: ds.id, status: "draft", format: "json" }],
      ["kitsuden_query_collection", { collection: ds.slug, format: "json" }],
    ] as const) {
      const r = await s.tool(tool, args);
      expect(r.isError, r.text).toBe(false);
      expect(r.text, `${tool} ${JSON.stringify(args)}`).not.toContain("draft secret");
    }
    await s.close();

    const adminKey = await agent(["admin"]);
    const sa = await mcp(adminKey.token);
    const seen = await sa.tool("kitsuden_query_dataset", { datasetId: ds.id, format: "json" });
    expect(seen.text).toContain("draft secret");
    await sa.close();
  });

  it("anonymous suggestions", async () => {
    if (!dbAvailable) return;
    const res = await call(
      "GET",
      `/api/search/suggestions?q=${encodeURIComponent(unique)}&limit=10`
    );
    const { suggestions } = (await res.json()) as { suggestions: { text: string }[] };
    const texts = suggestions.map((s) => s.text);
    expect(texts).toContain(publishedTitle);
    expect(texts).not.toContain(draftTitle);
    expect(texts).not.toContain(ownDraftTitle);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 8: MCP update and delete by id
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP writes by id", () => {
  const open = { readAccess: "authenticated", writeAccess: "authenticated" };

  it("a key let in by the policy only touches its own rows", async () => {
    if (!dbAvailable) return;
    const ds = await dataset(open);
    const someone = await human("user");
    const others = await entry(ds.id, { title: "not yours", ownerId: someone.userId });
    const { token } = await agent(["mcp:connect", "mcp:read", "mcp:write"]);
    const s = await mcp(token);

    for (const args of [
      { collection: ds.slug, id: others, data: { n: "2" } },
      { entryId: others, data: { n: "2" } },
    ]) {
      const r = await s.tool("kitsuden_update_record", args);
      expect(r.text, JSON.stringify(args)).toContain("Record not found");
    }
    for (const args of [{ collection: ds.slug, id: others }, { entryId: others }]) {
      const r = await s.tool("kitsuden_delete_record", args);
      expect(r.text, JSON.stringify(args)).toContain("Record not found");
    }
    const [still] = await db
      .select({ data: dataEntries.data })
      .from(dataEntries)
      .where(eq(dataEntries.id, others));
    expect((still!.data as { n: string }).n).toBe("1");

    const created = await s.tool("kitsuden_insert_record", {
      datasetId: ds.id,
      data: { title: "mine" },
    });
    const mine = /Record created: (\S+)/.exec(created.text)![1]!;
    expect(
      (await s.tool("kitsuden_update_record", { collection: ds.slug, id: mine, data: { n: "3" } }))
        .text
    ).toContain("Updated");
    expect(
      (await s.tool("kitsuden_delete_record", { collection: ds.slug, id: mine })).text
    ).toContain("Deleted");
    await s.close();
  });

  it("a scope that names the action reaches any row, but not the ones rlsRules hide", async () => {
    if (!dbAvailable) return;
    const ds = await dataset({
      ...open,
      rlsRules: [{ field: "team", operator: "eq", value: "blue" }],
    });
    const [visible] = await db
      .insert(dataEntries)
      .values({
        dataSetId: ds.id,
        title: "v",
        data: { team: "blue" },
        status: "published",
      } as never)
      .returning({ id: dataEntries.id });
    const [hidden] = await db
      .insert(dataEntries)
      .values({ dataSetId: ds.id, title: "h", data: { team: "red" }, status: "published" } as never)
      .returning({ id: dataEntries.id });
    const { token } = await agent([
      "mcp:connect",
      `datasets:${ds.slug}:write`,
      `datasets:${ds.slug}:delete`,
    ]);
    const s = await mcp(token);
    expect(
      (
        await s.tool("kitsuden_update_record", {
          collection: ds.slug,
          id: visible!.id,
          data: { n: "2" },
        })
      ).text
    ).toContain("Updated");
    expect(
      (
        await s.tool("kitsuden_update_record", {
          collection: ds.slug,
          id: hidden!.id,
          data: { n: "2" },
        })
      ).text
    ).toContain("Record not found");
    expect(
      (await s.tool("kitsuden_delete_record", { collection: ds.slug, id: hidden!.id })).text
    ).toContain("Record not found");
    await s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 9: the role in the session cookie cache
// ═══════════════════════════════════════════════════════════════════════════

describe("a demoted admin", () => {
  it("loses access at once, also with the cached session cookie", async () => {
    if (!dbAvailable) return;
    const u = await human("admin");
    const [row] = await db
      .select({ email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, u.userId));
    const signIn = await call("POST", "/api/auth/sign-in/email", {
      headers: { "X-Forwarded-For": testIp() },
      body: { email: row!.email, password: "TestPassword123!" },
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("session_data=");

    expect((await call("GET", "/api/runs", { cookie })).status).toBe(200);
    await db.update(authUsers).set({ role: "user" }).where(eq(authUsers.id, u.userId));
    expect((await call("GET", "/api/runs", { cookie })).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 10: routes mounted before the global origin check
// ═══════════════════════════════════════════════════════════════════════════

describe("the origin check", () => {
  it("covers what is mounted before the session middleware", async () => {
    if (!dbAvailable) return;
    const admin = await human("admin");
    for (const path of ["/api/system/grimoire-state", "/api/search/index", "/api/search/init"]) {
      const evil = await call("POST", path, {
        cookie: admin.cookie,
        headers: { origin: "https://evil.example" },
        body: {},
      });
      expect(evil.status, path).toBe(403);
      expect(((await evil.json()) as { message?: string }).message, path).toContain(
        "Origin not allowed"
      );
    }
    const ours = await call("POST", "/api/system/grimoire-state", {
      cookie: admin.cookie,
      body: {},
    });
    expect(ours.status).toBe(400); // past the check: `action` is missing
  });

  it("does not touch requests without a session cookie", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", "/api/system/setup", {
      headers: { origin: "https://evil.example" },
      body: {},
    });
    expect(res.status).not.toBe(500);
    expect(((await res.json()) as { message?: string }).message ?? "").not.toContain(
      "Origin not allowed"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 13: /api/health
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/health", () => {
  it("in production an anonymous caller gets statuses only; an admin the detail", async () => {
    if (!dbAvailable) return;
    const admin = await human("admin");
    process.env.NODE_ENV = "production";
    try {
      const anon = (await (await call("GET", "/api/health")).json()) as {
        environment?: string;
        checks: Record<string, Record<string, unknown>>;
      };
      expect(anon.environment).toBeUndefined();
      expect(Object.keys(anon.checks).length).toBeGreaterThan(0);
      for (const [name, check] of Object.entries(anon.checks)) {
        expect(Object.keys(check), name).toEqual(["status"]);
      }
      const full = (await (await call("GET", "/api/health", { cookie: admin.cookie })).json()) as {
        checks: Record<string, Record<string, unknown>>;
      };
      expect(full.checks.storage!.details).toBeDefined();
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  it("does not write to storage on every call", async () => {
    if (!dbAvailable) return;
    const probe = spyOn(store, "checkStorage");
    try {
      for (let i = 0; i < 5; i++) await call("GET", "/api/health");
      expect(probe.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      probe.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 14: seed scripts
// ═══════════════════════════════════════════════════════════════════════════

describe("seed scripts", () => {
  const run = (script: string, env: Record<string, string>) => {
    const r = Bun.spawnSync(["bun", "run", script], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  it("seed-user does not promote an account that already exists", async () => {
    if (!dbAvailable) return;
    const email = `audit-seed-${generateTestId()}@example.com`;
    const [row] = await db
      .insert(authUsers)
      .values({ id: randomUUID(), name: "Squatter", email, role: "user" })
      .returning({ id: authUsers.id });
    users.push(row!.id);
    const r = run("src/db/seed-user.ts", { SEED_ADMIN_EMAIL: email });
    expect(r.code, r.out).toBe(1);
    const [after] = await db
      .select({ role: authUsers.role })
      .from(authUsers)
      .where(eq(authUsers.id, row!.id));
    expect(after!.role).toBe("user");
  }, 60_000);

  it("seed-user creates a new admin with sign-up closed", async () => {
    if (!dbAvailable) return;
    const email = `audit-seed-${generateTestId()}@example.com`;
    const r = run("src/db/seed-user.ts", {
      SEED_ADMIN_EMAIL: email,
      KITSUDEN_SIGNUP: "closed",
      USER_SEED_PASSWORD: "TestPassword123!",
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("TestPassword123!");
    const [after] = await db
      .select({ id: authUsers.id, role: authUsers.role, v: authUsers.emailVerified })
      .from(authUsers)
      .where(eq(authUsers.email, email));
    users.push(after!.id);
    expect(after!.role).toBe("admin");
    expect(after!.v).toBe(true);
  }, 60_000);

  it("seed refuses a default admin address in production", () => {
    if (!dbAvailable) return;
    const r = run("src/db/seed.ts", { NODE_ENV: "production", SEED_ADMIN_EMAIL: "" });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("SEED_ADMIN_EMAIL");
    expect(r.out).not.toContain("Created admin");
  }, 60_000);

  it("seed does not replace or promote an account that holds the address", async () => {
    if (!dbAvailable) return;
    const email = `audit-seed-${generateTestId()}@example.com`;
    const [row] = await db
      .insert(authUsers)
      .values({ id: randomUUID(), name: "Someone", email, role: "user" })
      .returning({ id: authUsers.id });
    users.push(row!.id);
    const r = run("src/db/seed.ts", { SEED_ADMIN_EMAIL: email });
    expect(r.code, r.out).toBe(1);
    const [after] = await db
      .select({ role: authUsers.role })
      .from(authUsers)
      .where(eq(authUsers.id, row!.id));
    expect(after!.role).toBe("user");
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// H1: public search
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/search", () => {
  it("refuses a query above the limit, and one that is not a string", async () => {
    const long = await call("POST", "/api/search", {
      body: { query: "a".repeat(MAX_SEARCH_QUERY_CHARS + 1) },
    });
    expect(long.status).toBe(400);
    const array = await call("POST", "/api/search", { body: { query: ["a", "b"] } });
    expect(array.status).toBe(400);
  });

  it("finds public published rows, and nothing else", async () => {
    if (!dbAvailable) return;
    const word = `zq${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const open = await dataset({ readAccess: "public" });
    const closed = await dataset({ readAccess: "authenticated" });
    const isolated = await dataset({ readAccess: "public", rlsRules: [{ type: "owner" }] });
    await entry(closed.id, { title: `${word} closed` });
    await entry(isolated.id, { title: `${word} isolated` });
    await entry(open.id, { title: `${word} draft`, status: "draft" });
    await entry(open.id, { title: `${word} visible` });

    // `limit: 1`: the hidden rows must not use up the page.
    for (const body of [
      { query: word },
      { query: word, type: "fulltext" },
      { query: word, limit: 1 },
    ]) {
      const res = await call("POST", "/api/search", { body });
      expect(res.status, await res.clone().text()).toBe(200);
      const { results } = (await res.json()) as {
        results: { title: string; datasetId: string; content: string; type: string }[];
      };
      expect(results.map((r) => r.title)).toEqual([`${word} visible`]);
      expect(results[0]!.datasetId).toBe(open.id);
      expect(results[0]!.content).toContain(word);
      expect(results[0]!.type).toBe("data_entry");
    }

    const scoped = await call("POST", "/api/search", {
      body: { query: word, datasetId: closed.id },
    });
    expect(((await scoped.json()) as { results: unknown[] }).results).toEqual([]);
  });

  it("answers 400, not 500, to input it cannot use", async () => {
    for (const body of [
      { query: "hello", limit: "many" },
      { query: "hello", limit: 0 },
      { query: "hello", offset: -1 },
      { query: "hello", offset: 1e9 },
      { query: "hello", type: "other" },
      { query: "hello", datasetId: "not-a-uuid" },
    ]) {
      expect((await call("POST", "/api/search", { body })).status, JSON.stringify(body)).toBe(400);
    }
    const notJson = await app.request(
      new Request("http://localhost:3000/api/search", {
        method: "POST",
        headers: { origin: ORIGIN, "Content-Type": "application/json" },
        body: "{",
      })
    );
    expect(notJson.status).toBe(400);
  });

  it("POST /api/search/init leaves dataset writes working", async () => {
    if (!dbAvailable) return;
    const admin = await human("admin");
    const res = await call("POST", "/api/search/init", { cookie: admin.cookie });
    expect(res.status, await res.clone().text()).toBe(200);
    const ds = await dataset({ readAccess: "public" });
    expect(await entry(ds.id, { title: "after init" })).toBeTruthy();
  });

  it("in production without a provider, vector search does not compute the mock", async () => {
    const embeddings = await import("../services/embeddings");
    const mock = spyOn(embeddings, "generateMockEmbedding");
    const saved = {
      openai: process.env.OPENAI_API_KEY,
      url: process.env.EMBEDDINGS_URL,
      anthropic: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDINGS_URL;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.NODE_ENV = "production";
    try {
      if (embeddings.hasRealEmbeddingProvider()) return; // this machine has a provider
      expect(await searchVector("hello world")).toEqual([]);
      expect(mock).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = "test";
      if (saved.openai) process.env.OPENAI_API_KEY = saved.openai;
      if (saved.url) process.env.EMBEDDINGS_URL = saved.url;
      if (saved.anthropic) process.env.ANTHROPIC_API_KEY = saved.anthropic;
      mock.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M4: an OAuth grant and the human who gave it
// ═══════════════════════════════════════════════════════════════════════════

describe("OAuth grant of a human who left", () => {
  async function grant(humanId: string, scopes: string[]) {
    const { id: agentId } = await agent(scopes);
    const [key] = await db
      .insert(agentApiKeys)
      .values({
        agentId,
        keyHash: `oauth:${randomUUID()}`,
        keyPrefix: "kitsuden_oat_",
        algorithm: "oauth",
        name: "OAuth test",
      } as never)
      .returning({ id: agentApiKeys.id });
    const clientId = randomUUID();
    await db.insert(oauthClients).values({
      id: clientId,
      kind: "dcr",
      clientName: "Audit client",
      redirectUris: ["http://127.0.0.1:9/cb"],
      grantTypes: ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: "none",
    } as never);
    const grantId = randomUUID();
    const resource = mcpResource();
    await db.insert(oauthGrants).values({
      id: grantId,
      clientId,
      agentId,
      keyId: key!.id,
      userId: humanId,
      scopes,
      resource,
    });
    const access = newToken("access");
    const refresh = newToken("refresh");
    const common = {
      grantId,
      familyId: randomUUID(),
      clientId,
      scopes,
      resource,
      familyExpiresAt: new Date(Date.now() + 3_600_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    await db.insert(oauthTokens).values([
      { id: randomUUID(), tokenHash: access.hash, kind: "access", ...common },
      { id: randomUUID(), tokenHash: refresh.hash, kind: "refresh", ...common },
    ]);
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
    return { access: access.token, refresh: refresh.token, client: client! };
  }

  const refreshError = (g: { client: unknown; refresh: string }) =>
    refresh(g.client as never, { refresh_token: g.refresh }).then(
      () => "no error",
      (e: Error) => e.message
    );

  it("a deleted human: the token and its refresh are dead", async () => {
    if (!dbAvailable) return;
    const h = await human("admin");
    const g = await grant(h.userId, ["mcp:connect", "mcp:read"]);
    expect((await searchAccessToken(g.access, "/api/mcp")).ok).toBe(true);
    await db.delete(authUsers).where(eq(authUsers.id, h.userId));
    expect((await searchAccessToken(g.access, "/api/mcp")).ok).toBe(false);
    expect(await refreshError(g)).toContain("revoked");
  });

  it("moved out of the team: dead", async () => {
    if (!dbAvailable) return;
    const h = await human("editor");
    const g = await grant(h.userId, ["mcp:connect"]);
    expect((await searchAccessToken(g.access, "/api/mcp")).ok).toBe(true);
    await db.update(authUsers).set({ role: "user" }).where(eq(authUsers.id, h.userId));
    expect((await searchAccessToken(g.access, "/api/mcp")).ok).toBe(false);
    expect(await refreshError(g)).toContain("revoked");
  });

  it("an admin demoted to editor keeps what an editor can delegate, and only that", async () => {
    if (!dbAvailable) return;
    const h = await human("admin");
    const plain = await grant(h.userId, ["mcp:connect", "mcp:read"]);
    const wide = await grant(h.userId, ["mcp:connect", "admin"]);
    expect((await searchAccessToken(wide.access, "/api/mcp")).ok).toBe(true);
    await db.update(authUsers).set({ role: "editor" }).where(eq(authUsers.id, h.userId));
    expect((await searchAccessToken(plain.access, "/api/mcp")).ok).toBe(true);
    expect((await searchAccessToken(wide.access, "/api/mcp")).ok).toBe(false);
    expect(await refreshError(wide)).toContain("revoked");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L5: anonymous 404s and the trace table
// ═══════════════════════════════════════════════════════════════════════════

describe("trace rows of anonymous 404s", () => {
  it("are capped per minute; an authenticated 404 is not", async () => {
    if (!dbAvailable) return;
    const saved = {
      on: process.env.TRACES_ENABLED,
      cap: process.env.TRACES_MAX_ANONYMOUS_404_PER_MINUTE,
    };
    process.env.TRACES_ENABLED = "true";
    process.env.TRACES_MAX_ANONYMOUS_404_PER_MINUTE = "3";
    const prefix = `/api/nope-${generateTestId().toLowerCase()}`;
    const since = new Date().toISOString();
    try {
      const admin = await human("admin");
      for (let i = 0; i < 20; i++) await call("GET", `${prefix}/${"x".repeat(i + 1)}`);
      for (let i = 0; i < 4; i++)
        await call("GET", `${prefix}/${"x".repeat(i + 1)}`, { cookie: admin.cookie });
      await dump();
      await dump();
      const count = async (actor: "anonymous" | "human") => {
        const r = await db.execute(
          sql`SELECT count(*)::int AS n FROM kitsuden_request_traces
              WHERE status = 404 AND actor_type = ${actor} AND created_at >= ${since}::timestamptz`
        );
        return (r.rows[0] as { n: number }).n;
      };
      expect(await count("anonymous")).toBeLessThanOrEqual(3);
      expect(await count("human")).toBe(4);
    } finally {
      await stopTraces();
      if (saved.on === undefined) delete process.env.TRACES_ENABLED;
      else process.env.TRACES_ENABLED = saved.on;
      if (saved.cap === undefined) delete process.env.TRACES_MAX_ANONYMOUS_404_PER_MINUTE;
      else process.env.TRACES_MAX_ANONYMOUS_404_PER_MINUTE = saved.cap;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L6: brain sources and other owners' claims
// ═══════════════════════════════════════════════════════════════════════════

describe("brain claims and the global sources table", () => {
  const provider = { embed: async () => [], info: () => ({ mode: "lexical" }) } as never;
  const uri = `https://docs.example/${generateTestId()}`;
  const content = (s: string) => `${s} ${generateTestId()}`;
  const notes: string[] = [];

  async function note(actor: { kind: "user"; id: string; role: string }): Promise<string> {
    const r = await writeMemoryNote(
      db as never,
      actor,
      { key: `audit/${generateTestId()}`, title: "t", content: "c" } as never,
      provider
    );
    notes.push(r.note.id);
    return r.note.id;
  }

  afterAll(async () => {
    if (dbAvailable && notes.length)
      await db.delete(brainNotes).where(inArray(brainNotes.id, notes));
  });

  it("another owner's capture of the same uri neither stales nor rebinds a claim", async () => {
    if (!dbAvailable) return;
    const victim = { kind: "user" as const, id: `victim-${generateTestId()}`, role: "editor" };
    const attacker = { kind: "user" as const, id: `attacker-${generateTestId()}`, role: "editor" };
    const { claim } = await addClaim(db as never, victim, {
      noteId: await note(victim),
      statement: "the port is 3000",
      source: { title: "doc", content: content("the port is 3000"), uri },
    });
    await addClaim(db as never, attacker, {
      noteId: await note(attacker),
      statement: "anything",
      // A forged capturer is overwritten: this one counts as the attacker's.
      source: {
        title: "doc",
        content: content("attacker text"),
        uri,
        metadata: { capturedBy: `user:${victim.id}` },
      },
    });

    const lint = await lintClaims(db as never, { actor: victim });
    expect(lint.stale.map((s) => s.claimId)).not.toContain(claim.id);
    const r = await reverifyClaim(db as never, victim, claim.id, { rebind: true });
    expect(r.rebound).toBe(false);
    expect(r.claim.status).toBe("fresh");
    expect(r.claim.source).toEqual(claim.source);
  });

  it("its own newer capture, or an operator's, still makes it stale", async () => {
    if (!dbAvailable) return;
    const owner = { kind: "user" as const, id: `owner-${generateTestId()}`, role: "editor" };
    const ownUri = `https://docs.example/${generateTestId()}`;
    const first = await addClaim(db as never, owner, {
      noteId: await note(owner),
      statement: "first",
      source: { title: "doc", content: content("first"), uri: ownUri },
    });
    await Bun.sleep(5);
    await addClaim(db as never, owner, {
      noteId: await note(owner),
      statement: "second",
      source: { title: "doc", content: content("second"), uri: ownUri },
    });
    const stale = await lintClaims(db as never, { actor: owner });
    expect(stale.stale.map((s) => s.claimId)).toContain(first.claim.id);

    const other = { kind: "user" as const, id: `other-${generateTestId()}`, role: "editor" };
    const operatorUri = `https://docs.example/${generateTestId()}`;
    const third = await addClaim(db as never, other, {
      noteId: await note(other),
      statement: "third",
      source: { title: "doc", content: content("third"), uri: operatorUri },
    });
    await Bun.sleep(5);
    await captureSource(db as never, {
      title: "doc",
      content: content("operator"),
      uri: operatorUri,
    });
    const byOperator = await lintClaims(db as never, { actor: other });
    expect(byOperator.stale.map((s) => s.claimId)).toContain(third.claim.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L8: the cap on pending dynamic clients
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/oauth/register", () => {
  it("the cap is per network: one network filling it does not block another", async () => {
    if (!dbAvailable) return;
    const saved = process.env.OAUTH_MAX_PENDING_CLIENTS;
    const ids: string[] = [];
    process.env.OAUTH_MAX_PENDING_CLIENTS = "2";
    const a = 198;
    const net = `${a}.51.${100 + Math.floor(Math.random() * 100)}`;
    await db.delete(oauthClients).where(like(oauthClients.registeredIp, `${net}.%`));
    const register = (ip: string) =>
      call("POST", "/api/oauth/register", {
        headers: { "X-Forwarded-For": ip },
        body: {
          client_name: "Audit",
          redirect_uris: ["http://127.0.0.1:9/cb"],
          token_endpoint_auth_method: "none",
        },
      });
    try {
      const statuses: number[] = [];
      for (const host of [1, 2, 3]) {
        const r = await register(`${net}.${host}`);
        statuses.push(r.status);
        if (r.status === 201) ids.push(((await r.json()) as { client_id: string }).client_id);
      }
      expect(statuses).toEqual([201, 201, 429]);
      const elsewhere = await register("203.0.113.200");
      expect(elsewhere.status).toBe(201);
      ids.push(((await elsewhere.json()) as { client_id: string }).client_id);
      expect(await recentPendingClients(`${net}.9`)).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.OAUTH_MAX_PENDING_CLIENTS;
      else process.env.OAUTH_MAX_PENDING_CLIENTS = saved;
      if (ids.length) await db.delete(oauthClients).where(inArray(oauthClients.id, ids));
    }
  });

  it("groups IPv4 by /24 and IPv6 by /48", () => {
    expect(registerRange("203.0.113.9")).toBe("203.0.113.");
    expect(registerRange("2001:db8:1:2::3")).toBe("2001:db8:1:");
    expect(registerRange("unknown")).toBeNull();
  });
});
