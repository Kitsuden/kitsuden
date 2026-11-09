/**
 * A kon that declares its tables does not discover them again
 * ============================================================================
 *
 * ── WHAT WAS SEEN ──────────────────────────────────────────────────────────
 *
 * In CardSim, two rows of tabs for the SAME seven tables:
 *
 *     Games · Cards · Decks · Sessions · Matches · Standings · Queue
 *     Cards · Cardsim games · Cardsim decks · Cardsim sessions · …
 *
 * The top one with the manifest's labels; the bottom one with the humanized
 * table name. The same thing twice, and the second with worse names.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The explorer has a discovery —it asks the database which tables exist— and
 * it is designed for the ZERO CONFIGURATION case: you drop in a directory with
 * its `kon.json` and it appears. The condition to launch it was:
 *
 *     if (!config?.views || config.views.length === 0)
 *
 * and it was not enough: `onMount` runs on the first render, when the container
 * has not yet resolved which view is active, so `config.views` arrives
 * empty and the discovery fires even though the kon declares seven tables.
 *
 * A condition that depends on WHEN it is looked at is not a condition.
 *
 * ── AND THE ADD BUTTON ─────────────────────────────────────────────────────
 *
 * The same chromosome: the label came from `tables[0].label` —the kon's FIRST
 * table, fixed—, so while on "Cards" the button said "Add Games".
 * It is the family of the `apiBase` that served the first table to the eleven
 * tabs of Academy: taking `[0]` and calling it "the kon's one" works as long as
 * there is only one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const EXPLORER = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "admin",
  "DataExplorer.svelte"
);

describe("discovery does not compete with the manifest", () => {
  const source = readFileSync(EXPLORER, "utf-8");

  it("does not run if the kon declares its tables", () => {
    const mount = source.slice(source.indexOf("onMount(async () => {"));
    const body = mount.slice(0, mount.indexOf("\n  });") + 6);

    expect(body, "the discovery `onMount` was not found").toContain("discoverGrimoireTables");

    expect(
      body.includes("allTables?.length"),
      "the condition has to look at `allTables`, which comes from the manifest and is " +
        "stable from the first render. `config.views.length === 0` depends on " +
        "when it is checked: on the first render it is still empty and discovery " +
        "fires anyway, duplicating the tabs."
    ).toBe(true);
  });

  it("if it does run, it respects the declared names", () => {
    const discover = source.slice(source.indexOf("async function discoverGrimoireTables"));
    const body = discover.slice(0, 1600);

    expect(
      body.includes("allTables?.find((d) => d.name === t.name)?.label"),
      "humanizing the table name is the LAST resort: «Cardsim games» " +
        "is worse than «Games» in every language."
    ).toBe(true);
  });
});

describe("the add button names what is being viewed", () => {
  const source = readFileSync(EXPLORER, "utf-8");

  it("the label comes from the active table, not from the kon's first one", () => {
    const tag = source.slice(source.indexOf("const signupTag"), source.indexOf("const columns"));

    expect(tag.length, "`signupTag` was not found").toBeGreaterThan(0);

    expect(
      tag.includes("allTables?.find((t) => t.name === activeTable)?.label"),
      "the name has to come from `activeTable`. With `config.singularName` " +
        "—which is `tables[0].label`— while on «Cards» the button said " +
        "«Add Games»."
    ).toBe(true);
  });

  it("`config.singularName` is only a fallback", () => {
    const tag = source.slice(source.indexOf("const signupTag"), source.indexOf("const columns"));

    /**
     * Order matters: if `config.singularName` were consulted before the
     * active table, the kon's first table would win again and the bug
     * would come back intact.
     */
    const iTable = tag.indexOf("activeTable");
    const iConfig = tag.indexOf("config?.singularName");

    expect(iTable, "the active table is not consulted").toBeGreaterThan(-1);
    expect(
      iConfig === -1 || iTable < iConfig,
      "the active table has to be consulted BEFORE `config.singularName`."
    ).toBe(true);
  });
});
