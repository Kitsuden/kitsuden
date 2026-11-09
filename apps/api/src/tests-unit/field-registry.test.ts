/**
 * The single registry of field types.
 *
 * This file exists so that divergence does not come back. The repo came to have
 * a type's information spread over four places —the Zod enum, the validator's
 * `switch`, the admin palette and the indexing rules— and the
 * result was that `multiselect`, `textarea`, `datetime` and `media` validated
 * perfectly in the backend with nobody able to create them.
 *
 * What is checked here is not that the registry has this or that entry, but
 * that the consumers STILL agree with each other.
 */

import { buildFieldValidator, normalizeField } from "@kitsuden/engine";
import {
  FIELD_TYPES,
  FIELD_TYPE_ALIASES,
  FIELD_TYPE_NAMES,
  creatableFieldTypes,
  fieldTypeSpec,
  resolveFieldType,
  shouldIndexByDefault,
  shouldSearchByDefault,
  FieldTypeSchema,
} from "@kitsuden/shared";
import { describe, it, expect } from "bun:test";

describe("consumers cannot diverge", () => {
  it("the Zod enum is derived from the registry, not copied from it", () => {
    expect(new Set(FieldTypeSchema.options)).toEqual(new Set(FIELD_TYPE_NAMES));
  });

  it("the admin palette is a real subset of the registry", () => {
    const palette = creatableFieldTypes().map((t) => t.type);
    expect(palette.length).toBeGreaterThan(0);
    for (const t of palette) expect(FIELD_TYPE_NAMES).toContain(t);
  });

  it("EVERY declared type compiles to a validator without blowing up", () => {
    // It is the check that was missing: before, a name could be added to the enum
    // and the `switch` forgotten, and the type silently fell into the default
    // case validating as a string.
    for (const type of FIELD_TYPE_NAMES) {
      const v = buildFieldValidator([{ key: "field", type, label: "Field" }]);
      expect(v.safeParse({}).success).toBe(true);
    }
  });

  it("the four types that validated without being creatable can now be created", () => {
    const palette = creatableFieldTypes().map((t) => t.type as string);
    for (const t of ["multiselect", "textarea", "datetime", "media"]) {
      expect(palette).toContain(t);
    }
  });
});

describe("alias resolution", () => {
  it("a canonical type resolves to itself", () => {
    for (const t of FIELD_TYPE_NAMES) expect(resolveFieldType(t)).toBe(t);
  });

  it("every alias points to a type that exists", () => {
    for (const [alias, target] of Object.entries(FIELD_TYPE_ALIASES)) {
      expect(FIELD_TYPE_NAMES).toContain(target);
      expect(resolveFieldType(alias)).toBe(target);
    }
  });

  it("an unknown type falls back to text instead of blowing up", () => {
    // A schema with a type this build does not know must keep saving its
    // data, not take down the form. Same reason as the `passthrough()`.
    expect(resolveFieldType("invented_in_2030")).toBe("text");
    expect(resolveFieldType(undefined)).toBe("text");
    expect(resolveFieldType(null)).toBe("text");
    expect(fieldTypeSpec("invented_in_2030")).toBe(FIELD_TYPES.text);
  });

  it("the SQL column vocabulary comes in through the aliases", () => {
    expect(resolveFieldType("varchar")).toBe("text"); // unknown → text
    expect(resolveFieldType("integer")).toBe("number");
    expect(resolveFieldType("jsonb")).toBe("json");
    expect(resolveFieldType("timestamp")).toBe("datetime");
    expect(resolveFieldType("checkbox")).toBe("boolean");
  });
});

describe("the raw type is preserved", () => {
  it("normalizeField separates what the author wrote from what is canonical", () => {
    // `getSchemaVersion` hashes `type`. If we resolved aliases there, changing the
    // internal representation would mark as outdated entries nobody touched.
    const f = normalizeField({ key: "x", type: "checkbox" })!;
    expect(f.type).toBe("checkbox");
    expect(f.resolvedType).toBe("boolean");
  });

  it("and it still validates by the resolved type", () => {
    const v = buildFieldValidator([{ key: "x", type: "checkbox", isRequired: true }]);
    expect(v.safeParse({ x: true }).success).toBe(true);
    expect(v.safeParse({ x: "not a boolean" }).success).toBe(false);
  });
});

describe("indexing behavior did not change", () => {
  // The refactoring moved these rules into the registry. These lists are the
  // ones that existed BEFORE, literally, so that a change of criteria has to be
  // deliberate and not a side effect.
  it("exactly the same types as before are indexed by default", () => {
    const before = ["email", "url", "select", "relation"];
    for (const t of FIELD_TYPE_NAMES) {
      expect(shouldIndexByDefault(t)).toBe(before.includes(t));
    }
  });

  it("exactly the same ones as before are searched by default", () => {
    const before = ["text", "textarea"];
    for (const t of FIELD_TYPE_NAMES) {
      expect(shouldSearchByDefault(t)).toBe(before.includes(t));
    }
  });
});

describe("the jsonb escape hatch is still open", () => {
  it("undeclared keys are kept as they are", () => {
    // It is the explicit guarantee: a custom field builder without an
    // escape hatch forces migrating the schema to store a loose piece of data.
    const v = buildFieldValidator([{ key: "name", type: "text" }]);
    const r = v.safeParse({ name: "Ana", whatever: { nested: [1, 2] }, other: 42 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.whatever).toEqual({ nested: [1, 2] });
      expect(r.data.other).toBe(42);
    }
  });

  it("a json field accepts any structure", () => {
    const v = buildFieldValidator([{ key: "free", type: "json" }]);
    expect(v.safeParse({ free: { a: 1, b: [2, 3], c: { d: true } } }).success).toBe(true);
  });

  it("an empty schema rejects nothing", () => {
    expect(buildFieldValidator([]).safeParse({ any: "thing" }).success).toBe(true);
  });
});
