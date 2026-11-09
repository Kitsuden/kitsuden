/**
 * Vector Search Schema — Unified vector storage for all datasets
 *
 * Replaces: ai-memories kon tables
 * Schema: Single table stores vectors from ANY dataset
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
  vector,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Vector Index — Stores embeddings for dataset entries
 * One row per entry that has vector search enabled
 */
export const vectorIndexTable = pgTable(
  "vector_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Reference to source
    datasetId: varchar("dataset_id", { length: 255 }).notNull(),
    entryId: uuid("entry_id").notNull(),

    // Content that was indexed
    content: text("content").notNull(),

    // Vector embedding
    embedding: vector("embedding", { dimensions: 1536 }),

    // Metadata
    model: varchar("model", { length: 100 }).default("text-embedding-3-small"),
    fieldName: varchar("field_name", { length: 255 }), // Which field was indexed

    // Optional: chunk tracking for long content
    isChunked: integer("is_chunked").default(0),
    totalChunks: integer("total_chunks").default(1),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),

    // Expiration (optional TTL)
    expiresAt: timestamp("expires_at"),

    // Flexible metadata
    metadata: jsonb("metadata")
      .$type<{
        source?: string;
        tags?: string[];
        [key: string]: any;
      }>()
      .default({}),
  },
  (table) => ({
    // Index for fast dataset+entry lookups
    datasetEntryIdx: index("vector_index_dataset_entry_idx").on(table.datasetId, table.entryId),
    // IVFFlat index for vector similarity search
    embeddingIdx: index("vector_index_embedding_idx").using(
      "ivfflat",
      table.embedding.op("vector_cosine_ops")
    ),
    // Index for expiration cleanup
    expiresAtIdx: index("vector_index_expires_at_idx").on(table.expiresAt),
  })
);

/**
 * Vector Chunks — For long documents split into chunks
 */
export const vectorChunksTable = pgTable(
  "vector_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Reference to parent index
    indexId: uuid("index_id")
      .notNull()
      .references(() => vectorIndexTable.id, { onDelete: "cascade" }),

    // Chunk content
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),

    // Position tracking
    chunkIndex: integer("chunk_index").notNull(), // Position in document
    totalChunks: integer("total_chunks").notNull(),
    charOffset: integer("char_offset"), // Position in original text

    // Metadata for this chunk
    metadata: jsonb("metadata").default({}),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    indexIdIdx: index("vector_chunks_index_id_idx").on(table.indexId),
    embeddingIdx: index("vector_chunks_embedding_idx").using(
      "ivfflat",
      table.embedding.op("vector_cosine_ops")
    ),
  })
);

// Types
export type VectorIndex = typeof vectorIndexTable.$inferSelect;
export type VectorIndexInsert = typeof vectorIndexTable.$inferInsert;
export type VectorChunk = typeof vectorChunksTable.$inferSelect;
export type VectorChunkInsert = typeof vectorChunksTable.$inferInsert;

// Search result type
export interface VectorSearchResult {
  entryId: string;
  datasetId: string;
  content: string;
  similarity: number;
  fieldName?: string;
  metadata?: Record<string, unknown>;
  chunks?: VectorChunk[];
}

// Index status for a dataset
export interface DatasetVectorStatus {
  datasetId: string;
  totalIndexed: number;
  lastIndexedAt?: Date;
  fields: string[];
  model: string;
  isEnabled: boolean;
}
