/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Embeddings Service — Kitsuden Agents Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Generates real embeddings using the configured provider:
 *   - A LOCAL service compatible with the OpenAI API if EMBEDDINGS_URL exists
 *     (text-embeddings-inference, Infinity, llama.cpp server, Ollama /v1…):
 *     utility models on your machine, with no keys or Rust.
 *     EMBEDDINGS_MODEL picks the model; EMBEDDINGS_API_KEY, if needed.
 *   - OpenAI (text-embedding-3-small, default 1536 dims) if OPENAI_API_KEY exists
 *   - Ollama (nomic-embed-text, default 768 dims) if OLLAMA_BASE_URL/OLLAMA_MODEL exists
 *
 * Falls back to a deterministic mock only if no provider is configured,
 * so as not to break local development without keys.
 */

import { createLLMProvider, getDefaultProviderConfig } from "./llm";

export interface EmbeddingConfig {
  provider?: "openai" | "ollama";
  model?: string;
  dimensions?: number;
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_DIMENSIONS = 1536;

/**
 * Longest text that reaches a provider (about the 8191 tokens of
 * text-embedding-3-small): more would be refused, and it would be paid for.
 */
export const MAX_EMBEDDING_INPUT_CHARS = 32_000;

/**
 * The mock costs dimensions x bytes on the event loop, with no `await`: 100 KB
 * took 6.7 s. It is not a real embedding, so a long text gains nothing from it.
 */
const MAX_MOCK_INPUT_BYTES = 4_096;

/**
 * Generates an embedding for the given text.
 */
/** An OpenAI-compatible embeddings service (`POST {url}/v1/embeddings`). */
async function embeddingOverHttp(text: string, dimensions: number): Promise<number[]> {
  const base = (process.env.EMBEDDINGS_URL ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const res = await fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.EMBEDDINGS_API_KEY
        ? { authorization: `Bearer ${process.env.EMBEDDINGS_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      input: text,
      model: process.env.EMBEDDINGS_MODEL || "default",
      dimensions,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`EMBEDDINGS_URL responded ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const v = body.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error("EMBEDDINGS_URL did not return data[0].embedding");
  return v;
}

export async function generateEmbedding(
  fullText: string,
  config?: EmbeddingConfig
): Promise<number[]> {
  const text = fullText.slice(0, MAX_EMBEDDING_INPUT_CHARS);
  const dimensions = config?.dimensions || getDefaultDimensions(config?.provider);

  // A local service takes priority (no keys, on your network).
  if (!config?.provider && process.env.EMBEDDINGS_URL) {
    return embeddingOverHttp(text, dimensions);
  }

  // Explicit configuration
  if (config?.provider) {
    const provider = createLLMProvider({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    return provider.embed(text, { model: config.model, dimensions });
  }

  // Default configuration based on env
  const defaultConfig = getDefaultProviderConfig();
  if (defaultConfig) {
    const provider = createLLMProvider(defaultConfig);
    if (provider.isConfigured()) {
      return provider.embed(text, { model: defaultConfig.model, dimensions });
    }
  }

  // Fallback: deterministic 1536-dim mock (compatible with text-embedding-3-small)
  console.warn("[embeddings] No LLM provider configured. Returning deterministic mock embedding.");
  return generateMockEmbedding(text, dimensions);
}

/**
 * Returns the default dimensions per provider.
 */
function getDefaultDimensions(provider?: string): number {
  switch (provider) {
    case "openai":
      return 1536; // text-embedding-3-small
    case "ollama":
      return 768; // nomic-embed-text
    default:
      return DEFAULT_DIMENSIONS;
  }
}

/**
 * Generates a deterministic mock embedding from a simple hash.
 * Useful for tests and development without API keys.
 */
export function generateMockEmbedding(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text).subarray(0, MAX_MOCK_INPUT_BYTES);

  const embedding: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    let value = 0;
    for (let j = 0; j < bytes.length; j++) {
      value += Math.sin((i + 1) * (bytes[j] + 1) * 0.123) * Math.cos((j + 1) * 0.456);
    }
    embedding.push(Number(value.toFixed(6)));
  }

  return embedding;
}

/**
 * Checks whether a real embeddings provider is configured.
 */
export function hasRealEmbeddingProvider(): boolean {
  if (process.env.EMBEDDINGS_URL) return true;
  const defaultConfig = getDefaultProviderConfig();
  if (!defaultConfig) return false;
  const provider = createLLMProvider(defaultConfig);
  return provider.isConfigured();
}
