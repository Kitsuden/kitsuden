// @ts-nocheck
// spec: specs/kitsuden-full-coverage.md — Section 11: API Endpoints
// seed: tests/seed.spec.ts

import { test, expect } from "@playwright/test";

const API = (process.env.API_URL || "http://localhost:3001") + "/api";

test.describe("API Health & Endpoints", () => {
  test("Health check returns ok", async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.service).toBe("kitsuden-api");
  });

  test("Games endpoint returns seeded data", async ({ request }) => {
    const res = await request.get(`${API}/games`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data.docs).toBeDefined();
    expect(data.docs.length).toBeGreaterThanOrEqual(3);

    const game = data.docs[0];
    expect(game).toHaveProperty("title");
    expect(game).toHaveProperty("slug");
  });

  test("Games search finds the seeded example game", async ({ request }) => {
    const res = await request.get(`${API}/games?search=example`);
    const data = await res.json();
    expect(data.docs.length).toBeGreaterThanOrEqual(1);
    expect(data.docs[0].title).toContain("Example");
  });

  test("Games slug lookup works", async ({ request }) => {
    const res = await request.get(`${API}/games/slug/example-quest`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.title).toBe("Example Quest");
    expect(data.metacriticScore).toBe(90);
  });

  test("Games 404 for nonexistent slug", async ({ request }) => {
    const res = await request.get(`${API}/games/slug/nonexistent-xyz`);
    expect(res.status()).toBe(404);
  });

  test("Modules endpoint returns correct categories", async ({ request }) => {
    const res = await request.get(`${API}/modules`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    const byKey = new Map(data.docs.map((m: any) => [m.key, m]));

    // Native
    const datasets = byKey.get("datasets");
    expect(datasets).toBeDefined();
    expect(datasets.category).toBe("native");

    // Core
    expect(byKey.get("games")?.category).toBe("core");
    expect(byKey.get("blog")?.category).toBe("core");
    expect(byKey.get("media")?.category).toBe("core");

    // Optional
    expect(byKey.get("streamers")?.category).toBe("optional");
  });

  test("Blog posts endpoint returns data", async ({ request }) => {
    const res = await request.get(`${API}/blog-posts`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.docs.length).toBeGreaterThanOrEqual(1);
  });

  test("Platforms endpoint works", async ({ request }) => {
    const res = await request.get(`${API}/platforms`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.docs.length).toBeGreaterThanOrEqual(4);
  });

  test("Tags endpoint works", async ({ request }) => {
    const res = await request.get(`${API}/tags`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.docs.length).toBeGreaterThanOrEqual(6);
  });

  test("Settings endpoint returns config", async ({ request }) => {
    const res = await request.get(`${API}/settings`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.siteName).toBe("Kitsuden CMS");
  });

  test("Games CRUD lifecycle", async ({ request }) => {
    const slug = `pw-test-${Date.now()}`;

    // Create
    const createRes = await request.post(`${API}/games`, {
      data: {
        title: "Playwright Test Game",
        slug,
        excerpt: "E2E test",
        status: "draft",
        developer: "Test Studio",
        metacriticScore: 88,
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeDefined();

    // Update
    const updateRes = await request.patch(`${API}/games/${created.id}`, {
      data: { metacriticScore: 92, status: "published" },
    });
    expect(updateRes.ok()).toBeTruthy();

    // Delete
    const deleteRes = await request.delete(`${API}/games/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();
  });

  test("404 for nonexistent route", async ({ request }) => {
    const res = await request.get(`${API}/nonexistent-route`);
    expect(res.status()).toBe(404);
  });
});
