/**
 * Kitsuden — LLM layer
 * ============================================================================
 * Semantic cache (GPTCache style) and guaranteed structured output.
 * PURE modules: everything is injected (store, embeddings, provider), so they
 * are tested in memory and work with any backend.
 */

export {
  SemanticCache,
  memoryStore,
  cosine,
  type CacheStore,
  type EmbeddingProvider,
  type CachedResponse,
  type SemanticCacheOptions,
  type CacheHit,
  type CacheStats,
} from "./semantic-cache";

export {
  generateStructured,
  extractJson,
  toJsonSchema,
  type StructuredProvider,
  type StructuredRequest,
  type StructuredMode,
  type StructuredResult,
  type StructuredOptions,
} from "./structured";
