/**
 * KITSUDEN Brain — Layer 1: Sources (raw, immutable corpus)
 * ============================================================================
 *
 * Karpathy method, layer 1: raw documents that the AI READS but NEVER edits.
 * Everything you ingest lives here untouched; the wiki (Layer 2) is
 * derived interpretation. The sources are the auditable truth.
 *
 * Determinism:
 *   - The content hash (SHA-256) identifies the source. Ingesting the same
 *     content twice is idempotent (returns the existing source).
 *   - There is no `updateSource` by design. A changed source = a new source.
 */

import { createHash } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { brainSources } from "../../../../apps/api/src/db/schema-core";

import type { BrainDb } from "./notes";

export type BrainSourceType = "url" | "file" | "text" | "note";

export interface BrainSourceInput {
  title: string;
  content: string;
  sourceType?: BrainSourceType;
  uri?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface BrainSource {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  sourceType: string;
  uri: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Deterministic content hash (SHA-256 hex). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Ingests a raw source (idempotent by content hash).
 * If a source with the same content already exists, returns it without duplicating.
 */
export async function captureSource(
  db: BrainDb,
  input: BrainSourceInput
): Promise<{ source: BrainSource; deduped: boolean }> {
  const contentHash = hashContent(input.content);

  const existing = await db
    .select()
    .from(brainSources)
    .where(eq(brainSources.contentHash, contentHash))
    .limit(1);

  if (existing.length > 0) {
    return { source: existing[0] as BrainSource, deduped: true };
  }

  const [created] = await db
    .insert(brainSources)
    .values({
      title: input.title,
      content: input.content,
      contentHash,
      sourceType: input.sourceType ?? "text",
      uri: input.uri ?? null,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    })
    .returning();

  return { source: created as BrainSource, deduped: false };
}

/** Lists sources (most recent first). */
export async function listSources(db: BrainDb, limit = 100): Promise<BrainSource[]> {
  const rows = await db
    .select()
    .from(brainSources)
    .orderBy(desc(brainSources.createdAt))
    .limit(limit);
  return rows as BrainSource[];
}

/** Gets a source by id. */
export async function getSource(db: BrainDb, id: string): Promise<BrainSource | null> {
  const rows = await db.select().from(brainSources).where(eq(brainSources.id, id)).limit(1);
  return (rows[0] as BrainSource) ?? null;
}

/**
 * Deletes a source. It is the ONLY mutation allowed on Layer 1 (no update):
 * either the source exists intact, or it is removed entirely.
 */
export async function deleteSource(db: BrainDb, id: string): Promise<boolean> {
  const deleted = await db.delete(brainSources).where(eq(brainSources.id, id)).returning();
  return deleted.length > 0;
}
