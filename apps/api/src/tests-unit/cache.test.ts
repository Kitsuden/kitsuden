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
  (fn as any).mockRejectedValue = (e: any) => {
    impl = () => Promise.reject(e);
  };
  return fn as any;
}

const isValkeyAvailable = createMockFn(() => Promise.resolve(false));
const cacheGet = createMockFn(() => Promise.resolve(null));
const cacheSet = createMockFn(() => Promise.resolve(undefined));
const getValkeyClient = createMockFn(() => Promise.resolve({}));

mock.module("../lib/valkey", () => ({
  // With Valkey configured; without it, cache.ts uses process memory.
  valkeyConfigured: () => true,
  isValkeyAvailable,
  cacheGet,
  cacheSet,
  getValkeyClient,
}));

import { cachedQuery, invalidateCache } from "../lib/cache";

afterAll(() => {
  mock.restore();
});

describe("cachedQuery", () => {
  beforeEach(() => {
    isValkeyAvailable.mockReset();
    cacheGet.mockReset();
    cacheSet.mockReset();
    getValkeyClient.mockReset();
  });

  it("cache hit returns parsed JSON without calling queryFn", async () => {
    const data = { id: 1, name: "Test" };
    isValkeyAvailable.mockResolvedValue(true);
    cacheGet.mockResolvedValue(JSON.stringify(data));

    let queryFnCalled = false;
    const queryFn = async () => {
      queryFnCalled = true;
      return { id: 2, name: "Fresh" };
    };

    const result = await cachedQuery("key:1", 60, queryFn);

    expect(result).toEqual(data);
    expect(queryFnCalled).toBe(false);
    expect(cacheGet.mock.calls.length).toBeGreaterThan(0);
  });

  it("cache miss calls queryFn and caches result", async () => {
    const data = { id: 1, name: "Fresh" };
    isValkeyAvailable.mockResolvedValue(true);
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(undefined);

    const queryFn = async () => data;

    const result = await cachedQuery("key:2", 120, queryFn);

    expect(result).toEqual(data);
    expect(cacheSet.mock.calls.length).toBe(1);
    expect(cacheSet.mock.calls[0]).toEqual(["key:2", JSON.stringify(data), 120]);
  });

  it("valkey unavailable falls through to queryFn and does not crash on set", async () => {
    const data = { id: 1, name: "Fallback" };
    isValkeyAvailable.mockResolvedValue(false);

    const queryFn = async () => data;

    const result = await cachedQuery("key:3", 60, queryFn);

    expect(result).toEqual(data);
    expect(cacheSet.mock.calls.length).toBe(0);
  });

  it("cacheGet throws → falls through to queryFn", async () => {
    const data = { id: 1, name: "Fallback" };
    isValkeyAvailable.mockResolvedValue(true);
    cacheGet.mockRejectedValue(new Error("Valkey read error"));

    const queryFn = async () => data;

    const result = await cachedQuery("key:4", 60, queryFn);

    expect(result).toEqual(data);
  });
});

describe("invalidateCache", () => {
  beforeEach(() => {
    isValkeyAvailable.mockReset();
    cacheGet.mockReset();
    cacheSet.mockReset();
    getValkeyClient.mockReset();
  });

  it("valkey unavailable → returns immediately", async () => {
    isValkeyAvailable.mockResolvedValue(false);

    await invalidateCache("pattern:*");

    expect(getValkeyClient.mock.calls.length).toBe(0);
  });

  it("deletes matching keys via scanIterator + del", async () => {
    const of = createMockFn(() => Promise.resolve(undefined));
    const scanIterator = createMockFn(() =>
      (async function* () {
        yield "key:a:1";
        yield "key:a:2";
      })()
    );

    isValkeyAvailable.mockResolvedValue(true);
    getValkeyClient.mockResolvedValue({ scanIterator, del: of });

    await invalidateCache("key:a:*", "key:b:*");

    expect(getValkeyClient.mock.calls.length).toBe(1);
    expect(scanIterator.mock.calls.length).toBe(2);
    // mock generator yields same keys for both patterns
    expect(of.mock.calls.length).toBe(4);
    expect(of.mock.calls[0][0]).toBe("key:a:1");
    expect(of.mock.calls[1][0]).toBe("key:a:2");
  });
});
