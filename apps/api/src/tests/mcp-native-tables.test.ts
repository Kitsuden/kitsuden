/**
 * MCP: collection tools do NOT reach the core tables
 * ============================================================================
 *
 * Audit (C1): `kitsuden_query_collection` and friends fell through to
 * any table in the schema with just `mcp:read`/`mcp:write`. With the read-only
 * preset one could read `auth_verifications` (a password reset token)
 * and with `mcp:write` an agent could write `scopes: ["admin"]` for itself.
 *
 *   · `mcp:read` reads no native table (not even `auth_users`);
 *   · credential tables do not exist via MCP, not even with `admin`;
 *   · `mcp:write` does not write to `agent_identities`, and neither does `admin` here;
 *   · the `kitsuden://datasets` resources only show what the agent can read.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, dataSets } from "../db/schema";
import { app } from "../index";
import { createAgent } from "../services/agent-auth";

import { isDatabaseAvailable, generateTestId } from "./setup";

let dbAvailable = false;

interface Session {
  agentId: string;
  token: string;
  sessionId: string;
  close: () => Promise<void>;
}
const open: Session[] = [];

async function mcpSession(scopes: string[]): Promise<Session> {
  const { agent, plainApiKey } = await createAgent({
    name: `mcp-native-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", {
      headers: { Authorization: `Bearer ${plainApiKey}` },
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
  const s = {
    agentId: agent.id,
    token: plainApiKey,
    sessionId,
    close: () => reader.cancel().catch(() => {}),
  };
  open.push(s);
  return s;
}

let n = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC response read in the test
async function rpc(s: Session, method: string, params: unknown): Promise<any> {
  const res = await app.request(
    new Request(`http://localhost:3000/api/mcp?sessionId=${s.sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: n++, method, params }),
    })
  );
  return res.json();
}

/** The text (or the error) of a call, to search inside. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ditto
const textOf = (r: any) => JSON.stringify(r);

describe("MCP: native tables closed", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
  });
  afterAll(async () => {
    for (const s of open) await s.close();
  });

  it("mcp:read (read-only preset) does not read native tables", async () => {
    if (!dbAvailable) return;
    const reader = await mcpSession(["mcp:connect", "mcp:read", "datasets:*:read"]);
    for (const collection of [
      "authUsers",
      "auth_users",
      "authVerifications",
      "agentIdentities",
      "modules",
    ]) {
      const r = await rpc(reader, "tools/call", {
        name: "kitsuden_query_collection",
        arguments: { collection },
      });
      const t = textOf(r);
      expect(t, collection).not.toContain("@");
      expect(
        t.includes("Collection not found") || r.result?.isError === true || !!r.error,
        collection
      ).toBe(true);
    }
  });

  it("credential tables do not exist via MCP, not even with admin", async () => {
    if (!dbAvailable) return;
    const admin = await mcpSession(["mcp:connect", "admin"]);
    for (const collection of [
      "authVerifications",
      "authAccounts",
      "authSessions",
      "agentApiKeys",
      "apiKeys",
    ]) {
      const r = await rpc(admin, "tools/call", {
        name: "kitsuden_query_collection",
        arguments: { collection },
      });
      expect(textOf(r), collection).toContain("Collection not found");
    }
    // an admin does read auth_users (like /api/items), but without secret columns
    const r = await rpc(admin, "tools/call", {
      name: "kitsuden_query_collection",
      arguments: { collection: "authUsers" },
    });
    expect(textOf(r)).not.toContain("Collection not found");
  });

  it("mcp:write does not grant itself permissions: agent_identities is not written via MCP", async () => {
    if (!dbAvailable) return;
    for (const scopes of [
      ["mcp:connect", "mcp:read", "mcp:write"],
      ["mcp:connect", "admin"],
    ]) {
      const s = await mcpSession(scopes);
      const r = await rpc(s, "tools/call", {
        name: "kitsuden_update_record",
        arguments: { collection: "agentIdentities", id: s.agentId, data: { scopes: ["admin"] } },
      });
      expect(textOf(r)).not.toContain("Updated native record");
      const [row] = await db
        .select({ scopes: agentIdentities.scopes })
        .from(agentIdentities)
        .where(eq(agentIdentities.id, s.agentId));
      expect(row!.scopes).toEqual(scopes);
    }
  });

  it("kitsuden_dispatch_worker requires mail:send (mcp:write is no longer enough)", async () => {
    if (!dbAvailable) return;
    const editor = await mcpSession(["mcp:connect", "mcp:read", "mcp:write"]);
    const r = await rpc(editor, "tools/call", {
      name: "kitsuden_dispatch_worker",
      arguments: { queueName: "email", jobName: "x", payload: { to: "victim@example.com" } },
    });
    expect(textOf(r)).not.toContain("Job dispatched");
  });

  it("kitsuden://datasets only shows what the agent can read, without policyJson", async () => {
    if (!dbAvailable) return;
    const slug = `admin-only-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const [ds] = await db
      .insert(dataSets)
      .values({
        name: "Admin only",
        slug,
        schema: { fields: [] },
        policyJson: { readAccess: "admin", writeAccess: "admin" },
      } as never)
      .returning();
    const reader = await mcpSession(["mcp:connect", "mcp:read"]);

    const list = await rpc(reader, "resources/list", {});
    expect(textOf(list)).not.toContain(ds!.id);
    const all = await rpc(reader, "resources/read", { uri: "kitsuden://datasets" });
    expect(textOf(all)).not.toContain(slug);
    const one = await rpc(reader, "resources/read", { uri: `kitsuden://dataset/${ds!.id}` });
    expect(one.error.code).toBe(-32002);

    const admin = await mcpSession(["mcp:connect", "admin"]);
    const seen = await rpc(admin, "resources/read", { uri: `kitsuden://dataset/${ds!.id}` });
    expect(textOf(seen)).toContain(slug);
    expect(textOf(seen)).not.toContain("policyJson");
  });

  it("GET /api/mcp/logs is admin-only", async () => {
    if (!dbAvailable) return;
    const reader = await mcpSession(["mcp:connect", "mcp:read"]);
    const res = await app.request(
      new Request("http://localhost:3000/api/mcp/logs", {
        headers: { Authorization: `Bearer ${reader.token}` },
      })
    );
    expect(res.status).toBe(403);
  });
});
