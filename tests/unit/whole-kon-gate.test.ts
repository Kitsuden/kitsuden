/**
 * Prefix gates and scopes for a WHOLE kon
 * ============================================================================
 *
 * An agent with `crm:*` received 403
 * «Insufficient role» when creating a company through the legacy CRM route, even though
 * the guide promises that `<kon>:*` grants the whole kon. The `ADMIN_ONLY_ROUTES`
 * gates only knew `admin` and the fine-grained scope of the SDK operations.
 * Now:
 *
 *   · `<kon>:*` / `kon:<kon>:*` open the gate of THEIR kon (and of no other, nor of
 *     the core); `kon:*` does not; a denial of the whole kon wins;
 *   · `/api/blog/source` (reads any table) is not opened this way;
 *   · booking and directory require a SESSION (a design decision): any
 *     account, or an agent that can act as a user there; the kon's
 *     policies decide. An anonymous user, 401.
 *
 * Without the change: `crm:*` → 403, and a user in booking/directory → 403.
 */
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { registerKonRouter } from "../../apps/api/src/lib/kon-routes";
import {
  agentDenials,
  openedKonByScope,
  adminGate,
  ADMIN_ONLY_ROUTES,
} from "../../apps/api/src/middleware/auth-guard";

type Role = "admin" | "editor" | "user" | null;

const KONS: [string, string][] = [
  ["kon-crm", "/api/crm"],
  ["kon-booking", "/api/booking"],
  ["kon-directory", "/api/directory"],
  ["kon-blog", "/api/blog"],
  ["kon-dms", "/api/dms"],
  ["kon-games", "/api/games"],
];

beforeAll(() => {
  for (const [id, mount] of KONS) {
    const r = new Hono();
    r.all("/*", (c) => c.text("kon"));
    registerKonRouter(id, mount, r);
  }
});

function app(role: Role, agent?: string[]) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    if (agent) {
      (c as any).set("agent", { scopes: agent });
      (c as any).set("user", { id: "ag-1", role: "agent", scopes: agent });
    } else if (role) (c as any).set("user", { id: "u1", role });
    await next();
  });
  a.use("*", agentDenials);
  a.use("*", adminGate(ADMIN_ONLY_ROUTES));
  a.all("*", (c) => c.text("inside"));
  return a;
}

const status = async (role: Role, method: string, path: string, agent?: string[]) =>
  (await app(role, agent).request(path, { method })).status;

describe("`<kon>:*` opens the gate of ITS kon", () => {
  it("crm:* and kon:crm:* get into the legacy CRM routes (before: 403)", async () => {
    expect(await status(null, "POST", "/api/crm/companies", ["mcp:connect", "crm:*"])).toBe(200);
    expect(await status(null, "GET", "/api/crm/contacts", ["kon:crm:*"])).toBe(200);
    expect(await status(null, "DELETE", "/api/dms/files/x/download", ["dms:*"])).toBe(200);
  });

  it("only its kon: neither another kon nor the core", async () => {
    expect(await status(null, "GET", "/api/dms/files/x/download", ["crm:*"])).toBe(403);
    expect(await status(null, "GET", "/api/items/authUsers", ["crm:*"])).toBe(403);
    expect(await status(null, "PATCH", "/api/settings", ["crm:*"])).toBe(403);
  });

  it("`kon:*` (all SDK operations) does not open the legacy routes", async () => {
    expect(await status(null, "GET", "/api/crm/contacts", ["kon:*"])).toBe(403);
    expect(openedKonByScope(["kon:*"], "/api/crm/contacts")).toBe(false);
  });

  it("a loose scope of the kon does not open the staff gate", async () => {
    expect(await status(null, "GET", "/api/crm/contacts", ["crm:view"])).toBe(403);
  });

  it("a denial of the whole kon wins, `admin` included", async () => {
    expect(await status(null, "GET", "/api/crm/contacts", ["crm:*", "!crm:*"])).toBe(403);
    expect(await status(null, "GET", "/api/crm/contacts", ["admin", "!kon:crm:*"])).toBe(403);
    expect(openedKonByScope(["admin", "!crm:*"], "/api/crm/x")).toBe(false);
  });

  it("`/api/blog/source` (reads any table) is not opened with `blog:*`", async () => {
    expect(await status(null, "POST", "/api/blog", ["blog:*"])).toBe(200);
    expect(await status(null, "GET", "/api/blog/source/1", ["blog:*"])).toBe(403);
    expect(await status(null, "GET", "/api/blog/source/1", ["admin"])).toBe(200);
  });

  it("humans, as before", async () => {
    expect(await status("editor", "GET", "/api/crm/contacts")).toBe(200);
    expect(await status("user", "GET", "/api/crm/contacts")).toBe(403);
  });
});

describe("booking and directory: open to anyone with a session", () => {
  for (const path of ["/api/booking/bookings", "/api/directory/employees/x"]) {
    it(`${path}: any account gets in (the kon decides); an anonymous user, 401`, async () => {
      expect(await status("user", "GET", path)).toBe(200);
      expect(await status("user", "PATCH", path)).toBe(200);
      expect(await status("editor", "POST", path)).toBe(200);
      expect(await status(null, "GET", path)).toBe(401);
    });
  }

  it("an agent: with a kon scope or `user:act`; an arbitrary key, no", async () => {
    expect(await status(null, "GET", "/api/booking/bookings", ["booking:*"])).toBe(200);
    expect(await status(null, "POST", "/api/booking/bookings", ["user:act"])).toBe(200);
    expect(await status(null, "GET", "/api/directory/employees", ["kon:directory:*"])).toBe(200);
    expect(await status(null, "GET", "/api/booking/bookings", ["mcp:connect"])).toBe(403);
    expect(await status(null, "GET", "/api/booking/bookings", ["crm:*"])).toBe(403);
  });
});
