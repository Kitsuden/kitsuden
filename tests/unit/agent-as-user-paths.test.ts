/**
 * "An agent key is not an account" against the other agent paths
 * ============================================================================
 *
 * middleware/agent-as-user.ts closes a hole:
 * `requireAuth`/`protectRoute` let ANY agent through the routes
 * that only ask for "being authenticated" (commenting, signing up, saving builds).
 * These tests pin down how it coexists with what was already allowed, each thing
 * through its explicit path and without reopening the hole:
 *
 *   · SDK operation (`sdkOperation` mark): decides its own `permission`;
 *   · prefix gate that already opened by scope (`agentOpenedByGate`);
 *   · per-dataset scopes (`datasets:<slug>:<action>`) on the dataset routes
 *     (the route then looks at the specific dataset);
 *   · human SIGNER: signs what the agent creates, does NOT grant it
 *     permissions; without a scope, the agent with a signer still does not act as a user;
 *   · APPROVAL: runs with the agent's identity re-read from the
 *     database, so it goes through this same rule: approving does not widen permissions;
 *   · a `!user:act` denial does not count as a grant.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) } },
}));

import { forgetKonRouters, registerKonRouter } from "../../apps/api/src/lib/kon-routes";
import { requireAuth } from "../../apps/api/src/middleware/auth";
import { protectRoute } from "../../apps/api/src/middleware/auth-guard";

// A fake kon mounted on its prefix: the route's family comes from there.
registerKonRouter("kon-testcomments", "/api/testcomments", { routes: [] });
registerKonRouter("kon-datasets", "/api/datasets", { routes: [] });
afterAll(() => forgetKonRouters());

interface Agent {
  scopes: string[];
  sponsor?: { userId: string; valid: boolean } | null;
}

function asAgent(a: Agent, marks: Record<string, unknown> = {}): MiddlewareHandler {
  return async (c, next) => {
    c.set(
      "agent" as never,
      { agentId: "ag_1", scopes: a.scopes, sponsor: a.sponsor ?? null } as never
    );
    c.set(
      "user" as never,
      { id: "ag_1", role: "agent", scopes: a.scopes, sponsor: a.sponsor ?? null } as never
    );
    for (const [k, v] of Object.entries(marks)) c.set(k as never, v as never);
    await next();
  };
}

function app(prior: MiddlewareHandler) {
  const a = new Hono();
  a.use("*", prior);
  for (const path of [
    "/api/testcomments",
    "/api/datasets/clients/entries",
    "/api/data-sets/clients",
    "/api/other",
  ]) {
    a.post(path, requireAuth, (c) => c.json({ ok: true }));
    a.post(`/guard${path}`, protectRoute, (c) => c.json({ ok: true }));
  }
  return a;
}

const status = async (prior: MiddlewareHandler, path: string) =>
  (await app(prior).request(path, { method: "POST" })).status;

describe("agent as user: the explicit paths of E and F", () => {
  it("without a useful scope → 403 in requireAuth and in protectRoute", async () => {
    const a = asAgent({ scopes: ["datasets:clients:read"] });
    expect(await status(a, "/api/testcomments")).toBe(403);
    expect(await status(a, "/guard/api/testcomments")).toBe(403);
  });

  it("with `user:act` or `admin` → passes", async () => {
    expect(await status(asAgent({ scopes: ["user:act"] }), "/api/other")).toBe(200);
    expect(await status(asAgent({ scopes: ["admin"] }), "/guard/api/other")).toBe(200);
  });

  it("scope of the kon's family (`<kon>:…` or `kon:<kon>:…`) → passes in ITS kon, not in another", async () => {
    expect(await status(asAgent({ scopes: ["testcomments:*"] }), "/api/testcomments")).toBe(200);
    expect(
      await status(asAgent({ scopes: ["kon:testcomments:create"] }), "/api/testcomments")
    ).toBe(200);
    expect(await status(asAgent({ scopes: ["kon:testcomments:create"] }), "/api/other")).toBe(403);
  });

  it("per-dataset scopes → pass in /api/datasets and in the lite API /api/data-sets (the route looks at the dataset)", async () => {
    const a = asAgent({ scopes: ["datasets:clients:write"] });
    expect(await status(a, "/api/datasets/clients/entries")).toBe(200);
    expect(await status(a, "/api/data-sets/clients")).toBe(200);
    expect(await status(a, "/api/testcomments")).toBe(403);
  });

  it("human SIGNER does not widen permissions: with a signer and no scope, 403", async () => {
    const a = asAgent({
      scopes: ["mcp:connect", "mcp:write"],
      sponsor: { userId: "u_human", valid: true },
    });
    expect(await status(a, "/api/testcomments")).toBe(403);
    expect(await status(a, "/api/other")).toBe(403);
  });

  it("SDK operation or another gate that already opened by scope → it decides, not this rule", async () => {
    const withoutAnything = { scopes: ["mcp:connect"] };
    expect(await status(asAgent(withoutAnything, { sdkOperation: true }), "/api/other")).toBe(200);
    expect(
      await status(asAgent(withoutAnything, { agentOpenedByGate: true }), "/guard/api/other")
    ).toBe(200);
  });

  it("a DENIAL `!user:act` does not grant", async () => {
    expect(await status(asAgent({ scopes: ["!user:act"] }), "/api/other")).toBe(403);
  });
});
