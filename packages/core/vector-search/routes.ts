/**
 * Vector Search Routes — Auto-mounted per dataset with extension enabled
 *
 * Base path: /api/datasets/:datasetId/vector-*
 */

import { eq, and, inArray, sql } from "drizzle-orm"; // desc, lt, isNotNull removed - unused
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../../apps/api/src/db";

import { generateEmbedding } from "./embeddings";
import { vectorIndexTable, vectorChunksTable } from "./schema";

const app = new Hono();

// Schema validations
const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().default(10),
  threshold: z.number().min(0).max(1).default(0.7),
  fields: z.array(z.string()).optional(), // Filter by indexed fields
});

const indexSchema = z.object({
  entryId: z.guid(),
  content: z.string(),
  fieldName: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
  expiresAt: z.string().datetime().optional(),
});

/**
 * POST /api/datasets/:datasetId/vector-search
 * Semantic search within a dataset
 */
app.post("/datasets/:datasetId/vector-search", async (c) => {
  const datasetId = c.req.param("datasetId");
  const body = await c.req.json();

  const { query, limit, threshold, fields } = searchSchema.parse(body);

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(query);

  // Build search conditions
  const conditions = [eq(vectorIndexTable.datasetId, datasetId)];

  if (fields?.length) {
    // `= ANY(${array})` sends the array as ONE scalar parameter and Postgres
    // answers "malformed array literal". It only fails when someone uses the
    // filter, so it survives any test that does not pass it.
    conditions.push(inArray(vectorIndexTable.fieldName, fields));
  }

  // Perform vector search using cosine similarity
  const results = await db
    .select({
      id: vectorIndexTable.id,
      entryId: vectorIndexTable.entryId,
      content: vectorIndexTable.content,
      fieldName: vectorIndexTable.fieldName,
      metadata: vectorIndexTable.metadata,
      similarity: sql<number>`1 - (${vectorIndexTable.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector)`,
    })
    .from(vectorIndexTable)
    .where(and(...conditions))
    .orderBy(sql`${vectorIndexTable.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`)
    .limit(limit);

  // Filter by threshold and format response
  const filtered = results
    .filter((r) => r.similarity >= threshold)
    .map((r) => ({
      entryId: r.entryId,
      datasetId,
      content: r.content,
      fieldName: r.fieldName,
      similarity: r.similarity,
      metadata: r.metadata,
    }));

  return c.json({
    query,
    results: filtered,
    total: filtered.length,
  });
});

/**
 * POST /api/datasets/:datasetId/vector-index
 * Index or re-index content for an entry
 */
app.post("/datasets/:datasetId/vector-index", async (c) => {
  const datasetId = c.req.param("datasetId");
  const body = await c.req.json();
  const { entryId, content, fieldName, metadata, expiresAt } = indexSchema.parse(body);

  // Check if already indexed
  const existing = await db
    .select({ id: vectorIndexTable.id })
    .from(vectorIndexTable)
    .where(
      and(
        eq(vectorIndexTable.datasetId, datasetId),
        eq(vectorIndexTable.entryId, entryId),
        eq(vectorIndexTable.fieldName, fieldName)
      )
    )
    .limit(1);

  // Generate embedding
  const embedding = await generateEmbedding(content);

  // Chunk large content
  const chunks = chunkContent(content, 2000, 200);
  const isChunked = chunks.length > 1;

  if (existing.length > 0) {
    // Update existing
    await db
      .update(vectorIndexTable)
      .set({
        content,
        embedding,
        isChunked: isChunked ? 1 : 0,
        totalChunks: chunks.length,
        metadata: metadata || {},
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        updatedAt: new Date(),
      })
      .where(eq(vectorIndexTable.id, existing[0].id));

    // Delete old chunks
    await db.delete(vectorChunksTable).where(eq(vectorChunksTable.indexId, existing[0].id));

    // Insert new chunks if chunked
    if (isChunked) {
      await insertChunks(existing[0].id, chunks);
    }

    return c.json({
      success: true,
      action: "updated",
      entryId,
      chunks: chunks.length,
    });
  } else {
    // Create new
    const [inserted] = await db
      .insert(vectorIndexTable)
      .values({
        datasetId,
        entryId,
        content,
        embedding,
        fieldName,
        isChunked: isChunked ? 1 : 0,
        totalChunks: chunks.length,
        metadata: metadata || {},
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      })
      .returning({ id: vectorIndexTable.id });

    // Insert chunks if chunked
    if (isChunked && inserted) {
      await insertChunks(inserted.id, chunks);
    }

    return c.json({
      success: true,
      action: "created",
      entryId,
      chunks: chunks.length,
    });
  }
});

/**
 * DELETE /api/datasets/:datasetId/vector-index/:entryId
 * Remove entry from vector index
 */
app.delete("/datasets/:datasetId/vector-index/:entryId", async (c) => {
  const datasetId = c.req.param("datasetId");
  const entryId = c.req.param("entryId");
  const fieldName = c.req.query("field");

  const conditions = [
    eq(vectorIndexTable.datasetId, datasetId),
    eq(vectorIndexTable.entryId, entryId),
  ];

  if (fieldName) {
    conditions.push(eq(vectorIndexTable.fieldName, fieldName));
  }

  await db.delete(vectorIndexTable).where(and(...conditions));

  return c.json({ success: true, entryId });
});

/**
 * GET /api/datasets/:datasetId/vector-status
 * Get indexing status for a dataset
 */
app.get("/datasets/:datasetId/vector-status", async (c) => {
  const datasetId = c.req.param("datasetId");

  const stats = await db
    .select({
      count: sql<number>`count(*)`,
      fields: sql<string[]>`array_agg(distinct ${vectorIndexTable.fieldName})`,
      lastUpdated: sql<Date>`max(${vectorIndexTable.updatedAt})`,
    })
    .from(vectorIndexTable)
    .where(eq(vectorIndexTable.datasetId, datasetId));

  return c.json({
    datasetId,
    totalIndexed: stats[0]?.count || 0,
    fields: stats[0]?.fields?.filter(Boolean) || [],
    lastIndexedAt: stats[0]?.lastUpdated,
  });
});

/**
 * POST /api/vector-search/global
 * Search across ALL datasets (admin only)
 */
app.post("/vector-search/global", async (c) => {
  const body = await c.req.json();
  const { query, limit, threshold, datasetIds } = searchSchema
    .extend({
      datasetIds: z.array(z.string()).optional(),
    })
    .parse(body);

  const queryEmbedding = await generateEmbedding(query);

  const conditions = [];
  if (datasetIds?.length) {
    conditions.push(inArray(vectorIndexTable.datasetId, datasetIds));
  }

  const results = await db
    .select({
      entryId: vectorIndexTable.entryId,
      datasetId: vectorIndexTable.datasetId,
      content: vectorIndexTable.content,
      fieldName: vectorIndexTable.fieldName,
      metadata: vectorIndexTable.metadata,
      similarity: sql<number>`1 - (${vectorIndexTable.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector)`,
    })
    .from(vectorIndexTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${vectorIndexTable.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`)
    .limit(limit);

  return c.json({
    query,
    results: results.filter((r) => r.similarity >= threshold),
  });
});

// Helper: Chunk content
function chunkContent(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    start += size - overlap;
  }

  return chunks;
}

// Helper: Insert chunks
async function insertChunks(indexId: string, chunks: string[]) {
  for (let i = 0; i < chunks.length; i++) {
    const chunkEmbedding = await generateEmbedding(chunks[i]);

    await db.insert(vectorChunksTable).values({
      indexId,
      content: chunks[i],
      embedding: chunkEmbedding,
      chunkIndex: i,
      totalChunks: chunks.length,
      charOffset: i * (2000 - 200), // Approximate
    });
  }
}

export const vectorSearchRoutes = app;
