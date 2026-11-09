import { describe, it, expect, mock, afterAll } from "bun:test";

mock.module("../middleware/auth", () => ({
  requireAuth: mock(async (_c: any, next: any) => next()),
  requireRole: () => mock(async (_c: any, next: any) => next()),
  optionalAuth: mock(async (_c: any, next: any) => next()),
}));

mock.module("../lib/auth", () => ({
  auth: { api: { getSession: mock(async () => null) } },
}));

mock.module("../lib/cache", () => ({
  invalidateCache: mock(async () => {}),
}));

mock.module("../lib/events", () => ({
  events: { emit: mock(() => {}), on: mock(() => {}) },
}));

mock.module("../lib/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

mock.module("../lib/realtime", () => ({
  realtimeManager: {
    broadcast: mock(() => {}),
    sendToUser: mock(() => {}),
  },
}));

import {
  createKonContext,
  isHonoRouter,
  isKonDefinition,
  isAutoKon,
  sortKonsByDependencies,
  getLoadedKons,
} from "../lib/module-loader";

afterAll(() => {
  mock.restore();
});

describe("module-loader", () => {
  it("createKonContext exposes core services", () => {
    const ctx = createKonContext() as any;
    expect(ctx.db).toBeDefined();
    expect(ctx.cache).toBeDefined();
    expect(ctx.events).toBeDefined();
    expect(ctx.realtime).toBeDefined();
    expect(ctx.auth).toBeDefined();
    expect(ctx.storage).toBeDefined();
    expect(ctx.logger).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(ctx.contentPublishing).toBeDefined();
  });

  it("ContentPublishingRegistry registers and retrieves targets", () => {
    const ctx = createKonContext() as any;
    const registry = ctx.contentPublishing;

    const target = {
      id: "t1",
      name: "Target 1",
      konId: "g1",
      capabilities: ["publish"],
      publish: mock(async () => ({ url: "https://example.com/1" })),
      getPublishedUrl: (result: any) => result.url,
    };

    registry.register(target);
    expect(registry.hasTarget("t1")).toBe(true);
    expect(registry.getAvailableTargets()[0].id).toBe("t1");
  });

  it("ContentPublishingRegistry promotes a registered target", async () => {
    const ctx = createKonContext() as any;
    const registry = ctx.contentPublishing;

    const publish = mock(async () => ({ url: "https://example.com/2" }));
    registry.register({
      id: "t2",
      name: "Target 2",
      konId: "g2",
      capabilities: [],
      publish,
      getPublishedUrl: (result: any) => result.url,
    });

    const result = await registry.promote("t2", { title: "Hello" });
    expect(publish.mock.calls.length).toBe(1);
    expect(result.url).toBe("https://example.com/2");
  });

  it("ContentPublishingRegistry throws when promoting unknown target", async () => {
    const ctx = createKonContext() as any;
    expect(ctx.contentPublishing.promote("missing", {})).rejects.toThrow("not available");
  });

  it("ContentPublishingRegistry supports unpublish", async () => {
    const ctx = createKonContext() as any;
    const unpublish = mock(async () => {});
    ctx.contentPublishing.register({
      id: "t3",
      name: "Target 3",
      konId: "g3",
      capabilities: [],
      publish: mock(async () => ({})),
      unpublish,
      getPublishedUrl: (result: any) => result.url,
    });

    await ctx.contentPublishing.unpublish("t3", "cid");
    expect(unpublish.mock.calls.length).toBe(1);
  });

  it("isHonoRouter detects Hono-like objects", () => {
    expect(isHonoRouter({ fetch: () => {}, route: () => {} })).toBe(true);
    expect(isHonoRouter({})).toBe(false);
    expect(isHonoRouter(null)).toBe(false);
    expect(isHonoRouter("string")).toBe(false);
  });

  it("isKonDefinition detects modern kons", () => {
    expect(isKonDefinition({ id: "g", createRouter: () => {} })).toBe(true);
    expect(isKonDefinition({ id: "g" })).toBe(false);
    expect(isKonDefinition(null)).toBe(false);
  });

  it("isAutoKon detects auto-kons", () => {
    expect(isAutoKon({ id: "g", config: {}, initialize: () => {} })).toBe(true);
    expect(isAutoKon({ id: "g", config: {} })).toBe(false);
    expect(isAutoKon(null)).toBe(false);
  });

  it("sortKonsByDependencies topologically sorts kons", () => {
    const kons = [
      {
        id: "kon-a",
        name: "A",
        source: "local" as const,
        path: "/a",
        enabled: true,
        manifest: { dependencies: ["kon-b"] },
      },
      { id: "kon-b", name: "B", source: "local" as const, path: "/b", enabled: true },
      { id: "kon-c", name: "C", source: "local" as const, path: "/c", enabled: true },
    ];

    const sorted = sortKonsByDependencies(kons as any);
    const ids = sorted.map((g) => g.id);
    expect(ids.indexOf("kon-b")).toBeLessThan(ids.indexOf("kon-a"));
  });

  it("sortKonsByDependencies detects circular dependencies", () => {
    const kons = [
      {
        id: "kon-a",
        name: "A",
        source: "local" as const,
        path: "/a",
        enabled: true,
        manifest: { dependencies: ["kon-b"] },
      },
      {
        id: "kon-b",
        name: "B",
        source: "local" as const,
        path: "/b",
        enabled: true,
        manifest: { dependencies: ["kon-a"] },
      },
    ];

    expect(() => sortKonsByDependencies(kons as any)).toThrow("Circular");
  });

  it("getLoadedKons returns an array", async () => {
    const loaded = await getLoadedKons();
    expect(Array.isArray(loaded)).toBe(true);
  });
});
