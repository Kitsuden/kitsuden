/**
 * KITSUDEN Brain — Embedding providers (lexical by default)
 *
 * Deterministic, zero-cost LEXICAL embedding using a small term-frequency hash
 * (shared words, not meaning). A semantic provider is opt-in: see the end of
 * this file (`resolveEmbeddingProvider`).
 * No external API calls. Produces fixed-size vectors suitable for
 * similarity search and connection discovery.
 */

import type { EmbeddingProvider } from "./types";

export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

/**
 * Normalize a vector to unit length (L2 norm).
 */
function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

/**
 * Tokenize text into lowercase alphanumeric terms.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Hash a string to an integer bucket.
 */
function hashBucket(str: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % buckets;
}

/**
 * Build a sparse term-frequency embedding.
 *
 * The resulting vector captures term overlap patterns well enough for
 * discovering connections between code entities, notes and documentation.
 */
export function embedTextLocal(text: string, dimensions = DEFAULT_EMBEDDING_DIMENSIONS): number[] {
  const terms = tokenize(text);
  const vec = new Array(dimensions).fill(0);

  for (const term of terms) {
    const bucket = hashBucket(term, dimensions);
    // Weight longer terms slightly more; damp common short words
    const weight = term.length >= 4 ? 1.2 : 1.0;
    vec[bucket] += weight;

    // Add character-ngram signal for partial matches
    if (term.length >= 4) {
      for (let i = 0; i <= term.length - 3; i++) {
        const ngram = term.slice(i, i + 3);
        const ngramBucket = hashBucket(ngram, dimensions);
        vec[ngramBucket] += 0.3;
      }
    }
  }

  return normalize(vec);
}

/**
 * Default embedding provider.
 */
export function createLocalEmbeddingProvider(
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS
): EmbeddingProvider {
  return {
    dimensions,
    embed(text: string) {
      return embedTextLocal(text, dimensions);
    },
  };
}

/**
 * Cosine similarity between two normalized vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pluggable providers (2026-10-28)
// ═══════════════════════════════════════════════════════════════════════════
//
// The built-in provider above is a TERM-FREQUENCY HASH: two texts are close
// when they share words (and 3-letter fragments of long words). It is
// LEXICAL, not semantic: "car" and "automobile" are unrelated to it. It is
// free, deterministic and offline, and it stays the default.
//
// A semantic provider is opt-in, through env, and nothing paid is ever the
// default:
//
//   KITSUDEN_BRAIN_EMBEDDINGS=lexical          (default) the hash above
//   KITSUDEN_BRAIN_EMBEDDINGS=http             an OpenAI-compatible
//                                              `POST <url>/embeddings` endpoint
//                                              (Ollama, LM Studio, llama.cpp,
//                                              vLLM… or a paid API if YOU set it)
//   KITSUDEN_BRAIN_EMBEDDINGS_URL=http://localhost:11434/v1
//   KITSUDEN_BRAIN_EMBEDDINGS_MODEL=nomic-embed-text
//   KITSUDEN_BRAIN_EMBEDDINGS_API_KEY=…        optional (sent as Bearer)
//
// Every vector is stored with its `kind` (`lexical-hash-384`,
// `http:nomic-embed-text`), and search only compares vectors of the SAME
// kind: mixing spaces would return noise with a confident score. If the
// configured provider fails, the call fails (no silent fallback that would
// change the meaning of the score); the response always says which kind and
// whether it is semantic.

/** What a search or a write reports about the vectors it used. */
export interface EmbeddingInfo {
  /** Stored with each note; only vectors of the same kind are compared. */
  kind: string;
  /** `lexical` = shared words, `semantic` = a model's meaning space. */
  mode: "lexical" | "semantic";
  dimensions: number;
}

export interface PluggableEmbeddingProvider extends EmbeddingProvider {
  info: EmbeddingInfo;
}

export const LEXICAL_EMBEDDING_KIND = `lexical-hash-${DEFAULT_EMBEDDING_DIMENSIONS}`;

export function createLexicalEmbeddingProvider(): PluggableEmbeddingProvider {
  return {
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    info: {
      kind: LEXICAL_EMBEDDING_KIND,
      mode: "lexical",
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    },
    embed(text: string) {
      return embedTextLocal(text, DEFAULT_EMBEDDING_DIMENSIONS);
    },
  };
}

export interface HttpEmbeddingOptions {
  url: string;
  model: string;
  apiKey?: string;
  /** Known dimensions (otherwise learnt from the first answer). */
  dimensions?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI-compatible `POST {url}/embeddings` with `{ model, input }`. */
export function createHttpEmbeddingProvider(
  opts: HttpEmbeddingOptions
): PluggableEmbeddingProvider {
  const base = opts.url.replace(/\/+$/, "");
  const make = opts.fetchImpl ?? fetch;
  const info: EmbeddingInfo = {
    kind: `http:${opts.model}`,
    mode: "semantic",
    dimensions: opts.dimensions ?? 0,
  };
  return {
    get dimensions() {
      return info.dimensions;
    },
    info,
    async embed(text: string) {
      const res = await make(`${base}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: opts.model, input: text }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) throw new Error(`embeddings provider answered ${res.status}`);
      const json = (await res.json()) as { data?: { embedding?: unknown }[] };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0 || !vec.every((x) => typeof x === "number")) {
        throw new Error("embeddings provider returned no vector");
      }
      if (info.dimensions === 0) info.dimensions = vec.length;
      return normalize(vec as number[]);
    },
  };
}

/** The provider configured by env (lexical when nothing is set). */
export function resolveEmbeddingProvider(
  env: Record<string, string | undefined> = process.env
): PluggableEmbeddingProvider {
  const mode = (env.KITSUDEN_BRAIN_EMBEDDINGS ?? "lexical").trim().toLowerCase();
  if (mode === "" || mode === "lexical" || mode === "local" || mode === "hash") {
    return createLexicalEmbeddingProvider();
  }
  if (mode === "http") {
    const url = env.KITSUDEN_BRAIN_EMBEDDINGS_URL?.trim();
    const model = env.KITSUDEN_BRAIN_EMBEDDINGS_MODEL?.trim();
    if (!url || !model) {
      throw new Error(
        "KITSUDEN_BRAIN_EMBEDDINGS=http needs KITSUDEN_BRAIN_EMBEDDINGS_URL and KITSUDEN_BRAIN_EMBEDDINGS_MODEL"
      );
    }
    const dims = Number(env.KITSUDEN_BRAIN_EMBEDDINGS_DIMENSIONS);
    return createHttpEmbeddingProvider({
      url,
      model,
      apiKey: env.KITSUDEN_BRAIN_EMBEDDINGS_API_KEY?.trim() || undefined,
      dimensions: Number.isInteger(dims) && dims > 0 ? dims : undefined,
    });
  }
  throw new Error(`KITSUDEN_BRAIN_EMBEDDINGS='${mode}' is not a known provider (lexical | http)`);
}
