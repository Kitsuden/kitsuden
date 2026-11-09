# Your first model in five minutes

From nothing to a model with REST, OpenAPI, MCP tools, an admin view and a
typed SDK method. Each step says what you get.

> This runs from a clone of the repository (`pnpm install`, Postgres up, and
> the CLI built once: `pnpm --filter @kitsuden/cli build`). Nothing is published
> to npm or a container registry yet, so there is no one-command project outside
> a clone. See [Getting started](README.md#1-start).

## 1. A kon to hold it (30 s)

```bash
pnpm kitsuden make kon notes
```

A kon is a feature package: `packages/kons/kon-notes/` with its router, an
access policy and a test. You only need the folder; the model goes next.

## 2. The model (1 min)

```bash
pnpm kitsuden make model note --kon notes
```

Edit `packages/kons/kon-notes/src/note.model.ts`: three fields and who can
read and write:

```ts
export const note = defineModel({
  name: "note",
  description: "A personal note. Each account sees only its own.",
  fields: {
    title: field.text({ max: 200, required: true }),
    body: field.longText(),
    pinned: field.boolean({ required: true, defaultValue: false }),
  },
  access: { read: "owner", write: "owner" }, // required: no policy, no model
});
```

Register it in the kon: `defineModelsKon({ id: "kon-notes", …, models: [note] })`
(the generator prints the exact line).

## 3. The migration (1 min)

```bash
pnpm kitsuden makemigrations --kon notes     # writes migrations/0000_*.sql (review it)
pnpm --dir apps/api db:migrate               # applies it, with RLS (FORCE) on the table
```

## 4. Run it (1 min)

```bash
pnpm dev:api                 # the API on :3000
pnpm sdk:watch               # in another terminal: the SDK follows your models
```

Enable the kon in the panel (**Kons**) or declare it in `kitsuden.kons.json`.

## 5. What you have now (1 min to look)

| Where                                                                | What                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET/POST /api/notes/notes`, `GET/PATCH/DELETE /api/notes/notes/:id` | REST, owner-only by RLS                                                                     |
| `/api/docs`                                                          | OpenAPI 3.1 with the schemas                                                                |
| `/api/mcp`                                                           | MCP tools `notes__list-notes`, `notes__create-note`… with scopes `note:read` / `note:write` |
| Panel → **Models**                                                   | list and form built from the model                                                          |
| `packages/sdk/src/generated/kons/notes.ts`                           | `kitsuden.notes.createNote({ body: { title } })`, typed                                     |

Change a field and run `makemigrations` again: it writes only the difference.
Adding data to a table that already has rows has rules; read
[Day 2](agents/models.md#day-2-changing-a-model-that-already-has-rows).
Add `semantics: { fields: ["title", "body"] }` and you get semantic search
([local AI](agents/local-ai.md)).
