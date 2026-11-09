/**
 * MCP Server HTTP Tests
 *
 * Tests the Model Context Protocol endpoints using a real Agent NHI token.
 */

import { parse as parseTron } from "@tron-format/tron";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities } from "../db/schema";
import { app } from "../index";
import { decodeToon } from "../lib/toon-tabular";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;

/** What is checked in a JSON-RPC response in the error tests. */
interface RpcResponse {
  jsonrpc: string;
  error: { code: number; data: Record<string, unknown> & { code: string; docs: string } };
  result: {
    isError?: boolean;
    structuredContent: { code: string; retryable: boolean };
    content: Array<{ text: string }>;
  };
}

function req(path: string, opts: RequestInit = {}, cookie?: string, bearer?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (opts.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

describe("MCP Server", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
  });

  const adminEmail = `mcp-admin-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookieAdmin = "";
  let agentToken = "";
  let datasetId = "";
  let sessionId = "";
  // The SSE stream stays open for the whole suite: cancelling it deletes the
  // MCP session (`cancel()` in routes/mcp.ts) and the later POSTs would get 404.
  let sseReader: {
    read(): Promise<{ value?: Uint8Array; done: boolean }>;
    cancel(): Promise<void>;
  } | null = null;

  afterAll(async () => {
    await sseReader?.cancel().catch(() => {});
  });

  describe("Setup", () => {
    it("creates an admin user and signs in", async () => {
      if (!dbAvailable) return;

      // Admin so they can create API keys (and datasets).
      ({ cookie: cookieAdmin } = await enterAs(app, {
        email: adminEmail,
        password,
        name: "MCP Admin",
        role: "admin",
      }));
    });

    it("creates a dataset with sample data for tool tests", async () => {
      if (!dbAvailable) return;

      const dsRes = await app.request(
        req(
          "/api/data-sets",
          {
            method: "POST",
            body: JSON.stringify({
              name: `MCP Test Dataset ${generateTestId()}`,
              slug: `mcp-ds-${generateTestId()}`,
              description: "Dataset for MCP tool test",
              schema: {
                fields: [{ id: "f1", key: "title", type: "text", label: "Title", required: true }],
                version: "2.0",
              },
            }),
          },
          cookieAdmin
        )
      );
      expect(dsRes.status).toBe(201);
      const dsBody = (await dsRes.json()) as any;
      datasetId = dsBody.id;

      const entryRes = await app.request(
        req(
          `/api/data-sets/${datasetId}/entries`,
          {
            method: "POST",
            body: JSON.stringify({
              title: "MCP Entry",
              // `title` is required in the dataset schema and is now
              // validated on insert (before it responded 400 «Required»).
              data: { title: "MCP Entry", note: "sample" },
              status: "published",
            }),
          },
          cookieAdmin
        )
      );
      expect(entryRes.status).toBe(201);
    });

    it("creates an Agent NHI token with MCP scope", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          "/api/keys",
          {
            method: "POST",
            body: JSON.stringify({ name: "MCP Test Agent" }),
          },
          cookieAdmin
        )
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      agentToken = body.token;
      expect(agentToken).toMatch(/^kitsuden_agent_/);

      // Grant the MCP connection scope required by the MCP auth middleware.
      await db
        .update(agentIdentities)
        .set({ scopes: ["admin", "mcp:connect"] })
        .where(eq(agentIdentities.id, body.id));
    });
  });

  describe("SSE Endpoint", () => {
    it("should establish SSE connection with a valid agent token", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/mcp", {}, undefined, agentToken));
      expect(res.status).toBe(200);

      const contentType = res.headers.get("content-type") || "";
      expect(contentType).toContain("text/event-stream");

      // The stream never ends (keepalive every 30 s): `res.text()` waited
      // for an end that does not come and the test timed out at 5 s. Only the
      // first event is read.
      const reader = res.body!.getReader();
      sseReader = reader;
      let body = "";
      while (!body.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        body += new TextDecoder().decode(value);
      }
      expect(body).toContain("event: endpoint");
      expect(body).toContain("/api/mcp?sessionId=");

      const match = body.match(/sessionId=([a-zA-Z0-9-]+)/);
      expect(match).not.toBeNull();
      sessionId = match![1];
    });

    it("should reject SSE connection without auth", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/mcp"));
      expect(res.status).toBe(401);
      // JSON-RPC intact, and the same problem as the REST API in error.data
      const body = (await res.json()) as RpcResponse;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32000);
      expect(body.error.data).toMatchObject({
        code: "KITSUDEN_E_UNAUTHENTICATED",
        status: 401,
        retryable: false,
        retry_after: null,
      });
      expect(body.error.data.docs).toContain("#kitsuden_e_unauthenticated");
    });
  });

  describe("JSON-RPC Endpoint", () => {
    it("should respond to initialize", async () => {
      if (!dbAvailable) return;
      expect(sessionId).not.toBe("");

      const res = await app.request(
        req(
          `/api/mcp?sessionId=${sessionId}`,
          {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test-client", version: "1.0.0" },
              },
            }),
          },
          undefined,
          agentToken
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result.protocolVersion).toBe("2024-11-05");
      expect(body.result.serverInfo.name).toBe("kitsuden-mcp-server");
    });

    it("should reject requests without sessionId (other than initialize)", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          "/api/mcp",
          {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          },
          undefined,
          agentToken
        )
      );

      expect(res.status).toBe(400);
    });

    // Streamable HTTP (OAuth for MCP, docs/agents/oauth.md): `initialize` without a
    // session opens one and returns it in `Mcp-Session-Id`; with that header it continues.
    it("initialize without a session opens a Streamable HTTP session", async () => {
      if (!dbAvailable) return;
      const res = await app.request(
        req(
          "/api/mcp",
          {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          },
          undefined,
          agentToken
        )
      );
      expect(res.status).toBe(200);
      const id = res.headers.get("mcp-session-id");
      expect(id).toBeTruthy();
      const next = await app.request(
        req(
          "/api/mcp",
          {
            method: "POST",
            headers: { "Mcp-Session-Id": id! },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          },
          undefined,
          agentToken
        )
      );
      expect(next.status).toBe(200);
      const stream = await app.request(
        req("/api/mcp", { headers: { "Mcp-Session-Id": id! } }, undefined, agentToken)
      );
      expect(stream.status).toBe(405);
    });
  });

  describe("Tool: kitsuden_query_dataset", () => {
    it("should query dataset via MCP tool", async () => {
      if (!dbAvailable) return;
      expect(sessionId).not.toBe("");

      const res = await app.request(
        req(
          `/api/mcp?sessionId=${sessionId}`,
          {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "kitsuden_query_dataset",
                arguments: {
                  datasetId,
                  limit: 5,
                },
              },
            }),
          },
          undefined,
          agentToken
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(2);
      expect(body.result).toBeDefined();
      expect(body.result.content).toBeDefined();
      // Before, it was enough for there to be `content`, and it passed even if the tool
      // responded «Agent lacks required scope»: the session carried no scopes.
      expect(body.result.isError).not.toBe(true);
    });

    it("the result states its format in _meta and gives back the data; format:'json' is compact JSON", async () => {
      if (!dbAvailable) return;
      const call = async (args: Record<string, unknown>) => {
        const res = await app.request(
          req(
            `/api/mcp?sessionId=${sessionId}`,
            {
              method: "POST",
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name: "kitsuden_query_dataset",
                  arguments: { datasetId, limit: 5, ...args },
                },
              }),
            },
            undefined,
            agentToken
          )
        );
        return (await res.json()) as any;
      };

      const auto = await call({});
      const format = auto.result._meta?.["kitsuden/format"];
      expect(["json", "toon", "tron"]).toContain(format);
      const text = auto.result.content[0].text as string;
      // (what the agent sees depends on the dataset's policy; here what matters is that nothing is lost)
      const rows =
        format === "toon"
          ? decodeToon(text)
          : format === "tron"
            ? parseTron(text)
            : JSON.parse(text);
      expect(Array.isArray(rows)).toBe(true);

      const json = await call({ format: "json" });
      expect(json.result._meta?.["kitsuden/format"]).toBe("json");
      const jsonText = json.result.content[0].text as string;
      expect(jsonText).not.toContain("\n");
      expect(JSON.parse(jsonText)).toEqual(rows);
    });
  });

  describe("Errors with the problem+json fields", () => {
    const rpc = (body: unknown) =>
      app.request(
        req(
          `/api/mcp?sessionId=${sessionId}`,
          { method: "POST", body: JSON.stringify(body) },
          undefined,
          agentToken
        )
      );

    it("unknown method → error.data with KITSUDEN_E_NOT_FOUND", async () => {
      if (!dbAvailable) return;
      const res = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/frobnicate" });
      const body = (await res.json()) as RpcResponse;
      expect(body.error.code).toBe(-32601);
      expect(body.error.data.code).toBe("KITSUDEN_E_NOT_FOUND");
      expect(body.error.data.retryable).toBe(false);
    });

    it("unknown tool → isError with structuredContent and the summary in the text", async () => {
      if (!dbAvailable) return;
      const res = await rpc({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "this_tool_does_not_exist", arguments: {} },
      });
      const body = (await res.json()) as RpcResponse;
      expect(body.result.isError).toBe(true);
      // With the agent's scopes already in the session, a tool that does not
      // exist is NOT_FOUND (before it came out FORBIDDEN: it was checked against []).
      const code = body.result.structuredContent.code;
      expect(code).toBe("KITSUDEN_E_NOT_FOUND");
      expect(body.result.structuredContent.retryable).toBe(false);
      expect(body.result.content[0].text).toContain(`"code":"${code}"`);
    });

    it("body that is not JSON → -32700 with KITSUDEN_E_BAD_REQUEST (before, 500)", async () => {
      if (!dbAvailable) return;
      const res = await app.request(
        req(
          `/api/mcp?sessionId=${sessionId}`,
          { method: "POST", body: "{this is not json" },
          undefined,
          agentToken
        )
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as RpcResponse;
      expect(body.error.code).toBe(-32700);
      expect(body.error.data.code).toBe("KITSUDEN_E_BAD_REQUEST");
    });
  });

  describe("RLS via MCP", () => {
    it("should require auth for all MCP endpoints", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/mcp"));
      expect(res.status).toBe(401);
    });
  });
});
