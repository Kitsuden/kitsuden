/**
 * Kitsuden — Semantic LLM cache (GPTCache style)
 * ============================================================================
 *
 * An exact cache (prompt hash) fails as soon as the user rephrases:
 * "how do I make a kon?" and "how do I create a kon?" are two calls to the model
 * even though the answer is identical. In conversational assistants a large
 * part of the traffic is rephrasing — money and latency thrown away.
 *
 * This layer embeds the query and searches by cosine SIMILARITY. If it finds
 * a sufficiently similar entry, it returns its answer without calling the
 * model.
 *
 * DESIGN — two decisions that matter:
 *
 *   1. EXACT FIRST, SEMANTIC AFTER. The exact lookup is O(1) and free;
 *      only if it fails is the embedding paid for. This way the literally
 *      repeated case (which is frequent) costs nothing extra.
 *
 *   2. EVERYTHING INJECTED. The engine knows nothing about Valkey or OpenAI: it receives a
 *      `CacheStore` and an `EmbeddingProvider`. That makes it testable in memory
 *      and allows changing backends without touching it.
 *
 * SECURITY: the `scope` partitions the cache. Answers are never shared
 * between different scopes — one tenant's agent cannot read another's
 * cached answer.
 */

// ── Injected contracts ───────────────────────────────────────────────────────

/** Key-value store (Valkey in production, Map in tests). */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Keys by prefix — for the semantic sweep. */
  keys(pattern: string): Promise<string[]>;
  del(key: string): Promise<void>;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** What is stored and returned. */
export interface CachedResponse {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface SemanticCacheOptions {
  store: CacheStore;
  /** Without a provider, the cache works in exact mode (clean degradation). */
  embeddings?: EmbeddingProvider;
  /**
   * Cosine similarity threshold to count as a hit. 0.95 is
   * deliberately high: a false positive returns a WRONG answer
   * to the user, which is much worse than paying for another model call.
   */
  threshold?: number;
  ttlSeconds?: number;
  /** Maximum entries to compare per search (cost of the sweep). */
  maxCandidates?: number;
}

export interface CacheHit extends CachedResponse {
  /** "exact" (hash) or "semantic" (similarity). */
  hit: "exact" | "semantic";
  /** Similarity of the semantic hit (1 for the exact one). */
  similarity: number;
}

export interface CacheStats {
  lookups: number;
  exactHits: number;
  semanticHits: number;
  misses: number;
  /** Input tokens saved by hits. */
  tokensSaved: number;
}

// ── Similarity ────────────────────────────────────────────────────────────────

/** Cosine between two vectors. Returns 0 if either is null. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Stable hash (FNV-1a) for the exact key — no crypto dependencies. */
function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ── Cache ────────────────────────────────────────────────────────────────────

export class SemanticCache {
  private store: CacheStore;
  private embeddings?: EmbeddingProvider;
  private threshold: number;
  private ttl: number;
  private maxCandidates: number;
  private stats: CacheStats = {
    lookups: 0,
    exactHits: 0,
    semanticHits: 0,
    misses: 0,
    tokensSaved: 0,
  };

  constructor(options: SemanticCacheOptions) {
    this.store = options.store;
    this.embeddings = options.embeddings;
    this.threshold = options.threshold ?? 0.95;
    this.ttl = options.ttlSeconds ?? 3600;
    this.maxCandidates = options.maxCandidates ?? 200;
  }

  /** Key of the exact lookup. */
  private exactKey(scope: string, query: string): string {
    return `llmcache:${scope}:x:${hash(query)}`;
  }

  /** Prefix of entries with a vector, for the semantic sweep. */
  private vectorPrefix(scope: string): string {
    return `llmcache:${scope}:v:`;
  }

  /**
   * Looks up a cached answer.
   *
   * `query` must be the text that semantically represents the request
   * (typically the user's last message), NOT the full serialized prompt:
   * a 2,000-token system prompt would dilute the signal.
   *
   * `scope` partitions the cache — use something like `${agentId}:${model}` so as
   * not to mix answers from different agents or models.
   */
  async lookup(scope: string, query: string): Promise<CacheHit | null> {
    this.stats.lookups++;

    // 1. Exact: O(1) and no embedding cost.
    try {
      const raw = await this.store.get(this.exactKey(scope, query));
      if (raw) {
        const value = JSON.parse(raw) as CachedResponse;
        this.stats.exactHits++;
        this.stats.tokensSaved += value.tokensIn;
        return { ...value, hit: "exact", similarity: 1 };
      }
    } catch {
      // A cache failure must never break the request: carry on.
    }

    // 2. Semantic: only if there is an embeddings provider.
    if (!this.embeddings) {
      this.stats.misses++;
      return null;
    }

    try {
      const vector = await this.embeddings.embed(query);
      const keys = (await this.store.keys(`${this.vectorPrefix(scope)}*`)).slice(
        0,
        this.maxCandidates
      );

      let best: { value: CachedResponse; similarity: number } | null = null;

      for (const key of keys) {
        const raw = await this.store.get(key);
        if (!raw) continue;

        const entry = JSON.parse(raw) as CachedResponse & { vector: number[] };
        if (!Array.isArray(entry.vector)) continue;

        const similarity = cosine(vector, entry.vector);
        if (similarity >= this.threshold && (!best || similarity > best.similarity)) {
          best = { value: entry, similarity };
        }
      }

      if (best) {
        this.stats.semanticHits++;
        this.stats.tokensSaved += best.value.tokensIn;
        return { ...best.value, hit: "semantic", similarity: best.similarity };
      }
    } catch {
      // No embeddings available → behaves as an exact cache.
    }

    this.stats.misses++;
    return null;
  }

  /** Stores an answer under its exact key and (if available) its vector. */
  async store_(scope: string, query: string, response: CachedResponse): Promise<void> {
    const payload = JSON.stringify(response);

    try {
      await this.store.set(this.exactKey(scope, query), payload, this.ttl);
    } catch {
      return; // without a cache, the app carries on
    }

    if (!this.embeddings) return;

    try {
      const vector = await this.embeddings.embed(query);
      // All-zeros vector = provider without an API key: useless for similarity.
      if (vector.every((v) => v === 0)) return;

      await this.store.set(
        `${this.vectorPrefix(scope)}${hash(query)}`,
        JSON.stringify({ ...response, vector }),
        this.ttl
      );
    } catch {
      // The exact entry was already stored; the semantic one is an extra.
    }
  }

  /** Invalidates a whole scope (e.g. when an agent's system prompt changes). */
  async invalidate(scope: string): Promise<number> {
    try {
      const keys = [
        ...(await this.store.keys(`llmcache:${scope}:x:*`)),
        ...(await this.store.keys(`llmcache:${scope}:v:*`)),
      ];
      for (const key of keys) await this.store.del(key);
      return keys.length;
    } catch {
      return 0;
    }
  }

  getStats(): CacheStats & { hitRate: number } {
    const hits = this.stats.exactHits + this.stats.semanticHits;
    return {
      ...this.stats,
      hitRate: this.stats.lookups > 0 ? Number((hits / this.stats.lookups).toFixed(4)) : 0,
    };
  }

  resetStats(): void {
    this.stats = { lookups: 0, exactHits: 0, semanticHits: 0, misses: 0, tokensSaved: 0 };
  }
}

/** In-memory store — for tests and for degrading without Valkey. */
export function memoryStore(): CacheStore {
  const map = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async keys(pattern) {
      const prefix = pattern.replace(/\*$/, "");
      return Array.from(map.keys()).filter((k) => k.startsWith(prefix));
    },
    async del(key) {
      map.delete(key);
    },
  };
}
