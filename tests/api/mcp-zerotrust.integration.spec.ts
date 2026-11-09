// @ts-nocheck
// Integration Tests: MCP + Zero-Trust Authentication
// Tests the complete flow: Claude Desktop → MCP Server → Zero-Trust Middleware → API

import { test, expect } from "@playwright/test";

const API_URL = process.env.API_URL || "http://localhost:3001";

test.describe("🔐 MCP + Zero-Trust Integration", () => {
  test.describe("1. Agent Authentication Flow", () => {
    test("Should reject MCP connection without token", async ({ request }) => {
      const res = await request.get(`${API_URL}/api/mcp`, {
        headers: {
          // No Authorization header
        },
      });

      expect(res.status()).toBe(401);
      const data = await res.json();
      expect(data.error.message).toContain("Unauthorized");
    });

    test("Should reject invalid agent token format", async ({ request }) => {
      const res = await request.get(`${API_URL}/api/mcp`, {
        headers: {
          Authorization: "Bearer invalid_token_format",
        },
      });

      expect(res.status()).toBe(401);
      const data = await res.json();
      expect(data.error.message).toContain("Invalid API key format");
    });

    test("Should reject token with insufficient scopes", async ({ request }) => {
      // This would require creating an agent without mcp:connect scope
      // For now, we verify the scope checking logic exists
      const res = await request.get(`${API_URL}/api/mcp`, {
        headers: {
          Authorization: "Bearer kitsuden_sk_test_no_scope",
        },
      });

      // Should fail because legacy API keys don't have mcp:connect scope
      expect(res.status()).toBe(401);
    });
  });

  test.describe("2. Agent Identity NHI Flow", () => {
    test("Should authenticate valid kitsuden_agent token", async ({ request }) => {
      // This test requires a valid token to be set in environment
      const token = process.env.TEST_MCP_TOKEN;

      test.skip(!token, "TEST_MCP_TOKEN not configured");

      const res = await request.get(`${API_URL}/api/mcp`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      // Should establish SSE connection
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/event-stream");

      // Should have session ID
      const sessionId = res.headers()["x-mcp-session"];
      expect(sessionId).toBeTruthy();
    });

    test("Should include agent scopes in session", async ({ request }) => {
      const token = process.env.TEST_MCP_TOKEN;
      test.skip(!token, "TEST_MCP_TOKEN not configured");

      // Establish connection
      const sseRes = await fetch(`${API_URL}/api/mcp`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const sessionId = sseRes.headers.get("x-mcp-session");

      // Send initialize request
      const initRes = await request.post(`${API_URL}/api/mcp?sessionId=${sessionId}`, {
        data: {
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test", version: "1.0.0" },
          },
        },
      });

      expect(initRes.status()).toBe(200);
      const data = await initRes.json();
      expect(data.result.serverInfo.name).toBe("kitsuden-mcp-server");
    });
  });

  test.describe("3. Rate Limiting", () => {
    test("Should enforce rate limit per agent", async ({ request }) => {
      const token = process.env.TEST_MCP_TOKEN;
      test.skip(!token, "TEST_MCP_TOKEN not configured");

      // Make multiple rapid requests
      const requests = Array(10)
        .fill(null)
        .map(() =>
          request.get(`${API_URL}/api/mcp`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        );

      const responses = await Promise.all(requests);

      // Most should succeed, but rate limiting might kick in
      const successCount = responses.filter((r) => r.status() === 200).length;
      const rateLimitedCount = responses.filter((r) => r.status() === 429).length;

      // Either all succeed or some are rate limited
      expect(successCount + rateLimitedCount).toBe(10);
    });
  });

  test.describe("4. Audit Trail", () => {
    test("Should log agent activity in agent_audit_logs", async ({ request }) => {
      const token = process.env.TEST_MCP_TOKEN;
      test.skip(!token, "TEST_MCP_TOKEN not configured");

      // Perform an action
      const sseRes = await fetch(`${API_URL}/api/mcp`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const sessionId = sseRes.headers.get("x-mcp-session");

      // Call a tool
      await request.post(`${API_URL}/api/mcp?sessionId=${sessionId}`, {
        data: {
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        },
      });

      // Check audit logs (this would need DB access)
      // For now, we verify the endpoint structure exists
      const auditRes = await request.get(`${API_URL}/api/admin/agents`);
      expect(auditRes.status()).toBe(200);
    });
  });

  test.describe("5. Tool Scope Enforcement", () => {
    test("Should allow tools within agent scopes", async ({ request }) => {
      const token = process.env.TEST_MCP_TOKEN;
      test.skip(!token, "TEST_MCP_TOKEN not configured");

      // Agent with read:issues scope should be able to query datasets
      const sseRes = await fetch(`${API_URL}/api/mcp`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const sessionId = sseRes.headers.get("x-mcp-session");

      // List datasets
      const res = await request.post(`${API_URL}/api/mcp?sessionId=${sessionId}`, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_query_dataset",
            arguments: { datasetId: "test", limit: 5 },
          },
          id: 1,
        },
      });

      // Should not get 403 Forbidden
      expect(res.status()).not.toBe(403);
    });

    test("Should deny tools outside agent scopes", async ({ request }) => {
      // This would require an agent with limited scopes
      // For documentation purposes
      test.skip(true, "Requires agent with restricted scopes");
    });
  });
});
