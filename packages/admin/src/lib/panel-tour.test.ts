/**
 * What broke the real panel tour and must not come back
 * ============================================================================
 *
 * Each block is a failure seen with Playwright against a real API:
 *
 *   · Page Builder: blocks are edited and deleted through /page-builder/blocks/:id.
 *     The client requested /page-builder/pages/:p/blocks/:b, which does not exist (404).
 *   · Agents: the service talked to /api/admin (wrapped in {success,data}) when
 *     its contract is /api/v1 (flat lists). The screen came out empty.
 *   · Media: with local storage the API gives `/media/...` paths that IT
 *     serves; with the panel on another origin they were broken thumbnails.
 *   · Grimoires: with the registry loaded, a kon that is not in it has no
 *     configuration; requesting it by id only produced a 404 per visit.
 *   · Login: the editor (staff) gets in; a "user" account does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Static import: grimoire-loader loads all the views with import.meta.glob
// and re-importing it after vi.resetModules() does not finish in a reasonable time.
import { getGrimoireConfig } from "./grimoire-loader";

// Re-importing modules (vi.resetModules) takes seconds on Windows with the
// suite running in parallel; the default 5 s limit gave false failures.
vi.setConfig({ testTimeout: 60_000 });

const BASE = import.meta.env.VITE_API_URL ?? "";

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe("api: Page Builder blocks", () => {
  beforeEach(() => vi.resetModules());

  it("updates and deletes a block by its id, without the page in front", async () => {
    const { api } = await import("./api");
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return response({ id: "b1" });
    }) as typeof fetch;

    await api.updateBlock("p1", "b1", { content: {} });
    await api.deleteBlock("p1", "b1");

    expect(calls).toEqual([
      `PATCH ${BASE}/api/page-builder/blocks/b1`,
      `DELETE ${BASE}/api/page-builder/blocks/b1`,
    ]);
  });
});

describe("agents service", () => {
  beforeEach(() => vi.resetModules());

  it("lists agents on /api/v1 and unwraps the traces", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("/traces")) return response({ traces: [{ id: "t1" }], total: 1 });
      return response([{ id: "a1", name: "Bot" }]);
    }) as typeof fetch;

    const { listAgents, listTraces } = await import("./services/agents");
    // The rows are normalized on the way in (services/agent-mappers.ts): the API sends
    // no `status` or `totalTokens`, and the views read both.
    expect(await listAgents()).toMatchObject([{ id: "a1", name: "Bot", status: "active" }]);
    expect(await listTraces({ agentId: "a1" })).toMatchObject([{ id: "t1", totalTokens: 0 }]);

    expect(urls[0]).toBe(`${BASE}/api/v1/agents`);
    expect(urls[1]).toMatch(
      new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/v1/traces\\?.*agentId=a1`)
    );
  });

  it("the playground chat remains on /api/admin/agents/:id/chat", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return response({ success: true, response: "hello" });
    }) as typeof fetch;
    const { sendPlaygroundMessage } = await import("./services/agents");
    await sendPlaygroundMessage("a1", "hello");
    expect(urls).toEqual([`${BASE}/api/admin/agents/a1/chat`]);
  });
});

describe("mediaUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves /media/... against the API when the panel lives on another origin", async () => {
    vi.stubEnv("VITE_API_URL", "http://api.local:4000");
    vi.resetModules();
    const { mediaUrl } = await import("./states/media.svelte");
    expect(mediaUrl("/media/uploads/a.png")).toBe("http://api.local:4000/media/uploads/a.png");
    expect(mediaUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(mediaUrl("//cdn.example.com/a.png")).toBe("//cdn.example.com/a.png");
  });

  it("without VITE_API_URL (same origin) it leaves the path as is", async () => {
    vi.stubEnv("VITE_API_URL", "");
    vi.resetModules();
    const { mediaUrl } = await import("./states/media.svelte");
    expect(mediaUrl("/media/uploads/a.png")).toBe("/media/uploads/a.png");
  });
});

describe("grimoire-loader: per-kon configuration", () => {
  it("does not request /registry/:id if the listing arrived and the kon is not there", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return response({ success: true, kons: [{ id: "kon-crm", name: "CRM" }] });
    }) as typeof fetch;
    expect(await getGrimoireConfig("kon-datasets")).toBeNull();
    expect(urls.filter((u) => u.includes("/api/admin/registry/"))).toEqual([]);
  });
});

describe("who gets into the panel", () => {
  beforeEach(() => vi.resetModules());

  it("admin and editor are staff; user is not", async () => {
    const roles: Record<string, boolean> = {};
    for (const role of ["admin", "editor", "user"]) {
      vi.resetModules();
      global.fetch = vi.fn(async () =>
        response({ session: { id: "s" }, user: { id: "u", email: "x@y.z", role } })
      ) as typeof fetch;
      const auth = await import("./auth.svelte");
      await auth.checkSession();
      roles[role] = auth.isStaff();
    }
    expect(roles).toEqual({ admin: true, editor: true, user: false });
  });
});
