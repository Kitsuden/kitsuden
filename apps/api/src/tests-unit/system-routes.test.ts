import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";

const siteSettingsRows: any[] = [{ id: "s1", activeTheme: null, branding: null }];
const modulesRows: any[] = [];

function tableRows(table: any) {
  if (table === "siteSettings") return siteSettingsRows;
  if (table === "modules") return modulesRows;
  return [];
}

function queryBuilder(table: any) {
  const rows = tableRows(table);
  const qb: any = {
    where: () => qb,
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => qb,
    then: (resolve: any) => resolve(rows),
  };
  return qb;
}

const mockDb = {
  select: () => ({
    from: (table: any) => queryBuilder(table),
  }),
  insert: (table: any) => ({
    values: (data: any) => ({
      returning: () => {
        const items = Array.isArray(data) ? data : [data];
        tableRows(table).push(...items);
        return Promise.resolve(items);
      },
    }),
  }),
  update: (table: any) => ({
    set: (data: any) => ({
      where: (cond: any) => ({
        returning: () => {
          const rows = tableRows(table);
          rows.forEach((r) => Object.assign(r, data));
          return Promise.resolve(rows);
        },
      }),
    }),
  }),
  delete: (table: any) => ({
    where: (cond: any) => {
      tableRows(table).length = 0;
      return Promise.resolve();
    },
  }),
};

mock.module("../db", () => ({
  db: mockDb,
}));

mock.module("../db/schema", () => ({
  siteSettings: "siteSettings",
  modules: "modules",
}));

mock.module("../lib/auth", () => ({
  auth: {
    api: {
      getSession: mock(async () => ({
        user: { id: "user-1", role: "admin" },
        session: { id: "session-1" },
      })),
    },
  },
}));

mock.module("../services/scanner", () => ({
  scanPackages: mock(async (type: string) => {
    if (type === "themes") {
      return [{ id: "grimoire-a", name: "Grimoire A", theme_type: "grimoire" }];
    }
    if (type === "grimoires") {
      return [{ id: "grimoire-a", kons: ["kon-x"], optional_kons: [] }];
    }
    if (type === "kons") {
      return [{ id: "kon-x", name: "Kon X", description: "X", icon: "📦" }];
    }
    return [];
  }),
  runModuleMigrations: mock(async () => {}),
}));

mock.module("../services/module-registry", () => ({
  CORE_MODULES: [],
  CORE_MODULE_KEYS: [],
}));

import { systemRoutes } from "../routes/system";

afterAll(() => {
  mock.restore();
});

function buildApp() {
  const app = new Hono();
  app.route("/system", systemRoutes);
  return app;
}

async function getJson(res: Response) {
  const status = res.status;
  const body = (await res.json().catch(() => ({}))) as any;
  return { status, body };
}

describe("system routes inline handlers", () => {
  beforeEach(() => {
    siteSettingsRows.length = 0;
    siteSettingsRows.push({ id: "s1", activeTheme: null, branding: null });
    modulesRows.length = 0;
  });

  it("PATCH /system/active-theme activates a theme", async () => {
    const app = buildApp();
    const res = await app.request("/system/active-theme", {
      method: "PATCH",
      body: JSON.stringify({ themeId: "grimoire-a" }),
      headers: { "Content-Type": "application/json" },
    });
    const { status, body } = await getJson(res);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.activeTheme).toBe("grimoire-a");
  });

  it("PATCH /system/active-theme returns 404 for unknown theme", async () => {
    const app = buildApp();
    const res = await app.request("/system/active-theme", {
      method: "PATCH",
      body: JSON.stringify({ themeId: "unknown" }),
      headers: { "Content-Type": "application/json" },
    });
    const { status, body } = await getJson(res);
    expect(status).toBe(404);
    expect(body.error).toContain("Theme not found");
  });

  it("POST /system/grimoire-state activates a grimoire", async () => {
    const app = buildApp();
    const res = await app.request("/system/grimoire-state", {
      method: "POST",
      body: JSON.stringify({ action: "activate", grimoireId: "grimoire-a" }),
      headers: { "Content-Type": "application/json" },
    });
    const { status, body } = await getJson(res);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.action).toBe("activate");
  });

  it("POST /system/grimoire-state deactivates the active grimoire", async () => {
    siteSettingsRows[0].activeTheme = "grimoire-a";
    modulesRows.push({ key: "kon-x", enabled: true, grimoireId: "grimoire-a" });

    const app = buildApp();
    const res = await app.request("/system/grimoire-state", {
      method: "POST",
      body: JSON.stringify({ action: "deactivate" }),
      headers: { "Content-Type": "application/json" },
    });
    const { status, body } = await getJson(res);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.action).toBe("deactivate");
  });

  it("POST /system/grimoire-state returns 400 for invalid action", async () => {
    const app = buildApp();
    const res = await app.request("/system/grimoire-state", {
      method: "POST",
      body: JSON.stringify({ action: "pause" }),
      headers: { "Content-Type": "application/json" },
    });
    const { status, body } = await getJson(res);
    expect(status).toBe(400);
    expect(body.error).toContain("'activate' or 'deactivate'");
  });

  it("DELETE /system/grimoires/:id deletes a grimoire without kons", async () => {
    modulesRows.push({ key: "kon-x", enabled: false, grimoireId: "grimoire-a" });

    const app = buildApp();
    const res = await app.request("/system/grimoires/grimoire-a", { method: "DELETE" });
    const { status, body } = await getJson(res);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.deletedGrimoire).toBe("grimoire-a");
  });

  it("DELETE /system/grimoires/:id returns 409 when grimoire is active", async () => {
    siteSettingsRows[0].activeTheme = "grimoire-a";
    modulesRows.push({ key: "kon-x", enabled: true, grimoireId: "grimoire-a" });

    const app = buildApp();
    const res = await app.request("/system/grimoires/grimoire-a", { method: "DELETE" });
    const { status, body } = await getJson(res);
    expect(status).toBe(409);
    expect(body.error).toContain("Cannot delete grimoire");
  });
});
