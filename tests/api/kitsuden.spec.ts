// spec: packages/themes/kitsuden-cms/kitsuden-progress.txt
// seed: tests/seed.spec.ts

import { test, expect } from "@playwright/test";

const API = (process.env.API_URL || "http://localhost:3001") + "/api";

test.describe("Kitsuden CMS - Competitive Core API", () => {
  test("Players endpoint CRUD lifecycle", async ({ request }) => {
    const alias = `test-player-${Date.now()}`;

    // Create
    const createRes = await request.post(`${API}/players`, {
      data: {
        alias,
        bio: "E2E Test Player",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeDefined();
    expect(created.alias).toBe(alias);

    // Read List
    const listRes = await request.get(`${API}/players`);
    expect(listRes.ok()).toBeTruthy();
    const listData = await listRes.json();
    expect(Array.isArray(listData)).toBeTruthy();
    expect(listData.some((p: any) => p.id === created.id)).toBeTruthy();

    // Read Single
    const singleRes = await request.get(`${API}/players/${created.id}`);
    expect(singleRes.ok()).toBeTruthy();
    const singleData = await singleRes.json();
    expect(singleData.id).toBe(created.id);

    // Update
    const updateRes = await request.patch(`${API}/players/${created.id}`, {
      data: { bio: "Updated Test Player" },
    });
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.bio).toBe("Updated Test Player");

    // Delete
    const deleteRes = await request.delete(`${API}/players/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();

    // Verify Deletion
    const notFoundRes = await request.get(`${API}/players/${created.id}`);
    expect(notFoundRes.status()).toBe(404);
  });

  test("Teams endpoint CRUD lifecycle", async ({ request }) => {
    const teamName = `Test Team ${Date.now()}`;

    // Create Team
    const createRes = await request.post(`${API}/teams`, {
      data: {
        name: teamName,
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe(teamName);

    // Update
    const updateRes = await request.patch(`${API}/teams/${created.id}`, {
      data: { name: teamName + " Updated" },
    });
    expect(updateRes.ok()).toBeTruthy();

    // Delete
    const deleteRes = await request.delete(`${API}/teams/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();
  });

  test("Tournaments endpoint exists", async ({ request }) => {
    // Just verify list endpoint works (Epic 2)
    const res = await request.get(`${API}/tournaments`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test("Matches endpoint exists", async ({ request }) => {
    // Just verify list endpoint works (Epic 3)
    const res = await request.get(`${API}/matches`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });
});
