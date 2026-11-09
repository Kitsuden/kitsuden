/**
 * Kitsuden Functions (Workers) HTTP Tests
 *
 * Tests CRUD and execution of cloud functions via HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { app } from "../index";

import { isDatabaseAvailable, clearTestData, generateTestId, enterAs } from "./setup";

let dbAvailable = false;

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

describe("Functions HTTP", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await clearTestData();
  });

  afterAll(async () => {
    if (dbAvailable) await clearTestData();
  });

  const email = `functions-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookie = "";
  let fnId = "";
  let fnSlug = "";

  describe("Setup", () => {
    it("creates and signs in a user", async () => {
      if (!dbAvailable) return;

      // /api/functions is admin-only (middleware/authorization-matrix.ts):
      // it runs code on the server. Before, any account could.
      ({ cookie } = await enterAs(app, {
        email,
        password,
        name: "Functions User",
        role: "admin",
      }));
    });
  });

  describe("CRUD", () => {
    it("should create a function", async () => {
      if (!dbAvailable) return;

      fnSlug = `test-fn-${generateTestId()}`;
      const res = await app.request(
        req(
          "/api/functions",
          {
            method: "POST",
            body: JSON.stringify({
              name: "Test Function",
              slug: fnSlug,
              code: "return { hello: 'world' };",
              trigger: "manual",
              description: "Created by test",
            }),
          },
          cookie
        )
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.slug).toBe(fnSlug);
      fnId = body.id;
    });

    it("should list functions", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/functions", {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body.docs)).toBe(true);
      expect(body.docs.some((f: any) => f.id === fnId)).toBe(true);
    });

    it("should filter functions by trigger", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/functions?trigger=manual", {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.docs.every((f: any) => f.trigger === "manual")).toBe(true);
    });

    it("should get function by id", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/functions/${fnId}`, {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.id).toBe(fnId);
      expect(body.slug).toBe(fnSlug);
    });

    it("should update function code", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          `/api/functions/${fnId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              code: "return { updated: true };",
              description: "Updated by test",
            }),
          },
          cookie
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.code).toBe("return { updated: true };");
    });

    it("should reject function without required fields", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          "/api/functions",
          {
            method: "POST",
            body: JSON.stringify({ name: "Incomplete" }),
          },
          cookie
        )
      );

      expect(res.status).toBe(400);
    });

    it("should get cron status", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/functions/cron/status", {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body.jobs)).toBe(true);
    });
  });

  describe("Execution", () => {
    it("should execute function manually", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          `/api/functions/${fnId}/execute`,
          { method: "POST", body: JSON.stringify({ payload: {} }) },
          cookie
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(typeof body.success).toBe("boolean");
    });

    it("should get execution logs", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/functions/${fnId}/executions`, {}, cookie));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body.docs)).toBe(true);
    });
  });

  describe("Cleanup", () => {
    it("should delete function", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/functions/${fnId}`, { method: "DELETE" }, cookie));
      expect(res.status).toBe(200);

      // Verify deletion
      const getRes = await app.request(req(`/api/functions/${fnId}`, {}, cookie));
      expect(getRes.status).toBe(404);
    });
  });
});
