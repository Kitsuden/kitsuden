/**
 * A model's generated view (defineModel)
 * ============================================================================
 *
 * It is given a model's real DESCRIPTOR (the one `describe-<model>` serves)
 * and a simulated API: it must render the list with the model's columns,
 * a form with the control for each type (enum select, boolean checkbox,
 * number with its limits), send only what has to be sent on create and on edit,
 * and show a 422's per-field errors.
 */
import { field, defineModel, modelDescriptor } from "@kitsuden/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as confirmModule from "$lib/confirm.svelte";
import { setLocale } from "$lib/i18n";

import ModelView from "./ModelView.svelte";

vi.setConfig({ testTimeout: 60_000 });

const note = defineModel({
  name: "note",
  tag: "Note",
  description: "A personal note.",
  fields: {
    title: field.text({ max: 200, required: true, tag: "Title" }),
    status: field.enum(["draft", "published"], {
      required: true,
      defaultValue: "draft",
      tag: "Status",
    }),
    priority: field.integer({ min: 0, max: 5, required: true, defaultValue: 0, tag: "Priority" }),
    pinned: field.boolean({ required: true, defaultValue: false, tag: "Pinned" }),
    meta: field.json({ tag: "Metadata" }),
  },
  access: { read: "owner", write: "owner" },
});
const descriptor = modelDescriptor(note);
const BASE = "/api/notas/notes";

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  ownerId: "ana",
  title: "Buy bread",
  status: "draft",
  priority: 2,
  pinned: true,
  meta: null,
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function mockApi(responses: Record<string, (body: unknown) => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: String(url), body });
      const route = String(url)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0];
      const r = responses[`${method} ${route}`];
      return r ? r(body) : new Response("{}", { status: 404 });
    })
  );
  return calls;
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("ModelView", () => {
  it("renders the list with the model's columns and the declared access", async () => {
    setLocale("en");
    mockApi({ [`GET ${BASE}`]: () => json({ data: [ROW], total: 1, limit: 20, offset: 0 }) });
    render(ModelView, { descriptor, base: BASE });
    const table = await screen.findByTestId("model-table");
    expect(table.textContent).toContain("Buy bread");
    expect(table.textContent).toContain("Title");
    expect(table.textContent).toContain("Owner");
    expect(table.textContent).toContain("Yes"); // pinned
    expect(table.textContent).not.toContain("Metadata"); // json does not go in the list
    expect(screen.getByTestId("model-view").textContent).toContain("note:write");
  });

  it("create: one control per type and only what was filled in is sent", async () => {
    setLocale("en");
    const calls = mockApi({
      [`GET ${BASE}`]: () => json({ data: [], total: 0, limit: 20, offset: 0 }),
      [`POST ${BASE}`]: (c) => json({ ...ROW, ...(c as object) }, 201),
    });
    render(ModelView, { descriptor, base: BASE });
    await fireEvent.click(await screen.findByTestId("model-new"));
    const form = await screen.findByTestId("model-form");
    expect(form.querySelector("select#field-status")).not.toBeNull();
    expect(form.querySelector("input#field-pinned[type=checkbox]")).not.toBeNull();
    const priority = form.querySelector("input#field-priority") as HTMLInputElement;
    expect(priority.type).toBe("number");
    expect(priority.max).toBe("5");
    expect((form.querySelector("input#field-title") as HTMLInputElement).maxLength).toBe(200);

    await fireEvent.input(form.querySelector("input#field-title")!, { target: { value: "Nueva" } });
    await fireEvent.submit(form);
    await waitFor(() => expect(calls.some((l) => l.method === "POST")).toBe(true));
    const post = calls.find((l) => l.method === "POST")!;
    expect(post.body).toEqual({ title: "Nueva", status: "draft", priority: 0, pinned: false });
  });

  it("editing sends only what changed; a 422 is shown next to its field", async () => {
    setLocale("es");
    const calls = mockApi({
      [`GET ${BASE}`]: () => json({ data: [ROW], total: 1, limit: 20, offset: 0 }),
      [`PATCH ${BASE}/${ROW.id}`]: () =>
        json(
          {
            code: "KITSUDEN_E_VALIDATION",
            detail: "Validation failed",
            details: { fields: { title: ["Too big: expected string to have <=200 characters"] } },
          },
          422
        ),
    });
    render(ModelView, { descriptor, base: BASE });
    await screen.findByTestId("model-table");
    await fireEvent.click(screen.getByText("Editar"));
    const form = await screen.findByTestId("model-form");
    await fireEvent.input(form.querySelector("input#field-title")!, { target: { value: "Otro" } });
    await fireEvent.submit(form);
    await waitFor(() => expect(screen.getByTestId("error-title").textContent).toContain("200"));
    const patch = calls.find((l) => l.method === "PATCH")!;
    expect(patch.body).toEqual({ title: "Otro" });
  });

  it("deleting asks for confirmation and calls DELETE (204 with no body)", async () => {
    setLocale("en");
    // The confirmation is the panel dialog ($lib/confirm.svelte), not the browser confirm().
    const asked = vi.spyOn(confirmModule, "confirmDialog").mockResolvedValue(true);
    const calls = mockApi({
      [`GET ${BASE}`]: () => json({ data: [ROW], total: 1, limit: 20, offset: 0 }),
      [`DELETE ${BASE}/${ROW.id}`]: () => new Response(null, { status: 204 }),
    });
    render(ModelView, { descriptor, base: BASE });
    await screen.findByTestId("model-table");
    await fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(calls.some((l) => l.method === "DELETE")).toBe(true));
    expect(asked).toHaveBeenCalledTimes(1);
    await screen.findByText("Deleted");
  });
});
