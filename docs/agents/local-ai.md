# Local AI: embeddings, semantic search and a second opinion

Kitsuden uses small **utility** models, never a large LLM, for three things.
All three talk to a model server over HTTP, so the model runs wherever you want
(the same machine, a GPU box) and the API stays light. No Rust, no native
inference inside the API process.

## 1. Embeddings

`apps/api/src/services/embeddings.ts`, by priority:

| Setting                                                       | Provider                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDINGS_URL` (+ `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY`) | any **OpenAI-compatible** `/v1/embeddings` server: Hugging Face text-embeddings-inference, Infinity, llama.cpp server, Ollama's `/v1` |
| `OPENAI_API_KEY`                                              | OpenAI                                                                                                                                |
| `OLLAMA_BASE_URL`                                             | Ollama                                                                                                                                |
| none                                                          | a deterministic test vector (same text → same vector). Fine for tests, useless for real search                                        |

## 2. Semantic search in `defineModel`

```ts
defineModel({
  name: "article",
  description: "An article that can be searched by meaning.",
  fields: { title: field.text({ required: true }), body: field.longText() },
  access: { read: "public", write: "staff" },
  semantics: { fields: ["title", "body"], dimensions: 768 },
});
```

- `makemigrations` adds `embedding vector(768)` and an HNSW index (cosine).
- Every create/update queues the row's embedding on the Postgres queue, in the
  same transaction; the worker computes it with the provider above.
- The model gains `search-articles` (`GET /articles/search?q=&limit=`), with
  the same access policy and RLS as listing, and a `score` per row. It is a
  normal operation: REST, OpenAPI, MCP tool and typed SDK method.
- `dimensions` must match the model your provider serves (OpenAI small: 1536;
  `nomic-embed-text`: 768; `all-MiniLM-L6-v2`: 384). Changing it later clears
  the embeddings (the migration warns).

## 3. A prompt-injection classifier, as a second opinion

With `INJECTION_CLASSIFIER_URL`, every new **proposal** (human approval) is sent
in the background to a text classifier (`POST { "inputs": "<text>" }`, answer
`{ label, score }` or a Hugging Face list of them). The verdict is stored with
the proposal and the reviewer sees a warning in the panel when it looks like
an injection.

It is the **second** layer, never the first: it does not approve or reject
anything, because a classifier misses things. Human approval of sensitive
actions remains the defence.

## Example: a local embeddings server

```yaml
# docker-compose.local-ai.yml (not tested here; pick the image tag you trust)
services:
  embeddings:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-latest
    command: ["--model-id", "BAAI/bge-small-en-v1.5"] # 384 dimensions
    ports: ["127.0.0.1:8081:80"]
```

```dotenv
EMBEDDINGS_URL=http://127.0.0.1:8081
```

Measure before going further: if a local model is too slow on CPU, use a GPU
host for the model server rather than moving inference into the API.
