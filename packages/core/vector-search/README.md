# @kitsuden/vector-search

Embedding helpers and a per-dataset vector-search router for Kitsuden.

## Status

- **Embeddings (in use).** `embeddings.ts` exports `generateEmbedding`, `generateEmbeddings`,
  `isEmbeddingAvailable` and `getEmbeddingStatus`. The API uses them for the code graph's
  semantic search (`GET /api/code-graph/semantic`) and for the LLM response cache.
- **Per-dataset router (not mounted).** `routes.ts` exports `vectorSearchRoutes`, a Hono router
  with the endpoints below, and `schema.ts` defines the `vector_index` and `vector_chunks`
  tables behind it. The API does not mount this router, and the core migration runner
  skips this package's SQL migration on purpose. Treat it as reference code until it is wired in.

## Endpoints (in `vectorSearchRoutes`)

| Method | Endpoint                                     | Description         |
| ------ | -------------------------------------------- | ------------------- |
| POST   | `/datasets/:datasetId/vector-search`         | Semantic search     |
| POST   | `/datasets/:datasetId/vector-index`          | Index content       |
| DELETE | `/datasets/:datasetId/vector-index/:entryId` | Remove from index   |
| GET    | `/datasets/:datasetId/vector-status`         | Index stats         |
| POST   | `/vector-search/global`                      | Search all datasets |

Search body: `{ "query": "...", "limit": 10, "threshold": 0.7, "fields": ["description"] }`.

## Tables (in `schema.ts`)

### vector_index

| Column     | Type         | Description     |
| ---------- | ------------ | --------------- |
| dataset_id | varchar      | Source dataset  |
| entry_id   | uuid         | Source entry    |
| content    | text         | Indexed content |
| embedding  | vector(1536) | Embedding       |
| field_name | varchar      | Which field     |

### vector_chunks

For long documents (chunked):

| Column      | Type | Description  |
| ----------- | ---- | ------------ |
| index_id    | uuid | Parent index |
| content     | text | Chunk text   |
| chunk_index | int  | Position     |

## Configuration type

`index.ts` also exports the `VectorSearchExtension` interface and its defaults:

```typescript
interface VectorSearchExtension {
  enabled: boolean;
  fields: string[]; // Fields to index
  embeddingModel?: string; // Default: text-embedding-3-small
  dimensions?: number; // Default: 1536
  autoIndex?: boolean; // Index on create/update
  chunkSize?: number; // 2000 chars
  chunkOverlap?: number; // 200 chars
}
```

## Environment variables

```bash
OPENAI_API_KEY=sk-...  # Optional, for embeddings
```

Without an OpenAI key the helpers return zero vectors (for testing and development).
The `openai` package is an optional dependency, imported only when the key is set.
