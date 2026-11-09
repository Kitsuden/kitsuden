/**
 * `semantics` in defineModel: validation and the SQL that
 * `makemigrations` generates when adding, changing or removing semantic search.
 */

import {
  field,
  defineModel,
  generateModelMigration,
  modelsSnapshot,
  type ModelDeclaration,
} from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

const base = {
  name: "doc",
  description: "A document.",
  fields: {
    title: field.text({ max: 200, required: true }),
    body: field.longText(),
    n: field.integer(),
  },
  access: { read: "public", write: "staff" },
} as const satisfies ModelDeclaration;

const without = defineModel(base);
const withValue = defineModel({
  ...base,
  semantics: { fields: ["title", "body"], dimensions: 384 },
});

describe("semantics: validation", () => {
  it("text fields only, at least one, dimensions 1–2000", () => {
    expect(() => defineModel({ ...base, semantics: { fields: [] } })).toThrow(
      /at least one text field/
    );
    expect(() => defineModel({ ...base, semantics: { fields: ["n"] } })).toThrow(/text/);
    expect(() => defineModel({ ...base, semantics: { fields: ["nothing" as "title"] } })).toThrow(
      /is not a field/
    );
    expect(() =>
      defineModel({ ...base, semantics: { fields: ["title"], dimensions: 3072 } })
    ).toThrow(/2000/);
    expect(defineModel({ ...base, semantics: { fields: ["title"] } }).semantics).toEqual({
      fields: ["title"],
      dimensions: 1536,
    });
  });

  it("a model without semantics does not change its snapshot (the saved ones stay valid)", () => {
    expect("semantics" in modelsSnapshot([without], "k").models.doc!).toBe(false);
  });
});

describe("semantics: makemigrations", () => {
  it("new model: vector(N) column and HNSW index", () => {
    const r = generateModelMigration(null, [withValue], { kon: "k" });
    expect(r.sql).toContain('ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS "embedding" vector(384);');
    expect(r.sql).toContain('USING hnsw ("embedding" vector_cosine_ops)');
  });

  it("adding it to an existing model: the column, the index and a warning", () => {
    const r = generateModelMigration(modelsSnapshot([without], "k"), [withValue], { kon: "k" });
    expect(r.changes).toContain("add semantic search to doc (384 dimensions)");
    expect(r.sql).toContain("vector(384)");
    expect(r.warnings.join("\n")).toMatch(/no embedding/);
  });

  it("changing the dimensions empties the embeddings and rebuilds the index", () => {
    const other = defineModel({
      ...base,
      semantics: { fields: ["title", "body"], dimensions: 768 },
    });
    const r = generateModelMigration(modelsSnapshot([withValue], "k"), [other], { kon: "k" });
    expect(r.sql).toContain('ALTER COLUMN "embedding" TYPE vector(768) USING NULL;');
    expect(r.warnings.join("\n")).toMatch(/computed again/);
  });

  it("removing it is destructive: it comes out commented", () => {
    const r = generateModelMigration(modelsSnapshot([withValue], "k"), [without], { kon: "k" });
    expect(r.sql).toContain(
      '-- DESTRUCTIVE (skipped; re-run with --allow-destructive to emit it): ALTER TABLE "docs" DROP COLUMN IF EXISTS "embedding";'
    );
  });

  it("no changes, no migration", () => {
    expect(
      generateModelMigration(modelsSnapshot([withValue], "k"), [withValue], { kon: "k" }).sql
    ).toBe("");
  });
});
