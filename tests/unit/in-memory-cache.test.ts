/**
 * The process's in-memory cache: the substitute for Valkey on a single instance.
 * It expires, has a cap and understands Valkey's patterns.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  memoryOf,
  memoryGet,
  memoryKeys,
  memorySet,
  clearInMemoryCache,
} from "../../apps/api/src/lib/in-memory-cache";

afterEach(() => {
  clearInMemoryCache();
  delete process.env.CACHE_MEMORY_MAX_KEYS;
  vi.useRealTimers();
});

describe("in-memory cache", () => {
  it("stores, returns and deletes", () => {
    memorySet("blog:1", "a", 60);
    expect(memoryGet("blog:1")).toBe("a");
    memoryOf("blog:1");
    expect(memoryGet("blog:1")).toBeNull();
  });

  it("expires with the TTL", () => {
    vi.useFakeTimers();
    memorySet("k", "v", 2);
    vi.advanceTimersByTime(1999);
    expect(memoryGet("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(memoryGet("k")).toBeNull();
  });

  it("respects the key cap by evicting the oldest", () => {
    process.env.CACHE_MEMORY_MAX_KEYS = "2";
    memorySet("a", "1", 60);
    memorySet("b", "2", 60);
    memorySet("c", "3", 60);
    expect(memoryGet("a")).toBeNull();
    expect(memoryGet("b")).toBe("2");
    expect(memoryGet("c")).toBe("3");
  });

  it("Valkey patterns (`*`, `?`) match as in SCAN MATCH", () => {
    memorySet("blog:list:1", "x", 60);
    memorySet("blog:post:2", "x", 60);
    memorySet("wiki:list:1", "x", 60);
    expect(memoryKeys("blog:*").sort()).toEqual(["blog:list:1", "blog:post:2"]);
    expect(memoryKeys("*:list:?")).toHaveLength(2);
    // The pattern's regex characters are literals.
    memorySet("a.b", "x", 60);
    expect(memoryKeys("a.b")).toEqual(["a.b"]);
    expect(memoryKeys("a?b")).toEqual(["a.b"]);
  });
});
