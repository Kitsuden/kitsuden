// spec: specs/kitsuden-full-coverage.md — Section 11: API Endpoints -> MCP
// seed: tests/seed.spec.ts

import { test, expect } from "@playwright/test";

// We use native fetch because Hono's SSE does not end the response,
// and Playwright's request.get() would hang waiting for the end of the stream.
const API = (process.env.API_URL || "http://localhost:3001") + "/api/mcp";

test.describe.serial("🔴 MCP Server - Model Context Protocol", () => {
  let sessionId = "";
  let messageEndpoint = "";
  let testDatasetId = "";
  let sseController: AbortController;

  test.beforeAll(async () => {
    // Find a dataset for the Tools and Resources tests
    const dsRes = await fetch((process.env.API_URL || "http://localhost:3001") + "/api/datasets");
    const data = await dsRes.json();
    if (data.docs && data.docs.length > 0) {
      testDatasetId = data.docs[0].id;
    }

    // Establish SSE Connection
    sseController = new AbortController();
    const res = await fetch(API, { signal: sseController.signal });
    sessionId = res.headers.get("x-mcp-session") || "";
    if (sessionId) {
      messageEndpoint = `${API}?sessionId=${sessionId}`;
    }
    // DO NOT ABORT YET! The server deletes the session on abort!
    // We leave the connection open during tests.
  });

  test.afterAll(() => {
    if (sseController) {
      sseController.abort();
    }
  });

  // ==========================================
  // 1. CONNECTION & SESSION TESTS
  // ==========================================
  test.describe("1. Connection & Session Lifecycle", () => {
    test("Should establish SSE connection and return sessionId", async () => {
      expect(sessionId).toBeTruthy();
      expect(messageEndpoint).toContain(sessionId);
    });

    test("Should reject POST requests without session", async ({ request }) => {
      const res = await request.post(API, {
        data: { jsonrpc: "2.0", method: "ping", id: 1 },
      });
      const data = await res.json();
      expect(res.status()).toBe(400);
      expect(data.error.code).toBe(-32000);
      expect(data.error.message).toContain("Invalid or expired session");
    });

    test("Should reject POST requests with invalid session", async ({ request }) => {
      const res = await request.post(`${API}?sessionId=invalid-xyz-123`, {
        data: { jsonrpc: "2.0", method: "ping", id: 1 },
      });
      const data = await res.json();
      expect(res.status()).toBe(400);
      expect(data.error.code).toBe(-32000);
    });
  });

  // ==========================================
  // 2. CORE JSON-RPC PROTOCOL TESTS
  // ==========================================
  test.describe("2. JSON-RPC Protocol Implementations", () => {
    test("Should perform 'initialize' handshake", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "playwright-test", version: "1.0.0" },
          },
        },
      });
      const data = await res.json();
      expect(data.jsonrpc).toBe("2.0");
      expect(data.id).toBe(1);
      expect(data.result.protocolVersion).toBe("2024-11-05");
      expect(data.result.serverInfo.name).toBe("kitsuden-mcp-server");
      // Check capabilities
      expect(data.result.capabilities.resources).toBeDefined();
      expect(data.result.capabilities.tools).toBeDefined();
    });

    test("Should accept 'initialized' notification without response", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "initialized",
          // Notifications carry no 'id' and send no response, but here our app returns null,
          // which the JSON middleware in Hono could answer as an empty body or "null".
        },
      });
      const text = await res.text();
      expect(text).toBe("null"); // Hono `c.json(null)` returns the "null" string
    });

    test("Should respond to 'ping' requests", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: { jsonrpc: "2.0", method: "ping", id: 42 },
      });
      const data = await res.json();
      expect(data.result).toEqual({});
      expect(data.id).toBe(42);
    });

    test("Should return error (-32601) for unknown methods", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: { jsonrpc: "2.0", method: "unknown/method", id: 99 },
      });
      const data = await res.json();
      expect(data.error.code).toBe(-32601);
      expect(data.error.message).toContain("Method not found");
    });
  });

  // ==========================================
  // 3. RESOURCES CAPABILITIES
  // ==========================================
  test.describe("3. Resource Capability Tests", () => {
    test("Should list available resources", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: { jsonrpc: "2.0", method: "resources/list", id: 100 },
      });
      const data = await res.json();
      expect(data.result.resources).toBeDefined();
      expect(data.result.resources.length).toBeGreaterThanOrEqual(2);

      const uris = data.result.resources.map((r: any) => r.uri);
      expect(uris).toContain("kitsuden://datasets");
      expect(uris).toContain("kitsuden://kons");
    });

    test("Should read 'kitsuden://datasets' resource", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: "kitsuden://datasets" },
          id: 101,
        },
      });
      const data = await res.json();
      expect(data.result.contents[0].mimeType).toBe("application/json");
      expect(data.result.contents[0].text).toBeDefined();

      // Validate that it is parseable JSON
      const parsed = JSON.parse(data.result.contents[0].text);
      expect(Array.isArray(parsed)).toBe(true);
    });

    test("Should read 'kitsuden://kons' resource", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: "kitsuden://kons" },
          id: 102,
        },
      });
      const data = await res.json();
      expect(data.result.contents[0].text).toContain("active");
    });

    test("Should return error (-32002) for unknown resource URI", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: "kitsuden://unknown/path" },
          id: 103,
        },
      });
      const data = await res.json();
      expect(data.error.code).toBe(-32002);
      expect(data.error.message).toContain("Unknown resource");
    });
  });

  // ==========================================
  // 4. TOOLS CAPABILITIES
  // ==========================================
  test.describe("4. Tool Capability Tests", () => {
    test("Should list available tools and their schemas", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: { jsonrpc: "2.0", method: "tools/list", id: 200 },
      });
      const data = await res.json();
      expect(data.result.tools).toBeDefined();

      const toolNames = data.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain("kitsuden_query_dataset");
      expect(toolNames).toContain("kitsuden_insert_record");
      expect(toolNames).toContain("kitsuden_dispatch_worker");

      // Validate that the schema exists
      const queryTool = data.result.tools.find((t: any) => t.name === "kitsuden_query_dataset");
      expect(queryTool.inputSchema.properties.datasetId).toBeDefined();
    });

    test("Should return error (-32601) when calling unknown tool", async ({ request }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "invalid_tool", arguments: {} },
          id: 201,
        },
      });
      const data = await res.json();
      expect(data.error.code).toBe(-32601);
      expect(data.error.message).toContain("Unknown tool");
    });

    test("Should return error (-32602) for 'kitsuden_query_dataset' missing required arguments", async ({
      request,
    }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_query_dataset",
            arguments: { limit: 10 }, // Missing datasetId
          },
          id: 202,
        },
      });
      const data = await res.json();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toContain("datasetId");
    });

    test("Should execute 'kitsuden_insert_record' successfully", async ({ request }) => {
      test.skip(!testDatasetId, "No dataset ID is available to run this tool test.");

      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_insert_record",
            arguments: {
              datasetId: testDatasetId,
              title: "MCP E2E Verification Record",
              data: { verification: true, time: Date.now() },
              status: "published",
            },
          },
          id: 203,
        },
      });
      const data = await res.json();
      expect(data.result.content[0].type).toBe("text");
      expect(data.result.content[0].text).toContain("Successfully created record");
    });

    test("Should execute 'kitsuden_query_dataset' successfully with limit 5", async ({
      request,
    }) => {
      test.skip(!testDatasetId, "No dataset ID is available to run this tool test.");

      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_query_dataset",
            arguments: {
              datasetId: testDatasetId,
              limit: 5,
            },
          },
          id: 204,
        },
      });
      const data = await res.json();
      expect(data.result.content[0].type).toBe("text");

      const records = JSON.parse(data.result.content[0].text);
      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeLessThanOrEqual(5);
    });

    test("Should execute 'kitsuden_dispatch_worker' successfully on email queue", async ({
      request,
    }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_dispatch_worker",
            arguments: {
              queueName: "email",
              jobName: "send-notification",
              payload: {
                to: "admin@kitsuden.gg",
                subject: "MCP Extracted Data",
                body: "This is a test message from Model Context Protocol.",
              },
            },
          },
          id: 205,
        },
      });
      const data = await res.json();
      expect(data.result.content[0].type).toBe("text");
      expect(data.result.content[0].text).toContain("Job dispatched"); // The Postgres queue returns the job id
    });

    test("Should fail gracefully 'kitsuden_dispatch_worker' with unknown queue", async ({
      request,
    }) => {
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_dispatch_worker",
            arguments: {
              queueName: "non_existent_queue",
              jobName: "test",
              payload: {},
            },
          },
          id: 206,
        },
      });
      const data = await res.json();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toContain("Unknown queue");
    });
  });
});
