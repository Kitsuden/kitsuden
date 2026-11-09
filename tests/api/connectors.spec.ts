// @ts-nocheck
// spec: Epic 4 — Data Connectors E2E Tests

import { test, expect } from "@playwright/test";

const API = (process.env.API_URL || "http://localhost:3001") + "/api";

test.describe("Data Connectors", () => {
  let apiConnectorId: string;
  let dbConnectorId: string;

  // ── 1. API Connector Lifecycle ──
  test("CRUD lifecycle for API Connector", async ({ request }) => {
    // CREATE
    const createRes = await request.post(`${API}/custom/connectors`, {
      data: {
        name: "Test Public API",
        type: "api",
        config: {
          url: "https://jsonplaceholder.typicode.com/users",
          method: "GET",
        },
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    apiConnectorId = created.id;
    expect(created.name).toBe("Test Public API");
    expect(created.type).toBe("api");
    expect(created.enabled).toBe(true);
    expect(created.config.url).toBe("https://jsonplaceholder.typicode.com/users");

    // READ (list)
    const listRes = await request.get(`${API}/custom/connectors`);
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.docs.length).toBeGreaterThanOrEqual(1);
    const found = list.docs.find((c: any) => c.id === apiConnectorId);
    expect(found).toBeDefined();

    // READ (single)
    const getRes = await request.get(`${API}/custom/connectors/${apiConnectorId}`);
    expect(getRes.ok()).toBeTruthy();
    const fetched = await getRes.json();
    expect(fetched.name).toBe("Test Public API");

    // UPDATE
    const updateRes = await request.patch(`${API}/custom/connectors/${apiConnectorId}`, {
      data: {
        name: "Updated API Connector",
        enabled: false,
      },
    });
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.name).toBe("Updated API Connector");
    expect(updated.enabled).toBe(false);

    // FETCH DATA
    const dataRes = await request.get(`${API}/custom/connectors/${apiConnectorId}/data`);
    expect(dataRes.ok()).toBeTruthy();
    const apiData = await dataRes.json();
    expect(apiData.source).toBe("api");
    expect(apiData.data).toBeDefined();
    expect(Array.isArray(apiData.data)).toBe(true);
    expect(apiData.columns).toBeDefined();

    // Test Connection
    const testRes = await request.post(`${API}/custom/connectors/${apiConnectorId}/test`);
    expect(testRes.ok()).toBeTruthy();
    const testData = await testRes.json();
    expect(testData.success).toBe(true);
    expect(testData.type).toBe("api");

    // DELETE
    const deleteRes = await request.delete(`${API}/custom/connectors/${apiConnectorId}`);
    expect(deleteRes.ok()).toBeTruthy();

    // Verify deleted
    const verifyRes = await request.get(`${API}/custom/connectors/${apiConnectorId}`);
    expect(verifyRes.status()).toBe(404);
  });

  // ── 2. Validation ──
  test("Validation rules for creating connectors", async ({ request }) => {
    // Missing fields
    const res1 = await request.post(`${API}/custom/connectors`, {
      data: { name: "Missing Type" },
    });
    expect(res1.status()).toBe(400);

    // Invalid type
    const res2 = await request.post(`${API}/custom/connectors`, {
      data: {
        name: "Invalid Type",
        type: "invalid",
        config: {},
      },
    });
    expect(res2.status()).toBe(400);

    // Missing API config
    const res3 = await request.post(`${API}/custom/connectors`, {
      data: {
        name: "Missing API URL",
        type: "api",
        config: {},
      },
    });
    expect(res3.status()).toBe(400);

    // Missing DB config
    const res4 = await request.post(`${API}/custom/connectors`, {
      data: {
        name: "Missing DB Config",
        type: "database",
        config: { host: "localhost" },
      },
    });
    expect(res4.status()).toBe(400);
  });

  // Note: We cannot easily E2E test the DB Introspection connector lifecycle
  // comprehensively without a guaranteed external MySQL database running
  // alongside the test runner.
  // The API connector tests prove the CRUD and routing structure works.
});
