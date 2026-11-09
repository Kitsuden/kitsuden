/**
 * @kitsuden/core/vector-search — Vector Search Extension for Datasets
 *
 * MIGRATED from: packages/kons/ai-memories
 * Date: 2026-03-19
 *
 * Transforms AI Memories from standalone Kon into a Dataset Extension.
 * Any dataset can enable vector search on specific fields.
 *
 * Usage:
 * ```typescript
 * // In dataset definition
 * {
 *   name: "products",
 *   fields: [...],
 *   extensions: {
 *     vectorSearch: {
 *       enabled: true,
 *       fields: ["description", "content"],
 *       embeddingModel: "text-embedding-3-small"
 *     }
 *   }
 * }
 * ```
 *
 * Auto-generated endpoints:
 * - POST /api/datasets/:id/vector-index — Index content
 * - POST /api/datasets/:id/vector-search — Semantic search
 * - GET /api/datasets/:id/vector-status — Index status
 *
 * @version 1.0.0
 * @since 0.8.0
 * @migrationFrom ai-memories
 */

// @ts-ignore - Hono imported for type re-export
// @ts-ignore - Imported for type re-export

// Re-export for core integration
export { vectorSearchRoutes } from "./routes";
export {
  vectorIndexTable,
  vectorChunksTable,
  type VectorIndex,
  type VectorChunk,
  type VectorSearchResult,
  type DatasetVectorStatus,
} from "./schema";

// Re-export embedding utilities
export {
  generateEmbedding,
  generateEmbeddings,
  isEmbeddingAvailable,
  getEmbeddingStatus,
  type EmbeddingOptions,
} from "./embeddings";

// Re-export config types (declared below)

// Extension configuration interface
export interface VectorSearchExtension {
  enabled: boolean;
  fields: string[]; // Which fields to index
  embeddingModel?: string; // Default: text-embedding-3-small
  dimensions?: number; // Default: 1536
  autoIndex?: boolean; // Index on create/update
  chunkSize?: number; // For long text: 2000
  chunkOverlap?: number; // For long text: 200
}

// Extension metadata for core registry
export const vectorSearchMetadata = {
  id: "vector-search",
  name: "Vector Search",
  description: "Semantic search with embeddings for any dataset",
  version: "1.0.0",
  features: ["semantic-search", "auto-embeddings", "document-chunking", "similarity-scoring"],
};

// Default configuration
export const defaultVectorSearchConfig: Partial<VectorSearchExtension> = {
  embeddingModel: "text-embedding-3-small",
  dimensions: 1536,
  autoIndex: true,
  chunkSize: 2000,
  chunkOverlap: 200,
};
