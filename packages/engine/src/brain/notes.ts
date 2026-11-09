/**
 * KITSUDEN Brain — Notes Manager
 *
 * CRUD, lexical similarity search and connection discovery for brain notes.
 */

import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";

import type { Database } from "../../../../apps/api/src/db";
import { brainConnections, brainNotes } from "../../../../apps/api/src/db/schema-core";
import { eqEnum } from "../db-conditions";

import { cosineSimilarity, embedTextLocal, LEXICAL_EMBEDDING_KIND } from "./embeddings";
import type { BrainConnectionInput, BrainNote, BrainNoteInput, BrainNoteCategory } from "./types";

export type BrainDb = Database;

const DEFAULT_DIMENSIONS = 384;

/**
 * Without an explicit embedding, it is computed from the title and content. Before it was
 * computed from "" (a vector that resembles nothing), so a note
 * created without an embedding never showed up in searchSimilarBrainNotes.
 */
function ensureEmbedding(embedding: number[] | null | undefined, text: string): number[] {
  if (Array.isArray(embedding) && embedding.length > 0) return embedding;
  return embedTextLocal(text, DEFAULT_DIMENSIONS);
}

/**
 * Insert or update a brain note. If an existing note with the same sourcePath
 * and category exists, it is updated instead.
 */
export async function upsertBrainNote(db: BrainDb, input: BrainNoteInput): Promise<BrainNote> {
  const embedding = ensureEmbedding(input.embedding, `${input.title} ${input.content}`);
  const values = {
    title: input.title,
    content: input.content,
    source: input.source ?? "system",
    sourcePath: input.sourcePath ?? null,
    category: input.category ?? "general",
    tags: input.tags ?? [],
    embedding,
    importance: input.importance ?? 50,
    confidence: input.confidence ?? 80,
    metadata: input.metadata ?? {},
    relatedNoteIds: input.relatedNoteIds ?? [],
    // Explicit vectors keep their unknown kind; computed ones are the lexical hash.
    embeddingKind:
      Array.isArray(input.embedding) && input.embedding.length > 0 ? null : LEXICAL_EMBEDDING_KIND,
    ownerUserId: input.ownerUserId ?? null,
    // DB default is private (0051); a legacy note with no owner is project
    // knowledge and stays readable by the team and agents, as before.
    visibility: input.visibility ?? "shared",
    updatedAt: new Date(),
  };

  if (input.sourcePath) {
    const existing = await db
      .select({ id: brainNotes.id })
      .from(brainNotes)
      .where(
        // Only legacy notes (no owner, no key): an agent's note or a graphify
        // import with the same file path is never overwritten by the scanner.
        and(
          eq(brainNotes.sourcePath, input.sourcePath),
          eq(brainNotes.category, values.category),
          isNull(brainNotes.ownerAgentId),
          isNull(brainNotes.noteKey)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(brainNotes)
        .set(values)
        .where(eq(brainNotes.id, existing[0].id))
        .returning();
      return updated as BrainNote;
    }
  }

  const [created] = await db.insert(brainNotes).values(values).returning();
  return created as BrainNote;
}

/**
 * Find a note by id.
 */
export async function getBrainNote(db: BrainDb, id: string): Promise<BrainNote | null> {
  const rows = await db.select().from(brainNotes).where(eq(brainNotes.id, id)).limit(1);
  return (rows[0] as BrainNote) ?? null;
}

/**
 * List notes with optional filters.
 */
export async function listBrainNotes(
  db: BrainDb,
  filters: {
    category?: BrainNoteCategory;
    source?: string;
    search?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
    orderBy?: "importance" | "createdAt" | "updatedAt";
  } = {}
): Promise<BrainNote[]> {
  const conditions = [];
  if (filters.category) conditions.push(eq(brainNotes.category, filters.category));
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const sourceFilter = eqEnum(brainNotes.source, filters.source);
  if (sourceFilter) conditions.push(sourceFilter);
  if (filters.search) {
    conditions.push(
      ilike(brainNotes.title, `%${filters.search}%`) // simple search; pg_trgm can be added later
    );
  }
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(sql`${brainNotes.tags} @> ${JSON.stringify(filters.tags)}::jsonb`);
  }

  const orderColumn =
    filters.orderBy === "importance"
      ? desc(brainNotes.importance)
      : filters.orderBy === "updatedAt"
        ? desc(brainNotes.updatedAt)
        : desc(brainNotes.createdAt);

  const rows = await db
    .select()
    .from(brainNotes)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(orderColumn)
    .limit(filters.limit ?? 100)
    .offset(filters.offset ?? 0);

  return rows as BrainNote[];
}

/**
 * Similarity search over brain notes using the built-in LEXICAL embeddings
 * (term-frequency hash: shared words, not meaning). Global: no owner filter;
 * owner-aware search is `searchMemoryNotes` (memory.ts).
 * Loads embeddings into memory; suitable for small/medium note collections.
 */
export async function searchSimilarBrainNotes(
  db: BrainDb,
  query: string,
  options: { limit?: number; threshold?: number } = {}
): Promise<Array<BrainNote & { similarity: number }>> {
  const limit = options.limit ?? 10;
  const threshold = options.threshold ?? 0.1;
  const queryVector = embedTextLocal(query, DEFAULT_DIMENSIONS);

  const rows = await db.select().from(brainNotes);
  const scored = (rows as BrainNote[])
    .map((note) => {
      const vec = Array.isArray(note.embedding) ? note.embedding : [];
      const similarity = vec.length === queryVector.length ? cosineSimilarity(queryVector, vec) : 0;
      return { ...note, similarity };
    })
    .filter((n) => n.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

/**
 * Create an explicit connection between two notes.
 */
export async function createBrainConnection(
  db: BrainDb,
  input: BrainConnectionInput
): Promise<BrainConnectionInput & { id: string; createdAt: Date }> {
  const values = {
    sourceNoteId: input.sourceNoteId,
    targetNoteId: input.targetNoteId,
    relationType: input.relationType ?? "related",
    strength: input.strength ?? 0.5,
    metadata: input.metadata ?? {},
    origin: input.origin ?? "INFERRED",
    confidence: Math.min(1, Math.max(0, input.confidence ?? input.strength ?? 0.5)),
  };

  const [created] = await db
    .insert(brainConnections)
    .values(values)
    .onConflictDoNothing({
      target: [
        brainConnections.sourceNoteId,
        brainConnections.targetNoteId,
        brainConnections.relationType,
      ],
    })
    .returning();

  return created as BrainConnectionInput & { id: string; createdAt: Date };
}

/**
 * List connections for a note.
 */
/**
 * Connections of a note, or ALL if none is specified.
 *
 * Without `noteId` it returns the whole table, and that is not an extra: three places in
 * the engine itself (`getBrainIndex`, and the two graph functions) called with an
 * empty string meaning exactly that.
 *
 * But `""` did not mean "all": it was put in as a parameter in the comparison,
 * and comparing a `uuid` column with an empty string makes Postgres throw
 * `invalid input syntax for type uuid`. The result was a 500 on
 * `GET /api/brain/status` and in the graph — that is, the Brain screen
 * never loaded, and the error seen in the browser was
 * "Something went wrong · [object Object]".
 */
export async function listBrainConnections(
  db: BrainDb,
  noteId?: string
): Promise<BrainConnectionInput[]> {
  const query = db.select().from(brainConnections);

  const filtered = noteId
    ? query.where(
        sql`${brainConnections.sourceNoteId} = ${noteId} OR ${brainConnections.targetNoteId} = ${noteId}`
      )
    : query;

  const rows = await filtered.orderBy(desc(brainConnections.strength));
  return rows as BrainConnectionInput[];
}

/**
 * Delete a note and its connections.
 */
export async function deleteBrainNote(db: BrainDb, id: string): Promise<boolean> {
  await db
    .delete(brainConnections)
    .where(
      sql`${brainConnections.sourceNoteId} = ${id} OR ${brainConnections.targetNoteId} = ${id}`
    );
  const result = await db.delete(brainNotes).where(eq(brainNotes.id, id)).returning();
  return result.length > 0;
}
