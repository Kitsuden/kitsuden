# Extensible DataExplorer

Generic data exploration system for the Kitsuden admin, with extensible field types and calculated fields.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  DataExplorer.svelte (main component)                           │
│  ├── Props: table, config, apiEndpoint, data                    │
│  ├── Features: search, filters, sorting, pagination             │
│  └── Render: fieldRegistry.get(type) → component                │
├─────────────────────────────────────────────────────────────────┤
│  Field Registry (fieldRegistry.ts)                              │
│  ├── Map<type, Component>                                       │
│  ├── Calculated fields                                          │
│  └── Helpers: count, sum, avg, timeAgo, currency...             │
├─────────────────────────────────────────────────────────────────┤
│  Field components                                               │
│  ├── TextField.svelte                                           │
│  ├── NumberField.svelte                                         │
│  ├── BooleanField.svelte                                        │
│  ├── DateField.svelte                                           │
│  ├── StatusBadgeField.svelte                                    │
│  └── CalculatedField.svelte                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Basic use

```svelte
<script>
  import DataExplorer from "$lib/components/DataExplorer.svelte";

  const config = {
    table: "blog_posts",
    label: "Blog Posts",
    columns: [
      { field: "title", label: "Title", fieldConfig: { type: "text" } },
      { field: "status", label: "Status", fieldConfig: { type: "status-badge" } },
    ],
    searchableFields: ["title"],
    filterableFields: ["status"],
  };
</script>

<DataExplorer table="blog_posts" {config} apiEndpoint="/api/blog" />
```

## Calculated fields

### Option 1: frontend (JavaScript)

```typescript
{
  field: "readingTime",
  label: "Read Time",
  fieldConfig: {
    type: "calculated",
    options: {
      calculate: (row) => {
        const words = String(row.content).split(/\s+/).length;
        return Math.ceil(words / 200) + " min";
      }
    }
  }
}
```

### Option 2: backend (API)

```typescript
// In the API response
{
  docs: posts.map((p) => ({
    ...p,
    readingTime: calculateReadingTime(p.content), // Backend
  }));
}
```

### Option 3: declarative configuration

```json
{
  "fields": {
    "readingTime": {
      "type": "calculated",
      "backend": true,
      "expression": "CEIL(LENGTH(content) / 1200)"
    }
  }
}
```

## Available field types

| Type           | Description      | Options                  |
| -------------- | ---------------- | ------------------------ |
| `text`         | Simple text      | maxLength, placeholder   |
| `number`       | Number           | min, max, step           |
| `boolean`      | Checkbox         | —                        |
| `date`         | Date             | format                   |
| `datetime`     | Date and time    | format                   |
| `status-badge` | Colored badge    | colors: { value: class } |
| `select`       | Select           | choices: [...]           |
| `calculated`   | Calculated value | calculate, format        |

## Registering custom types

```typescript
import { fieldRegistry } from "$lib/data-explorer/fieldRegistry";
import MyCustomField from "./MyCustomField.svelte";

fieldRegistry.register("my-type", MyCustomField);
```

## Calculation helpers

```typescript
import { calculatedHelpers } from "$lib/data-explorer/fieldRegistry";

calculatedHelpers.count(array);
calculatedHelpers.sum(array, "field");
calculatedHelpers.avg(array, "field");
calculatedHelpers.timeAgo(date);
calculatedHelpers.dateFormat(date, "YYYY-MM-DD");
calculatedHelpers.currency(value, "USD");
calculatedHelpers.get(obj, "path.nested");
```

## Presets

```typescript
import { fieldPresets } from "$lib/data-explorer/fieldRegistry";

// Status with colors
fieldPresets.status({ active: "green", inactive: "gray" });

// Relation
fieldPresets.relation("users", "name");

// Media
fieldPresets.media({ crop: true, aspectRatio: "16:9" });

// Count (calculated)
fieldPresets.count("comments", "Comments");

// Relative time (calculated)
fieldPresets.timeAgo("createdAt", "Age");
```

## Where do calculated fields go?

| Location        | When to use                  | Example                          |
| --------------- | ---------------------------- | -------------------------------- |
| **Backend**     | Heavy data, SQL aggregations | `COUNT(*)`, `SUM(amount)`        |
| **Frontend**    | Simple transformations, UX   | `timeAgo`, concatenating strings |
| **Declarative** | Configuration without code   | `expression: "field1 + field2"`  |

### Rule of thumb:

- **Backend**: when you need data from other tables or aggregations
- **Frontend**: when it is pure presentation or transformation
- **Declarative JSON**: when it should be configurable without code
