/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEARCH ENGINE - Full-Text + Vector Search with PGVector
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Combines traditional PostgreSQL full-text search with
 * semantic search using embeddings and PGVector.
 */

import { isUuid } from "@kitsuden/engine";
import { publishedOrOwn } from "@kitsuden/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { requireAdminRole } from "../middleware/auth-guard";
import {
  generateEmbedding as generateRealEmbedding,
  hasRealEmbeddingProvider,
} from "../services/embeddings";
import type { AppVariables } from "../types/hono";

import { inProduction } from "./environment";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SearchOptions {
  query: string;
  datasetId?: string;
  type?: "fulltext" | "vector" | "hybrid";
  limit?: number;
  offset?: number;
  filters?: Record<string, unknown>;
  sortBy?: "relevance" | "date" | "title";
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  type: string;
  datasetId?: string;
  score: number;
  highlights?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  datasetId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL-TEXT SEARCH (PostgreSQL tsvector)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initializes the extensions required in PostgreSQL
 * Run only once during setup
 */
export async function initializeSearchExtensions(): Promise<void> {
  try {
    // Enable pgvector
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

    // Enable pg_trgm for fuzzy search
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    console.log("✅ Search extensions initialized (vector, pg_trgm)");
  } catch (error) {
    console.error("Failed to initialize search extensions:", error);
    throw error;
  }
}

/**
 * Traditional full-text search
 */
export async function searchFullText(options: SearchOptions): Promise<SearchResult[]> {
  const { query, limit = 20, offset = 0 } = options;

  // `data_entries` has no `content` or `type`, and its dataset column is
  // `data_set_id`: this query answered 500 to every search. Public rows only, in
  // the SQL itself, so a page is not emptied by filtering it afterwards. The
  // headline runs on the outer query: only on the page, not on every match.
  const results = await db.execute<{
    id: string;
    title: string;
    dataset_id: string;
    score: number;
    fragment: string;
    created_at: string;
  }>(sql`
    SELECT
      m.id,
      m.title,
      m.data_set_id AS dataset_id,
      m.score,
      ts_headline('english', m.title || ' ' || m.data::text, m.query, 'MaxFragments=3,MaxWords=50,MinWords=10,StartSel="",StopSel=""') AS fragment,
      m.created_at
    FROM (
      SELECT e.id, e.title, e.data, e.data_set_id, e.created_at, q.query,
             ts_rank_cd(e.search_vector, q.query) AS score
      FROM data_entries e
      JOIN data_sets d ON d.id = e.data_set_id
      CROSS JOIN plainto_tsquery('english', ${query}) AS q(query)
      WHERE e.search_vector @@ q.query
        AND ${PUBLIC_DATASET_SQL}
        AND ${publishedOrOwn(null, "e")}
        ${options.datasetId ? sql`AND e.data_set_id = ${options.datasetId}` : sql``}
      ORDER BY score DESC, e.id
      LIMIT ${limit}
      OFFSET ${offset}
    ) m
    ORDER BY m.score DESC, m.id
  `);

  return results.rows.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.fragment,
    type: "data_entry",
    datasetId: row.dataset_id,
    score: row.score,
    highlights: row.fragment ? [row.fragment] : undefined,
    createdAt: row.created_at,
  }));
}

/**
 * Fuzzy search using trigrams (for typos)
 */
export async function searchFuzzy(
  query: string,
  table: string = "data_entries",
  column: string = "title",
  limit: number = 10
): Promise<{ id: string; title: string; similarity: number }[]> {
  const results = await db.execute<{
    id: string;
    title: string;
    similarity: number;
  }>(sql`
    SELECT 
      id,
      ${sql.identifier(column)} as title,
      similarity(${sql.identifier(column)}, ${query}) as similarity
    FROM ${sql.identifier(table)}
    WHERE ${sql.identifier(column)} % ${query}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `);

  return results.rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VECTOR SEARCH (PGVector)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generates an embedding using the configured provider (OpenAI, Ollama).
 * Falls back to a deterministic mock if no provider is configured.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return generateRealEmbedding(text);
}

/**
 * Creates the vectors table for documents
 */
export async function createVectorTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vector_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      embedding VECTOR(384),
      metadata JSONB DEFAULT '{}',
      dataset_id UUID REFERENCES data_sets(id) ON DELETE CASCADE,
      source_type VARCHAR(50),
      source_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // HNSW index for efficient vector search
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS vector_documents_embedding_idx 
    ON vector_documents 
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  `);

  // Additional indexes
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS vector_documents_dataset_idx ON vector_documents(dataset_id);
    CREATE INDEX IF NOT EXISTS vector_documents_source_idx ON vector_documents(source_type, source_id);
  `);

  console.log("✅ Vector documents table created");
}

/**
 * Inserts or updates a vector document
 */
export async function upsertVectorDocument(
  content: string,
  metadata: Record<string, unknown> = {},
  options: {
    id?: string;
    datasetId?: string;
    sourceType?: string;
    sourceId?: string;
    embedding?: number[];
  } = {}
): Promise<string> {
  const embedding = options.embedding || (await generateEmbedding(content));
  const embeddingLiteral = `[${embedding.join(",")}]`;

  if (options.id) {
    // Update
    await db.execute(sql`
      UPDATE vector_documents
      SET 
        content = ${content},
        embedding = ${embeddingLiteral}::vector,
        metadata = ${JSON.stringify(metadata)}::jsonb,
        updated_at = NOW()
      WHERE id = ${options.id}
    `);
    return options.id;
  } else {
    // Insert
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO vector_documents (content, embedding, metadata, dataset_id, source_type, source_id)
      VALUES (
        ${content},
        ${embeddingLiteral}::vector,
        ${JSON.stringify(metadata)}::jsonb,
        ${options.datasetId || null},
        ${options.sourceType || null},
        ${options.sourceId || null}
      )
      RETURNING id
    `);
    return result.rows[0].id;
  }
}

/**
 * Semantic search by vector similarity
 */
export async function searchVector(
  query: string,
  options: {
    datasetId?: string;
    limit?: number;
    threshold?: number;
    sourceType?: string;
  } = {}
): Promise<SearchResult[]> {
  const { limit = 10, threshold = 0.7 } = options;

  // Without a provider the embedding is a mock: useless as a search, and it runs
  // on the event loop. Not in production.
  if (inProduction() && !hasRealEmbeddingProvider()) return [];

  const queryEmbedding = await generateEmbedding(query);
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  const results = await db.execute<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    dataset_id: string;
    source_type: string;
    similarity: number;
    created_at: string;
  }>(sql`
    SELECT 
      id,
      content,
      metadata,
      dataset_id,
      source_type,
      1 - (embedding <=> ${embeddingLiteral}::vector) as similarity,
      created_at
    FROM vector_documents
    WHERE embedding IS NOT NULL
    ${options.datasetId ? sql`AND dataset_id = ${options.datasetId}` : sql``}
    ${options.sourceType ? sql`AND source_type = ${options.sourceType}` : sql``}
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${limit}
  `);

  return results.rows
    .filter((row) => row.similarity >= threshold)
    .map((row) => ({
      id: row.id,
      // `metadata` comes from jsonb, so its content is free-form: the title is
      // optional and it must be assumed that it may not be text. Truncating the
      // content is the fallback, not an oddity.
      title:
        typeof row.metadata?.title === "string" ? row.metadata.title : row.content.slice(0, 100),
      content: row.content,
      type: row.source_type || "vector_doc",
      datasetId: row.dataset_id,
      score: row.similarity,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
}

/**
 * Hybrid search: combines full-text + vector
 */
export async function searchHybrid(options: SearchOptions): Promise<SearchResult[]> {
  // Run both searches in parallel
  const [fulltextResults, vectorResults] = await Promise.all([
    searchFullText({ ...options, limit: (options.limit || 10) * 2 }),
    // The semantic half is optional: `vector_documents` has a fixed dimension, and a
    // provider with another one must not take the full-text results down with it.
    searchVector(options.query, {
      datasetId: options.datasetId,
      limit: (options.limit || 10) * 2,
    }).catch((error) => {
      console.error("Vector search failed, using full text only:", error);
      return [] as SearchResult[];
    }),
  ]);

  // Combine and deduplicate results
  const seen = new Set<string>();
  const combined: SearchResult[] = [];

  // Normalize scores (0-1)
  const maxFulltextScore = Math.max(...fulltextResults.map((r) => r.score), 1);
  const maxVectorScore = Math.max(...vectorResults.map((r) => r.score), 1);

  // Add full-text with weight 0.6
  for (const result of fulltextResults) {
    if (!seen.has(result.id)) {
      seen.add(result.id);
      combined.push({
        ...result,
        score: (result.score / maxFulltextScore) * 0.6,
      });
    }
  }

  // Add vector with weight 0.4
  for (const result of vectorResults) {
    if (!seen.has(result.id)) {
      seen.add(result.id);
      combined.push({
        ...result,
        score: (result.score / maxVectorScore) * 0.4,
      });
    } else {
      // Boost existing result
      const existing = combined.find((r) => r.id === result.id);
      if (existing) {
        existing.score += (result.score / maxVectorScore) * 0.4;
      }
    }
  }

  // Sort by combined score and limit
  return combined.sort((a, b) => b.score - a.score).slice(0, options.limit || 10);
}

/**
 * Main unified search
 */
export async function search(options: SearchOptions): Promise<SearchResult[]> {
  const searchType = options.type || "hybrid";

  switch (searchType) {
    case "fulltext":
      return searchFullText(options);
    case "vector":
      return searchVector(options.query, {
        datasetId: options.datasetId,
        limit: options.limit,
      });
    case "hybrid":
    default:
      return searchHybrid(options);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

export const searchRoutes = new Hono<{ Variables: AppVariables }>();

/**
 * What the PUBLIC search can return: dataset entries whose
 * policy is `readAccess: "public"` and without `rlsRules` (no isolation by
 * owner).
 *
 * Audit 2026-10-15: `/api/search/suggestions` (no session) returned
 * titles of ALL the rows of `data_entries`, from any dataset —
 * private, admin-only or isolated per user—, and `POST /api/search` did not
 * look at any dataset's policy. The routes mount before the session
 * middleware, so there is no user here: public is the only safe option.
 */
const PUBLIC_DATASET_SQL = sql`
  d.policy_json->>'readAccess' = 'public'
  AND COALESCE(jsonb_array_length(
    CASE WHEN jsonb_typeof(d.policy_json->'rlsRules') = 'array'
         THEN d.policy_json->'rlsRules' ELSE '[]'::jsonb END), 0) = 0`;

async function publicDatasets(): Promise<Set<string>> {
  const r = await db.execute<{ id: string }>(
    sql`SELECT d.id::text AS id FROM data_sets d WHERE ${PUBLIC_DATASET_SQL}`
  );
  return new Set(r.rows.map((f) => f.id));
}

/** Keeps only the results from public datasets (exported so it can be tested). */
export function publicResultsOnly(
  results: SearchResult[],
  publicOnes: ReadonlySet<string>
): SearchResult[] {
  return results.filter((r) => r.datasetId !== undefined && publicOnes.has(String(r.datasetId)));
}

/** Longest `query` of the public search (same limit as the model search). */
export const MAX_SEARCH_QUERY_CHARS = 2000;

/** Deepest page of the public search: a large OFFSET still walks every match. */
export const MAX_SEARCH_OFFSET = 10_000;

/**
 * POST /api/search - Unified search
 */
searchRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }
  if (typeof body.query === "string" && body.query.length > MAX_SEARCH_QUERY_CHARS) {
    return c.json({ error: `Query must be at most ${MAX_SEARCH_QUERY_CHARS} characters` }, 400);
  }
  if (body.query !== undefined && typeof body.query !== "string") {
    return c.json({ error: "Query must be a string" }, 400);
  }
  const limit = body.limit === undefined ? 20 : Number(body.limit);
  const offset = body.offset === undefined ? 0 : Number(body.offset);
  if (!Number.isInteger(limit) || limit < 1) {
    return c.json({ error: "Limit must be a positive integer" }, 400);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET) {
    return c.json({ error: `Offset must be an integer from 0 to ${MAX_SEARCH_OFFSET}` }, 400);
  }
  if (body.type !== undefined && !["fulltext", "vector", "hybrid"].includes(body.type)) {
    return c.json({ error: "Type must be fulltext, vector or hybrid" }, 400);
  }
  if (body.datasetId !== undefined && !isUuid(String(body.datasetId))) {
    return c.json({ error: "datasetId must be a UUID" }, 400);
  }
  const options: SearchOptions = {
    query: body.query,
    type: body.type || "hybrid",
    limit: Math.min(limit, 100),
    offset,
    datasetId: body.datasetId,
    filters: body.filters,
    sortBy: body.sortBy || "relevance",
  };

  if (!options.query || options.query.length < 2) {
    return c.json({ error: "Query must be at least 2 characters" }, 400);
  }

  try {
    const results = publicResultsOnly(await search(options), await publicDatasets());
    return c.json({
      results,
      total: results.length,
      query: options.query,
      type: options.type,
    });
  } catch (error) {
    console.error("Search error:", error);
    return c.json({ error: "Search failed" }, 500);
  }
});

/**
 * GET /api/search/suggestions - Autocomplete
 */
searchRoutes.get("/suggestions", async (c) => {
  const query = c.req.query("q") || "";
  const limit = Math.min(Number(c.req.query("limit")) || 5, 10);

  if (query.length < 2) {
    return c.json({ suggestions: [] });
  }

  try {
    // Quick fuzzy search, ONLY over public datasets (see above)
    const results = (
      await db.execute<{ id: string; title: string; similarity: number }>(sql`
        SELECT e.id, e.title, similarity(e.title, ${query}) AS similarity
        FROM data_entries e
        JOIN data_sets d ON d.id = e.data_set_id
        WHERE e.title % ${query} AND ${PUBLIC_DATASET_SQL} AND ${publishedOrOwn(null, "e")}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `)
    ).rows;

    return c.json({
      suggestions: results.map((r) => ({
        text: r.title,
        similarity: r.similarity,
      })),
    });
  } catch (error) {
    return c.json({ suggestions: [] });
  }
});

/**
 * POST /api/search/index - Index content (for admins)
 */
searchRoutes.post("/index", requireAdminRole, async (c) => {
  const body = await c.req.json();

  try {
    const id = await upsertVectorDocument(body.content, body.metadata, {
      id: body.id,
      datasetId: body.datasetId,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
    });

    return c.json({ success: true, id });
  } catch (error) {
    console.error("Index error:", error);
    return c.json({ error: "Failed to index document" }, 500);
  }
});

/**
 * GET /api/search/stats - Search statistics
 */
searchRoutes.get("/stats", requireAdminRole, async (c) => {
  try {
    const [vectorCount, tableInfo] = await Promise.all([
      db.execute<{ count: number }>(sql`SELECT COUNT(*) as count FROM vector_documents`),
      db.execute<{ tablename: string; hassearch: boolean }>(sql`
        SELECT 
          tablename,
          EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE tablename = c.relname AND indexdef LIKE '%gin%'
          ) as hassearch
        FROM pg_tables t
        JOIN pg_class c ON c.relname = t.tablename
        WHERE schemaname = 'public'
      `),
    ]);

    return c.json({
      vectorDocuments: vectorCount.rows[0]?.count || 0,
      indexedTables: tableInfo.rows.filter((r) => r.hassearch).map((r) => r.tablename),
    });
  } catch (error) {
    return c.json({ error: "Failed to get stats" }, 500);
  }
});

/**
 * POST /api/search/init - Initialize search (setup)
 */
searchRoutes.post("/init", requireAdminRole, async (c) => {
  try {
    await initializeSearchExtensions();
    await createVectorTable();

    return c.json({ success: true, message: "Search initialized successfully" });
  } catch (error) {
    console.error("Init error:", error);
    return c.json({ error: "Failed to initialize search" }, 500);
  }
});
