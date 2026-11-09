/**
 * The demo models (test-only kon `kon-notes`, docs/agents/models.md).
 *
 * Declared ONCE. `kitsuden makemigrations --dir tests/unit/fixtures/kon-notes`
 * wrote migrations/0000_models.sql and migrations/models.snapshot.json from
 * this file; tests/unit/models-*.test.ts mount the kon on PGlite with that SQL.
 */
import { field, defineModel } from "@kitsuden/shared";

/** Personal notes: each account reads and writes its own. */
export const note = defineModel({
  name: "note",
  tag: "Note",
  description: "A personal note. Each account sees only its own.",
  fields: {
    title: field.text({ max: 200, required: true, tag: "Title" }),
    body: field.longText({ tag: "Body" }),
    status: field.enum(["draft", "published"], {
      required: true,
      defaultValue: "draft",
      tag: "Status",
    }),
    priority: field.integer({ min: 0, max: 5, required: true, defaultValue: 0, tag: "Priority" }),
    pinned: field.boolean({ required: true, defaultValue: false, tag: "Pinned" }),
    dueAt: field.date({ tag: "Due" }),
    slug: field.text({ max: 80, unique: true, tag: "Slug" }),
    meta: field.json({ tag: "Metadata" }),
  },
  access: { read: "owner", write: "owner" },
});

/** Shared categories: anyone reads, only staff writes. */
export const category = defineModel({
  name: "category",
  plural: "categories",
  tag: "Category",
  description: "A shared category that anyone can read and only staff can change.",
  fields: {
    name: field.text({ max: 80, required: true, unique: true, tag: "Name" }),
    color: field.text({ max: 20, tag: "Color" }),
  },
  access: { read: "public", write: "staff" },
});
