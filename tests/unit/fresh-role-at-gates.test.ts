/**
 * Role gates read the FRESH role, not the one from the cookie cache
 * (earlier audit). With better-auth's `cookieCache`, a demoted admin
 * kept the old role valid for up to 5 minutes.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { requireAdminRole, setSessionRefresh } from "../../apps/api/src/middleware/auth-guard";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    // What the global middleware leaves from the cookie cache: old role
    (c as any).set("user", { id: "u1", role: "admin" });
    (c as any).set("session", { id: "s1" });
    await next();
  });
  a.use("*", requireAdminRole);
  a.all("*", (c) => c.text("inside"));
  return a;
}

afterEach(() => {
  // Reasonable default for the rest of the suite: trust the context
  setSessionRefresh(async () => ({ role: "admin" }));
});

describe("requireRole with a human session", () => {
  it("demoted in the database → 403 even if the cookie says admin", async () => {
    setSessionRefresh(async () => ({ role: "user" }));
    expect((await app().request("/api/items/x")).status).toBe(403);
  });

  it("session closed in the database → 401", async () => {
    setSessionRefresh(async () => null);
    expect((await app().request("/api/items/x")).status).toBe(401);
  });

  it("still admin → allowed in", async () => {
    setSessionRefresh(async () => ({ role: "admin" }));
    expect((await app().request("/api/items/x")).status).toBe(200);
  });
});
