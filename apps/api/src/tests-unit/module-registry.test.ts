import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

function createMockFn(defaultImpl?: (...args: any[]) => any) {
  let impl = defaultImpl;
  const calls: any[][] = [];
  const fn = (...args: any[]) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  (fn as any).mock = { calls };
  (fn as any).mockReset = () => {
    calls.length = 0;
    impl = defaultImpl;
  };
  (fn as any).mockResolvedValue = (v: any) => {
    impl = () => Promise.resolve(v);
  };
  return fn as any;
}

const dbExecute = createMockFn(() => Promise.resolve({ rows: [{ cnt: 1 }] }));

mock.module("../db", () => ({
  mergedSchema: {},
  db: { execute: dbExecute },
}));

mock.module("drizzle-orm", () => ({
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }), {
    raw: (s: string) => ({ raw: s }),
  }),
}));

import {
  getCoreKons,
  getCoreDenKons,
  getOptionalKons,
  getGrimoireKons,
  getKonsByGrimoire,
  checkCanDisable,
  KON_REGISTRY,
  CORE_MODULES,
  CORE_MODULE_KEYS,
} from "../services/module-registry";

afterAll(() => {
  mock.restore();
});

describe("module-registry getters", () => {
  it("getCoreKons returns only core category kons", () => {
    const core = getCoreKons();
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((g) => g.category === "core")).toBe(true);
  });

  it("getCoreDenKons returns only core-den category", () => {
    const gc = getCoreDenKons();
    expect(gc.every((g) => g.category === "core-den")).toBe(true);
  });

  it("getOptionalKons returns only optional category", () => {
    const opt = getOptionalKons();
    expect(opt.every((g) => g.category === "optional")).toBe(true);
  });

  it("getGrimoireKons filters by grimoireId when provided", () => {
    const grimoire = getGrimoireKons("esports");
    expect(grimoire.every((g) => g.category === "grimoire" && g.grimoireId === "esports")).toBe(
      true
    );
  });

  it("getGrimoireKons returns all grimoire kons when no grimoireId", () => {
    const grimoire = getGrimoireKons();
    expect(grimoire.every((g) => g.category === "grimoire")).toBe(true);
  });

  it("getKonsByGrimoire returns kons matching grimoireId", () => {
    const grimoire = getKonsByGrimoire("esports");
    expect(grimoire.every((g) => g.grimoireId === "esports")).toBe(true);
  });
});

describe("checkCanDisable", () => {
  beforeEach(() => {
    dbExecute.mockReset();
  });

  it("returns canDisable=true for unknown kon", async () => {
    const result = await checkCanDisable("unknown-key", new Set());
    expect(result.canDisable).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("returns canDisable=true when no dependents are enabled", async () => {
    const kon = KON_REGISTRY.find((g) => g.dependsOn.length === 0);
    expect(kon).toBeDefined();
    const result = await checkCanDisable(kon!.key, new Set());
    expect(result.canDisable).toBe(true);
  });

  it("blocks disabling when a referenced-by kon is enabled and has data", async () => {
    // Find a kon that is referenced by another
    const referenced = KON_REGISTRY.find((g) => g.referencedBy.length > 0);
    if (!referenced) {
      console.warn("No referenced kon found, skipping");
      return;
    }
    const ref = referenced.referencedBy[0];
    dbExecute.mockResolvedValue({ rows: [{ cnt: 5 }] });

    const enabled = new Set([ref.kon]);
    const result = await checkCanDisable(referenced.key, enabled);
    expect(result.canDisable).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0].kon).toBe(ref.kon);
  });

  it("allows disabling when referenced-by table has no data", async () => {
    const referenced = KON_REGISTRY.find((g) => g.referencedBy.length > 0);
    if (!referenced) {
      console.warn("No referenced kon found, skipping");
      return;
    }
    const ref = referenced.referencedBy[0];
    dbExecute.mockResolvedValue({ rows: [{ cnt: 0 }] });

    const enabled = new Set([ref.kon]);
    const result = await checkCanDisable(referenced.key, enabled);
    expect(result.canDisable).toBe(true);
  });

  it("blocks disabling when a dependency kon is enabled and has data", async () => {
    // Find kon A that another kon B depends on
    const dependent = KON_REGISTRY.find((g) => g.dependsOn.length > 0);
    if (!dependent) {
      console.warn("No dependent kon found, skipping");
      return;
    }
    const depKey = dependent.dependsOn[0];
    dbExecute.mockResolvedValue({ rows: [{ cnt: 3 }] });

    const enabled = new Set([dependent.key]);
    const result = await checkCanDisable(depKey, enabled);
    expect(result.canDisable).toBe(false);
    expect(result.blockers.some((b) => b.kon === dependent.key)).toBe(true);
  });
});

describe("CORE_MODULES and CORE_MODULE_KEYS", () => {
  it("CORE_MODULE_KEYS contains all keys from CORE_MODULES", () => {
    expect(CORE_MODULE_KEYS.length).toBe(CORE_MODULES.length);
    for (const mod of CORE_MODULES) {
      expect(CORE_MODULE_KEYS).toContain(mod.key);
    }
  });
});
