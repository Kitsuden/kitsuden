/**
 * Hardening 2026-11-20: a data source's header values are never returned.
 *
 * `headers` of an API or webhook data source usually carries an
 * `Authorization` token; the routes returned it in the clear while the password
 * next to it was already hidden. Now responses show each header name with a
 * mask, and a `PUT` that sends the mask back keeps the stored value.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const rows = [
  {
    id: "ds-1",
    name: "CRM API",
    type: "api",
    url: "https://crm.example.test",
    headers: { Authorization: "Bearer secret-token", "X-Tenant": "acme" },
    hasPassword: false,
  },
];

vi.mock("../../apps/api/src/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: async () => rows,
        where: () => ({ limit: async () => rows }),
      }),
    }),
  },
  isLiteMode: false,
}));

vi.mock("../../apps/api/src/middleware/auth", () => ({
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const {
  default: dataSourcesRouter,
  HEADER_MASK,
  maskHeaders,
  mergeHeaders,
} = await import("../../apps/api/src/routes/data-sources");

describe("data source headers", () => {
  it("the list shows header names, not values", async () => {
    const app = new Hono();
    app.route("/api/admin/data-sources", dataSourcesRouter);
    const res = await app.request("/api/admin/data-sources");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(body.data[0].headers).toEqual({ Authorization: HEADER_MASK, "X-Tenant": HEADER_MASK });
  });

  it("one data source shows header names, not values", async () => {
    const app = new Hono();
    app.route("/api/admin/data-sources", dataSourcesRouter);
    const res = await app.request("/api/admin/data-sources/ds-1");
    expect(JSON.stringify(await res.json())).not.toContain("secret-token");
  });

  it("maskHeaders hides every value and tolerates no headers", () => {
    expect(maskHeaders({ A: "1" })).toEqual({ A: HEADER_MASK });
    expect(maskHeaders(null)).toBeNull();
    expect(maskHeaders([])).toBeNull();
  });

  it("a PUT that sends the mask back keeps the stored value", () => {
    const stored = { Authorization: "Bearer old", "X-Old": "gone" };
    expect(mergeHeaders({ Authorization: HEADER_MASK, "X-New": "v" }, stored)).toEqual({
      Authorization: "Bearer old",
      "X-New": "v",
    });
    expect(mergeHeaders({ Authorization: "Bearer new" }, stored)).toEqual({
      Authorization: "Bearer new",
    });
    // A mask for a header that was never stored is dropped, not saved as the mask.
    expect(mergeHeaders({ Missing: HEADER_MASK }, stored)).toEqual({});
  });
});
