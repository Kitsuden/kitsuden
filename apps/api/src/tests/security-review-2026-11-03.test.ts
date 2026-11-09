/**
 * Security review of 2026-11-03: the fixes that need the real API and Postgres
 * ============================================================================
 *
 *   1. GraphQL does not expose credential tables or secret columns.
 *   2. `POST /api/datasets/query/:table` refuses the same tables.
 *   3. A demoted admin loses admin routes at once (no 5-minute cookie cache).
 *   4. `kitsuden_define_action` over MCP needs `admin`, not `mcp:admin`.
 *   5. An agent with `admin` cannot create agents or issue keys; it still reads.
 *
 * The checks without a database are in tests/unit/security-review-2026-11-03.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, authUsers } from "../db/schema-core";
import { app } from "../index";
import { createAgent } from "../services/agent-auth";

import { ensureAppRole, enterAs, generateTestId, isDatabaseAvailable, testIp } from "./setup";

const ORIGIN = "http://localhost:5173";
let available = false;
let admin: { cookie: string; userId: string };
const agents: string[] = [];

async function newAgent(scopes: string[]): Promise<{ id: string; token: string }> {
  const { agent, plainApiKey } = await createAgent({
    name: `review-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  agents.push(agent.id);
  return { id: agent.id, token: plainApiKey };
}

function request(
  auth: { cookie?: string; token?: string },
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, "X-Forwarded-For": testIp() };
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    app.request(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )
  );
}

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  await ensureAppRole();
  admin = await enterAs(app, {
    email: `review-admin-${generateTestId()}@example.com`,
    password: "TestPassword123!",
    name: "Review Admin",
    role: "admin",
  });
}, 60_000);

afterAll(async () => {
  if (!available) return;
  if (agents.length) await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
});

describe("GraphQL and the direct table query", () => {
  it("the graph has no credential tables and no secret columns", async () => {
    if (!available) return;
    const res = await request({ cookie: admin.cookie }, "POST", "/api/graphql", {
      query: "{ __schema { types { name fields { name } } queryType { fields { name } } } }",
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 500)).toBe(200);
    const schema = JSON.parse(text).data.__schema as {
      types: { name: string; fields: { name: string }[] | null }[];
      queryType: { fields: { name: string }[] };
    };
    const queries = schema.queryType.fields.map((f) => f.name.toLowerCase());
    for (const forbidden of [
      "authsession",
      "authaccount",
      "authverification",
      "apikey",
      "oauthtoken",
      "kitsudensecret",
    ]) {
      expect(
        queries.some((q) => q.includes(forbidden)),
        forbidden
      ).toBe(false);
    }
    const secretFields = schema.types
      .filter((t) => !t.name.startsWith("__"))
      .flatMap((t) => (t.fields ?? []).map((f) => `${t.name}.${f.name}`))
      .filter((n) => /(token|password|secret|keyHash|tokenHash)$/i.test(n.split(".")[1]!));
    expect(secretFields).toEqual([]);
  });

  it("the direct table query refuses the credential tables, even for an admin", async () => {
    if (!available) return;
    for (const table of ["authSessions", "authAccounts", "agentApiKeys", "authsessions"]) {
      const res = await request(
        { cookie: admin.cookie },
        "POST",
        `/api/datasets/query/${table}`,
        {}
      );
      const text = await res.text();
      expect(res.status, `${table}: ${text.slice(0, 300)}`).toBe(400);
      const offered = (JSON.parse(text) as { availableTables?: string[] }).availableTables ?? [];
      expect(offered).not.toContain("authSessions");
      expect(offered).not.toContain("agentApiKeys");
    }
  });
});

describe("a demoted admin", () => {
  it("loses the admin routes at once", async () => {
    if (!available) return;
    const demoted = await enterAs(app, {
      email: `review-demoted-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Demoted",
      role: "admin",
    });
    const before = await request(
      { cookie: demoted.cookie },
      "POST",
      "/api/datasets/query/dataSets",
      {}
    );
    expect(before.status, await before.text()).toBe(200);

    await db.update(authUsers).set({ role: "user" }).where(eq(authUsers.id, demoted.userId));
    const after = await request(
      { cookie: demoted.cookie },
      "POST",
      "/api/datasets/query/dataSets",
      {}
    );
    expect(after.status, await after.text()).toBe(403);
  });
});

describe("agents and the admin tools", () => {
  async function mcpCall(token: string, name: string, args: unknown) {
    const ip = testIp();
    const open = await app.request(
      new Request("http://localhost:3000/api/mcp", {
        headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": ip },
      })
    );
    expect(open.status).toBe(200);
    const reader = open.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const sessionId = text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!;
    try {
      const res = await app.request(
        new Request(`http://localhost:3000/api/mcp?sessionId=${sessionId}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Forwarded-For": ip,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        })
      );
      return JSON.stringify(await res.json());
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  it("kitsuden_define_action needs `admin`, not `mcp:admin`", async () => {
    if (!available) return;
    const ag = await newAgent(["mcp:connect", "mcp:admin"]);
    const out = await mcpCall(ag.token, "kitsuden_define_action", {
      name: "exfil",
      slug: `exfil-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      type: "webhook_out",
      trigger: "event",
      triggerConfig: { eventName: "entry.created" },
      config: { url: "https://example.com/x" },
    });
    expect(out).toContain("isError");
    expect(out).toContain("'admin'");
  });

  it("kitsuden_install_kon refuses a kon id that is a path", async () => {
    if (!available) return;
    const ag = await newAgent(["mcp:connect", "mcp:admin", "admin"]);
    const out = await mcpCall(ag.token, "kitsuden_install_kon", {
      konId: "../../etc",
      source: "local",
    });
    expect(out).toContain("isError");
  });

  it("an agent with `admin` reads agents but cannot create one or issue keys", async () => {
    if (!available) return;
    const ag = await newAgent(["admin"]);
    const list = await request({ token: ag.token }, "GET", "/api/v1/agents");
    expect(list.status).not.toBe(403);

    const create = await request({ token: ag.token }, "POST", "/api/v1/agents", {
      name: `minted-${generateTestId()}`,
      scopes: ["admin"],
    });
    expect(create.status, await create.text()).toBe(403);

    const keys = await request({ token: ag.token }, "POST", `/api/v1/agents/${ag.id}/keys`, {});
    expect(keys.status).toBe(403);
    const keysAdmin = await request(
      { token: ag.token },
      "POST",
      `/api/admin/agents/${ag.id}/keys`,
      {}
    );
    expect(keysAdmin.status).toBe(403);
    const sneaky = await request({ token: ag.token }, "POST", `//api//v1//agents`, { name: "x" });
    expect(sneaky.status).not.toBe(201);
  });

  it("a person still creates agents", async () => {
    if (!available) return;
    const res = await request({ cookie: admin.cookie }, "POST", "/api/v1/agents", {
      name: `human-made-${generateTestId()}`,
    });
    const text = await res.text();
    expect([200, 201], text.slice(0, 300)).toContain(res.status);
    const id =
      (JSON.parse(text) as { id?: string; agent?: { id?: string } }).id ??
      (JSON.parse(text) as { agent?: { id?: string } }).agent?.id;
    if (id) agents.push(id);
  });
});
