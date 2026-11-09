/**
 * Kitsuden — Testable DI: createTestKonContext()
 * ============================================================================
 *
 * Makes dependency injection TESTABLE: it builds a complete KonContext
 * with in-memory / no-op defaults and allows selective override of only
 * the dependencies the test needs. That way you can test a kon's
 * `createRouter(ctx)` in isolation, without a real database or Valkey.
 *
 * Usage:
 *   const ctx = createTestKonContext({
 *     db: mockDb,                       // only what matters to you
 *     config: { siteName: "Test" },
 *   });
 *   const router = miKon.createRouter(ctx);
 *   const res = await router.request("/algo");
 *
 * Dependencies NOT provided and NOT mocked by default throw a clear error
 * ("not mocked") if the code under test touches them — it fails loudly, not silently.
 */

import type { KonContext } from "@kitsuden/shared";

function notMocked(dep: string): never {
  throw new Error(
    `[test-kon-context] '${dep}' was not mocked. Pass it in createTestKonContext({${dep}: ... }).`
  );
}

/** Working in-memory cache (for tests that exercise caching). */
function makeMemoryCache() {
  const store = new Map<string, { value: unknown; expires?: number }>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires && hit.expires < Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.value as T;
    },
    async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      store.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
    },
    async del(key: string): Promise<void> {
      store.delete(key);
    },
    async invalidate(): Promise<void> {
      store.clear();
    },
  };
}

/** Logger that captures lines for assertions in tests. */
export function makeCapturingLogger() {
  const lines: { level: string; message: string; meta?: unknown }[] = [];
  const log = (level: string) => (message: string, meta?: Record<string, unknown>) =>
    lines.push({ level, message, meta });
  return {
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    lines,
  };
}

export type KonContextOverrides = {
  [K in keyof KonContext]?: Partial<KonContext[K]> | KonContext[K];
};

/**
 * Builds a KonContext for tests. Everything not provided uses a safe
 * default (in-memory cache, capturing logger, test config) or a stub that
 * throws "not mocked" to force explicit mocks where it matters.
 */
export function createTestKonContext(overrides: KonContextOverrides = {}): KonContext {
  const { logger } = makeCapturingLogger();

  const base: KonContext = {
    // Dependencies that almost always need to be mocked → loud stub by default.
    db:
      (overrides.db as KonContext["db"]) ??
      (new Proxy({}, { get: () => notMocked("db") }) as KonContext["db"]),
    events:
      (overrides.events as KonContext["events"]) ??
      ({ emit: () => {}, on: () => {}, off: () => {} } as unknown as KonContext["events"]),
    realtime:
      (overrides.realtime as KonContext["realtime"]) ??
      ({ broadcast: () => {}, publish: () => {} } as unknown as KonContext["realtime"]),
    auth:
      (overrides.auth as KonContext["auth"]) ??
      (new Proxy({}, { get: () => notMocked("auth") }) as KonContext["auth"]),
    storage:
      (overrides.storage as KonContext["storage"]) ??
      (new Proxy({}, { get: () => notMocked("storage") }) as KonContext["storage"]),
    contentPublishing:
      (overrides.contentPublishing as KonContext["contentPublishing"]) ??
      (new Proxy(
        {},
        { get: () => notMocked("contentPublishing") }
      ) as KonContext["contentPublishing"]),

    // Working in-memory / no-op defaults.
    cache:
      (overrides.cache as KonContext["cache"]) ??
      (makeMemoryCache() as unknown as KonContext["cache"]),
    logger: (overrides.logger as KonContext["logger"]) ?? logger,
    config: {
      siteName: "Test Site",
      siteUrl: "http://localhost:3000",
      environment: "test",
      ...(overrides.config as object),
    },

    // The tests' public site: the development one, without a database
    site: (overrides.site as KonContext["site"]) ?? {
      publicUrl: async () => "http://localhost:4321",
    },

    /**
     * Per-kon settings (`konSetting`).
     *
     * If this forwarding is missing, the override is accepted without complaint and discarded:
     * the kon under test reads its defaults, and whoever wrote the test believes they are
     * exercising the configuration. It happened with the store's shipping rate —
     * the test gave 2500 instead of 3000 and the cause was not in the kon.
     */
    konConfig: overrides.konConfig as KonContext["konConfig"],

    // The agent engine and embeddings: absent unless the test gives them, as on a host without an engine.
    agents: overrides.agents as KonContext["agents"],
    ai: overrides.ai as KonContext["ai"],
  };

  return base;
}
