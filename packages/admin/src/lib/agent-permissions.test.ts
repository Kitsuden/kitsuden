/**
 * The panel talks to the permissions, keys and quotas routes
 * ============================================================================
 *
 * Contract with routes/agent-permissions.ts (mounted at /api/v1, admin only):
 * methods, routes and bodies. And that a 422 for invalid scopes reaches the user
 * with the API's reason, not a mute «HTTP 422».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const BASE = import.meta.env.VITE_API_URL ?? "";

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: "", json: async () => body } as Response;
}

describe("agent permissions service", () => {
  beforeEach(() => vi.resetModules());

  it("each call goes to its route with its method and body", async () => {
    const calls: { what: string; body?: unknown }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        what: `${init?.method ?? "GET"} ${String(url)}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).endsWith("/keys") && !init?.method) return response({ keys: [{ id: "k1" }] });
      return response({});
    }) as typeof fetch;

    const s = await import("./services/agents");
    await s.getAccessCatalog();
    await s.getAgentAccess("a1");
    await s.setAgentScopes("a1", ["kon:blog:create-post", "!kon:blog:delete-post"]);
    expect(await s.listAgentKeys("a1")).toEqual([{ id: "k1" }]);
    await s.createAgentKey("a1", { name: "ci", expiresInDays: 30 });
    await s.rotateAgentKey("a1", "k1", { graceHours: 24 });
    await s.revokeAgentKey("a1", "k1");
    await s.getAgentQuotas("a1");
    await s.setAgentQuotas("a1", { writesPerDay: 100, budgetUnitsPerDay: null });

    expect(calls.map((l) => l.what)).toEqual([
      `GET ${BASE}/api/v1/agent-access/catalog`,
      `GET ${BASE}/api/v1/agents/a1/access`,
      `PUT ${BASE}/api/v1/agents/a1/scopes`,
      `GET ${BASE}/api/v1/agents/a1/keys`,
      `POST ${BASE}/api/v1/agents/a1/keys`,
      `POST ${BASE}/api/v1/agents/a1/keys/k1/rotate`,
      `POST ${BASE}/api/v1/agents/a1/keys/k1/revoke`,
      `GET ${BASE}/api/v1/agents/a1/quotas`,
      `PUT ${BASE}/api/v1/agents/a1/quotas`,
    ]);
    expect(calls[2]!.body).toEqual({ scopes: ["kon:blog:create-post", "!kon:blog:delete-post"] });
    expect(calls[4]!.body).toEqual({ name: "ci", expiresInDays: 30 });
    expect(calls[5]!.body).toEqual({ graceHours: 24 });
    expect(calls[8]!.body).toEqual({ writesPerDay: 100, budgetUnitsPerDay: null });
  });

  it("MCP settings: GET and PUT to /mcp-settings with toolset and wrapper", async () => {
    const calls: { what: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        what: `${init?.method ?? "GET"} ${String(url)}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response({
        settings: { toolset: "read", untrustedWrap: "delimiters" },
        options: { toolsets: [], kons: [], untrustedWrap: [] },
      });
    }) as typeof fetch;
    const s = await import("./services/agents");
    await s.getAgentMcpSettings("a1");
    const r = await s.setAgentMcpSettings("a1", { toolset: "read", untrustedWrap: "delimiters" });
    expect(r.settings.untrustedWrap).toBe("delimiters");
    expect(calls.map((l) => l.what)).toEqual([
      `GET ${BASE}/api/v1/agents/a1/mcp-settings`,
      `PUT ${BASE}/api/v1/agents/a1/mcp-settings`,
    ]);
    expect(calls[1]!.body).toEqual({ toolset: "read", untrustedWrap: "delimiters" });
  });

  it("an invalid scope carries the API's reason", async () => {
    global.fetch = vi.fn(async () =>
      response(
        { error: "Invalid scope '!admin': '!admin' is not allowed: remove 'admin' instead" },
        422
      )
    ) as typeof fetch;
    const { setAgentScopes } = await import("./services/agents");
    await expect(setAgentScopes("a1", ["!admin"])).rejects.toThrow(/is not allowed/);
  });
});
