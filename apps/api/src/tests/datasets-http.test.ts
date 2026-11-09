/**
 * Dataset CRUD + Entries HTTP Tests
 *
 * Tests dataset and entry operations via HTTP through the Hono app.
 * Covers: create, list, entries CRUD, RLS filtering.
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

describe("Dataset HTTP CRUD", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await clearTestData();
  });

  afterAll(async () => {
    if (dbAvailable) await clearTestData();
  });

  const userAEmail = `ds-user-a-${generateTestId()}@example.com`;
  const userBEmail = `ds-user-b-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookieA = "";
  let cookieB = "";
  let cookieAdmin = "";
  let userAId = "";
  let userBId = "";
  let datasetId = "";
  let entryId = "";

  describe("Setup Users", () => {
    it("should create user A and sign in", async () => {
      if (!dbAvailable) return;

      // Creating a dataset (`POST /api/data-sets`) is staff-only according to the
      // authorization matrix: A is an editor. B stays as a normal user, which is
      // exactly who isolation between users has to protect.
      ({ cookie: cookieA, userId: userAId } = await enterAs(app, {
        email: userAEmail,
        password,
        name: "User A",
        role: "editor",
      }));
    });

    it("should create user B and sign in", async () => {
      if (!dbAvailable) return;

      ({ cookie: cookieB, userId: userBId } = await enterAs(app, {
        email: userBEmail,
        password,
        name: "User B",
      }));
    });

    it("should create an admin and sign in", async () => {
      if (!dbAvailable) return;

      // The Kitsuden QL query on a dataset with per-owner rows and
      // `/api/datasets/batch` are admin-only since the
      // audit (see «Dataset Query Engine» below).
      ({ cookie: cookieAdmin } = await enterAs(app, {
        email: `ds-admin-${generateTestId()}@example.com`,
        password,
        name: "Dataset Admin",
        role: "admin",
      }));
    });
  });

  describe("Create Dataset", () => {
    it("should create a dataset via HTTP", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          "/api/data-sets",
          {
            method: "POST",
            body: JSON.stringify({
              name: `HTTP Test Dataset ${generateTestId()}`,
              slug: `http-ds-${generateTestId()}`,
              description: "Created via HTTP test",
              schema: {
                fields: [{ id: "f1", key: "title", type: "text", label: "Title", required: true }],
                version: "2.0",
              },
            }),
          },
          cookieA
        )
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.name).toContain("HTTP Test Dataset");
      datasetId = body.id;
    });

    it("opens the dataset to accounts (it is closed by default): only an admin can", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
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
      expect(res.status).toBe(200);
    });

    it("should reject dataset creation without auth", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/data-sets", {
          method: "POST",
          body: JSON.stringify({ name: "No Auth Dataset", slug: `no-auth-${generateTestId()}` }),
        })
      );

      expect(res.status).toBe(401);
    });
  });

  describe("List Datasets", () => {
    it("should list datasets", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/data-sets", {}, cookieA));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body.docs)).toBe(true);
      expect(body.docs.length).toBeGreaterThan(0);
      expect(body.docs.some((d: any) => d.id === datasetId)).toBe(true);
    });

    it("should list datasets with limit", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/data-sets?limit=1", {}, cookieA));
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.docs.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Dataset Entries", () => {
    it("should insert an entry into dataset", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          `/api/data-sets/${datasetId}/entries`,
          {
            method: "POST",
            body: JSON.stringify({
              title: "Test Entry A",
              data: { title: "Test Entry A", score: 42 },
              status: "published",
            }),
          },
          cookieA
        )
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].title).toBe("Test Entry A");
      entryId = body[0].id;
    });

    it("should list entries for dataset", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieA));

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.docs.length).toBeGreaterThan(0);
      expect(body.docs[0].title).toBe("Test Entry A");
    });

    it("should reject entry insert without auth", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(`/api/data-sets/${datasetId}/entries`, {
          method: "POST",
          body: JSON.stringify({ title: "No Auth Entry" }),
        })
      );

      expect(res.status).toBe(401);
    });
  });

  describe("RLS Filtering", () => {
    it("should not show user A entries to user B (HTTP layer)", async () => {
      if (!dbAvailable) return;

      // User B lists entries for the same dataset
      const res = await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieB));

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      // RLS must filter entries created by user A when queried by user B.
      expect(body.docs.some((e: any) => e.id === entryId)).toBe(false);
      expect(body.docs.length).toBe(0);
    });

    // ?count=exact (performance): the count goes through the SAME
    // visibility as the rows. B does not see A's: their count is 0, not the total.
    it("?count=exact counts only what the asker can see (and limit=0 reads no rows)", async () => {
      if (!dbAvailable) return;

      const fromA = (await (
        await app.request(req(`/api/data-sets/${datasetId}/entries?count=exact`, {}, cookieA))
      ).json()) as any;
      expect(fromA.totalCount).toBe(fromA.docs.length);
      expect(fromA.totalCount).toBeGreaterThan(0);

      const onlyCountTo = (await (
        await app.request(
          req(`/api/data-sets/${datasetId}/entries?count=exact&limit=0`, {}, cookieA)
        )
      ).json()) as any;
      expect(onlyCountTo.docs).toEqual([]);
      expect(onlyCountTo.totalCount).toBe(fromA.totalCount);

      const resB = await app.request(
        req(`/api/data-sets/${datasetId}/entries?count=exact&limit=0`, {}, cookieB)
      );
      expect(resB.status).toBe(200);
      expect(((await resB.json()) as any).totalCount).toBe(0);

      // Without the parameter, the response is the usual one
      const withoutCounting = (await (
        await app.request(req(`/api/data-sets/${datasetId}/entries`, {}, cookieA))
      ).json()) as any;
      expect("totalCount" in withoutCounting).toBe(false);
    });
  });

  describe("Dataset Query Engine", () => {
    it("should refuse the query engine to non-admins on a per-owner dataset (403)", async () => {
      if (!dbAvailable) return;

      // The query engine does not know how to apply the policy's `rlsRules`:
      // with a dataset isolated by owner, any account with read access saw everyone's rows
      // through here. Until it understands them, admin only
      // (`queryWouldSkipIsolation` in routes/datasets-query.ts).
      const res = await app.request(
        req(
          `/api/datasets/${datasetId}/query`,
          { method: "POST", body: JSON.stringify({ where: { title: { eq: "Test Entry A" } } }) },
          cookieA
        )
      );
      expect(res.status).toBe(403);
    });

    it("should query entries with filters via POST /api/datasets/:id/query", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req(
          `/api/datasets/${datasetId}/query`,
          {
            method: "POST",
            body: JSON.stringify({
              where: { title: { eq: "Test Entry A" } },
            }),
          },
          cookieAdmin
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
      expect(body.data[0].title).toBe("Test Entry A");
      expect(body.meta.total).toBe(1);
    });

    it("should batch insert entries", async () => {
      if (!dbAvailable) return;

      // `/api/datasets/batch` operates on any table in a transaction:
      // admin only (authorization matrix and `canUseBatch`).
      const prohibited = await app.request(
        req(
          "/api/datasets/batch",
          { method: "POST", body: JSON.stringify({ operations: [] }) },
          cookieA
        )
      );
      expect(prohibited.status).toBe(403);

      const res = await app.request(
        req(
          "/api/datasets/batch",
          {
            method: "POST",
            body: JSON.stringify({
              operations: [
                {
                  op: "create",
                  table: "dataEntries",
                  data: {
                    dataSetId: datasetId,
                    title: "Batch 1",
                    data: { index: 1 },
                    status: "published",
                  },
                },
                {
                  op: "create",
                  table: "dataEntries",
                  data: {
                    dataSetId: datasetId,
                    title: "Batch 2",
                    data: { index: 2 },
                    status: "published",
                  },
                },
              ],
            }),
          },
          cookieAdmin
        )
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.results).toHaveLength(2);
      // Each result carries `status: "created"` and the summary goes in `meta`
      // (routes/datasets-query.ts); there is no longer a `success` per operation.
      expect(body.results.every((r: any) => r.status === "created")).toBe(true);
      expect(body.meta.successfulOperations).toBe(2);
      expect(body.meta.failedOperations).toBe(0);
    });
  });
});
