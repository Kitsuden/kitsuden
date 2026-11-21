/**
 * A `!` denial can close a legacy CORE route (hardening 2026-11-21, H58)
 * ============================================================================
 *
 * `routeDenial` matched a denial against an SDK operation or a whole kon. A
 * legacy core route (/api/admin/secrets, /api/keys, /api/items…) is neither, so
 * an `admin` key with `!core:secrets:*` still reached the secrets manager. Each
 * legacy core route now has a `core:<area>:<access>` name (lib/legacy-routes.ts).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) } },
}));

import { forgetKonRouters, registerKonRouter } from "../../apps/api/src/lib/kon-routes";
import { LEGACY_ROUTES, legacyCoreScope } from "../../apps/api/src/lib/legacy-routes";
import {
  agentDenials,
  requireAdmin,
  requireAdminRole,
  routeDenial,
} from "../../apps/api/src/middleware/auth-guard";

registerKonRouter("kon-legacydeny", "/api/legacydeny", { routes: [] });
afterAll(() => forgetKonRouters());

function asAgent(scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    c.set("agent" as never, { agentId: "ag_1", scopes } as never);
    await next();
  };
}

async function status(scopes: string[], gate: MiddlewareHandler, method: string, path: string) {
  const a = new Hono();
  a.use("*", asAgent(scopes));
  a.all("*", gate, (c) => c.json({ ok: true }));
  return (await a.request(path, { method })).status;
}

describe("every legacy core route has a scope name", () => {
  it("each entry of LEGACY_ROUTES resolves to core:<area>:<access>", () => {
    const missing: string[] = [];
    for (const entry of LEGACY_ROUTES) {
      const [method, path] = entry.split(" ") as [string, string];
      const concrete = path.replace(/:[A-Za-z]+/g, "x").replace(/\*$/, "x");
      const scope = legacyCoreScope(method, concrete);
      if (!scope || !/^core:[a-z-]+:(read|write|connect)$/.test(scope)) missing.push(entry);
    }
    expect(missing).toEqual([]);
  });

  it("read for GET and HEAD, write for the rest, connect for MCP", () => {
    expect(legacyCoreScope("GET", "/api/admin/secrets")).toBe("core:secrets:read");
    expect(legacyCoreScope("POST", "/api/admin/secrets/X/inject")).toBe("core:secrets:write");
    expect(legacyCoreScope("DELETE", "/api/keys/abc")).toBe("core:keys:write");
    expect(legacyCoreScope("GET", "/admin/traces/1/steps")).toBe("core:traces:read");
    expect(legacyCoreScope("GET", "/admin/metrics")).toBe("core:observability:read");
    expect(legacyCoreScope("POST", "/api/mcp")).toBe("core:mcp:connect");
    expect(legacyCoreScope("GET", "/api/docs-legacy/sdk")).toBe("core:docs:read");
    expect(legacyCoreScope("GET", "/")).toBe("core:health:read");
    // Not a prefix match by text: /api/itemsx is not /api/items.
    expect(legacyCoreScope("GET", "/api/itemsx")).toBeNull();
  });
});

describe("`!core:…` refuses an admin-scoped agent on a legacy core route", () => {
  it("requireAdmin: `admin` + `!core:secrets:*` → 403 on the secrets manager", async () => {
    const scopes = ["admin", "!core:secrets:*"];
    expect(await status(scopes, requireAdmin, "POST", "/api/admin/secrets")).toBe(403);
    expect(await status(scopes, requireAdmin, "GET", "/api/admin/secrets")).toBe(403);
    // Another core area stays open.
    expect(await status(scopes, requireAdmin, "GET", "/api/admin/vault")).toBe(200);
  });

  it("requireAdminRole (the prefix gates): `!core:keys:write` closes writes, not reads", async () => {
    const scopes = ["admin", "!core:keys:write"];
    expect(await status(scopes, requireAdminRole, "POST", "/api/keys")).toBe(403);
    expect(await status(scopes, requireAdminRole, "DELETE", "/api/keys/k1")).toBe(403);
    expect(await status(scopes, requireAdminRole, "GET", "/api/keys")).toBe(200);
  });

  it("agentDenials (global): `!core:*:write` closes every core write but not MCP", async () => {
    const scopes = ["admin", "!core:*:write"];
    expect(await status(scopes, agentDenials, "PATCH", "/api/items/posts/1")).toBe(403);
    expect(await status(scopes, agentDenials, "POST", "/api/v1/agents/a1/token")).toBe(403);
    expect(await status(scopes, agentDenials, "GET", "/api/items/posts")).toBe(200);
    expect(await status(scopes, agentDenials, "POST", "/api/mcp")).toBe(200);
  });

  it("`!core:*` closes every legacy core route, MCP included", async () => {
    const scopes = ["admin", "!core:*"];
    expect(await status(scopes, agentDenials, "GET", "/api/explorer/tables")).toBe(403);
    expect(await status(scopes, agentDenials, "POST", "/api/mcp")).toBe(403);
  });

  it("without a covering denial nothing changes", async () => {
    expect(await status(["admin"], requireAdmin, "POST", "/api/admin/secrets")).toBe(200);
    expect(await status(["admin", "!core:vault:*"], requireAdmin, "POST", "/api/keys")).toBe(200);
    expect(routeDenial(["admin"], "POST", "/api/admin/secrets")).toBeNull();
  });

  it("a mounted kon's path keeps the kon rule, not a core name", () => {
    expect(routeDenial(["admin", "!core:*"], "POST", "/api/legacydeny/x")).toBeNull();
    expect(routeDenial(["admin", "!legacydeny:*"], "POST", "/api/legacydeny/x")).toBe(
      "!legacydeny:*"
    );
  });

  it("people are not affected: denials are an agent-key setting", async () => {
    const a = new Hono();
    a.all("*", agentDenials, (c) => c.json({ ok: true }));
    expect((await a.request("/api/admin/secrets", { method: "POST" })).status).toBe(200);
  });
});
