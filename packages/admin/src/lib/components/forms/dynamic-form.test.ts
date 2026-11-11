/**
 * The entry form renders every field type the schema builder offers.
 *
 * It knew ten of the seventeen: long text, date & time, file, multi-select, KPI and
 * repeater fields did not appear and the entry was saved without them. The first block
 * holds the rules; the second mounts the form.
 */
import { FIELD_TYPES, creatableFieldTypes } from "@kitsuden/shared";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import {
  REGISTRY_CONTROLS,
  cleanValues,
  controlFor,
  emptyRow,
  emptyValue,
  fileNameOf,
  fromDatetimeLocal,
  initialValues,
  toDateInput,
  toDatetimeLocal,
  validateFields,
  type FormField,
} from "./dynamic-form";
import DynamicForm from "./DynamicForm.svelte";

const field = (over: Partial<FormField> & { type: string; key: string }): FormField =>
  ({
    id: over.key,
    label: over.key,
    order: 0,
    isRequired: false,
    isUnique: false,
    hidden: false,
    ...over,
  }) as FormField;

beforeEach(() => setLocale("en", { reload: false }));

describe("controlFor", () => {
  it("has a control for every type of the shared registry", () => {
    expect(REGISTRY_CONTROLS).toHaveLength(Object.keys(FIELD_TYPES).length);
    expect(REGISTRY_CONTROLS).not.toContain("unknown");
    for (const t of creatableFieldTypes()) expect(controlFor(t.type), t.type).toBe(t.type);
  });

  it("resolves the legacy aliases", () => {
    expect(controlFor("string")).toBe("text");
    expect(controlFor("file")).toBe("media");
    expect(controlFor("timestamp")).toBe("datetime");
    expect(controlFor("longtext")).toBe("textarea");
    expect(controlFor("checkbox")).toBe("boolean");
  });

  it("anything else is unknown, never silently text", () => {
    expect(controlFor("geo-point")).toBe("unknown");
    expect(controlFor("")).toBe("unknown");
    expect(controlFor(undefined)).toBe("unknown");
    // A key of Object.prototype is not a field type.
    expect(controlFor("toString")).toBe("unknown");
  });
});

describe("starting values", () => {
  it("each kind starts with a value of its own shape", () => {
    expect(emptyValue(field({ key: "a", type: "boolean" }))).toBe(false);
    expect(emptyValue(field({ key: "a", type: "multiselect" }))).toEqual([]);
    expect(emptyValue(field({ key: "a", type: "repeater" }))).toEqual([]);
    expect(emptyValue(field({ key: "a", type: "textarea" }))).toBeNull();
    expect(emptyValue(field({ key: "a", type: "number", defaultValue: "7" }))).toBe(7);
    expect(emptyValue(field({ key: "a", type: "multiselect", defaultValue: "a, b" }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("the entry's own value wins, including false and 0", () => {
    const fields = [field({ key: "on", type: "boolean" }), field({ key: "n", type: "number" })];
    expect(initialValues(fields, { on: false, n: 0 })).toEqual({ on: false, n: 0 });
  });

  it("a repeater row starts from its subfields", () => {
    const rep = field({
      key: "faq",
      type: "repeater",
      subFields: [field({ key: "q", type: "text" }), field({ key: "open", type: "boolean" })],
    });
    expect(emptyRow(rep)).toEqual({ q: null, open: false });
  });
});

describe("dates", () => {
  it("round-trips a local date-time", () => {
    const iso = fromDatetimeLocal("2026-03-04T09:30");
    expect(iso).toBe(new Date("2026-03-04T09:30").toISOString());
    expect(toDatetimeLocal(iso)).toBe("2026-03-04T09:30");
  });
  it("empty and invalid values are empty, not 'Invalid Date'", () => {
    expect(toDatetimeLocal(null)).toBe("");
    expect(toDatetimeLocal("nonsense")).toBe("");
    expect(fromDatetimeLocal("")).toBeNull();
    expect(toDateInput("2026-03-04T09:30:00.000Z")).toBe("2026-03-04");
    expect(toDateInput("nope")).toBe("");
  });
});

describe("validation", () => {
  it("required covers the new kinds", () => {
    const fields = [
      field({ key: "body", type: "textarea", label: "Body", isRequired: true }),
      field({ key: "tags", type: "multiselect", label: "Tags", isRequired: true }),
      field({ key: "when", type: "datetime", label: "When", isRequired: true }),
      field({ key: "doc", type: "media", label: "Doc", isRequired: true }),
    ];
    const errors = validateFields(fields, { body: "", tags: [], when: null, doc: null });
    expect(Object.keys(errors).sort()).toEqual(["body", "doc", "tags", "when"]);
    expect(errors.body).toBe("Body is required");
  });

  it("a multi-select only accepts its options", () => {
    const f = field({
      key: "tags",
      type: "multiselect",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    });
    expect(validateFields([f], { tags: ["a", "b"] })).toEqual({});
    expect(validateFields([f], { tags: ["a", "zz"] })).toHaveProperty("tags");
  });

  it("a KPI and an unknown type are never the user's error", () => {
    const fields = [
      field({ key: "total", type: "kpi", isRequired: true }),
      field({ key: "geo", type: "geo-point", isRequired: true }),
    ];
    expect(validateFields(fields, { total: null, geo: null })).toEqual({});
  });

  it("a repeater checks its row limits and each row's subfields", () => {
    const rep = field({
      key: "faq",
      type: "repeater",
      minLength: 1,
      maxLength: 2,
      subFields: [field({ key: "q", type: "text", label: "Question", isRequired: true })],
    });
    expect(validateFields([rep], { faq: [] })).toHaveProperty("faq");
    expect(validateFields([rep], { faq: [{ q: "a" }, { q: "b" }, { q: "c" }] })).toHaveProperty(
      "faq"
    );
    expect(validateFields([rep], { faq: [{ q: "a" }, { q: "" }] })).toEqual({
      "faq.1.q": "Question is required",
    });
  });

  it("long text honours length limits like text does", () => {
    const f = field({ key: "body", type: "textarea", maxLength: 3 });
    expect(validateFields([f], { body: "abcd" })).toHaveProperty("body");
  });
});

describe("what is submitted", () => {
  it("numbers are numbers (0 stays 0), JSON is parsed, repeater rows are cleaned", () => {
    const fields = [
      field({ key: "n", type: "number" }),
      field({ key: "j", type: "json" }),
      field({
        key: "rows",
        type: "repeater",
        subFields: [field({ key: "qty", type: "number" })],
      }),
      field({ key: "geo", type: "geo-point" }),
    ];
    expect(
      cleanValues(fields, { n: "0", j: '{"a":1}', rows: [{ qty: "2", extra: 1 }], geo: { x: 1 } })
    ).toEqual({ n: 0, j: { a: 1 }, rows: [{ qty: 2 }], geo: { x: 1 } });
  });

  it("names a file by the end of its address", () => {
    expect(fileNameOf("/media/2026/annual%20report.pdf?v=2")).toBe("annual report.pdf");
    expect(fileNameOf("%E0%A4%A.pdf")).toBe("%E0%A4%A.pdf");
  });
});

describe("DynamicForm", () => {
  const all: FormField[] = [
    ...creatableFieldTypes()
      .filter((t) => t.type !== "relation")
      .map((t, i) =>
        field({
          key: `f_${t.type}`,
          label: `Field ${t.label}`,
          type: t.type,
          order: i,
          options:
            t.type === "select" || t.type === "multiselect"
              ? [
                  { label: "One", value: "one" },
                  { label: "Two", value: "two" },
                ]
              : undefined,
          subFields:
            t.type === "repeater"
              ? [field({ key: "q", label: "Question", type: "text" })]
              : undefined,
        })
      ),
    field({ key: "geo", label: "Location", type: "geo-point", order: 99 }),
  ];

  it("renders a row for every field, and none is the fallback except the unknown one", () => {
    const { container } = render(DynamicForm, { props: { fields: all as never } });
    const rows = [...container.querySelectorAll("form > [data-field]")];
    expect(rows).toHaveLength(all.length);
    for (const f of all) {
      const row = container.querySelector(`[data-field="${f.key}"]`);
      expect(row, f.key).not.toBeNull();
      expect(row?.textContent, f.key).toContain(f.label);
    }
    const unknown = rows.filter((r) => r.getAttribute("data-control") === "unknown");
    expect(unknown.map((r) => r.getAttribute("data-field"))).toEqual(["geo"]);
  });

  it("says that an unknown type cannot be edited, naming the type", () => {
    render(DynamicForm, { props: { fields: all as never } });
    const note = screen.getByTestId("field-unsupported");
    expect(note.textContent).toContain("geo-point");
    expect(note.textContent).toMatch(/cannot be edited here/i);
  });

  it("the new kinds get real controls", () => {
    const { container } = render(DynamicForm, { props: { fields: all as never } });
    const q = (key: string, sel: string) => container.querySelector(`[data-field="${key}"] ${sel}`);
    expect(q("f_textarea", "textarea")).not.toBeNull();
    expect(q("f_datetime", 'input[type="datetime-local"]')).not.toBeNull();
    expect(q("f_date", 'input[type="date"]')).not.toBeNull();
    expect(
      container.querySelectorAll('[data-field="f_multiselect"] input[type="checkbox"]')
    ).toHaveLength(2);
    expect(q("f_boolean", '[role="switch"]')).not.toBeNull();
    expect(q("f_media", "button")).not.toBeNull();
    expect(q("f_kpi", '[role="note"]')).not.toBeNull();
    expect(q("f_repeater", "button")).not.toBeNull();
  });

  it("every labelled control is reachable from its label", () => {
    const { container } = render(DynamicForm, { props: { fields: all as never } });
    for (const label of container.querySelectorAll("form label[for]")) {
      const id = label.getAttribute("for")!;
      expect(container.querySelector(`[id="${id}"]`), label.textContent ?? id).not.toBeNull();
    }
  });

  it("submits the values of the new kinds, keeping what it cannot edit", async () => {
    const onSubmit = vi.fn();
    const { container } = render(DynamicForm, {
      props: {
        fields: all as never,
        initialData: { f_textarea: "long", f_multiselect: ["two"], geo: { lat: 1 }, f_kpi: 42 },
        onSubmit,
      },
    });
    const add = container.querySelector('[data-field="f_repeater"] button')!;
    await fireEvent.click(add);
    const rowInput = container.querySelector('[data-field="f_repeater.0.q"] input')!;
    await fireEvent.input(rowInput, { target: { value: "Why?" } });
    const one = container.querySelector('[data-field="f_multiselect"] input[type="checkbox"]')!;
    await fireEvent.click(one);
    await fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const sent = onSubmit.mock.calls[0][0];
    expect(sent.f_textarea).toBe("long");
    expect([...sent.f_multiselect].sort()).toEqual(["one", "two"]);
    expect(sent.f_repeater).toEqual([{ q: "Why?" }]);
    expect(sent.geo).toEqual({ lat: 1 });
    expect(sent.f_kpi).toBe(42);
  });

  it("a required field left empty blocks the submit and shows its error", async () => {
    const onSubmit = vi.fn();
    const { container } = render(DynamicForm, {
      props: {
        fields: [
          field({ key: "body", label: "Body", type: "textarea", isRequired: true }),
        ] as never,
        onSubmit,
      },
    });
    await fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Body is required");
  });
});
