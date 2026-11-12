/**
 * The "New journal entry" view mounts. It bound the counterparty Select to a field the
 * blank journal did not have (`undefined`), Svelte threw `props_invalid_value`, and the view
 * never left its skeleton. A stored journal without a counterparty did the same.
 */
import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import JournalForm from "./JournalForm.svelte";

const { getContaJournal } = vi.hoisted(() => ({
  getContaJournal: vi.fn(async () => ({
    data: { id: "j1", date: "2026-11-01", description: "Rent", lines: undefined },
  })),
}));

vi.mock("$lib/api", () => ({
  api: {
    getContaAccounts: vi.fn(async () => ({ data: [{ id: "a1", code: "1000", name: "Cash" }] })),
    getContaCounterparties: vi.fn(async () => ({
      data: [{ id: "cp1", name: "Kiambu", type: "supplier" }],
    })),
    getContaCurrencies: vi.fn(async () => ({ data: [{ code: "USD" }] })),
    getContaJournal,
  },
}));

beforeEach(() => setLocale("en", { reload: false }));

describe("JournalForm", () => {
  it("a new entry mounts with its counterparty select and two lines", async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    render(JournalForm, { onBack: () => {}, onSave: () => {} });
    expect(await screen.findByRole("option", { name: /Kiambu/ })).toBeTruthy();
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
  });

  it("a stored entry with no counterparty or lines mounts too", async () => {
    render(JournalForm, { journalId: "j1", onBack: () => {}, onSave: () => {} });
    expect(await screen.findByDisplayValue("Rent")).toBeTruthy();
    expect(getContaJournal).toHaveBeenCalledWith("j1");
  });
});
