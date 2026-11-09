import { existsSync } from "node:fs";

import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";

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

const dbExecute = createMockFn(() => Promise.resolve({ rows: [{ cnt: 0 }] }));

function createQueryBuilder(data: any[] = []) {
  const qb: any = {
    where: () => qb,
    limit: (n: number) => Promise.resolve(data),
    orderBy: () => qb,
    then: (resolve: any) => resolve(data),
  };
  return qb;
}

mock.module("../db", () => ({
  mergedSchema: {},
  db: {
    select: () => ({
      from: (table: any) => createQueryBuilder([]),
    }),
    execute: dbExecute,
  },
}));

import { getModuleHandler, checkModuleHandler } from "../routes/modules";

afterAll(() => {
  mock.restore();
});

function createMockContext(params: Record<string, string> = {}) {
  const jsonResponses: any[] = [];
  return {
    req: {
      param: (name: string) => params[name],
      query: () => undefined,
      json: async () => ({}),
      raw: { headers: new Headers() },
    },
    get: () => undefined,
    set: () => {},
    json: (data: any, status?: number) => {
      jsonResponses.push({ data, status });
      return { data, status };
    },
    _jsonResponses: jsonResponses,
  } as any;
}

describe("modules handlers", () => {
  beforeAll(() => {
    dbExecute.mockReset();
  });

  it("getModuleHandler returns 404 for unknown key", async () => {
    const c = createMockContext({ key: "unknown-key" });
    await getModuleHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.status).toBe(404);
    expect(last.data.error).toContain("not found");
  });

  it("getModuleHandler returns module from registry", async () => {
    const c = createMockContext({ key: "kon-media" });
    await getModuleHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.key).toBe("kon-media");
    expect(last.data.name).toBeDefined();
  });

  it("checkModuleHandler returns canDisable for unknown key", async () => {
    const c = createMockContext({ key: "unknown-key" });
    await checkModuleHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.canDisable).toBe(true);
    expect(last.data.blockers).toEqual([]);
  });

  // kon-esports is an INSTALLABLE kon (kitsuden-kons): without it, it belongs to no one.
  (existsSync(new URL("../../../../packages/kons/kon-esports/kon.json", import.meta.url))
    ? it
    : it.skip)("checkModuleHandler returns grimoire warning for grimoire kon", async () => {
    const c = createMockContext({ key: "kon-esports" });
    await checkModuleHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.isGrimoireKon).toBe(true);
    expect(last.data.warning).toContain("grimoire");
  });
});
