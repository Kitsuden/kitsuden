// spec: Epic 2 — Webhooks Engine E2E Tests

import { test, expect } from "@playwright/test";

const API = (process.env.API_URL || "http://localhost:3001") + "/api";

// We need a valid dataset ID for webhook tests.
// Fetch one dynamically from the seeded data.
let datasetId: string;

test.describe("Webhooks Engine", () => {
  test.beforeAll(async ({ request }) => {
    // Ensure we have at least one dataset to attach webhooks to
    const res = await request.get(`${API}/data-sets`);
    const data = await res.json();
    if (data.docs && data.docs.length > 0) {
      datasetId = data.docs[0].id;
    }
  });

  // ── CRUD Lifecycle ──
  test("Full webhook CRUD lifecycle", async ({ request }) => {
    test.skip(!datasetId, "No datasets available for testing");

    // CREATE
    const createRes = await request.post(`${API}/custom/webhooks`, {
      data: {
        name: "Test Webhook",
        datasetId,
        event: "on_create",
        targetUrl: "https://httpbin.org/post",
        secret: "test-secret-123",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe("Test Webhook");
    expect(created.event).toBe("on_create");
    expect(created.enabled).toBe(true);

    const webhookId = created.id;

    // READ (single)
    const getRes = await request.get(`${API}/custom/webhooks/${webhookId}`);
    expect(getRes.ok()).toBeTruthy();
    const fetched = await getRes.json();
    expect(fetched.id).toBe(webhookId);

    // READ (list)
    const listRes = await request.get(`${API}/custom/webhooks`);
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.docs.length).toBeGreaterThanOrEqual(1);

    // READ (filtered by datasetId)
    const filteredRes = await request.get(`${API}/custom/webhooks?datasetId=${datasetId}`);
    expect(filteredRes.ok()).toBeTruthy();
    const filtered = await filteredRes.json();
    expect(filtered.docs.some((w: any) => w.id === webhookId)).toBe(true);

    // UPDATE
    const updateRes = await request.patch(`${API}/custom/webhooks/${webhookId}`, {
      data: {
        name: "Updated Webhook",
        enabled: false,
      },
    });
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.name).toBe("Updated Webhook");
    expect(updated.enabled).toBe(false);

    // DELETE
    const deleteRes = await request.delete(`${API}/custom/webhooks/${webhookId}`);
    expect(deleteRes.ok()).toBeTruthy();
    const deleted = await deleteRes.json();
    expect(deleted.success).toBe(true);

    // Verify deleted
    const verifyRes = await request.get(`${API}/custom/webhooks/${webhookId}`);
    expect(verifyRes.status()).toBe(404);
  });

  // ── Validation ──
  test("Create webhook rejects missing fields", async ({ request }) => {
    const res = await request.post(`${API}/custom/webhooks`, {
      data: { name: "Incomplete" },
    });
    expect(res.status()).toBe(400);
  });

  test("Create webhook rejects invalid event", async ({ request }) => {
    test.skip(!datasetId, "No datasets available for testing");

    const res = await request.post(`${API}/custom/webhooks`, {
      data: {
        name: "Bad Event",
        datasetId,
        event: "on_explode",
        targetUrl: "https://example.com",
      },
    });
    expect(res.status()).toBe(400);
  });

  // ── Test Ping ──
  test("Test ping queues a delivery", async ({ request }) => {
    test.skip(!datasetId, "No datasets available for testing");

    // Create a webhook for the test
    const createRes = await request.post(`${API}/custom/webhooks`, {
      data: {
        name: "Ping Test Webhook",
        datasetId,
        event: "on_update",
        targetUrl: "https://httpbin.org/post",
      },
    });
    const created = await createRes.json();
    const webhookId = created.id;

    // Send test ping
    const pingRes = await request.post(`${API}/custom/webhooks/${webhookId}/test`);
    expect(pingRes.ok()).toBeTruthy();
    const ping = await pingRes.json();
    expect(ping.queued).toBe(true);

    // Cleanup
    await request.delete(`${API}/custom/webhooks/${webhookId}`);
  });

  // ── Logs Endpoint ──
  test("Logs endpoint returns delivery history", async ({ request }) => {
    test.skip(!datasetId, "No datasets available for testing");

    // Create a webhook
    const createRes = await request.post(`${API}/custom/webhooks`, {
      data: {
        name: "Logs Test Webhook",
        datasetId,
        event: "on_create",
        targetUrl: "https://httpbin.org/post",
      },
    });
    const created = await createRes.json();
    const webhookId = created.id;

    // Fetch logs (should be empty initially)
    const logsRes = await request.get(`${API}/custom/webhooks/${webhookId}/logs`);
    expect(logsRes.ok()).toBeTruthy();
    const logs = await logsRes.json();
    expect(logs.docs).toBeDefined();
    expect(Array.isArray(logs.docs)).toBe(true);

    // Cleanup
    await request.delete(`${API}/custom/webhooks/${webhookId}`);
  });

  // ── 404 Cases ──
  test("Get nonexistent webhook returns 404", async ({ request }) => {
    const res = await request.get(`${API}/custom/webhooks/00000000-0000-0000-0000-000000000000`);
    expect(res.status()).toBe(404);
  });

  test("Test ping on nonexistent webhook returns 404", async ({ request }) => {
    const res = await request.post(
      `${API}/custom/webhooks/00000000-0000-0000-0000-000000000000/test`
    );
    expect(res.status()).toBe(404);
  });
});
