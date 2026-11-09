# @kitsuden/sdk

Official JavaScript/TypeScript SDK for Kitsuden — The Modular BaaS/CMS.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔥 **Edge-Ready** — Works in Cloudflare Workers, Vercel Edge, Deno Deploy
- 📝 **Type-Safe** — Full TypeScript support with generic table types
- 🚀 **Zero Dependencies** — Lightweight, only uses native `fetch` and `WebSocket`
- ⚡ **Lean on the wire** — reads TOON and lets the server pick the shorter of compact JSON / TOON per response
- 🔒 **Secure** — Agent NHI tokens (`kitsuden_agent_*`) + Bearer auth
- 🔄 **Real-time** — Live Query subscriptions via WebSocket

## Installation

`@kitsuden/sdk` is **not published on npm**. Use it from the Kitsuden
monorepo: inside the workspace, depend on it with `"@kitsuden/sdk": "workspace:*"`
and build it with `pnpm --filter @kitsuden/sdk build`. Outside the monorepo,
build it and install the folder (or a `pnpm pack` tarball) by path.

## Typed client: 5 lines to your first call

Generated from the API's OpenAPI 3.1 (every `defineOperation` of the installed kons and
the core: 700+ operations, one property per kon). Set `KITSUDEN_API_URL` (the API origin)
and `KITSUDEN_API_TOKEN` (`kitsuden_agent_…`):

```typescript
import { createKitsuden } from "@kitsuden/sdk";

const kitsuden = createKitsuden();
const res = await kitsuden.datasets.listDatasets({ limit: 5 });
if (res.kind === "ok") console.log(res.data.docs.map((d) => d.name));
```

- Typed arguments (path and query flat, body under `body`: the MCP tool's shape) and typed
  responses; `KitsudenErrorCode` is the closed union of `KITSUDEN_E_*` codes.
- `202 KITSUDEN_E_APPROVAL_REQUIRED` comes back as `{ kind: "proposal_pending", proposal }`,
  never retried.
- Automatic `Idempotency-Key` on writes; retries only when safe, honouring `Retry-After`.
- `format: "json" | "toon" | "tron" | "auto"`, always decoded; `provenance: true` gives
  `meta.provenance` and `provenanceOf(row)`.
- `kitsuden.datasets.searchEntries.iterate({ id, limit: 50 })` walks every page.
- Streaming operations (`output.flow` on the server) return a typed `AsyncIterable`:
  `for await (const event of kitsuden.proposals.proposalEvents({ id })) …`. Standard Server-Sent
  Events underneath (no custom protocol); `event: error` throws `KitsudenApiError`, and
  breaking out of the loop aborts the request.
- Validate before sending with any Standard Schema consumer (Zod, Valibot, ArkType, form
  libraries): `operationSchemas(spec, "datasets.create-dataset").body` turns the operation's
  JSON Schema into a Standard Schema v1 validator; the spec ships as
  `@kitsuden/sdk/openapi.json`. `toStandardSchema(jsonSchema)` does it for any schema.
- Zero runtime dependencies: Node 18+, Bun, Deno and browsers.

Full guide: [docs/agents/clients.md](../../docs/agents/clients.md). Regenerate after an API
change with `pnpm sdk:openapi && pnpm sdk:generate` (CI runs `pnpm sdk:check`), or keep
`pnpm sdk:watch` running: it regenerates on every change to a `defineModel` or
`defineOperation` (about 3 s) and only rewrites the files that changed, so your editor
picks up the new types at once.

## Quick Start (CRUD helpers)

```typescript
import { KitsudenClient } from "@kitsuden/sdk";

const kitsuden = new KitsudenClient({
  url: "https://api.example.com",
  apiKey: "kitsuden_agent_your_agent_token",
});

// Explorer API — primary way to interact with data
const recipes = await kitsuden.from("recipes").list();
const recipe = await kitsuden.from("recipes").get("uuid-123");
const newRecipe = await kitsuden.from("recipes").create({ title: "New recipe" });
await kitsuden.from("recipes").update(newRecipe.id, { status: "published" });
await kitsuden.from("recipes").delete(newRecipe.id);
```

## Usage

### Initialize Client

```typescript
import { KitsudenClient } from "@kitsuden/sdk";

const kitsuden = new KitsudenClient({
  url: "https://api.example.com",
  // Optional: Agent NHI token for authentication
  apiKey: process.env.KITSUDEN_API_KEY,
});
```

### CRUD via Explorer API (Recommended)

The `.from(table)` method returns a `TableRef` with full CRUD capabilities:

#### List with pagination, sorting, and filtering

```typescript
const recipes = await kitsuden.from("recipes").list();
console.log(recipes.data); // Array of records
console.log(recipes.pagination); // { page, limit, total, totalPages, hasNextPage, hasPrevPage }

// With options
const filtered = await kitsuden.from("recipes").list({
  limit: 10,
  page: 1,
  sort: "title",
  dir: "asc",
  filter_field: "status",
  filter_op: "equals",
  filter_value: "published",
});
```

#### Get by ID

```typescript
const recipe = await kitsuden.from("recipes").get("uuid-123");
```

#### Create

```typescript
const newRecipe = await kitsuden.from("recipes").create({
  title: "Lemon tart",
  slug: "lemon-tart",
  tags: ["dessert", "baking"],
});
```

#### Update

```typescript
await kitsuden.from("recipes").update("uuid-123", {
  status: "published",
});
```

#### Delete

```typescript
await kitsuden.from("recipes").delete("uuid-123");
```

#### Dropdown options (for foreign keys)

```typescript
const categories = await kitsuden.from("categories").options();
// [{ value: 'uuid-1', label: 'Desserts' }, ...]
```

### TypeScript Support

```typescript
interface Recipe {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  tags: string[];
  createdAt: string;
}

// Type-safe table reference
const recipes = kitsuden.from<Recipe>("recipes");
const allRecipes = await recipes.list();
// allRecipes.data is typed as Recipe[]
```

### Schema Introspection

```typescript
// Get column types, editability, and relations for a table
const schema = await kitsuden.schema("recipes");
console.log(schema.columns);
// [{ name: 'title', type: 'text', editable: true, nullable: false }, ...]

// List all available tables
const tables = await kitsuden.tables();
// [{ key: 'recipes', label: 'Recipes', icon: 'book', rowCount: 42 }, ...]
```

### Module Management

```typescript
// List all kons (modules)
const modules = await kitsuden.modules.list();

// Toggle a kon on/off
await kitsuden.modules.toggle("academy");

// Get only enabled modules
const enabled = await kitsuden.modules.enabled();
```

### Wire formats: JSON, TOON, auto

The SDK always returns plain objects; `format` only changes what travels over
the wire:

- `"json"` (default): compact JSON.
- `"toon"`: [TOON](https://toonformat.dev). Shorter than JSON for flat, uniform
  lists (categories, tags, page lists); **longer** for nested records such as
  dataset entries. Measured numbers: `docs/agents/benchmarks.md` in the
  Kitsuden repository.
- `"auto"`: the server encodes each response as compact JSON and as TOON,
  checks that the TOON version decodes back to exactly the same data, and
  sends the shorter one (`Content-Type` says which).

```typescript
const agent = new KitsudenClient({
  url: "https://api.example.com",
  apiKey: "kitsuden_agent_xxx",
  format: "auto",
});

const recipes = await agent.from("recipes").list(); // same objects as with "json"
```

The TOON codec is exported too: `import { encodeToon, decodeToon } from "@kitsuden/sdk"`.
The API can also answer in TRON (`Accept: application/vnd.tron`); the SDK does
not decode TRON, to stay dependency-free.

### Error Handling

```typescript
import { KitsudenClient, KitsudenError } from "@kitsuden/sdk";

try {
  const recipes = await kitsuden.from("recipes").list();
} catch (error) {
  if (error instanceof KitsudenError) {
    console.error(`HTTP ${error.statusCode}:`, error.message);
  } else {
    console.error("Network or unknown error:", error);
  }
}
```

### Real-time Subscriptions

```typescript
import { createRealtime } from "@kitsuden/sdk/realtime";

const rt = createRealtime("https://api.example.com");

rt.onStateChange((state) => {
  console.log("Connection:", state); // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
});

await rt.connect();

// Subscribe to dataset changes
const unsub = rt.subscribeToDataset("recipes-dataset-id", (event) => {
  console.log("Change:", event.event, event.entry);
});

// Presence (who's online)
rt.joinRoom("editor:doc-123");
rt.onPresence("editor:doc-123", (users) => {
  console.log("Online users:", users);
});

// Cleanup
unsub();
rt.disconnect();
```

### Health Check

```typescript
const healthy = await kitsuden.ping();
console.log("API is", healthy ? "up" : "down");
```

## Edge Runtime Support

Works in all edge runtimes with zero dependencies:

```typescript
// Cloudflare Workers
export default {
  async fetch(request: Request, env: Env) {
    const kitsuden = new KitsudenClient({
      url: env.KITSUDEN_URL,
      apiKey: env.KITSUDEN_API_KEY,
    });

    const recipes = await kitsuden.from("recipes").list();
    return Response.json(recipes);
  },
};

// Vercel Edge
export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const kitsuden = new KitsudenClient({
    url: process.env.KITSUDEN_URL!,
    apiKey: process.env.KITSUDEN_API_KEY,
  });

  const recipes = await kitsuden.from("recipes").list();
  return new Response(JSON.stringify(recipes));
}
```

## Configuration Options

```typescript
interface KitsudenClientConfig {
  /** Base URL of your Kitsuden API */
  url: string;
  /** Agent NHI token for authentication (optional) */
  apiKey?: string;
  /** Wire format: 'json' (default), 'toon' or 'auto' */
  format?: "json" | "toon" | "auto";
}
```

## API Reference

### KitsudenClient

Main class for interacting with Kitsuden API.

#### `new KitsudenClient(config)`

Creates a new client instance.

#### `from<T>(table: string): TableRef<T>`

Returns a table reference for Explorer-based CRUD operations. **This is the recommended API.**

#### `schema(table: string): Promise<SchemaInfo>`

Returns column definitions, types, and relation info for a table.

#### `tables(): Promise<TableListItem[]>`

Lists all available tables with metadata.

#### `collection<T>(name: string): CollectionRef<T>`

Legacy Dataset API (backward compatibility). Use `.from()` for new code.

#### `ping(): Promise<boolean>`

Health check — returns `true` if the API is reachable.

### TableRef

Primary CRUD interface. Returned by `.from(table)`.

| Method    | Signature                                             | Description                        |
| --------- | ----------------------------------------------------- | ---------------------------------- |
| `list`    | `(options?: ListOptions) => Promise<ListResponse<T>>` | List with pagination, sort, filter |
| `get`     | `(id: string) => Promise<T>`                          | Get single record by ID            |
| `create`  | `(data: Partial<T>) => Promise<T>`                    | Create new record                  |
| `update`  | `(id: string, data: Partial<T>) => Promise<T>`        | Update existing record             |
| `delete`  | `(id: string) => Promise<void>`                       | Delete record                      |
| `options` | `() => Promise<OptionItem[]>`                         | Get dropdown options for FKs       |

### KitsudenError

```typescript
class KitsudenError extends Error {
  statusCode: number; // HTTP status code
}
```

## Examples

### Next.js App Router

```typescript
// app/recipes/page.tsx
import { KitsudenClient } from '@kitsuden/sdk';

const kitsuden = new KitsudenClient({
  url: process.env.KITSUDEN_URL!,
  apiKey: process.env.KITSUDEN_API_KEY
});

export default async function RecipesPage() {
  const recipes = await kitsuden.from('recipes').list({ limit: 10 });

  return (
    <ul>
      {recipes.data.map(recipe => (
        <li key={recipe.id}>{recipe.title}</li>
      ))}
    </ul>
  );
}
```

### Astro

```typescript
---
import { KitsudenClient } from '@kitsuden/sdk';

const kitsuden = new KitsudenClient({
  url: import.meta.env.KITSUDEN_URL,
  apiKey: import.meta.env.KITSUDEN_API_KEY
});

const recipes = await kitsuden.from('recipes').list();
---

<ul>
  {recipes.data.map(recipe => (
    <li>{recipe.title}</li>
  ))}
</ul>
```

### SvelteKit

```typescript
// +page.ts
import { KitsudenClient } from "@kitsuden/sdk";

const kitsuden = new KitsudenClient({
  url: import.meta.env.VITE_KITSUDEN_URL,
  apiKey: import.meta.env.VITE_KITSUDEN_API_KEY,
});

export async function load() {
  const recipes = await kitsuden.from("recipes").list();
  return { recipes };
}
```

## License

MIT © Kitsuden Contributors

## Links

- [GitHub](https://github.com/Kitsuden/kitsuden)
- [Issues](https://github.com/Kitsuden/kitsuden/issues)

---

Made with ❤️ by the Kitsuden contributors
