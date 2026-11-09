/**
 * Modules Mutation Handlers — Unit Tests
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

import { createMockContext, getLastJsonResponse } from "../tests/mock-context";

// ─── DB proxy ───────────────────────────────────────────────────────────────
let selectResults: any[][] = [];
let insertResult: any[] = [];
let updateResult: any[] = [];
let deleteResult: any[] = [];
let selectCallIndex = 0;

function createDbProxy(result: any): any {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") return (resolve: any) => resolve(result);
      return createDbProxy(result);
    },
    apply(_target, _thisArg, _args) {
      return createDbProxy(result);
    },
  });
}

function getNextSelectResult() {
  return selectResults[selectCallIndex++] || [];
}

const mockDb = {
  select: mock(() => createDbProxy(getNextSelectResult())),
  insert: mock(() => createDbProxy(insertResult)),
  update: mock(() => createDbProxy(updateResult)),
  delete: mock(() => createDbProxy(deleteResult)),
  execute: mock(() => Promise.resolve({ rows: [{ cnt: 0 }] })),
};

mock.module("../db", () => ({ db: mockDb, mergedSchema: {} }));
mock.module("drizzle-orm", () => ({
  eq: () => "eq",
  and: () => "and",
  sql: Object.assign(() => "sql", { raw: (s: string) => s }),
}));
mock.module("../services/scanner", () => ({
  runModuleMigrations: mock(() => Promise.resolve()),
  // `updateModuleHandler` uses it to read the tables the manifest declares
  // before considering the kon installed. The ones these tests enable are there, as
  // they would be on an install that has them; a clean clone has no kons of its own.
  scanPackages: mock(() => Promise.resolve([{ id: "kon-blog" }, { id: "kon-academy-lms" }])),
}));

/**
 * Installing the schema is simulated: here the HANDLER is tested, not the migrations.
 *
 * `migrationResult` is what the simulation returns, and each test
 * adjusts it. It matters that it is configurable because the new rule —do not enable a kon
 * whose tables do not exist— can only be tested by controlling that response.
 */
let migrationResult: {
  applied: string[];
  alreadyWere: string[];
  missingTables: string[];
  connection: "admin" | "app";
} = { applied: [], alreadyWere: [], missingTables: [], connection: "app" };

mock.module("../lib/kon-migrations", () => ({
  applyKonMigrations: mock(() => Promise.resolve({ konId: "x", ...migrationResult })),
}));

import { updateModuleHandler } from "../routes/modules";

afterAll(() => mock.restore());

beforeEach(() => {
  selectResults = [];
  insertResult = [];
  updateResult = [];
  deleteResult = [];
  selectCallIndex = 0;
  migrationResult = { applied: [], alreadyWere: [], missingTables: [], connection: "app" };
});

// ═════════════════════════════════════════════════════════════════════════════
// updateModuleHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("updateModuleHandler", () => {
  it("returns 409 when disabling with active dependents", async () => {
    // First select for _existingModule, then dbModules for check, then execute for checkCanDisable
    selectResults = [
      [{ key: "kon-media", enabled: true, grimoireId: null }],
      [{ key: "kon-media", enabled: true, grimoireId: null }],
    ];
    // Make checkCanDisable think there are dependents by returning cnt > 0
    mockDb.execute = mock(() => Promise.resolve({ rows: [{ cnt: 5 }] }));
    const c = createMockContext({ params: { key: "kon-media" }, body: { enabled: false } });
    const res = await updateModuleHandler(c);
    expect(res.status).toBe(409);
    mockDb.execute = mock(() => Promise.resolve({ rows: [{ cnt: 0 }] }));
  });

  it("inserts new module when not existing and enabled=true", async () => {
    selectResults = [
      [], // _existingModule
      [], // dbModules for check (not called because enabled !== false)
      [], // existing for upsert
      [{ key: "kon-blog", enabled: true, name: "Blog", category: "optional" }],
    ];
    const c = createMockContext({ params: { key: "kon-blog" }, body: { enabled: true } });
    const res = await updateModuleHandler(c);
    expect(res.status).toBe(200);
  });

  it("does not enable a kon whose tables still do not exist", async () => {
    /**
     * The rule that prevents the state that motivated all this: `modules.enabled` set
     * to true and ZERO of the kon's tables in the database.
     *
     * Before, a migration failure was logged with `console.error` and the kon
     * was marked as enabled anyway. It showed up in the menu and each of its
     * screens returned 500 or a form with no fields.
     */
    migrationResult = {
      applied: [],
      alreadyWere: [],
      missingTables: ["courses", "lessons"],
      connection: "app",
    };
    selectResults = [[], [], [], []];
    const c = createMockContext({
      params: { key: "kon-academy-lms" },
      body: { enabled: true },
    });
    const res = await updateModuleHandler(c);
    expect(res.status).toBe(409);
    expect((getLastJsonResponse(c)?.data as { missingTables?: string[] })?.missingTables).toEqual([
      "courses",
      "lessons",
    ]);
  });

  it("a kon that is not on this install: 409 and how to install it, not 500", async () => {
    selectResults = [[], [], [], []];
    const c = createMockContext({
      params: { key: "kon-not-on-this-install" },
      body: { enabled: true },
    });
    const res = await updateModuleHandler(c);
    expect(res.status).toBe(409);
    const body = getLastJsonResponse(c)?.data as { error?: string; hint?: string };
    expect(body.error).toBe("Kon not installed");
    expect(body.hint).toContain("kitsuden kon add not-on-this-install");
  });

  it("updates existing module settings", async () => {
    selectResults = [
      [{ key: "kon-blog", enabled: true, grimoireId: null }],
      [{ key: "kon-blog", enabled: true, grimoireId: null }],
      [{ key: "kon-blog", enabled: true, grimoireId: null }],
    ];
    const c = createMockContext({
      params: { key: "kon-blog" },
      body: { settings: { foo: 1 } },
    });
    const res = await updateModuleHandler(c);
    expect(res.status).toBe(200);
  });

  it("returns registry defaults when no DB record and no enabled flag", async () => {
    selectResults = [
      [], // _existingModule
      [], // existing for upsert
    ];
    const c = createMockContext({ params: { key: "kon-media" }, body: {} });
    const res = await updateModuleHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.key).toBe("kon-media");
  });
});
