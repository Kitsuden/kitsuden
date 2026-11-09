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

const scanPackages = createMockFn(() => Promise.resolve([]));

mock.module("../services/scanner", () => ({
  scanPackages,
}));

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
  },
}));

import {
  listThemesHandler,
  listGrimoiresHandler,
  getGrimoireHandler,
  getActiveThemeConfigHandler,
  getThemeCssHandler,
  themeCheckHandler,
} from "../routes/system";

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
    text: (data: any, status?: number) => {
      jsonResponses.push({ data, status });
      return { data, status };
    },
    _jsonResponses: jsonResponses,
  } as any;
}

describe("system handlers", () => {
  beforeAll(() => {
    scanPackages.mockReset();
  });

  it("listThemesHandler returns docs array", async () => {
    const c = createMockContext();
    await listThemesHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.docs).toEqual([]);
  });

  it("listGrimoiresHandler returns array", async () => {
    const c = createMockContext();
    await listGrimoiresHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(Array.isArray(last.data)).toBe(true);
  });

  it("getGrimoireHandler returns 404 for unknown grimoire", async () => {
    const c = createMockContext({ id: "unknown" });
    await getGrimoireHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.status).toBe(404);
  });

  it("getActiveThemeConfigHandler returns theme null when no themes", async () => {
    const c = createMockContext();
    await getActiveThemeConfigHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.theme).toBeNull();
  });

  it("getThemeCssHandler returns 404 when theme not found", async () => {
    const c = createMockContext({ themeId: "missing" });
    await getThemeCssHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.status).toBe(404);
  });

  it("getThemeCssHandler returns 400 for invalid themeId", async () => {
    const c = createMockContext({ themeId: "../etc/passwd" });
    await getThemeCssHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.status).toBe(400);
  });

  it("themeCheckHandler returns 404 for unknown theme", async () => {
    scanPackages.mockResolvedValue([]);
    const c = createMockContext({ id: "unknown" });
    await themeCheckHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.status).toBe(404);
  });

  it("themeCheckHandler returns check result for valid theme", async () => {
    scanPackages.mockResolvedValue([
      {
        id: "grimoire-default",
        name: "Default Grimoire",
        theme_type: "grimoire",
        requires_modules: ["kon-media"],
        optional_modules: [],
      },
    ]);
    const c = createMockContext({ id: "grimoire-default" });
    await themeCheckHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.theme.id).toBe("grimoire-default");
    expect(Array.isArray(last.data.requires)).toBe(true);
  });
});
