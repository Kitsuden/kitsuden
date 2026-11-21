/**
 * An agent key's `!pattern` denials hold on every gate (hardening 2026-11-20)
 * ============================================================================
 *
 * `requireAdmin` and `requireScope` let `admin` (or the scope) through without
 * looking at the key's denials; `agentCanActAsUser` dropped the denials before
 * asking about `user:act`, so `!user:act` did nothing; `/api/mail` and
 * `/api/runs` had no prefix gate (fresh role, denials).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) } },
}));

import { forgetKonRouters, registerKonRouter } from "../../apps/api/src/lib/kon-routes";
import {
  ADMIN_ONLY_ROUTES,
  protectRoute,
  refuseDeniedScope,
  requireAdmin,
  requireScope,
  ruleFor,
} from "../../apps/api/src/middleware/auth-guard";

registerKonRouter("kon-hardtest", "/api/hardtest", { routes: [] });
afterAll(() => forgetKonRouters());

function asAgent(scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    c.set("agent" as never, { agentId: "ag_1", scopes } as never);
    await next();
  };
}

async function status(scopes: string[], gate: MiddlewareHandler, path: string) {
  const a = new Hono();
  a.use("*", asAgent(scopes));
  a.post("*", gate, (c) => c.json({ ok: true }));
  return (await a.request(path, { method: "POST" })).status;
}

describe("requireAdmin honours the agent's denials", () => {
  it("`admin` with a denial of the whole kon → 403 on that kon's route", async () => {
    expect(await status(["admin", "!hardtest:*"], requireAdmin, "/api/hardtest/x")).toBe(403);
  });
  it("`admin` without a covering denial still passes", async () => {
    expect(await status(["admin", "!other:*"], requireAdmin, "/api/hardtest/x")).toBe(200);
    expect(await status(["admin"], requireAdmin, "/api/mail")).toBe(200);
  });
});

describe("requireScope honours the agent's denials", () => {
  it("a denial covering the scope wins over the scope and over `admin`", async () => {
    expect(await status(["reports:read", "!reports:*"], requireScope("reports:read"), "/x")).toBe(
      403
    );
    expect(await status(["admin", "!reports:read"], requireScope("reports:read"), "/x")).toBe(403);
  });
  it("without a denial it behaves as before", async () => {
    expect(await status(["reports:read"], requireScope("reports:read"), "/x")).toBe(200);
    expect(await status(["other"], requireScope("reports:read"), "/x")).toBe(403);
  });
});

describe("refuseDeniedScope (POST /api/mail/test and `!mail:send`)", () => {
  it("refuses an `admin` key that denies mail:send", async () => {
    expect(
      await status(["admin", "!mail:send"], refuseDeniedScope("mail:send"), "/api/mail/test")
    ).toBe(403);
  });
  it("lets an `admin` key without the denial, and people, through", async () => {
    expect(await status(["admin"], refuseDeniedScope("mail:send"), "/api/mail/test")).toBe(200);
    const a = new Hono();
    a.post("*", refuseDeniedScope("mail:send"), (c) => c.json({ ok: true }));
    expect((await a.request("/api/mail/test", { method: "POST" })).status).toBe(200);
  });
});

describe("`!user:act` closes the act-as-user path", () => {
  it("`admin` or `user:act` with `!user:act` → 403 on a route that only asks for an account", async () => {
    expect(await status(["admin", "!user:act"], protectRoute, "/api/other")).toBe(403);
    expect(await status(["user:act", "!user:act"], protectRoute, "/api/other")).toBe(403);
  });
  it("without the denial `admin` and `user:act` still act as a user", async () => {
    expect(await status(["admin"], protectRoute, "/api/other")).toBe(200);
    expect(await status(["user:act"], protectRoute, "/api/other")).toBe(200);
  });
  it("a scope of the route's own kon still opens it", async () => {
    expect(await status(["hardtest:read", "!user:act"], protectRoute, "/api/hardtest/x")).toBe(200);
  });
});

describe("/api/mail and /api/runs sit behind the admin prefix gate", () => {
  it("every method of both prefixes has an admin rule", () => {
    for (const path of ["/api/mail", "/api/mail/test", "/api/runs", "/api/runs/stats"]) {
      for (const method of ["GET", "POST"]) {
        const rule = ruleFor(ADMIN_ONLY_ROUTES, method, path);
        expect(rule, `${method} ${path}`).not.toBeNull();
        expect(rule?.role ?? "admin").toBe("admin");
      }
    }
  });
});
