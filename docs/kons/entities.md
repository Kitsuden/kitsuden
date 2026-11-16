# Kon entities

A kon that needs a table writes a migration. A kon that needs a table whose
fields the installation decides (a CRM's custom objects, the extra fields of a
registration form) cannot: the columns are not known when the kon is written.

An entity is a dataset the kon owns. The kon declares it and the host creates it
at load, with no SQL:

```ts
export default defineKon({
  id: "kon-crm",
  entities: [
    {
      slug: "crm-vehicle",
      name: "Vehicle",
      fields: [
        { key: "plate", type: "text", required: true },
        { key: "year", type: "number" },
        { key: "fuel", type: "select", options: ["petrol", "diesel", "electric"] },
      ],
      access: { read: "authenticated", write: "admin" },
    },
  ],
});
```

Records are rows of `data_entries`, so an entity gets what every dataset has: the
dataset REST operations and MCP tools, row policies and per-dataset agent scopes
(`datasets:crm-vehicle:read`), [record history](../record-history.md), search,
snapshots and [reports](../reports.md).

## The declaration

|                               |                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slug`                        | The dataset slug: lower case letters, digits and `-`. Slugs are global, so prefix it with the kon's name.                                                                                                                                              |
| `name`, `description`, `icon` | For the panel.                                                                                                                                                                                                                                         |
| `fields`                      | `key`, `type`, and optionally `label`, `required`, `options`, `description`, `sensitivity`. `type` is a name from the field type registry (`text`, `textarea`, `number`, `boolean`, `date`, `datetime`, `select`, `multiselect`, `relation`, `json`…). |
| `access`                      | `read` and `write`: `admin` (default), `authenticated` or `public`.                                                                                                                                                                                    |

`sensitivity: "customer"` or `"personal"` marks a field for the
[egress guard](../agents/egress.md).

At every start the host creates the dataset or brings it up to date with the
declaration. **The declaration wins**: a field edited in the panel is put back at
the next start. Removing a field from the declaration stops validating it; the
values already stored are kept.

A kon never takes over a slug it does not own. If the slug belongs to a dataset
a person made, or to another kon, the entity is refused, the load log says so,
and the dataset is left alone.

A field keeps every other key the kon writes on it: the limits the field compiler
reads (`minValue`, `maxValue`, `minLength`, `maxLength`, `validationRegex`,
`showIf`) and keys of the kon's own.

`settings` is an object the kon keeps with the entity (numbering, a default
pipeline, flags). It is stored with the definition and returned by `describe`;
the core never reads it.

## Entities defined at runtime

Some entity types are not known when the kon is written: a person creates them
in the kon's settings ("Case", "Property", "Project"). Define those when they are
created:

```ts
await ctx.entities.define("kon-crm", {
  slug: "crm-case",
  name: "Case",
  fields: [{ key: "reference", type: "text", required: true, maxLength: 20 }],
  settings: { numbering: { prefix: "C-", next: 1 }, requiresContact: true },
});

const types = await ctx.entities.definitions("kon-crm");
await ctx.entities.undefine("kon-crm", "crm-case");
```

- `define` creates the entity or replaces its definition, and is persisted. An
  entity defined at runtime is not in the declaration, so a restart leaves it as
  it is.
- The first argument is the kon's own id. A kon defines, lists and removes only
  what it owns.
- `undefine` refuses while the entity has records, unless `{ withRecords: true }`
  is passed, which deletes them too.
- `define` and `undefine` write as the system: check that whoever is asking may
  change the kon's settings first.

### Values kept in the kon's own table

When the records already live in a table of the kon (a deal) and only its custom
field values follow the entity's fields, keep them in a `jsonb` column and check
them with `validate`:

```ts
const custom = await ctx.entities.validate("crm-case", input.customFields);
await db.update(deals).set({ customFields: custom }).where(eq(deals.id, id));
```

`validate` stores nothing. It returns the data as validated, or throws
`KonEntityValidationError`.

## Reading and writing: `ctx.entities`

```ts
const car = await ctx.entities.create("crm-vehicle", {
  title: "Ana's car",
  data: { plate: "ABC-123", year: 2021 },
  ownerId: user.id,
});

await ctx.entities.update("crm-vehicle", car.id, { data: { year: 2022 } });
const cars = await ctx.entities.list("crm-vehicle", { where: { plate: "ABC-123" } });
const one = await ctx.entities.get("crm-vehicle", car.id);
await ctx.entities.remove("crm-vehicle", car.id);
```

- **Every write is validated** against the declared fields. A write that breaks
  them throws `KonEntityValidationError`, with one message per field in
  `issues`. The dataset REST operations store whatever `data` they are given;
  `ctx.entities` is the door that validates.
- `update` merges `data` into what is stored and validates the whole record. A
  key set to `null` is cleared.
- Keys that are not declared are kept as they are.
- `list` takes equality filters on fields of `data`, `limit` (at most 500) and
  `offset`. For anything richer, use the dataset query operations or a report.
- `describe(slug)` returns the definition as stored, or `null`.
- Writes go to the record history and emit `entry:created`, `entry:updated` and
  `entry:deleted`, like any dataset entry.

`ctx.entities` reaches only datasets a kon declared, never a person's.

### Who is writing

Calls run on the request's connection: inside a kon's route that is whoever is
asking, and the row policies of `data_entries` apply. Outside a request (a rule's
step, a startup hook) it is the system. Check your own permission first, as for
any table.

`ctx.entities` is optional: it is absent when the datasets battery is not
installed.

## Extra fields on your own table

When the records already live in a table of the kon and only some fields are
custom, keep a `jsonb` column for them and validate with the same compiler:

```ts
import { validateAgainstFields } from "@kitsuden/engine";

const result = validateAgainstFields(fieldDefinitions, input.custom);
if (!result.success) throw AppError.validation("Invalid custom fields", result.error.issues);
```

Store the field definitions wherever the kon keeps its settings.

## Limits

- An entity is one dataset: there are no joins between entities. Relate records
  with a `relation` field or with [links](links.md).
- Fields are not indexed automatically; an administrator adds indexes from the
  dataset's index operations.
- There are no per-field permissions.
