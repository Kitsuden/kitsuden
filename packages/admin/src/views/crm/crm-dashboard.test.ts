/**
 * The CRM dashboard's tabs load once. The tab effect used to read each loader's paging and
 * filters as dependencies; the loader then wrote the paging back, the effect ran again, and
 * the Deals tab reloaded forever behind skeleton rows. Editing a deal opens a sheet; there
 * is no `/crm/...` route to send it to.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import CrmDashboard from "./CrmDashboard.svelte";

const { deal, getCrmDeals, goto } = vi.hoisted(() => {
  const deal = {
    id: "d1",
    title: "Bluebird house blend",
    value: 9600,
    currency: "USD",
    status: "open",
    probability: 60,
    tags: [],
  };
  return {
    deal,
    getCrmDeals: vi.fn(async () => ({
      data: [deal],
      pagination: { offset: 0, limit: 20, total: 1 },
    })),
    goto: vi.fn(),
  };
});

vi.mock("$lib/api", () => ({
  api: {
    getCrmStats: vi.fn(async () => ({
      data: { contacts: 0, companies: 0, deals: { count: 1, values: { open: 0, total: 0 } } },
    })),
    getCrmDeals,
    getCrmDeal: vi.fn(async () => ({ data: deal })),
    getCrmContacts: vi.fn(async () => ({ data: [], pagination: { total: 0 } })),
    getCrmCompanies: vi.fn(async () => ({ data: [], pagination: { total: 0 } })),
    getCrmPipelines: vi.fn(async () => ({ data: [] })),
    getCrmPipeline: vi.fn(async () => ({ data: { stages: [] } })),
  },
}));

vi.mock("$app/navigation", () => ({ goto }));

beforeEach(() => {
  setLocale("en", { reload: false });
  getCrmDeals.mockClear();
  goto.mockClear();
});

describe("CRM dashboard", () => {
  it("the Deals tab loads its rows once and shows them", async () => {
    render(CrmDashboard);
    await fireEvent.click(await screen.findByRole("tab", { name: /Deals/ }));
    await screen.findByText("Bluebird house blend", { selector: "td *, td" });
    const calls = getCrmDeals.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    // The overview asks once for recent deals, the tab once: not a loop.
    expect(getCrmDeals.mock.calls.length).toBe(calls);
    expect(calls).toBeLessThanOrEqual(3);
  }, 20_000);

  it("Edit on a deal opens the deal form in a sheet, not a missing route", async () => {
    render(CrmDashboard);
    await fireEvent.click(await screen.findByRole("tab", { name: /Deals/ }));
    await screen.findByText("Bluebird house blend", { selector: "td *, td" });
    const row = screen.getByText("Bluebird house blend", { selector: "td *, td" }).closest("tr")!;
    const edit = [...row.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Edit"
    )!;
    await fireEvent.click(edit);
    await waitFor(() =>
      expect(document.querySelector("dialog[open]")?.textContent).toContain("Edit deal")
    );
    expect(goto).not.toHaveBeenCalled();
  }, 20_000);
});
