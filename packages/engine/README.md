# @kitsuden/engine - Core Framework

Level 1 of the Kitsuden framework: the engine that cannot be switched off.
It is a private workspace package, not published to npm.

## Modules

### 1. Actions Layer (`src/actions.ts`)

A unified action system. One action can run through HTTP, events or MCP agents.

```typescript
import { defineAction } from "@kitsuden/engine/actions";

defineAction({
  trigger: "http.post:/webhooks/stripe",
  run: async ({ payload, db }) => ({ processed: true }),
});
```

### 2. Kon System (`src/kon.ts`)

Auto-API and MCP generator: it turns Drizzle models into REST APIs and MCP tools.

```typescript
import { defineKon, InferKonSelect } from "@kitsuden/engine/kon";
import { myTable } from "./schema";

type MyRow = InferKonSelect<typeof myTable>;

const kon = defineKon({
  id: "my-kon",
  models: [myTable],
  actions: [
    {
      trigger: "http.post:/custom",
      run: async ({ payload }) => ({ success: true }),
    },
  ],
});

kon.initialize(ctx, hono, mcpServer);
```

## Conventions

### Auto-generated routes

For every model:

```
GET    /api/{kon}/{table}       # List
POST   /api/{kon}/{table}       # Create
GET    /api/{kon}/{table}/:id   # Read
PATCH  /api/{kon}/{table}/:id   # Update
DELETE /api/{kon}/{table}/:id   # Delete
```

### Auto-generated MCP tools

For every model:

```
{kon}_read_{table}     # Query with filters
{kon}_create_{table}   # Create a record
```

## Type checking

The engine is type-checked with the rest of the monorepo:

```bash
pnpm typecheck:root
```

## Exports

### Actions

- `defineAction()` - define an action
- `initActions()` - initialize the system
- `parseTrigger()` - parse a trigger string

### Kon

- `defineKon()` - define a kon
- `registerKon()` - register it globally
- `initializeKons()` - initialize all of them
- `InferKonSelect<T>` - infer the Select type
- `InferKonInsert<T>` - infer the Insert type
