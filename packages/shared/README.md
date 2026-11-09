# @kitsuden/shared

Shared types, schemas, and utilities for Kitsuden: the kon API (`defineKon`, `defineOperation`, `defineModel`), the error catalogue, permission and approval contracts, Zod schemas and small helpers.

## Installation

`@kitsuden/shared` is **not published on npm yet**. It is a workspace package of
the Kitsuden monorepo (`"@kitsuden/shared": "workspace:*"`). `pnpm install`
at the root builds it (its `prepare` script uses Bun); after changing
`src/`, rebuild it with `pnpm --filter @kitsuden/shared build`.

## Usage

Everything is exported from the package root (`exports` has a single entry point).

### Types

```typescript
import type { DataSet, DataEntry, Game, BlogPost, SiteSettings } from "@kitsuden/shared";
```

### Schemas (Zod)

```typescript
import { safeValidateDataset } from "@kitsuden/shared";

// Validate data without throwing
const result = safeValidateDataset(data);
if (result.success) {
  console.log("Valid:", result.data);
} else {
  console.error("Invalid:", result.error);
}
```

`validateDatasetDefinition(data)` does the same but throws a `ZodError`.

### Utilities

```typescript
import { formatDate, truncate, buildCmsUrl, gameJsonLd } from "@kitsuden/shared";

const formatted = formatDate(new Date());
const excerpt = truncate(longText, 100);
const structuredData = gameJsonLd(game);
```

### Constants

```typescript
import { SITE_CONFIG, BREAKPOINTS, NEON_COLORS } from "@kitsuden/shared";
```

## Exports

| Export Path                     | Description                             |
| ------------------------------- | --------------------------------------- |
| `@kitsuden/shared`              | Types, schemas, utilities and constants |
| `@kitsuden/shared/package.json` | The package manifest                    |

## License

MIT © Kitsuden Contributors
