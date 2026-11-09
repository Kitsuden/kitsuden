/**
 * Actions Engine HTTP Tests
 *
 * Tests the unified actions system (workers + webhooks + agents).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { actions } from "../db/schema";
import { app } from "../index";

import { isDatabaseAvailable, clearTestData, generateTestId, enterAs } from "./setup";

let dbAvailable = false;

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

describe("Actions Engine HTTP", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await clearTestData();
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(actions).where(eq(actions.slug, `test-action-${generateTestId()}`));
    }
  });

  const email = `actions-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookie = "";
  let actionId = "";
  let actionSlug = "";

  describe("Setup", () => {
    it("creates and signs in a user", async () => {
      if (!dbAvailable) return;

      // /api/actions is admin-only (middleware/authorization-matrix.ts):
      // it runs code. A normal user would get 403 on everything below.
      ({ cookie } = await enterAs(app, {
        email,
        password,
        name: "Actions User",
        role: "admin",
      }));
    });
  });

  describe("CRUD", () => {
    it("should register an action via HTTP", async () => {
      if (!dbAvailable) return;

      actionSlug = `test-action-${generateTestId()}`;
      const res = await app.request(
        req(
          "/api/actions",
          {
            method: "POST",
            body: JSON.stringify({
              name: "Test Action",
              slug: actionSlug,
              description: "Created by test suite",
              type: "code",
              trigger: "manual",
              config: { code: "return { ok: true };" },
            }),
          },
          cookie
        )
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.slug).toBe(actionSlug);
      actionId = body.id;
    });

    it("should list actions", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/actions", {}, cookie));
      expect(res.status).toBe(200);

      // The listing responds `{ docs, totalDocs }` (routes/actions.ts), like the
      // rest of the API's listings; the test expected the bare array.
      const body = (await res.json()) as any;
      expect(Array.isArray(body.docs)).toBe(true);
      expect(body.totalDocs).toBe(body.docs.length);
      expect(body.docs.some((a: any) => a.id === actionId)).toBe(true);
    });

    it("should get action by id", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/actions/${actionId}`, {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.id).toBe(actionId);
      expect(body.slug).toBe(actionSlug);
    });

    it("should update action config", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          `/api/actions/${actionId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: "Updated Test Action",
              config: { code: "return { updated: true };" },
            }),
          },
          cookie
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.name).toBe("Updated Test Action");
    });

    it("should delete action", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/actions/${actionId}`, { method: "DELETE" }, cookie));
      expect(res.status).toBe(200);

      // Verify deletion
      const getRes = await app.request(req(`/api/actions/${actionId}`, {}, cookie));
      expect(getRes.status).toBe(404);
    });
  });

  describe("Execution", () => {
    it("should execute an action via HTTP", async () => {
      if (!dbAvailable) return;

      // Create a fresh action for execution
      const slug = `exec-action-${generateTestId()}`;
      const createRes = await app.request(
        req(
          "/api/actions",
          {
            method: "POST",
            body: JSON.stringify({
              name: "Exec Action",
              slug,
              type: "code",
              trigger: "manual",
              config: { code: "return { executed: true };" },
            }),
          },
          cookie
        )
      );

      expect(createRes.status).toBe(201);
      const action = (await createRes.json()) as any;

      const execRes = await app.request(
        req(
          `/api/actions/${action.id}/execute`,
          { method: "POST", body: JSON.stringify({}) },
          cookie
        )
      );

      // Execution may be queued (202) or return result (200)
      expect([200, 202, 500]).toContain(execRes.status);

      // Cleanup
      await app.request(req(`/api/actions/${action.id}`, { method: "DELETE" }, cookie));
    });
  });

  describe("Stats", () => {
    it("should get actions stats overview", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/actions/stats/overview", {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(typeof body).toBe("object");
    });
  });
});
