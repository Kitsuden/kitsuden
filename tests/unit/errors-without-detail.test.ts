/**
 * In production, a 5xx does not show its internal detail to non-admins
 * (earlier audit: `POST /api/datasets/:id/query` returned to any
 * account the Drizzle message, which carries the SQL query with its parameters).
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { errorsWithoutDetail } from "../../apps/api/src/middleware/errors-without-detail";

function app(prod: boolean, role: string | null) {
  const a = new Hono();
  a.use(
    "*",
    errorsWithoutDetail(() => prod)
  );
  a.use("*", async (c, next) => {
    (c as any).set("requestId", "req-1");
    if (role) (c as any).set("user", { id: "u", role });
    await next();
  });
  a.get("/api/x", (c) =>
    c.json(
      { error: "Query execution failed", message: 'Failed query: select * from "auth_users"' },
      500
    )
  );
  a.get("/api/health", (c) => c.json({ status: "degraded", checks: { db: "unavailable" } }, 503));
  a.get("/api/ok", (c) => c.json({ message: "detail that is meant for the client" }, 400));
  return a;
}

describe("errorsWithoutDetail", () => {
  it("production + regular user: generic body with requestId", async () => {
    const r = await app(true, "user").request("/api/x");
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body).toEqual({ error: "Internal Server Error", requestId: "req-1" });
    expect(JSON.stringify(body)).not.toContain("auth_users");
  });

  it("production + anonymous: same", async () => {
    expect(JSON.stringify(await (await app(true, null).request("/api/x")).json())).not.toContain(
      "select"
    );
  });

  it("admin still sees the detail; outside production too", async () => {
    expect((await (await app(true, "admin").request("/api/x")).json()).message).toContain(
      "auth_users"
    );
    expect((await (await app(false, "user").request("/api/x")).json()).message).toContain(
      "auth_users"
    );
  });

  it("does not touch 4xx or health", async () => {
    expect((await (await app(true, null).request("/api/ok")).json()).message).toContain("client");
    expect((await (await app(true, null).request("/api/health")).json()).checks).toBeDefined();
  });
});
