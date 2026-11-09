/**
 * System Routes HTTP Tests
 *
 * Tests health checks, init-check, setup, grimoires, themes.
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;
let appInstance: any = null;

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

describe("System HTTP", () => {
  beforeAll(async () => {
    const mod = await import("../index");
    appInstance = mod.app;

    dbAvailable = await isDatabaseAvailable();
  });

  const email = `system-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookie = "";

  describe("Public Endpoints", () => {
    it("GET /api/system/init-check → returns initialization status", async () => {
      const res = await appInstance!.request(req("/api/system/init-check"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(typeof body.initialized).toBe("boolean");
    });

    it("GET /api/system/themes → lists themes", async () => {
      const res = await appInstance!.request(req("/api/system/themes"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body.docs)).toBe(true);
    });

    it("GET /api/system/grimoires → lists grimoires", async () => {
      const res = await appInstance!.request(req("/api/system/grimoires"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body)).toBe(true);
    });

    it("GET /api/system/grimoires/:id → returns grimoire detail", async () => {
      const listRes = await appInstance!.request(req("/api/system/grimoires"));
      expect(listRes.status).toBe(200);
      const grimoires = (await listRes.json()) as any[];
      const grimoireId = grimoires[0]?.id ?? "grimoire-default";

      const res = await appInstance!.request(req(`/api/system/grimoires/${grimoireId}`));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.id).toBe(grimoireId);
    });

    it("GET /api/system/active-theme-config → returns theme config", async () => {
      const res = await appInstance!.request(req("/api/system/active-theme-config"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty("theme");
      expect(body).toHaveProperty("branding");
    });
  });

  describe("Setup", () => {
    it("POST /api/system/setup → creates first admin or rejects when initialized", async () => {
      // Signing up the first admin goes through Better-Auth: several tables, an
      // argon2 hash and a transaction. pg-mem cannot sustain it (the suite itself applies
      // the migrations with 63 statements that fail), so without real
      // PostgreSQL this does not test sign-up, it tests pg-mem.
      if (!dbAvailable) return;

      const initRes = await appInstance!.request(req("/api/system/init-check"));
      expect(initRes.status).toBe(200);
      const { initialized } = (await initRes.json()) as any;

      const setupEmail = `setup-${generateTestId()}@example.com`;
      const res = await appInstance!.request(
        req("/api/system/setup", {
          method: "POST",
          body: JSON.stringify({
            name: "Setup Admin",
            email: setupEmail,
            password,
          }),
        })
      );

      if (initialized) {
        expect(res.status).toBe(403);
      } else {
        expect([200, 201]).toContain(res.status);
      }
    });

    it("POST /api/system/setup → a failure does NOT return the SQL to the client", async () => {
      // This route is public and pre-authentication. It returned `e.message`,
      // which in a Drizzle error is the entire query with its parameters:
      // the schema and the email just sent, for anyone who calls.
      const res = await appInstance!.request(
        req("/api/system/setup", {
          method: "POST",
          body: JSON.stringify({
            name: "Leak Probe",
            email: `leak-${generateTestId()}@example.com`,
            password,
          }),
        })
      );

      const body = await res.text();
      expect(body).not.toContain("select ");
      expect(body).not.toContain("auth_users");
      expect(body).not.toContain("params:");
    });
  });

  describe("Authenticated Endpoints", () => {
    it("creates and signs in a user", async () => {
      if (!dbAvailable) return;

      // Changing the active grimoire is admin-only (middleware/authorization-matrix.ts):
      // it changes the entire site. Before, having a session was enough.
      ({ cookie } = await enterAs(appInstance!, {
        email,
        password,
        name: "System User",
        role: "admin",
      }));
    });

    it("POST /api/system/grimoire-state → deactivates grimoire as admin", async () => {
      if (!dbAvailable) return;

      const res = await appInstance!.request(
        req(
          "/api/system/grimoire-state",
          {
            method: "POST",
            body: JSON.stringify({ action: "deactivate" }),
          },
          cookie
        )
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });
  });
});
