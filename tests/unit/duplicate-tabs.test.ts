/**
 * A kon that declares its views does not discover its tables again
 * ============================================================================
 *
 * ── WHAT WAS SEEN ────────────────────────────────────────────────────────────
 *
 * In CardSim, two rows of tabs for the SAME seven tables: one with the manifest's labels
 * and one with the humanized table names. The old explorer discovered tables from the
 * database on mount, when the container had not yet said which views the kon declares.
 * And its "Add" button took its label from `tables[0]`: on "Cards" it said "Add Games".
 *
 * ── HOW IT IS NOW ────────────────────────────────────────────────────────────
 *
 * The kon page (`GrimoirePage.svelte`) is the only place that decides: the views a kon
 * declares are its tabs; the explorer's own discovery (`generateDefaultConfig`) is asked
 * ONLY for a kon that has tables and declares no view, after the kon's config has loaded.
 * The "New …" button and the record pages are named after the table of the ACTIVE view.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const KON_PAGE = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "admin",
  "GrimoirePage.svelte"
);

const source = readFileSync(KON_PAGE, "utf-8");

describe("discovery does not compete with the manifest", () => {
  const at = source.indexOf("generateDefaultConfig(kon)");
  const effect = source.slice(source.lastIndexOf("$effect(() => {", at), at);

  it("is asked in one place only", () => {
    expect(at, "the fallback discovery was not found").toBeGreaterThan(-1);
    expect(source.match(/generateDefaultConfig\(/g)?.length).toBe(1);
  });

  it("does not run while the kon is loading, or when it declares views", () => {
    expect(
      effect.includes("if (loading || LegacyView || !grimoireConfig) return;"),
      "the discovery has to wait for the kon's config: before it arrives, `views` is " +
        "empty for every kon and discovery would fire for all of them."
    ).toBe(true);
    expect(
      effect.includes("grimoireConfig.views.length > 0"),
      "a kon that declares views must not get discovered tabs on top of them."
    ).toBe(true);
  });

  it("the tabs are the declared views", () => {
    expect(source).toContain("(grimoireConfig?.views ?? []).map((view) => ({");
  });
});

describe("the add button names what is being viewed", () => {
  it("the label comes from the active view's table, not from the kon's first one", () => {
    const start = source.indexOf("const tableLabel =");
    const label = source.slice(start, source.indexOf(";", start));
    expect(start, "`tableLabel` was not found").toBeGreaterThan(-1);
    expect(
      label.includes("grimoireConfig?.tables.find((tb) => tb.name === table)?.label"),
      "the name has to come from the table of the ACTIVE view. With `tables[0].label`, " +
        "while on «Cards» the button said «Add Games»."
    ).toBe(true);
    expect(label.includes("tables[0]")).toBe(false);
  });
});
