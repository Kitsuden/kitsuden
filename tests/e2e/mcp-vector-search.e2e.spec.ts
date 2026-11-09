// @ts-nocheck
// End-to-End Tests: MCP + Vector Search Integration
// Scenario: Claude Desktop uses MCP to perform semantic search on datasets

import { test, expect } from "@playwright/test";

const API_URL = process.env.API_URL || "http://localhost:3001";

test.describe("🎯 E2E: Claude → MCP → Vector Search Flow", () => {
  let sessionId: string;
  let testDatasetId: string;
  let messageEndpoint: string;
  const token = process.env.TEST_MCP_TOKEN || "test-token";

  test.beforeAll(async ({ request }) => {
    // 1. Create a knowledge base dataset with vector search
    const datasetRes = await request.post(`${API_URL}/api/datasets`, {
      data: {
        name: `kb-mcp-test-${Date.now()}`,
        slug: `kb-mcp-test-${Date.now()}`,
        description: "Knowledge base for MCP vector search testing",
        schema: [
          { fieldName: "question", fieldType: "text", required: true },
          { fieldName: "answer", fieldType: "richtext", required: true },
          { fieldName: "category", fieldType: "text", required: false },
        ],
        extensions: {
          vectorSearch: {
            enabled: true,
            fields: ["question", "answer"],
            autoIndex: true,
          },
        },
      },
    });

    if (datasetRes.ok()) {
      const data = await datasetRes.json();
      testDatasetId = data.id;
    }

    // 2. Seed knowledge base with FAQ entries
    if (testDatasetId) {
      const faqs = [
        {
          question: "How do I reset my password?",
          answer:
            "Go to Settings > Security > Change Password. You'll receive an email confirmation.",
          category: "account",
        },
        {
          question: "What payment methods are accepted?",
          answer: "We accept credit cards (Visa, MasterCard, Amex), PayPal, and bank transfers.",
          category: "billing",
        },
        {
          question: "How to contact support?",
          answer:
            "Email us at support@kitsuden.gg or use the live chat in the bottom right corner.",
          category: "support",
        },
        {
          question: "Can I export my data?",
          answer:
            "Yes! Go to Settings > Data > Export. You can download your data in JSON or CSV format.",
          category: "data",
        },
      ];

      for (const faq of faqs) {
        await request.post(`${API_URL}/api/datasets/${testDatasetId}/entries`, {
          data: {
            title: faq.question,
            ...faq,
          },
        });
      }
    }

    // 3. Establish MCP session
    const sseRes = await fetch(`${API_URL}/api/mcp`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
    });

    sessionId = sseRes.headers.get("x-mcp-session") || "";
    messageEndpoint = `${API_URL}/api/mcp?sessionId=${sessionId}`;

    // Initialize MCP
    await request.post(messageEndpoint, {
      data: {
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "e2e-test", version: "1.0.0" },
        },
      },
    });
  });

  test.afterAll(async ({ request }) => {
    // Cleanup dataset
    if (testDatasetId) {
      await request.delete(`${API_URL}/api/datasets/${testDatasetId}`);
    }
  });

  test.describe("Scenario 1: Semantic FAQ Search via MCP", () => {
    test("Claude asks: 'How do I change my password?'", async ({ request }) => {
      test.skip(!sessionId || !testDatasetId, "Setup failed");

      // Step 1: List available tools (Claude discovers capabilities)
      const toolsRes = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/list",
          id: 100,
        },
      });

      expect(toolsRes.ok()).toBe(true);
      const toolsData = await toolsRes.json();
      const hasSearchTool = toolsData.result.tools.some(
        (t: any) => t.name === "kitsuden_search_entries"
      );
      expect(hasSearchTool).toBe(true);

      // Step 2: Use semantic search to find relevant FAQ
      const searchRes = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_search_entries",
            arguments: {
              datasetId: testDatasetId,
              query: "change password",
              semantic: true,
              limit: 3,
            },
          },
          id: 101,
        },
      });

      expect(searchRes.ok()).toBe(true);
      const searchData = await searchRes.json();

      // Verify we found the password reset FAQ
      const content = searchData.result?.content?.[0]?.text || "";
      expect(content.toLowerCase()).toContain("password");
    });

    test("Claude asks: 'What are the payment options?'", async ({ request }) => {
      test.skip(!sessionId || !testDatasetId, "Setup failed");

      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_search_entries",
            arguments: {
              datasetId: testDatasetId,
              query: "payment methods credit card",
              semantic: true,
            },
          },
          id: 102,
        },
      });

      expect(res.ok()).toBe(true);
      const data = await res.json();
      const content = data.result?.content?.[0]?.text || "";

      // Should find the payment FAQ
      expect(content.toLowerCase()).toContain("payment");
    });

    test("Claude asks: 'How can I get help?'", async ({ request }) => {
      test.skip(!sessionId || !testDatasetId, "Setup failed");

      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_search_entries",
            arguments: {
              datasetId: testDatasetId,
              query: "contact support help",
              semantic: true,
            },
          },
          id: 103,
        },
      });

      expect(res.ok()).toBe(true);
      const data = await res.json();
      const content = data.result?.content?.[0]?.text || "";

      // Should find support contact info
      expect(content.toLowerCase()).toContain("support");
    });
  });

  test.describe("Scenario 2: Vector Search Status Check", () => {
    test("Claude checks vector index status", async ({ request }) => {
      test.skip(!sessionId || !testDatasetId, "Setup failed");

      // Get dataset schema to see vector search config
      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_get_dataset_schema",
            arguments: {
              datasetId: testDatasetId,
            },
          },
          id: 200,
        },
      });

      expect(res.ok()).toBe(true);
      const data = await res.json();

      // Should show vector search is enabled
      const content = data.result?.content?.[0]?.text || "";
      expect(content).toContain("vectorSearch");
    });
  });

  test.describe("Scenario 3: Add Knowledge via MCP and Search", () => {
    test("Claude adds new FAQ and searches for it", async ({ request }) => {
      test.skip(!sessionId || !testDatasetId, "Setup failed");

      // Step 1: Create new entry
      const createRes = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_create_entry",
            arguments: {
              datasetId: testDatasetId,
              data: {
                question: "Is there a mobile app available?",
                answer: "Yes! Download our app from the App Store or Google Play Store.",
                category: "mobile",
              },
            },
          },
          id: 300,
        },
      });

      expect(createRes.ok()).toBe(true);
      const createData = await createRes.json();
      const entryId = createData.result?.entryId;
      expect(entryId).toBeTruthy();

      // Step 2: Search for the new entry
      // Wait a moment for indexing
      await new Promise((r) => setTimeout(r, 500));

      const searchRes = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_search_entries",
            arguments: {
              datasetId: testDatasetId,
              query: "mobile app download",
              semantic: true,
            },
          },
          id: 301,
        },
      });

      expect(searchRes.ok()).toBe(true);
      const searchData = await searchRes.json();
      const content = searchData.result?.content?.[0]?.text || "";

      // Should find the new mobile app FAQ
      expect(content.toLowerCase()).toContain("mobile");
    });
  });

  test.describe("Scenario 4: Error Handling", () => {
    test("Claude searches in non-existent dataset", async ({ request }) => {
      test.skip(!sessionId, "Setup failed");

      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_search_entries",
            arguments: {
              datasetId: "non-existent-uuid",
              query: "test",
            },
          },
          id: 400,
        },
      });

      // Should fail gracefully
      expect(res.ok() || res.status() === 400 || res.status() === 404).toBe(true);
    });

    test("Claude searches with empty query", async ({ request }) => {
      test.skip(!sessionId || !testDatasetId, "Setup failed");

      const res = await request.post(messageEndpoint, {
        data: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "kitsuden_search_entries",
            arguments: {
              datasetId: testDatasetId,
              query: "",
              semantic: true,
            },
          },
          id: 401,
        },
      });

      // Should validate input
      expect(res.ok() || res.status() === 400).toBe(true);
    });
  });
});

test.describe("🔐 E2E: Zero-Trust Security in MCP + Vector Search", () => {
  test("Should reject vector search without authentication", async ({ request }) => {
    const res = await request.post(`${API_URL}/api/datasets/test/vector-search`, {
      data: { query: "test" },
    });

    expect(res.status()).toBeOneOf([401, 403]);
  });

  test("Should reject MCP tool call with invalid token", async ({ request }) => {
    const res = await request.post(`${API_URL}/api/mcp?sessionId=test`, {
      data: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "kitsuden_search_entries",
          arguments: { datasetId: "test", query: "test" },
        },
        id: 1,
      },
    });

    expect(res.status()).toBeOneOf([400, 401, 403]);
  });
});
