/**
 * Agent scopes in the MCP session
 * ============================================================================
 *
 * The MCP session was opened with an authenticated agent, but did not store its
 * scopes: each tool was checked against an empty list and always failed
 * («Agent lacks required scope»). Here, against the real route:
 *
 *   - the tools the scope allows work, and the others do not;
 *   - another key that knows the sessionId does not speak for someone else's session;
 *   - removing a scope takes effect on the next message, without reconnecting;
 *   - the agent's list of allowed tools (panel) filters
 *     `tools/list` and `tools/call`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities } from "../db/schema";
import { app } from "../index";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

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
  await db.update(agentIdentities).set({ scopes }).where(eq(agentIdentities.id, body.id));
  return { id: body.id, token: body.token };
}

/** Opens the SSE session and returns its id; the stream stays open until the end */
async function openSession(token: string): Promise<string> {
  const res = await app.request(req("/api/mcp", {}, undefined, token));
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

describe("MCP: the agent's scopes reach the session", () => {
  let cookie = "";
  let reader = { id: "", token: "" };
  let other = { id: "", token: "" };
  let session = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie } = await enterAs(app, {
      email: `mcp-scopes-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "MCP Scopes",
      role: "admin",
    }));
    reader = await createAgent(cookie, "MCP reader", ["mcp:connect", "mcp:read"]);
    other = await createAgent(cookie, "Other MCP", ["mcp:connect", "admin"]);
    session = await openSession(reader.token);
  });

  afterAll(async () => {
    for (const l of readers) await l.cancel().catch(() => {});
  });

  it("a read tool works with mcp:read (before, it always failed)", async () => {
    if (!dbAvailable) return;
    const { status, body } = await call(session, reader.token, "kitsuden_list_datasets");
    expect(status).toBe(200);
    expect(body.result.isError).not.toBe(true);
  });

  it("a write tool is denied: the agent does not have mcp:write", async () => {
    if (!dbAvailable) return;
    const { body } = await call(session, reader.token, "kitsuden_create_record", {});
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.code).toBe("KITSUDEN_E_FORBIDDEN");
    expect(body.result.content[0].text).toContain("mcp:write");
  });

  it("another valid key cannot speak for the session (nor inherit its scopes)", async () => {
    if (!dbAvailable) return;
    const { status, body } = await call(session, other.token, "kitsuden_list_datasets");
    expect(status).toBe(400);
    expect(body.error.data.code).toBe("KITSUDEN_E_BAD_REQUEST");
  });

  it("removing the scope takes effect on the next message, without reconnecting", async () => {
    if (!dbAvailable) return;
    await db
      .update(agentIdentities)
      .set({ scopes: ["mcp:connect"] })
      .where(eq(agentIdentities.id, reader.id));
    const { body } = await call(session, reader.token, "kitsuden_list_datasets");
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.code).toBe("KITSUDEN_E_FORBIDDEN");
    // It is given back for the rest of the suite
    await db
      .update(agentIdentities)
      .set({ scopes: ["mcp:connect", "mcp:read"] })
      .where(eq(agentIdentities.id, reader.id));
  });

  it("the agent's allowed tools filter tools/list and tools/call", async () => {
    if (!dbAvailable) return;
    await db
      .update(agentIdentities)
      .set({ allowedTools: ["kitsuden_list_datasets"] })
      .where(eq(agentIdentities.id, reader.id));

    const list = await rpc(session, reader.token, "tools/list");
    const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(["kitsuden_list_datasets"]);

    const allowed = await call(session, reader.token, "kitsuden_list_datasets");
    expect(allowed.body.result.isError).not.toBe(true);

    // It has mcp:read, but it is not in its list
    const outside = await call(session, reader.token, "kitsuden_system_status");
    expect(outside.body.error.data.code).toBe("KITSUDEN_E_FORBIDDEN");
  });
});
