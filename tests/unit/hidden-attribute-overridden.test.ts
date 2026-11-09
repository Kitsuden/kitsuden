/**
 * A class with its own `display` cannot override the `hidden` attribute
 * ============================================================================
 *
 * ── THE FAILURE ────────────────────────────────────────────────────────────
 *
 * `[hidden] { display: none }` lives in the BROWSER's stylesheet, and any
 * author rule beats it. So it is enough for the element's class to declare
 * its own `display` for the attribute to stop doing anything:
 *
 *     .new   { display: flex; }     →   <form class="new" hidden>   is visible
 *     .row   { display: flex; }     →   <div  class="row"   hidden>   is visible
 *
 * In the tier list editor that left the «New tier list» form
 * open ALWAYS, wedged between the header and the board, whether the
 * button had been pressed or not — and «Cancel» closed nothing: it set the attribute that
 * was already set. In `scoreboard.js`, the empty scoreboard and the screen
 * buttons stayed in view next to the notice that there is no match.
 *
 * ── WHY IT IS HARD TO SEE ──────────────────────────────────────────────────
 *
 * Because the JavaScript is correct and does not fail: `form.hidden = true` leaves the
 * attribute set, `el.hidden` returns `true`, and even tests that
 * check `expect(el.hidden).toBe(true)` pass. The only thing that does not happen is
 * the hiding. No error, no trace, and the symptom —«the screen looks
 * weird»— does not point to the CSS.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Every view artifact that uses the attribute declares `[hidden]` with
 * `!important` in its own stylesheet. One line, and it also covers the classes
 * someone adds tomorrow.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HAS_INSTALLED_KONS } from "./helpers/known-kons";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "packages", "kons");

/** The admin view artifacts each kon contributes. */
function artifacts(): { kon: string; file: string; source: string }[] {
  const foundItems: { kon: string; file: string; source: string }[] = [];

  for (const kon of readdirSync(KONS)) {
    const dir = join(KONS, kon, "admin");
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      foundItems.push({ kon, file, source: readFileSync(join(dir, file), "utf-8") });
    }
  }

  return foundItems;
}

/** Classes whose rule declares `display`. Those are the ones that override the attribute. */
function classesWithDisplay(source: string): Set<string> {
  const classes = new Set<string>();

  for (const rule of source.matchAll(/\.([a-zA-Z0-9_-]+)[^{}]*\{([^}]*)\}/g)) {
    if (/(^|[;\s])display\s*:/.test(rule[2])) classes.add(rule[1]);
  }

  return classes;
}

/** Markup elements that carry `hidden` AND a class, in either order. */
function hiddenWithClass(source: string): string[] {
  const classes: string[] = [];

  for (const re of [
    /<[a-z0-9]+[^>]*\bclass="([^"]+)"[^>]*\bhidden\b/g,
    /<[a-z0-9]+[^>]*\bhidden\b[^>]*\bclass="([^"]+)"/g,
  ]) {
    for (const m of source.matchAll(re)) classes.push(...m[1].split(/\s+/));
  }

  return classes;
}

describe("the `hidden` attribute really hides", () => {
  const all = artifacts();

  it.skipIf(!HAS_INSTALLED_KONS)("artifacts to review were found", () => {
    /**
     * Without this, moving or renaming the `admin/` folder would leave the test
     * walking an empty list and passing green without looking at anything.
     */
    expect(all.length, "no view artifact was located").toBeGreaterThan(3);
  });

  for (const { kon, file: file, source } of all) {
    const usesHidden = /\bhidden\b/.test(source);
    if (!usesHidden) continue;

    it(`${kon}/${file}`, () => {
      const withDisplay = classesWithDisplay(source);
      const atRisk = [...new Set(hiddenWithClass(source))].filter((c) => withDisplay.has(c));

      // If nothing collides, nothing is required: the rule is only needed where it can
      // be overridden, and requiring it everywhere would be noise.
      if (atRisk.length === 0) return;

      expect(
        /\[hidden\]\s*\{[^}]*display\s*:\s*none[^}]*!important/.test(source),
        `The classes ${atRisk.map((c) => `.${c}`).join(", ")} declare their ` +
          `own \`display\` and are used with the \`hidden\` attribute, which on that ` +
          `element hides nothing: the browser stylesheet loses to the ` +
          `author's. The JS will keep setting the attribute with no error and no effect. ` +
          `Add \`[hidden] { display: none !important; }\` to the stylesheet of this ` +
          `artifact.`
      ).toBe(true);
    });
  }
});
