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

const dbSelectLimit = createMockFn(() => Promise.resolve([]));
const dbInsertReturning = createMockFn(() => Promise.resolve([{ id: "ss-1" }]));
const dbUpdateReturning = createMockFn(() => Promise.resolve([{ id: "ss-1" }]));

mock.module("../db", () => ({
  mergedSchema: {},
  db: {
    select: () => ({
      from: (table: any) => ({
        where: (cond: any) => ({ limit: dbSelectLimit }),
        limit: dbSelectLimit,
      }),
    }),
    insert: () => ({
      values: (data: any) => ({ returning: dbInsertReturning }),
    }),
    update: () => ({
      set: (data: any) => ({
        where: (cond: any) => ({ returning: dbUpdateReturning }),
      }),
    }),
  },
}));

mock.module("../services/igdb", () => ({
  searchGames: async (_query: string, _limit?: number) => [{ id: 1, name: "Game" }],
}));

mock.module("../services/twitch", () => ({
  getStreamStatus: async (_channels: string[]) => new Map([["channel1", { live: true }]]),
}));

import {
  getSettingsHandler,
  patchSettingsHandler,
  igdbSearchHandler,
  igdbImportHandler,
  twitchStatusHandler,
} from "../routes/crud";

afterAll(() => {
  mock.restore();
});

function createMockContext(body: any = null, params: Record<string, string> = {}) {
  const jsonResponses: any[] = [];
  return {
    req: {
      param: (name: string) => params[name],
      query: () => undefined,
      json: async () => body,
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

describe("crud handlers", () => {
  beforeAll(() => {
    dbSelectLimit.mockReset();
    dbInsertReturning.mockReset();
    dbUpdateReturning.mockReset();
  });

  it("getSettingsHandler inserts defaults when empty", async () => {
    dbSelectLimit.mockResolvedValue([]);
    dbInsertReturning.mockResolvedValue([{ id: "ss-1", siteName: "Kitsuden" }]);
    const c = createMockContext();
    await getSettingsHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.siteName).toBe("Kitsuden");
  });

  it("getSettingsHandler returns existing settings", async () => {
    dbSelectLimit.mockResolvedValue([{ id: "ss-1", siteName: "Test" }]);
    const c = createMockContext();
    await getSettingsHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.siteName).toBe("Test");
  });

  it("patchSettingsHandler inserts when no existing", async () => {
    dbSelectLimit.mockResolvedValue([]);
    dbInsertReturning.mockResolvedValue([{ id: "ss-1", siteName: "New" }]);
    const c = createMockContext({ siteName: "New" });
    await patchSettingsHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.siteName).toBe("New");
  });

  it("patchSettingsHandler updates existing", async () => {
    dbSelectLimit.mockResolvedValue([{ id: "ss-1", siteName: "Old" }]);
    dbUpdateReturning.mockResolvedValue([{ id: "ss-1", siteName: "Updated" }]);
    const c = createMockContext({ siteName: "Updated" });
    await patchSettingsHandler(c);
    const last = c._jsonResponses[c._jsonResponses.length - 1];
    expect(last.data.siteName).toBe("Updated");
  });

  it("igdbSearchHandler returns results", async () => {
    const c = createMockContext({ query: "Zelda", limit: 5 });
    const result = await igdbSearchHandler(c);
    const data = (result as any).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].name).toBe("Game");
  });

  it("igdbImportHandler returns 501", async () => {
    const c = createMockContext();
    const result = await igdbImportHandler(c);
    expect((result as any).status).toBe(501);
    expect((result as any).data.error).toContain("kon-games");
  });

  it("twitchStatusHandler returns statuses", async () => {
    const c = createMockContext({ channelIds: ["channel1"] });
    const result = await twitchStatusHandler(c);
    const data = (result as any).data;
    expect(data.channel1).toBeDefined();
  });
});
