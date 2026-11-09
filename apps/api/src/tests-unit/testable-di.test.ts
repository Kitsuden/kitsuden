/**
 * Testable DI — proves that a kon can be tested in isolation with
 * selectively mocked dependencies (createTestKonContext).
 */

import type { KonContext } from "@kitsuden/shared";
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

import { createTestKonContext, makeCapturingLogger } from "../lib/test-kon-context";

// An example "kon": it receives the context and returns its router.
function demoKon(ctx: KonContext) {
  const app = new Hono();
  app.get("/cached", async (c) => {
    const hit = await ctx.cache.get<string>("k");
    if (hit) return c.json({ from: "cache", value: hit });
    await ctx.cache.set("k", "hello", 60);
    ctx.logger.info("cache miss");
    return c.json({ from: "compute", value: "hello" });
  });
  return app;
}

describe("Testable DI — createTestKonContext", () => {
  it("tests a kon with a real in-memory cache, without a DB or Valkey", async () => {
    const { logger, lines } = makeCapturingLogger();
    const ctx = createTestKonContext({
      logger,
      config: { siteName: "Demo" },
    });
    const app = demoKon(ctx);

    const miss = await app.request("http://x/cached");
    expect(await miss.json()).toEqual({ from: "compute", value: "hello" });

    const hit = await app.request("http://x/cached");
    expect(await hit.json()).toEqual({ from: "cache", value: "hello" });

    // The logger captured the "cache miss" (assertion on effects).
    expect(lines.some((l) => l.message === "cache miss")).toBe(true);
  });

  it("default test config + selective override", () => {
    const ctx = createTestKonContext({ config: { siteName: "X" } });
    expect(ctx.config.environment).toBe("test");
    expect(ctx.config.siteName).toBe("X");
  });

  it("a NON-mocked dependency throws a clear error if touched", () => {
    const ctx = createTestKonContext();
    expect(() => (ctx.db as unknown as { select: () => void }).select()).toThrow(/not.*mock/i);
  });
});
