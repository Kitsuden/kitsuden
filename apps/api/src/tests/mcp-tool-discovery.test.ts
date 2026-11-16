/**
 * MCP discovery mode, result cap and `fields` — against the real route
 * ============================================================================
 *
 * lib/tool-discovery.ts wired in routes/mcp.ts. The pure parts are tested
 * without a database in src/tests-unit/tool-discovery.test.ts.
 *
 * The suite's .env.test sets MCP_TOOLS_LIST_MAX_BYTES=0 so the other MCP tests
 * keep seeing the full list; here each test sets the budget it needs (the route
 * reads it on every call).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, dataEntries, dataSets } from "../db/schema";
import { app } from "../index";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;

type Reader = { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> };
const readers: Reader[] = [];

function req(path: string, opts: RequestInit = {}, cookie?: string, bearer?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (opts.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

async function createAgent(cookie: string, name: string, scopes: string[]) {
  const res = await app.request(
    req("/api/keys", { method: "POST", body: JSON.stringify({ name }) }, cookie)
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; token: string };
  await db
    .update(agentIdentities)
    .set({ scopes } as never)
    .where(eq(agentIdentities.id, body.id));
  return { id: body.id, token: body.token };
}

async function openSession(token: string, query = ""): Promise<string> {
  const res = await app.request(req(`/api/mcp${query}`, {}, undefined, token));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader() as Reader;
  readers.push(reader);
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!;
}

async function rpc(session: string, token: string, method: string, params: unknown = {}) {
  const res = await app.request(
    req(
      `/api/mcp?sessionId=${session}`,
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
      undefined,
      token
    )
  );
  return { status: res.status, body: (await res.json()) as any };
}

const call = (session: string, token: string, name: string, args: unknown = {}) =>
  rpc(session, token, "tools/call", { name, arguments: args });

const list = async (session: string, token: string) =>
  (await rpc(session, token, "tools/list")).body.result as {
    tools: { name: string }[];
    _meta?: Record<string, any>;
  };

const budget = process.env.MCP_TOOLS_LIST_MAX_BYTES;
const cap = process.env.MCP_RESULT_MAX_CHARS;

describe("MCP: discovery mode, result cap and fields", () => {
  let cookie = "";
  let agent = { id: "", token: "" };
  let slug = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie } = await enterAs(app, {
      email: `mcp-disc-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "MCP Discovery",
      role: "admin",
    }));
    slug = `disc-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    agent = await createAgent(cookie, "Discovery agent", [
      "mcp:connect",
      "mcp:read",
      "mcp:write",
      `datasets:${slug}:*`,
    ]);
    const [ds] = await db
      .insert(dataSets)
      .values({ name: "Discovery", slug, schema: { fields: [] } } as never)
      .returning();
    await db.insert(dataEntries).values(
      Array.from({ length: 30 }, (_, i) => ({
        dataSetId: ds!.id,
        title: `Row ${i}`,
        status: "published",
        data: { price: i, note: "x".repeat(200) },
      })) as never
    );
  });

  afterEach(() => {
    if (budget === undefined) delete process.env.MCP_TOOLS_LIST_MAX_BYTES;
    else process.env.MCP_TOOLS_LIST_MAX_BYTES = budget;
    if (cap === undefined) delete process.env.MCP_RESULT_MAX_CHARS;
    else process.env.MCP_RESULT_MAX_CHARS = cap;
  });

  afterAll(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    if (!dbAvailable) return;
    await db.delete(dataSets).where(eq(dataSets.slug, slug));
  });

  it("over budget and no toolset: only the discovery and approval tools", async () => {
    if (!dbAvailable) return;
    process.env.MCP_TOOLS_LIST_MAX_BYTES = "200";
    const s = await openSession(agent.token);
    const r = await list(s, agent.token);
    const names = r.tools.map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(["kitsuden_find_tools", "kitsuden_call_tool"]);
    expect(names).not.toContain("kitsuden_query_collection");
    expect(r._meta?.["kitsuden/tools"].mode).toBe("discovery");
    expect(r._meta?.["kitsuden/tools"].available).toBeGreaterThan(2);
  });

  it("an explicit toolset, `all` or a budget of 0 keep the direct list", async () => {
    if (!dbAvailable) return;
    process.env.MCP_TOOLS_LIST_MAX_BYTES = "200";
    for (const q of ["?toolset=all", "?toolset=data"]) {
      const names = (await list(await openSession(agent.token, q), agent.token)).tools.map(
        (t) => t.name
      );
      expect(names, q).toContain("kitsuden_query_collection");
      expect(names, q).not.toContain("kitsuden_find_tools");
    }
    process.env.MCP_TOOLS_LIST_MAX_BYTES = "0";
    const names = (await list(await openSession(agent.token), agent.token)).tools.map(
      (t) => t.name
    );
    expect(names).toContain("kitsuden_query_collection");
    // Stable order: sorted by name (approval tools last)
    const sorted = names.filter(
      (n) => n.startsWith("kitsuden_query") || n.startsWith("kitsuden_create")
    );
    expect(sorted).toEqual([...sorted].sort());
  });

  it("find, then call through kitsuden_call_tool with fields and the new default limit", async () => {
    if (!dbAvailable) return;
    process.env.MCP_TOOLS_LIST_MAX_BYTES = "200";
    const s = await openSession(agent.token);
    const found = await call(s, agent.token, "kitsuden_find_tools", { query: "query collection" });
    const tools = JSON.parse(found.body.result.content[0].text).tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain("kitsuden_query_collection");

    const overview = await call(s, agent.token, "kitsuden_find_tools", {});
    expect(JSON.parse(overview.body.result.content[0].text).groups.length).toBeGreaterThan(0);

    const r = await call(s, agent.token, "kitsuden_call_tool", {
      name: "kitsuden_query_collection",
      arguments: { collection: slug, fields: ["title", "price"], format: "json" },
    });
    const rows = JSON.parse(r.body.result.content[0].text) as Record<string, unknown>[];
    expect(rows).toHaveLength(20);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["id", "price", "title"]);
  });

  it("kitsuden_call_tool grants nothing: a dataset outside the scopes stays closed", async () => {
    if (!dbAvailable) return;
    const s = await openSession(agent.token);
    const r = await call(s, agent.token, "kitsuden_call_tool", {
      name: "kitsuden_query_collection",
      arguments: { collection: `other-${slug}` },
    });
    const failed = Boolean(r.body.error) || Boolean(r.body.result?.isError);
    expect(failed).toBe(true);
    const self = await call(s, agent.token, "kitsuden_call_tool", { name: "kitsuden_call_tool" });
    expect(self.body.error?.data?.code ?? self.body.error?.message).toBeTruthy();
  });

  it("a result over MCP_RESULT_MAX_CHARS is cut and says so", async () => {
    if (!dbAvailable) return;
    process.env.MCP_RESULT_MAX_CHARS = "500";
    const s = await openSession(agent.token, "?toolset=data");
    const r = await call(s, agent.token, "kitsuden_query_collection", {
      collection: slug,
      format: "json",
    });
    expect(r.body.result.content[0].text).toHaveLength(500);
    expect(r.body.result._meta["kitsuden/truncated"].totalChars).toBeGreaterThan(500);
  });
});
