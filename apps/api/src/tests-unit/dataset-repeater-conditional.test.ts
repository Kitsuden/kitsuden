/**
 * Repeater and conditional logic — the two real gaps compared with ACF/Pods.
 *
 * What really has to be demonstrated here is not that an array validates, but the
 * two things a naive implementation leaves out:
 *
 *   1. A required field that is HIDDEN by its condition cannot block
 *      the form. Zod validates each key in isolation and does not see its siblings, so
 *      required-ness has to be checked on the whole object.
 *   2. Inside a repeater, the condition is resolved against ITS ROW. If it looked
 *      at the parent form, one row would decide for the others.
 */

import { describe, it, expect } from "bun:test";

import {
  buildDatasetEntryValidator,
  isFieldVisible,
  normalizeDatasetField,
  validateDatasetEntry,
} from "../lib/dataset-optimizations";

const field = (extra: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  key: "x",
  label: "X",
  type: "text",
  ...extra,
});

describe("repeater", () => {
  const faqs = [
    field({
      key: "faqs",
      label: "FAQs",
      type: "repeater",
      subFields: [
        field({ key: "question", label: "Question", type: "text", isRequired: true }),
        field({ key: "response", label: "Answer", type: "text" }),
      ],
    }),
  ];

  it("accepts a list of rows with the declared shape", () => {
    const r = validateDatasetEntry(faqs, {
      faqs: [
        { question: "Shipping?", response: "Yes" },
        { question: "Returns?", response: "30 days" },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data.faqs as unknown[]).length).toBe(2);
  });

  it("rejects a row that is missing a required subfield", () => {
    const r = validateDatasetEntry(faqs, {
      faqs: [{ question: "Shipping?" }, { response: "orphan" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // The error points at the specific row, not at the whole repeater: without that the
      // form does not know where to draw the warning.
      expect(r.error.issues[0].path).toEqual(["faqs", 1, "question"]);
    }
  });

  it("rejects something that is not a list", () => {
    expect(validateDatasetEntry(faqs, { faqs: { question: "I am not a row" } }).success).toBe(
      false
    );
  });

  it("uses minLength/maxLength as the minimum and maximum of ROWS", () => {
    const bounded = [
      field({
        key: "tiers",
        type: "repeater",
        minLength: 1,
        maxLength: 2,
        subFields: [field({ key: "price", type: "number" })],
      }),
    ];
    expect(validateDatasetEntry(bounded, { tiers: [] }).success).toBe(false);
    expect(validateDatasetEntry(bounded, { tiers: [{ price: 1 }] }).success).toBe(true);
    expect(
      validateDatasetEntry(bounded, { tiers: [{ price: 1 }, { price: 2 }, { price: 3 }] }).success
    ).toBe(false);
  });

  it("validates the subfields' types, not only their presence", () => {
    const r = validateDatasetEntry(
      [
        field({
          key: "tiers",
          type: "repeater",
          subFields: [field({ key: "price", type: "number" })],
        }),
      ],
      { tiers: [{ price: "I am not a number" }] }
    );
    expect(r.success).toBe(false);
  });

  it("a repeater without subfields accepts empty rows instead of blowing up", () => {
    // It is the transient state of a field just dragged in the admin.
    const r = validateDatasetEntry([field({ key: "empty", type: "repeater" })], {
      empty: [{}, {}],
    });
    expect(r.success).toBe(true);
  });

  it("does NOT nest: a subfield of type repeater does not create a second level", () => {
    // The one-level cut is deliberate. What matters is that it does not blow up.
    const r = validateDatasetEntry(
      [
        field({
          key: "a",
          type: "repeater",
          subFields: [field({ key: "b", type: "repeater", subFields: [field({ key: "c" })] })],
        }),
      ],
      { a: [{ b: [{ c: "hello" }] }] }
    );
    expect(r.success).toBe(true);
  });
});

describe("conditional logic", () => {
  const dispatch = [
    field({ key: "method", label: "Method", type: "select" }),
    field({
      key: "address",
      label: "Address",
      type: "text",
      isRequired: true,
      showIf: { field: "method", operator: "eq", value: "shipping" },
    }),
  ];

  it("requires the field when the condition is met", () => {
    const r = validateDatasetEntry(dispatch, { method: "shipping" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["address"]);
  });

  it("does NOT require it when hidden — the case that breaks the naive version", () => {
    // Without this, the user sees a valid form that the server rejects because of
    // a field that was never on screen.
    expect(validateDatasetEntry(dispatch, { method: "pickup" }).success).toBe(true);
  });

  it("accepts it when the condition is met and it is filled in", () => {
    expect(
      validateDatasetEntry(dispatch, { method: "shipping", address: "Street 1" }).success
    ).toBe(true);
  });

  it("treats the empty string as absent", () => {
    expect(validateDatasetEntry(dispatch, { method: "shipping", address: "" }).success).toBe(false);
  });

  it("a NON-required conditional field never blocks", () => {
    const optional = [
      field({ key: "method", type: "select" }),
      field({
        key: "note",
        type: "text",
        showIf: { field: "method", operator: "eq", value: "shipping" },
      }),
    ];
    expect(validateDatasetEntry(optional, { method: "shipping" }).success).toBe(true);
  });

  it("inside a repeater the condition looks at ITS row, not the form", () => {
    const rows = [
      field({
        key: "items",
        type: "repeater",
        subFields: [
          field({ key: "type", type: "select" }),
          field({
            key: "detail",
            label: "Detail",
            type: "text",
            isRequired: true,
            showIf: { field: "type", operator: "eq", value: "other" },
          }),
        ],
      }),
    ];

    // Row 0 does not need it; row 1 does and has it. If the condition were evaluated
    // against the parent object, neither of the two rows would find `type`.
    expect(
      validateDatasetEntry(rows, {
        items: [{ type: "standard" }, { type: "other", detail: "custom" }],
      }).success
    ).toBe(true);

    // And the row that needs it and does not have it fails, pointing at its index.
    const r = validateDatasetEntry(rows, {
      items: [{ type: "standard" }, { type: "other" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["items", 1, "detail"]);
  });
});

describe("isFieldVisible", () => {
  const withValue = (operator: string, value: string) =>
    normalizeDatasetField(field({ key: "y", showIf: { field: "x", operator, value } }))!;

  it("without a condition, always visible", () => {
    expect(isFieldVisible(normalizeDatasetField(field({}))!, {})).toBe(true);
  });

  it("eq / neq / contains", () => {
    expect(isFieldVisible(withValue("eq", "a"), { x: "a" })).toBe(true);
    expect(isFieldVisible(withValue("eq", "a"), { x: "b" })).toBe(false);
    expect(isFieldVisible(withValue("neq", "a"), { x: "b" })).toBe(true);
    expect(isFieldVisible(withValue("contains", "am"), { x: "example" })).toBe(true);
    expect(isFieldVisible(withValue("contains", "zz"), { x: "example" })).toBe(false);
  });

  it("compares numbers as numbers, not as text", () => {
    // As text, "10" < "9" would be true. That is the classic bug.
    expect(isFieldVisible(withValue("gt", "9"), { x: 10 })).toBe(true);
    expect(isFieldVisible(withValue("lt", "9"), { x: 10 })).toBe(false);
  });

  it("gt/lt with something non-numeric is false, not an invented ordering", () => {
    expect(isFieldVisible(withValue("gt", "9"), { x: "hello" })).toBe(false);
    expect(isFieldVisible(withValue("lt", "abc"), { x: 1 })).toBe(false);
  });

  it("the missing referenced field is equivalent to an empty string", () => {
    expect(isFieldVisible(withValue("eq", ""), {})).toBe(true);
    expect(isFieldVisible(withValue("eq", "a"), {})).toBe(false);
  });

  it("an invalid condition is discarded and the field stays visible", () => {
    // A typo in the operator cannot silently make data disappear.
    const bad = normalizeDatasetField(
      field({ key: "y", showIf: { field: "x", operator: "approximately", value: "a" } })
    )!;
    expect(bad.showIf).toBeUndefined();
    expect(isFieldVisible(bad, { x: "whatever" })).toBe(true);
  });

  it("a condition without a field is also discarded", () => {
    const bad = normalizeDatasetField(field({ key: "y", showIf: { operator: "eq", value: "a" } }))!;
    expect(bad.showIf).toBeUndefined();
  });
});

describe("does not break what was already there", () => {
  it("a schema without repeater or showIf keeps validating the same", () => {
    const v = buildDatasetEntryValidator([
      field({ key: "name", type: "text", isRequired: true }),
      field({ key: "age", type: "number", minValue: 0 }),
    ]);
    expect(v.safeParse({ name: "Ana", age: 30 }).success).toBe(true);
    expect(v.safeParse({ age: 30 }).success).toBe(false);
    expect(v.safeParse({ name: "Ana", age: -1 }).success).toBe(false);
  });
});
