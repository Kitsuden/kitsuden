import { describe, expect, it, vi } from "vitest";

import { pageTitle, queryChoice, setQuery, withQuery } from "./page";

import { goto } from "$app/navigation";

vi.mock("$app/navigation", () => ({ goto: vi.fn(async () => {}) }));

describe("pageTitle", () => {
  it("puts the page before the product", () => {
    expect(pageTitle("Datasets")).toBe("Datasets · Kitsuden");
  });
  it("falls back to the product alone", () => {
    expect(pageTitle("")).toBe("Kitsuden");
    expect(pageTitle(undefined)).toBe("Kitsuden");
  });
});

describe("query state", () => {
  const url = new URL("http://panel.test/approvals?tab=inbox&id=7");

  it("sets, replaces and removes parameters", () => {
    expect(withQuery(url, { tab: "audit" })).toBe("/approvals?tab=audit&id=7");
    expect(withQuery(url, { id: null })).toBe("/approvals?tab=inbox");
    expect(withQuery(url, { tab: "", id: undefined })).toBe("/approvals");
  });

  it("navigates only when something changes, keeping focus and scroll", async () => {
    await setQuery(url, { tab: "inbox" });
    expect(goto).not.toHaveBeenCalled();
    await setQuery(url, { tab: "audit" });
    expect(goto).toHaveBeenCalledWith("/approvals?tab=audit&id=7", {
      keepFocus: true,
      noScroll: true,
      replaceState: false,
    });
  });

  it("accepts only known values", () => {
    const tabs = ["inbox", "audit"] as const;
    expect(queryChoice(url, "tab", tabs, "audit")).toBe("inbox");
    expect(queryChoice(new URL("http://x/?tab=nope"), "tab", tabs, "inbox")).toBe("inbox");
    expect(queryChoice(new URL("http://x/"), "tab", tabs, "inbox")).toBe("inbox");
  });
});
