/**
 * `/g/<id>` does not block what is not a kon
 * ============================================================================
 *
 * `GrimoirePage` shows «This kon is not activated» when the kon is off.
 * Without that, entering an off kon painted its explorer with «0 records» and an
 * «Add» button that opened a form complaining about a nonexistent table:
 * the error talked about the table when what was missing was the kon.
 *
 * ── BUT NOT EVERYTHING UNDER `/g/` IS A KON ────────────────────────────────
 *
 * `grimoire-loader.ts` registers SYSTEM views by key —`system-tools-editor`,
 * `system-tools-builder`, `system-tools-agents`— and the content editor lives
 * at `/g/system-tools/editor`. `system-tools` does not appear in the `modules` table
 * because it is not a kon.
 *
 * The first version of the check did not distinguish them, so the blog
 * editor started answering «This kon is not activated». A screen that
 * worked was broken while fixing another — and two rounds earlier it was already written in
 * `routes/content/edit/+page.ts` that `system-tools` is NOT a kon, precisely
 * to avoid making that mistake.
 *
 * That is why the condition has TWO halves and this test guards that both remain.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const PAGE = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "admin",
  "GrimoirePage.svelte"
);
const LOADER = join(ROOT, "packages", "admin", "src", "lib", "grimoire-loader.ts");

describe("kon screen", () => {
  const page = withoutComments(readFileSync(PAGE, "utf-8"));

  it("checks whether the id belongs to a kon before blocking", () => {
    expect(
      /isKon/.test(page),
      "GrimoirePage decides the block with `enabledKeys` alone again. The ids " +
        "served by the system views registry (system-tools/editor, " +
        "system-tools/builder) are not in `modules`, so screens that " +
        "work would be blocked."
    ).toBe(true);

    // The condition has to OPEN when it is not a kon, not close.
    const line = page.split("\n").find((l) => l.includes("!isKon"));
    expect(
      line,
      "`activatedKon` must start with `!isKon`: if the id is not a kon, this " +
        "screen has nothing to say about its activation."
    ).toBeTruthy();
  });

  it("system-tools is still a key of the views registry", () => {
    // If this disappeared, the exception above would no longer be needed — but
    // it would be necessary to check that the content editor was not left without a destination.
    const loader = readFileSync(LOADER, "utf-8");
    expect(
      loader.includes('"system-tools-editor"'),
      "the `system-tools-editor` view no longer exists: check where " +
        "/content/edit redirects before accepting this test."
    ).toBe(true);
  });
});
