/**
 * Kitsuden — Semantic search for models
 * ============================================================================
 *
 * `defineModel({ …, semantics: { fields: ["title", "content"] } })`:
 *
 *   · When a row is created or updated, `modelOperations` enqueues in the
 *     Postgres queue (`kitsuden-embeddings`, in the SAME transaction) the computation
 *     of its embedding. The host computes it and stores it in the
 *     `embedding vector(N)` column that `makemigrations` added.
 *   · `search-<plural>` (`GET /<plural>/search?q=`) computes the embedding of the
 *     query and orders by cosine distance, with the same owner filter and
 *     the same RLS as listing.
 *
 * The embedding is provided by the host (`configureEmbeddings`): OpenAI, Ollama or a
 * local OpenAI-compatible embeddings service (`EMBEDDINGS_URL`). The
 * engine does not know which one; it only asks for a vector of N dimensions.
 */

import { AppError, ErrorCode } from "./errors";

export const EMBEDDINGS_QUEUE = "kitsuden-embeddings";

export type Embedder = (text: string, dimensions: number) => Promise<number[]>;

let embedder: Embedder | null = null;

/** The host plugs in its embeddings provider (once, at startup). */
export function configureEmbeddings(fn: Embedder | null): void {
  embedder = fn;
}

/** The embedding of a text. 503 if the host configured no provider. */
export async function embed(text: string, dimensions: number): Promise<number[]> {
  if (!embedder) {
    throw new AppError(ErrorCode.INTERNAL, "Semantic search is not configured on this server", {
      status: 503,
      expose: true,
    });
  }
  const v = await embedder(text, dimensions);
  if (!Array.isArray(v) || v.length !== dimensions || v.some((x) => !Number.isFinite(x))) {
    throw new Error(
      `The embeddings provider returned ${Array.isArray(v) ? v.length : "something that is not a vector"}; expected ${dimensions} dimensions`
    );
  }
  return v;
}

/** A vector as a pgvector literal (`[0.1,0.2,…]`). */
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => Number(x).toString()).join(",")}]`;
}

/** What travels in the queue job. */
export interface EmbeddingJob {
  table: string;
  id: string;
  columns: string[];
  dimensions: number;
}
