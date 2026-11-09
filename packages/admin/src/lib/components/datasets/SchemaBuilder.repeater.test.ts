/**
 * The repeater and conditional-logic UI, actually mounted.
 *
 * This file exists because "it compiles" is not "it works". The repeater was
 * validating in the backend and appearing in the palette for several iterations
 * without anyone being able to define its subfields, and the typecheck was green
 * the whole time.
 *
 * It is the admin's first component test: the dependencies
 * (@testing-library/svelte + jsdom) were installed and unused.
 */

import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";

import SchemaBuilder from "./SchemaBuilder.svelte";

function dataset(fields: unknown[] = []) {
  return {
    id: "ds-1",
    name: "Productos",
    slug: "productos",
    fields,
    policyJson: {
      readAccess: "authenticated" as const,
      writeAccess: "admin" as const,
      enableRLS: false,
      rlsRules: [],
    },
  } as never;
}

const field = (extra: Record<string, unknown>) => ({
  id: `f-${extra.key ?? "x"}`,
  key: "x",
  label: "X",
  type: "text",
  isRequired: false,
  isUnique: false,
  order: 0,
  hidden: false,
  ...extra,
});

/** Selects a field from the list to open its detail panel. */
async function openField(tag: string) {
  const row = screen.getByText(tag);
  await fireEvent.click(row);
}

describe("paleta", () => {
  it("offers the repeater and the four types that previously could not be created", () => {
    render(SchemaBuilder, { props: { definition: dataset() } });
    for (const tag of ["Repeater", "Multi-select", "Long text", "Date & time", "File"]) {
      expect(screen.getByText(tag)).toBeTruthy();
    }
  });

  it("each palette type is rendered with its own description", () => {
    // If an icon or a label were missing from the map, several fields would come out
    // the same; checking the descriptions detects that collapse.
    render(SchemaBuilder, { props: { definition: dataset() } });
    expect(screen.getByText("Repeating group of subfields")).toBeTruthy();
    expect(screen.getByText("Any media item — PDF, video, document")).toBeTruthy();
  });
});

describe("repeater editor", () => {
  const withRepeater = dataset([
    field({
      key: "faqs",
      label: "FAQs",
      type: "repeater",
      subFields: [field({ key: "pregunta", label: "Pregunta", type: "text" })],
    }),
  ]);

  it("shows the subfields section when a repeater is selected", async () => {
    render(SchemaBuilder, { props: { definition: withRepeater } });
    await openField("FAQs");
    expect(screen.getByText("Row fields")).toBeTruthy();
    expect(screen.getByText("Add row field")).toBeTruthy();
  });

  it("renders the existing subfields", async () => {
    render(SchemaBuilder, { props: { definition: withRepeater } });
    await openField("FAQs");
    expect(screen.getByDisplayValue("Pregunta")).toBeTruthy();
    expect(screen.getByDisplayValue("pregunta")).toBeTruthy();
  });

  it("adds a subfield when the button is pressed", async () => {
    render(SchemaBuilder, { props: { definition: withRepeater } });
    await openField("FAQs");
    const before = screen.getAllByPlaceholderText("Label").length;
    await fireEvent.click(screen.getByText("Add row field"));
    expect(screen.getAllByPlaceholderText("Label").length).toBe(before + 1);
  });

  it("warns when a repeater has no subfields — its rows would be empty", async () => {
    render(SchemaBuilder, {
      props: { definition: dataset([field({ key: "vacio", label: "Empty", type: "repeater" })]) },
    });
    await openField("Empty");
    expect(screen.getByText(/No row fields yet/)).toBeTruthy();
  });

  it("subfields do NOT offer repeater — nesting is cut off at one level", async () => {
    render(SchemaBuilder, { props: { definition: withRepeater } });
    await openField("FAQs");
    // The subfield's <select> lists types; none of its options is repeater.
    const selects = screen.getAllByRole("combobox");
    const subfieldOptions = selects
      .flatMap((s) => Array.from(s.querySelectorAll("option")))
      .map((o) => (o as HTMLOptionElement).value);
    expect(subfieldOptions).toContain("text");
    expect(subfieldOptions).not.toContain("repeater");
  });

  it("exposes min/max as ROWS, not as characters", async () => {
    render(SchemaBuilder, { props: { definition: withRepeater } });
    await openField("FAQs");
    expect(screen.getByLabelText("Min rows")).toBeTruthy();
    expect(screen.getByLabelText("Max rows")).toBeTruthy();
  });

  it("a normal field does not show the subfields section", async () => {
    render(SchemaBuilder, {
      props: { definition: dataset([field({ key: "title", label: "Title", type: "text" })]) },
    });
    await openField("Title");
    expect(screen.queryByText("Row fields")).toBeNull();
  });
});

describe("condition editor", () => {
  it("with a single field, it cannot be enabled: there is nothing to depend on", async () => {
    render(SchemaBuilder, {
      props: { definition: dataset([field({ key: "solo", label: "Solo", type: "text" })]) },
    });
    await openField("Solo");
    expect(screen.getByText(/Needs at least one other field/)).toBeTruthy();
  });

  it("with two fields, enabling it shows source, operator and value", async () => {
    render(SchemaBuilder, {
      props: {
        definition: dataset([
          field({ key: "method", label: "Method", type: "select" }),
          field({ key: "direccion", label: "Address", type: "text" }),
        ]),
      },
    });
    await openField("Address");
    expect(screen.getByText("Conditional")).toBeTruthy();

    // The switch is the only button inside the Conditional block.
    const block = screen.getByText("Conditional").closest("div")?.parentElement?.parentElement;
    const interruptor = block?.querySelector("button");
    expect(interruptor).toBeTruthy();
    await fireEvent.click(interruptor!);

    expect(screen.getByText("equals")).toBeTruthy();
    expect(screen.getByPlaceholderText("value")).toBeTruthy();
  });

  it("the source dropdown does NOT offer itself", async () => {
    // A self-referencing condition cannot be evaluated: the value would be needed
    // to decide whether the value counts.
    render(SchemaBuilder, {
      props: {
        definition: dataset([
          field({ key: "method", label: "Method", type: "select" }),
          field({ key: "direccion", label: "Address", type: "text" }),
        ]),
      },
    });
    await openField("Address");
    const block = screen.getByText("Conditional").closest("div")?.parentElement?.parentElement;
    await fireEvent.click(block!.querySelector("button")!);

    const options = screen
      .getAllByRole("combobox")
      .flatMap((s) => Array.from(s.querySelectorAll("option")))
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain("method");
    expect(options).not.toContain("direccion");
  });

  it("an already saved condition is rendered when the field is opened", async () => {
    render(SchemaBuilder, {
      props: {
        definition: dataset([
          field({ key: "method", label: "Method", type: "select" }),
          field({
            key: "direccion",
            label: "Address",
            type: "text",
            isRequired: true,
            showIf: { field: "method", operator: "eq", value: "envio" },
          }),
        ]),
      },
    });
    await openField("Address");
    expect(screen.getByDisplayValue("envio")).toBeTruthy();
    // And it explains the rule people do not expect.
    expect(screen.getByText(/Required only while this condition holds/)).toBeTruthy();
  });

  it("warns that gt/lt compare as numbers", async () => {
    render(SchemaBuilder, {
      props: {
        definition: dataset([
          field({ key: "cantidad", label: "Cantidad", type: "number" }),
          field({
            key: "descuento",
            label: "Descuento",
            type: "number",
            showIf: { field: "cantidad", operator: "gt", value: "10" },
          }),
        ]),
      },
    });
    await openField("Descuento");
    expect(screen.getByText(/Compared as numbers/)).toBeTruthy();
  });
});
