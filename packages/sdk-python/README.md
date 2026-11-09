# kitsuden (Python)

Official Python client for **Kitsuden**, the self-hosted, AI-native backend
framework. This package is the twin of `@kitsuden/sdk` (TypeScript): same
endpoints, same names, same semantics.

```bash
pip install kitsuden          # not on PyPI yet: pip install ./packages/sdk-python
```

Its only dependency is `httpx`, on purpose: an SDK that drags in half of PyPI
causes conflicts in the user's project.

## Typed client: 5 lines to your first call

Generated from the API's OpenAPI 3.1 (every `defineOperation` of the installed kons and
the core: one attribute per kon, one method per operation), sync and async, with
`py.typed`. Set `KITSUDEN_API_URL` (the API origin) and `KITSUDEN_API_TOKEN`
(`kitsuden_agent_…`):

```python
from kitsuden import KitsudenApi

kitsuden = KitsudenApi()
res = kitsuden.datasets.list_datasets(limit=5)
if res.ok: print([d["name"] for d in res.data["docs"]])
```

Async, same contract:

```python
async with AsyncKitsudenApi() as kitsuden:
    res = await kitsuden.datasets.list_datasets(limit=5)
```

- Keyword arguments (path and query in snake*case, the body as `body=`), `TypedDict`
  bodies and responses, `KitsudenErrorCode` as a `Literal` of every `KITSUDEN_E*\*` code.
- `202 KITSUDEN_E_APPROVAL_REQUIRED` is returned as `ProposalPending` (with `proposal`),
  never retried; `expect_ok(res)` raises `ProposalPendingError` instead.
- Automatic `Idempotency-Key` on writes; retries only when safe, honouring `Retry-After`
  (`RetryPolicy`, or `retry=False`).
- `format="json" | "toon" | "tron" | "auto"`, always decoded;
  `RequestOptions(provenance=True)` gives `res.meta.provenance` and `provenance_of(row)`.
- `kitsuden.datasets.iter_search_entries(id=dataset_id, limit=50)` walks every page (`async for` in async).
- Errors: `KitsudenApiError` (`code`, `status`, `problem`, `retry_after`, `request_id`),
  `KitsudenNetworkError`, `KitsudenDecodeError`; all are `KitsudenError`.

Why dataclasses and `TypedDict`, not pydantic: `httpx` stays the only dependency, a
response is the `dict` the API sent (unknown fields kept), and type checkers still see every
field. Full guide: [docs/agents/clients.md](../../docs/agents/clients.md).

Tests: `pnpm test:sdk:py` (mocked server) and `pnpm test:sdk:integration` (a live API).

## Usage (CRUD client, predates the typed client)

```python
from kitsuden import KitsudenClient

client = KitsudenClient("http://localhost:3001", api_key="kitsuden_sk_...")

# CRUD on any exposed table (core, kon or dataset)
page = client.table("recipes").list(limit=10, sort="createdAt", dir="desc")
for recipe in page:
    print(recipe["title"])

recipe = client.table("recipes").create({"title": "Lemon tart"})
client.table("recipes").update(recipe["id"], {"title": "Lemon meringue tart"})
client.table("recipes").delete(recipe["id"])

# Dynamic collections (datasets) by slug
books = client.collection("reading-list")
books.insert({"title": "Dune", "year": "1965"})
print(books.entries(limit=5).data)

# Semantic search
hits = client.vector_search("dataset-id", "novels about desert planets", limit=5)

# Tree retrieval: sections WITH their citation ("Guide > Part 3 > Baking")
index = client.tree_index(doc_markdown, title="Guide")
result = client.tree_retrieve(doc_markdown, "how long do I bake the tart?")
```

## Async

Same contract, with `await` in front. Meant for agents and async-first services:

```python
from kitsuden import AsyncKitsudenClient

async with AsyncKitsudenClient(url, api_key=key) as client:
    page = await client.table("recipes").list()
```

## Response formats: JSON, TOON, auto

The client always returns dicts and lists; `format` only changes what travels over the wire:

- `"json"` (default): compact JSON.
- `"toon"`: [TOON](https://toonformat.dev). Shorter than JSON for flat, uniform
  lists (categories, tags, page lists) and **longer** for nested records such as
  dataset entries. Measured numbers: `docs/agents/benchmarks.md` in the
  Kitsuden repository.
- `"auto"`: the API encodes each response as compact JSON and as TOON, checks
  that the TOON decodes back to exactly the same data, and sends the shorter one.

```python
client = KitsudenClient(url, api_key=key, format="auto")
```

Writes always travel as JSON (`format` is a response format). The decoder is
exposed: `from kitsuden import decode_toon`.

## Errors

```python
from kitsuden import KitsudenError

try:
    client.table("recipes").get("nope")
except KitsudenError as e:
    print(e.status)     # 404
    print(e.payload)    # raw envelope, to decide programmatically
```

## How it fits with the rest of Kitsuden

| You want to...                    | Use                                          |
| --------------------------------- | -------------------------------------------- |
| Consume data from Python          | **this SDK**                                 |
| Let an LLM agent operate Kitsuden | the **MCP server** (`@kitsuden/mcp-server`)  |
| Extend Kitsuden with Python logic | a **bridge service** over webhooks or queues |
| Write kons                        | TypeScript: the framework lives there        |

## Tests

No network and no server: `httpx.MockTransport` checks the literal contract
(paths, headers, error envelope, TOON).

```bash
python -m pytest tests/
```
