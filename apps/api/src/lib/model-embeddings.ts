/**
 * Kitsuden — Embeddings for models with semantic search (plan D5)
 * ============================================================================
 *
 * The host wires two things to the engine's seam (engine/src/semantics.ts):
 *
 *   1. The PROVIDER: `services/embeddings.ts` (by priority: a
 *      local OpenAI-compatible service at `EMBEDDINGS_URL`, OpenAI, Ollama; with
 *      none, a deterministic test vector that is NOT useful for real
 *      search, with a warning).
 *   2. The WORKER of the `kitsuden-embeddings` queue: reads the text fields of
 *      the row, computes its embedding and stores it in the `embedding` column.
 *      With the SYSTEM connection and OUTSIDE the job's transaction: the
 *      job was already authorized when enqueued, the row may belong to someone else, and
 *      the provider call must not hold an open transaction (rule
 *      3 of kon-transactions.md). Idempotent: recomputing gives the same result.
 */

import { sql } from "drizzle-orm";

import { PermanentError, queue, type QueueJob } from "../../../../packages/engine/src/queue";
import { background } from "../../../../packages/engine/src/rls-request";
import {
  EMBEDDINGS_QUEUE,
  configureEmbeddings,
  vectorLiteral,
  type EmbeddingJob,
} from "../../../../packages/engine/src/semantics";
import { db } from "../db";
import { generateEmbedding } from "../services/embeddings";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const q = (id: string) => `"${id}"`;

/** Wires the host's embeddings provider (at startup, with or without a worker). */
export function configureModelEmbeddings(): void {
  configureEmbeddings((text, dimensions) => generateEmbedding(text, { dimensions }));
}

export async function computeRowEmbedding(job: QueueJob): Promise<void> {
  const t = job.payload as EmbeddingJob;
  if (
    !t?.id ||
    !IDENTIFIER.test(t.table ?? "") ||
    !Array.isArray(t.columns) ||
    t.columns.length === 0 ||
    !t.columns.every((c) => IDENTIFIER.test(c))
  ) {
    throw new PermanentError("malformed embedding job");
  }
  const table = sql.raw(q(t.table));
  const text = sql.raw(`concat_ws(' ', ${t.columns.map(q).join(", ")})`);
  // Empty request scope: nothing resolves to the job's transaction.
  await background(async () => {
    const r = (await db.execute(
      sql`SELECT ${text} AS text FROM ${table} WHERE id = ${t.id}::uuid`
    )) as {
      rows: Array<{ text: string | null }>;
    };
    const row = r.rows[0];
    if (!row) return; // deleted while waiting: nothing to do
    const content = (row.text ?? "").trim();
    const value = content
      ? sql`${vectorLiteral(await generateEmbedding(content.slice(0, 8000), { dimensions: t.dimensions }))}::vector`
      : sql`NULL`;
    await db.execute(sql`UPDATE ${table} SET "embedding" = ${value} WHERE id = ${t.id}::uuid`);
  });
}

/** Registers the embeddings queue handler (called by the worker startup). */
export function registerModelEmbeddings(): void {
  queue.handle(EMBEDDINGS_QUEUE, computeRowEmbedding, { concurrency: 2 });
}
