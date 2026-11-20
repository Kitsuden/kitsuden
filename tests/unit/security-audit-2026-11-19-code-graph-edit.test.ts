/**
 * POST /api/code-graph/edit/:op: only a person applies a source edit (security audit 2026-11-19)
 * ============================================================================
 *
 * `requireAdmin` admits an agent whose scopes include `admin`, and with
 * `apply: true` the route wrote the server's source files. Code reaches the
 * server through promotion, which is human-only, so an agent now gets 403 for
 * `apply: true`. A dry run (no `apply`) stays open to it.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

// The auth gates are tested elsewhere; here they let everyone through so the
// route's own check is what answers.
vi.mock("../../apps/api/src/middleware/auth-guard", () => ({
  protectRoute: async (_c: unknown, next: () => Promise<void>) => next(),
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { callerIsAgent, codeGraphRoutes } from "../../apps/api/src/routes/code-graph";

function appAs(vars: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) (c.set as (k: string, v: unknown) => void)(k, v);
    await next();
  });
  app.route("/api/code-graph", codeGraphRoutes);
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request("/api/code-graph/edit/insert-before", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("code-graph edit: apply is for people", () => {
  it("an agent with the admin scope cannot apply", async () => {
    const app = appAs({ agent: { agentId: "ag_1", scopes: ["admin"] }, user: null });
    const res = await post(app, { name: "x", code: "export const y = 1;", apply: true });
    expect(res.status).toBe(403);
  });

  it("a session with role agent or a machine key cannot apply", async () => {
    for (const user of [
      { id: "u1", role: "agent" },
      { id: "machine-legacy", role: "admin" },
    ]) {
      const res = await post(appAs({ user }), { apply: true });
      expect(res.status).toBe(403);
    }
  });

  it("a human admin passes the check (then the usual validation answers)", async () => {
    const res = await post(appAs({ user: { id: "u1", role: "admin" } }), { apply: true });
    expect(res.status).toBe(400);
  });

  it("an agent's dry run is not refused by the check", async () => {
    const res = await post(appAs({ agent: { agentId: "ag_1", scopes: ["admin"] } }), {});
    expect(res.status).toBe(400);
  });

  it("callerIsAgent", () => {
    const get = (vars: Record<string, unknown>) => (k: string) => vars[k];
    expect(callerIsAgent(get({ agent: { agentId: "a" } }))).toBe(true);
    expect(callerIsAgent(get({ user: { id: "u", role: "admin" } }))).toBe(false);
  });
});
