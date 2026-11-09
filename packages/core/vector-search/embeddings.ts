/**
 * Embedding Service — OpenAI integration for vector generation
 *
 * Extracted from AI Memories kon
 */

// @ts-ignore - openai may not be installed
import type OpenAI from "openai";

// Lazy initialization: the SDK is only imported with OPENAI_API_KEY
// (optional dependency of the published package).
let openai: OpenAI | null = null;

async function getOpenAI(): Promise<OpenAI | null> {
  if (!openai && process.env.OPENAI_API_KEY) {
    const { default: Client } = await import("openai");
    openai = new Client({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openai;
}

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
}

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;

/**
 * Generate embedding for text
 */
export async function generateEmbedding(
  text: string,
  options: EmbeddingOptions = {}
): Promise<number[]> {
  const client = await getOpenAI();

  if (!client) {
    // Return zero vector if no OpenAI key (allows testing without API)
    console.warn("[Vector Search] No OPENAI_API_KEY, returning zero vector");
    return new Array(options.dimensions || DEFAULT_DIMENSIONS).fill(0);
  }

  try {
    const response = await client.embeddings.create({
      model: options.model || DEFAULT_MODEL,
      input: text.slice(0, 8000), // OpenAI limit
      dimensions: options.dimensions || DEFAULT_DIMENSIONS,
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error("[Vector Search] Embedding generation failed:", error);
    throw error;
  }
}

/**
 * Generate embeddings for multiple texts (batch)
 */
export async function generateEmbeddings(
  texts: string[],
  options: EmbeddingOptions = {}
): Promise<number[][]> {
  const client = await getOpenAI();

  if (!client) {
    const dims = options.dimensions || DEFAULT_DIMENSIONS;
    return texts.map(() => new Array(dims).fill(0));
  }

  try {
    const response = await client.embeddings.create({
      model: options.model || DEFAULT_MODEL,
      input: texts.map((t) => t.slice(0, 8000)),
      dimensions: options.dimensions || DEFAULT_DIMENSIONS,
    });

    return response.data.map((d: { embedding: number[] }) => d.embedding);
  } catch (error) {
    console.error("[Vector Search] Batch embedding generation failed:", error);
    throw error;
  }
}

/**
 * Check if embedding service is available
 */
export function isEmbeddingAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Get embedding service status
 */
export function getEmbeddingStatus() {
  return {
    available: isEmbeddingAvailable(),
    model: DEFAULT_MODEL,
    dimensions: DEFAULT_DIMENSIONS,
    provider: "openai",
  };
}
