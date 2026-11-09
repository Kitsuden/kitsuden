/**
 * The panel surface is for admin only (or staff, for content).
 *
 * Audit, checked against a production API:
 * `GET /api/items/authSessions` returned session tokens without a session,
 * `PATCH /api/settings` and `/api/modules` asked for nothing, and any account
 * (sign-up is open) could run functions, edit the blog or the pages.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  adminGate,
  ruleFor,
  ADMIN_ONLY_ROUTES,
  EARLY_ADMIN_ONLY_ROUTES,
} from "../../apps/api/src/middleware/auth-guard";

type Role = "admin" | "editor" | "user" | null;

function app(role: Role, agent?: string[]) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    if (agent) (c as any).set("agent", { scopes: agent });
    if (role) (c as any).set("user", { id: "u1", role });
    await next();
  });
  a.use("*", adminGate([...EARLY_ADMIN_ONLY_ROUTES, ...ADMIN_ONLY_ROUTES]));
  a.all("*", (c) => c.text("inside"));
  return a;
}

const status = async (role: Role, method: string, path: string, agent?: string[]) =>
  (await app(role, agent).request(path, { method })).status;

describe("ruleFor", () => {
  it("covers the dangerous things that were seen open in production", () => {
    for (const [m, p] of [
      ["GET", "/api/items/authSessions"],
      ["GET", "/api/items/authAccounts"],
      ["PATCH", "/api/settings"],
      ["DELETE", "/api/modules/kon-blog"],
      ["POST", "/api/functions/1/execute"],
      ["POST", "/api/actions/1/execute"],
      ["POST", "/api/relations/auth_users/inlines/x"],
      ["PATCH", "/api/v1/agents/1"],
      ["POST", "/api/graphql"],
      ["GET", "/api/generate-code/collections"],
      ["GET", "/admin/logs"],
      ["DELETE", "/api/admin/rate-limits/x"],
      ["POST", "/api/search/init"],
      ["PATCH", "/api/system/active-theme"],
      ["POST", "/api/blog"],
      ["PATCH", "/api/page-builder/pages/1"],
      ["POST", "/api/media/upload"],
      ["GET", "/api/blog/source/1"],
      ["PUT", "/api/cardsim/games"],
      ["POST", "/api/cardsim/games/pokemon/cards"],
      ["GET", "/api/crm/contacts"],
      ["GET", "/api/directory/employees"],
    ]) {
      expect(
        ruleFor([...EARLY_ADMIN_ONLY_ROUTES, ...ADMIN_ONLY_ROUTES], m!, p!),
        `${m} ${p}`
      ).not.toBeNull();
    }
  });

  it("does not touch what the public site uses", () => {
    for (const [m, p] of [
      ["GET", "/api/settings"],
      ["GET", "/api/settings/social-live"],
      ["GET", "/api/data-sets/slug/x"],
      ["GET", "/api/blog"],
      ["GET", "/api/blog/my-post"],
      ["GET", "/api/media/1"],
      ["POST", "/api/search"],
      ["GET", "/api/system/themes"],
      ["POST", "/api/cardsim/games/pokemon/decks"],
      ["POST", "/api/comments"],
      ["GET", "/api/itemsx"],
      ["OPTIONS", "/api/items/authSessions"],
    ]) {
      expect(
        ruleFor([...EARLY_ADMIN_ONLY_ROUTES, ...ADMIN_ONLY_ROUTES], m!, p!),
        `${m} ${p}`
      ).toBeNull();
    }
  });

  it("repeated slashes do not bypass the gate", () => {
    expect(ruleFor(ADMIN_ONLY_ROUTES, "GET", "//api//items/authSessions")).not.toBeNull();
  });
});

describe("adminGate", () => {
  it("normal user: 403 on the panel; admin: allowed in", async () => {
    expect(await status("user", "GET", "/api/items/authUsers")).toBe(403);
    expect(await status("user", "PATCH", "/api/settings")).toBe(403);
    expect(await status("admin", "GET", "/api/items/authUsers")).toBe(200);
    expect(await status("admin", "PATCH", "/api/settings")).toBe(200);
  });

  it("content: editor gets in, user does not", async () => {
    expect(await status("editor", "POST", "/api/blog")).toBe(200);
    expect(await status("user", "POST", "/api/blog")).toBe(403);
    expect(await status("editor", "PATCH", "/api/settings")).toBe(403);
  });

  it("no session: 401", async () => {
    expect(await status(null, "GET", "/api/items/authSessions")).toBe(401);
    expect(await status(null, "DELETE", "/api/modules/kon-blog")).toBe(401);
  });

  it("agent: only with the admin scope", async () => {
    expect(await status(null, "GET", "/api/items/x", ["datasets:read"])).toBe(401);
    expect(await status(null, "GET", "/api/items/x", ["admin"])).toBe(200);
  });

  it("public routes stay open", async () => {
    expect(await status(null, "GET", "/api/settings")).toBe(200);
    expect(await status(null, "GET", "/api/blog")).toBe(200);
  });
});

describe("index.ts mounts the gates in the right place", () => {
  // Normalized: a checkout may have CRLF, and a pattern below includes a line end.
  const source = (
    require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../apps/api/src/index.ts"),
      "utf8"
    ) as string
  ).replaceAll("\r\n", "\n");
  const pos = (s: string) => {
    const i = source.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };

  it("the early one goes before the critical routes (observability, limits, search) and /api/system", () => {
    const gate = pos('app.use("*", adminGate(EARLY_ADMIN_ONLY_ROUTES))');
    expect(gate).toBeLessThan(pos("registerCriticalFeatures(app);\n"));
    expect(gate).toBeLessThan(pos('app.route("/api/system", systemRoutes)'));
  });

  it("the general one goes after the session and before mounting items/graphql/modules and the kons", () => {
    const gate = pos('app.use("*", adminGate(ADMIN_ONLY_ROUTES))');
    expect(gate).toBeGreaterThan(pos('app.use("*", enrichUserContext)'));
    for (const r of [
      'app.route("/", rpcSurface)',
      'app.route("/api/graphql", graphqlRoutes)',
      'app.route("/api/modules", modulesRoutes)',
      'app.route("/api/settings", settingsRoutes)',
      "await loadModules(app)",
    ]) {
      expect(gate, r).toBeLessThan(pos(r));
    }
  });
});

describe("the first admin's sign-up is not left behind the gate", () => {
  it("POST /api/system/setup has no rule; the other writes of /api/system do", () => {
    expect(ruleFor(EARLY_ADMIN_ONLY_ROUTES, "POST", "/api/system/setup")).toBeNull();
    expect(ruleFor(EARLY_ADMIN_ONLY_ROUTES, "POST", "/api/system/grimoire-state")).not.toBeNull();
    expect(ruleFor(EARLY_ADMIN_ONLY_ROUTES, "POST", "/api/system/setup-x")).not.toBeNull();
    expect(ruleFor(EARLY_ADMIN_ONLY_ROUTES, "PATCH", "/api/system/active-theme")).not.toBeNull();
  });
});
