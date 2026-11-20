/**
 * Kitsuden — Valkey Caching Layer for Postgres Queries
 *
 * Wraps `cacheGet`/`cacheSet` from valkey.ts into a convenient
 * `cachedQuery` helper. Falls through to Postgres when Valkey is down.
 * Without `VALKEY_URL` (single instance) it caches in process memory.
 *
 * Usage:
 *   const data = await cachedQuery("blog:list:1", 60, () => db.select()...);
 */

import { memoryOf, memoryKeys } from "./in-memory-cache";
import { cacheGet, cacheSet, isValkeyAvailable, getValkeyClient, valkeyConfigured } from "./valkey";

/** Can it be cached now? In memory always; in Valkey if it responds. */
async function hasCache(): Promise<boolean> {
  return !valkeyConfigured() || (await isValkeyAvailable());
}

// ── Cached Query ───────────────────────────────────────────────

/**
 * Run a query with Valkey caching.
 *   1. Check Valkey for cached result
 *   2. On miss → run queryFn, cache result
 *   3. On Valkey error → fall through to Postgres (no crash)
 *
 * @param key     Cache key (e.g. "blog:list:1:published")
 * @param ttl     TTL in seconds (default 120)
 * @param queryFn Async function that hits Postgres and returns data
 */
export async function cachedQuery<T>(
  key: string,
  ttl: number,
  queryFn: () => Promise<T>,
  options: { tags?: string[] } = {}
): Promise<T> {
  try {
    if (await hasCache()) {
      const cached = await cacheGet(key);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    }
  } catch {
    // Valkey down — fall through
  }

  // Cache miss or Valkey unavailable → query Postgres
  const result = await queryFn();

  // Store in Valkey (fire-and-forget, don't block response)
  try {
    if (await hasCache()) {
      await cacheSet(key, JSON.stringify(result), ttl);
      if (options.tags?.length) await tagKey(key, options.tags, ttl);
    }
  } catch {
    // Valkey write failed — non-critical
  }

  return result;
}

// ── Cache Invalidation ─────────────────────────────────────────

/**
 * Delete all cache keys matching given prefixes.
 * Uses SCAN + DEL for pattern-based deletion.
 *
 * @param patterns  Key patterns (e.g. "blog:*", "collections:*")
 */
export async function invalidateCache(...patterns: string[]): Promise<void> {
  try {
    if (!valkeyConfigured()) {
      for (const pattern of patterns) for (const key of memoryKeys(pattern)) memoryOf(key);
      return;
    }
    const available = await isValkeyAvailable();
    if (!available) return;

    const client = await getValkeyClient();

    for (const pattern of patterns) {
      // Use SCAN to find matching keys (safe for production, non-blocking)
      const keys: string[] = [];
      // @ts-ignore - scanIterator types are complex in redis client
      const iterator = client.scanIterator({ MATCH: pattern, COUNT: 100 }) as AsyncIterable<string>;
      for await (const key of iterator) {
        keys.push(key);
      }

      if (keys.length > 0) {
        // Delete keys one by one to avoid type issues with spread
        for (const key of keys) {
          await client.del(key);
        }
      }
    }
  } catch {
    // Cache invalidation is non-critical
  }
}

// ── Invalidation by tag ────────────────────────────────────────

/**
 * Tags name what a cached value was built from (`page:<id>`, `dataset:<id>`), so a write purges exactly the
 * entries that read it: `invalidateTags("page:<id>")` instead of a SCAN over a key pattern, which walks the
 * whole keyspace and misses keys whose name does not carry the id (a list, a search).
 *
 * Valkey: one set per tag (`cache:tag:<tag>`) holding the keys. Memory: a map. A tag set lives as long as
 * the longest entry put in it (refreshed on every add, at least a day); a key that expired before its tag
 * is harmless (deleting it again is a no-op).
 */
const TAG_PREFIX = "cache:tag:";
const memoryTags = new Map<string, Set<string>>();
const TAG = /^[A-Za-z0-9:._/-]{1,200}$/;

function validTags(tags: string[]): string[] {
  return tags.filter((t) => typeof t === "string" && TAG.test(t));
}

async function tagKey(key: string, tags: string[], ttl: number): Promise<void> {
  const list = validTags(tags);
  if (!valkeyConfigured()) {
    for (const tag of list) {
      const keys = memoryTags.get(tag) ?? new Set<string>();
      keys.add(key);
      memoryTags.set(tag, keys);
    }
    return;
  }
  const client = await getValkeyClient();
  for (const tag of list) {
    await client.sAdd(TAG_PREFIX + tag, key);
    await client.expire(TAG_PREFIX + tag, Math.max(ttl, 86_400));
  }
}

/** Stores a value under `key` with tags (what `cachedQuery` does after a miss). */
export async function cacheSetTagged(
  key: string,
  value: unknown,
  ttl: number,
  tags: string[]
): Promise<void> {
  try {
    if (!(await hasCache())) return;
    await cacheSet(key, JSON.stringify(value), ttl);
    await tagKey(key, tags, ttl);
  } catch {
    // Non-critical, like every cache write
  }
}

/** Deletes every entry stored with any of these tags. */
export async function invalidateTags(...tags: string[]): Promise<void> {
  const list = validTags(tags);
  if (list.length === 0) return;
  try {
    if (!valkeyConfigured()) {
      for (const tag of list) {
        for (const key of memoryTags.get(tag) ?? []) memoryOf(key);
        memoryTags.delete(tag);
      }
      return;
    }
    if (!(await isValkeyAvailable())) return;
    const client = await getValkeyClient();
    for (const tag of list) {
      const keys = (await client.sMembers(TAG_PREFIX + tag)) as string[];
      for (const key of keys) await client.del(key);
      await client.del(TAG_PREFIX + tag);
    }
  } catch {
    // Cache invalidation is non-critical
  }
}
