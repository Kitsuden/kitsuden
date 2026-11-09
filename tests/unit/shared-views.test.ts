/**
 * A component registered for several views has to know which one was clicked
 * ============================================================================
 *
 * ── THE FAILURE ────────────────────────────────────────────────────────────
 *
 * `GamesView.svelte` is registered for TWO views of the kon —«All Games» and
 * «Collections»— and has its own tabs inside. `GrimoirePage` mounted it
 * like this:
 *
 *     <CustomComponent />
 *
 * Passing it nothing. The component always opened on its «games» tab, so
 * clicking «Collections» highlighted the top tab and showed the list of
 * games. Nothing failed: it showed what it was not.
 *
 * It is exactly the same shape as «Scheduled» showing drafts, and as
 * «All Posts» without fetching all the posts. The tab says one thing and the
 * content is another, without a single error in between.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * 1. That the mount passes `viewId`.
 * 2. That every component registered for MORE THAN ONE view declares it as a prop.
 *    This is the one that matters: registering the same component for two views is
 *    a decision made on one line of the registry, far from the component,
 *    and nothing forces anyone to check whether it can tell them apart.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ADMIN = join(ROOT, "packages", "admin", "src");
const LOADER = join(ADMIN, "lib", "grimoire-loader.ts");
const PAGE = join(ADMIN, "lib", "components", "admin", "GrimoirePage.svelte");
const KONS = join(ROOT, "packages", "kons");

describe("custom views", () => {
  const loader = readFileSync(LOADER, "utf-8");
  const page = readFileSync(PAGE, "utf-8");

  it("the mount tells the component which view was clicked", () => {
    expect(
      /<CustomComponent\s+viewId=\{activeViewId\}/.test(page),
      "`GrimoirePage` must mount the custom view with `viewId`. " +
        "Without it, a component registered for several views cannot tell " +
        "which one was clicked and always opens on the same one."
    ).toBe(true);
  });

  it("every component used by several views declares `viewId`", () => {
    /**
     * ── WHY THE MANIFESTS ARE READ AND NOT JUST THE REGISTRY ────────────────
     *
     * The first version of this test grouped by component by counting the
     * registry KEYS, and flagged seven correct components.
     *
     * The reason: each kon appears with two key shapes —the bare kon one
     * (`kon-blog`, which is the fallback and resolves to its default view) and one
     * per view (`kon-blog-posts`)—. Counting them as two distinct views
     * turns the normal into a failure.
     *
     * And a guard that cries wolf over correct things is worse than not having one: you
     * learn to ignore it, and the day it points at something real it is
     * ignored too.
     *
     * The right question is: **of the views this kon DECLARES, how many
     * end up at the same component?** That is in its `kon.json`, so it is read
     * from there.
     */
    const inputs = new Map<string, string>();
    for (const m of loader.matchAll(/"([^"]+)":\s*\(\)\s*=>\s*import\("(\$[^"]+)"\)/g)) {
      inputs.set(m[1], m[2]);
    }
    expect(inputs.size, "view registry not found").toBeGreaterThan(5);

    const problems: string[] = [];

    for (const dir of readdirSync(KONS)) {
      const manifest = join(KONS, dir, "kon.json");
      if (!existsSync(manifest)) continue;

      let kon: {
        id?: string;
        admin?: { views?: Array<{ id: string; type?: string; title?: string }> };
      };
      try {
        kon = JSON.parse(readFileSync(manifest, "utf-8"));
      } catch {
        continue;
      }

      const konId = kon.id || dir;
      // Only `custom` views: the others are painted by the explorer, which already
      // receives its own configuration per view.
      const views = (kon.admin?.views ?? []).filter((v) => v.type === "custom");
      if (views.length < 2) continue;

      /** The same way the panel resolves: first the per-view key, then the kon's. */
      const componentOf = (viewId: string) => inputs.get(`${konId}-${viewId}`) ?? inputs.get(konId);

      const byComponent = new Map<string, string[]>();
      for (const v of views) {
        const comp = componentOf(v.id);
        if (!comp) continue;
        byComponent.set(comp, [...(byComponent.get(comp) ?? []), v.id]);
      }

      for (const [mod, ids] of byComponent) {
        if (ids.length < 2) continue;

        const route = join(ADMIN, mod.replace(/^\$views/, "views").replace(/^\$lib/, "lib"));
        if (!existsSync(route)) continue;

        if (!readFileSync(route, "utf-8").includes("viewId")) {
          problems.push(
            `${konId}: views ${ids.join(" and ")} are both rendered with ` +
              `${mod}, and that component does not declare \`viewId\`. It will always open ` +
              `on the same one, so one of the two will show content that does not ` +
              `match its name, with no error.`
          );
        }
      }
    }

    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("GamesView maps the view to its internal tab", () => {
    const games = readFileSync(join(ADMIN, "views", "games", "GamesView.svelte"), "utf-8");

    expect(games).toContain("function tabOf");

    /**
     * And it reacts to changes, not just to mounting: the panel's router
     * REUSES the component when navigating between views of the same kon. A value
     * computed once is stuck with the first one — the same failure that left the
     * data explorer tabs without reloading.
     */
    expect(
      games.includes("lastAppliedView"),
      "the view change has to be reflected even if the component is not" + "mounted again."
    ).toBe(true);
  });
});
