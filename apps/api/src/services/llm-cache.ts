/**
 * Kitsuden — Host LLM cache (semantic when there are embeddings)
 * ============================================================================
 *
 * Wires the engine's `SemanticCache` to the real infrastructure: Valkey
 * as the store and core's `vector-search` as the embeddings provider.
 *
 * Degradation in two steps, none of which breaks the request:
 *   Valkey + embeddings → semantic cache (hits on rephrasings)
 *   Valkey without embeddings → exact cache (as before)
 *   Valkey down → no cache
 *   Without VALKEY_URL (single instance) → the same store in process memory
 */

// The alias LLMEmbeddingProvider is used: the bare name EmbeddingProvider
// collides with the Brain's, which has a different shape.
import { SemanticCache, type CacheStore, type LLMEmbeddingProvider } from "@kitsuden/engine";

import { memoryOf, memoryGet, memoryKeys, memorySet } from "../lib/in-memory-cache";
import { getValkeyClient, isValkeyAvailable, valkeyConfigured } from "../lib/valkey";

/** In-memory store: the single-instance one, without Valkey. */
const memoryStore: CacheStore = {
  get: async (key) => memoryGet(key),
  set: async (key, value, ttlSeconds) => memorySet(key, value, ttlSeconds),
  keys: async (pattern) => memoryKeys(pattern).slice(0, 500),
  del: async (key) => memoryOf(key),
};

/** Store over Valkey. Each method fails silently: the cache is an extra. */
const valkeyOnly: CacheStore = {
  async get(key) {
    if (!(await isValkeyAvailable())) return null;
    const client = await getValkeyClient();
    const value = await client.get(key);
    return typeof value === "string" ? value : null;
  },

  async set(key, value, ttlSeconds) {
    if (!(await isValkeyAvailable())) return;
    const client = await getValkeyClient();
    await client.set(key, value, { EX: ttlSeconds });
  },

  async keys(pattern) {
    if (!(await isValkeyAvailable())) return [];
    const client = await getValkeyClient();
    // SCAN instead of KEYS: KEYS blocks the server with large datasets.
    const found: string[] = [];
    let cursor = "0";
    do {
      const res: any = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = String(res.cursor ?? res[0] ?? "0");
      const batch: string[] = res.keys ?? res[1] ?? [];
      found.push(...batch);
      // Hard cap: the semantic sweep must not degenerate into a full scan.
      if (found.length >= 500) break;
    } while (cursor !== "0");
    return found;
  },

  async del(key) {
    if (!(await isValkeyAvailable())) return;
    const client = await getValkeyClient();
    await client.del(key);
  },
};

/** Valkey if configured; otherwise, process memory. */
const valkeyStore: CacheStore = {
  get: (key) => (valkeyConfigured() ? valkeyOnly : memoryStore).get(key),
  set: (key, value, ttl) => (valkeyConfigured() ? valkeyOnly : memoryStore).set(key, value, ttl),
  keys: (pattern) => (valkeyConfigured() ? valkeyOnly : memoryStore).keys(pattern),
  del: (key) => (valkeyConfigured() ? valkeyOnly : memoryStore).del(key),
};

/**
 * Embeddings provider from @kitsuden/core. It is resolved once, lazily:
 * if there is no OPENAI_API_KEY, `isEmbeddingAvailable` is false and the
 * cache stays in exact mode.
 */
let _embeddings: LLMEmbeddingProvider | null | undefined;

async function resolveEmbeddings(): Promise<LLMEmbeddingProvider | undefined> {
  if (_embeddings !== undefined) return _embeddings ?? undefined;

  try {
    const mod: any = await import("../../../../packages/core/vector-search/embeddings");
    if (!mod.isEmbeddingAvailable?.()) {
      _embeddings = null;
      return undefined;
    }
    _embeddings = { embed: (text: string) => mod.generateEmbedding(text) };
    return _embeddings;
  } catch {
    _embeddings = null;
    return undefined;
  }
}

let _cache: SemanticCache | null = null;

/** Shared instance. The first call decides whether there is semantic mode. */
export async function getLlmCache(): Promise<SemanticCache> {
  if (_cache) return _cache;

  const embeddings = await resolveEmbeddings();
  _cache = new SemanticCache({
    store: valkeyStore,
    embeddings,
    // 0.95: a false positive returns a WRONG answer to the user,
    // which is much worse than paying for another call to the model.
    threshold: Number(process.env.LLM_CACHE_THRESHOLD) || 0.95,
    ttlSeconds: Number(process.env.LLM_CACHE_TTL) || 3600,
  });

  console.log(
    `  🧠 LLM cache: ${embeddings ? "semantic (embeddings active)" : "exact (no embeddings)"}`
  );
  return _cache;
}

/** Invalidates an agent's cache (call when its system prompt changes). */
export async function invalidateAgentCache(agentId: string): Promise<number> {
  const cache = await getLlmCache();
  return cache.invalidate(agentId);
}
