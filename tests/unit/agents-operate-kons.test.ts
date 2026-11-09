/**
 * An agent with a token can operate a kon's domain
 * ============================================================================
 *
 * ── WHAT WAS HAPPENING ─────────────────────────────────────────────────────
 *
 * Kitsuden is sold as "AI-native" and an agent could not do anything in a kon.
 * Two closed doors, one behind the other:
 *
 *   1. `requireAuth` —the one every kon route uses— only looked at the
 *      COOKIE session. The global middleware had already verified the
 *      `Bearer kitsuden_agent_*` token and left the agent in the context, but
 *      `requireAuth` did not consult it: 401 on any protected route.
 *
 *   2. Even if it got through, the policies ask about ROLE (`admin`, `editor`)
 *      and an agent arrives with `role: "agent"`. Generating a bracket, reporting a
 *      set or editing someone else's tier list: 403.
 *
 * So the domain MCP tools could not have done anything, and a vibecoder
 * would have ended up writing rows by hand — skipping exactly the rules
 * Kitsuden sells.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * That the verified agent passes `requireAuth`, that its scopes grant policy
 * actions, and the three limits that make that safe: a scope does not invent
 * actions, a user without `agent` does not sneak in, and nothing changes for
 * humans.
 */

import {
  can,
  defineGate,
  definePolicy,
  readRouteMeta,
  resetAuthz,
  scopeConcede,
} from "@kitsuden/engine";
import { Hono, type MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The cookie session does not exist in these tests: that way we check that the
// agent goes through ITS path and not one that happened to return a session.
vi.mock("../../apps/api/src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) } },
}));

import { requireAuth } from "../../apps/api/src/middleware/auth";

describe("an agent's scopes grant policy actions", () => {
  beforeEach(() => {
    resetAuthz();
    definePolicy("esports", {
      manage: (user) => user?.role === "admin" || user?.role === "editor",
    });
    defineGate("access-admin", (user) => user?.role === "admin");
  });

  const agent = (scopes: string[]) => ({ id: "ag_1", role: "agent", scopes });

  it("today an agent without scopes does not pass a role rule", async () => {
    expect(await can(agent([]), "manage", {}, "esports")).toBe(false);
  });

  it("an exact scope grants the action", async () => {
    expect(await can(agent(["esports:manage"]), "manage", {}, "esports")).toBe(true);
  });

  it("`resource:*` grants all the actions of that resource, and only of that one", async () => {
    expect(await can(agent(["esports:*"]), "manage", {}, "esports")).toBe(true);
    expect(await can(agent(["tierlist:*"]), "manage", {}, "esports")).toBe(false);
  });

  it("`admin:*` grants what the policy defines…", async () => {
    expect(await can(agent(["admin:*"]), "manage", {}, "esports")).toBe(true);
  });

  it("…but does NOT invent actions nobody wrote", async () => {
    /**
     * Deny-by-default must stay true with any scope. If
     * `admin:*` opened actions without a rule, a kon that forgets to define `delete`
     * would be left open to all agents with that scope.
     */
    expect(await can(agent(["admin:*"]), "delete", {}, "esports")).toBe(false);
    expect(await can(agent(["admin:*"]), "manage", {}, "nonexistent-resource")).toBe(false);
  });

  it("gates are granted with `gate:<name>`", async () => {
    expect(await can(agent(["gate:access-admin"]), "access-admin")).toBe(true);
    expect(await can(agent(["esports:*"]), "access-admin")).toBe(false);
  });

  it("nothing changes for humans", async () => {
    // A Better Auth user carries no `scopes`: they win or lose by their role, as before.
    expect(await can({ id: "u1", role: "editor" }, "manage", {}, "esports")).toBe(true);
    expect(await can({ id: "u2", role: "user" }, "manage", {}, "esports")).toBe(false);
  });

  it("the rules of the scope comparator", () => {
    expect(scopeConcede(["esports:manage"], "esports:manage")).toBe(true);
    expect(scopeConcede(["esports:*"], "esports:view")).toBe(true);
    expect(scopeConcede(["*:view"], "esports:view")).toBe(true);
    expect(scopeConcede(["*:view"], "esports:manage")).toBe(false);
    expect(scopeConcede(["admin"], "any:thing")).toBe(true);
    expect(scopeConcede([], "esports:manage")).toBe(false);
    expect(scopeConcede(undefined, "esports:manage")).toBe(false);
  });
});

describe("`requireAuth` recognizes the already-verified agent", () => {
  /**
   * Simulates what the global middleware of `index.ts` leaves behind after verifying the
   * token. `/protected` belongs to no kon, so since the audit
   * (middleware/agent-as-user.ts) only whoever carries
   * `user:act` gets through; with only `esports:*` it would pass through /api/esports, not here.
   */
  const withScopes =
    (scopes: string[]): MiddlewareHandler =>
    async (c, next) => {
      c.set("agent" as never, { agentId: "ag_1", scopes } as never);
      c.set("user" as never, { id: "ag_1", role: "agent", scopes } as never);
      await next();
    };
  const asVerifiedAgent = withScopes(["esports:*", "user:act"]);

  /** What a legacy `kitsuden_sk_*` key leaves: a user, but without `agent`. */
  const asLegacyKey: MiddlewareHandler = async (c, next) => {
    c.set("user" as never, { id: "machine-1", role: "admin" } as never);
    await next();
  };

  function app(...priors: MiddlewareHandler[]) {
    const a = new Hono();
    for (const mw of priors) a.use("*", mw);
    a.get("/protected", requireAuth, (c) => c.json({ ok: true }));
    return a;
  }

  it("a verified agent passes without a cookie", async () => {
    const res = await app(asVerifiedAgent).request("/protected");
    expect(res.status, "with a valid agent token this used to give 401").toBe(200);
  });

  it("…but an agent without `user:act` or a scope of the route's family does not act as a user", async () => {
    const res = await app(withScopes(["esports:*"])).request("/protected");
    expect(res.status).toBe(403);
  });

  it("without an agent or a session it is still 401", async () => {
    expect((await app().request("/protected")).status).toBe(401);
  });

  it("a user set by another route is NOT enough: `agent` is required", async () => {
    /**
     * Legacy `kitsuden_sk_*` keys leave an admin user but no
     * `agent`. If `requireAuth` accepted any user in the context, those
     * keys —already past their retirement date— would gain access to all the
     * kon routes they do not have today.
     */
    expect((await app(asLegacyKey).request("/protected")).status).toBe(401);
  });

  it("leaves it written on the route that requires a credential", () => {
    // It is what marks the operation as protected in the OpenAPI.
    expect(readRouteMeta(requireAuth)?.auth).toBe("required");
  });
});
