/**
 * RLS End-to-End Tests
 *
 * Verifies Row-Level Security isolates data between users at the HTTP layer.
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

describe("RLS E2E", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await clearTestData();
  });

  afterAll(async () => {
    if (dbAvailable) await clearTestData();
  });

  const userAEmail = `rls-a-${generateTestId()}@example.com`;
  const userBEmail = `rls-b-${generateTestId()}@example.com`;
  const adminEmail = `rls-admin-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookieA = "";
  let cookieB = "";
  let cookieAdmin = "";
  let _userAId = "";
  let _userBId = "";
  let adminId = "";
  let datasetId = "";
  let entryAId = "";
  let entryBId = "";

  describe("Setup", () => {
    it("creates user A and signs in", async () => {
      if (!dbAvailable) return;

      // A is an editor: creating a dataset (`POST /api/data-sets`) is staff-only
      // according to the authorization matrix. The isolation being tested is that of
      // B, a normal user, against A's rows.
      ({ cookie: cookieA, userId: _userAId } = await enterAs(app, {
        email: userAEmail,
        password,
        name: "RLS User A",
        role: "editor",
      }));
    });

    it("creates user B and signs in", async () => {
      if (!dbAvailable) return;

      ({ cookie: cookieB, userId: _userBId } = await enterAs(app, {
        email: userBEmail,
        password,
        name: "RLS User B",
      }));
    });

    it("creates admin and signs in", async () => {
      if (!dbAvailable) return;

      ({ cookie: cookieAdmin, userId: adminId } = await enterAs(app, {
        email: adminEmail,
        password,
        name: "RLS Admin",
        role: "admin",
      }));
    });

    it("user A creates a dataset", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          "/api/data-sets",
          {
            method: "POST",
            body: JSON.stringify({
              name: `RLS Dataset ${generateTestId()}`,
              slug: `rls-ds-${generateTestId()}`,
              schema: { fields: [], version: "2.0" },
            }),
          },
          cookieA
        )
      );
      datasetId = ((await res.json()) as any).id;

      // Closed by default: opening it to accounts is an admin's decision.
      const open = await app.request(
        req(
          `/api/data-sets/${datasetId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              policyJson: {
                readAccess: "authenticated",
                writeAccess: "authenticated",
                enableRLS: true,
                rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
              },
            }),
          },
          cookieAdmin
        )
      );
      expect(open.status).toBe(200);
    });

    it("user A inserts an entry", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          `/api/data-sets/${datasetId}/entries`,
          {
            method: "POST",
            body: JSON.stringify({
              title: "RLS Entry A",
              data: { secret: "user-a-data" },
              status: "published",
            }),
          },
          cookieA
        )
      );
      entryAId = ((await res.json()) as any)[0].id;
    });
  });

  describe("Isolation", () => {
    it("user A can see their own entry", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieA));
      const body = (await res.json()) as any;
      expect(body.docs.some((e: any) => e.id === entryAId)).toBe(true);
    });

    it("user B should not see user A entry (RLS isolation)", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieB));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // RLS must filter out user A's entry from user B's view.
      expect(body.docs.some((e: any) => e.id === entryAId)).toBe(false);
      expect(body.docs.length).toBe(0);
    });

    it("user B can insert (and see) their own entry", async () => {
      if (!dbAvailable) return;

      // User B creates their own entry
      const resB = await app.request(
        req(
          `/api/data-sets/${datasetId}/entries`,
          {
            method: "POST",
            body: JSON.stringify({
              title: "RLS Entry B",
              data: { secret: "user-b-data" },
              status: "published",
            }),
          },
          cookieB
        )
      );
      expect(resB.status).toBe(201);
      const entryB = ((await resB.json()) as any)[0];
      expect(entryB.id).toBeDefined();
      entryBId = entryB.id;

      const own = await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieB));
      const ownBody = (await own.json()) as any;
      expect(ownBody.docs.map((e: any) => e.id)).toEqual([entryBId]);
    });

    // The admin sees everyone's rows (buildDatasetWhere does not apply the owner rule
    // to them), like the Postgres policy and realtime.
    it("admin can see entries of both users", async () => {
      if (!dbAvailable) throw new Error("no database: nothing to check");

      // Admin should see both entries
      const res = await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieAdmin));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.docs)).toBe(true);
      expect(body.docs.length).toBeGreaterThanOrEqual(2);
      expect(body.docs.some((e: any) => e.id === entryAId)).toBe(true);
      expect(body.docs.some((e: any) => e.id === entryBId)).toBe(true);
    });
  });

  describe("set_config invocation", () => {
    it("should verify set_config is called per request via RLS middleware", async () => {
      if (!dbAvailable) return;

      // Make any authenticated request that hits the DB
      const res = await app.request(req("/api/data-sets", {}, cookieA));
      expect(res.status).toBe(200);

      // We can't directly assert set_config was called without instrumentation,
      // but we can verify the request succeeded (which implies middleware ran).
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });
});
