/**
 * What a kon declares in `admin.views` has to reach the panel
 * ============================================================================
 *
 * ── THE FAILURE ────────────────────────────────────────────────────────────
 *
 * `admin-registry.ts` converts each view in the `kon.json` into the object that
 * travels to the panel, copying FIELD BY FIELD:
 *
 *     const view = { id: raw.id, type, title: raw.title, table: raw.table };
 *     if (raw.groupBy !== undefined) view.groupBy = raw.groupBy;
 *     …
 *
 * What is not named there disappears. No error, no warning, no trace.
 *
 * `defaultFilter` was not there. It is the field that makes «Published» show the
 * published ones and «Drafts» the drafts, so both tabs requested the whole
 * table and showed the same thing: a draft post came out under
 * «Published».
 *
 * ── WHAT MAKES THIS CASE INSTRUCTIVE ───────────────────────────────────────
 *
 * It had already been «fixed» once. On the client, `generateExplorerConfig`
 * did not copy `defaultFilter` either; that was corrected, it was checked that the copy
 * was there, and the failure continued exactly the same — because the data never left
 * the server. The second half of the path was repaired while the first was still
 * cut, and the test at the time passed green guarding the wrong half.
 *
 * That is why this test does not look at a hand-written list: it READS the keys that the
 * kons really use and checks them against the ones the mapping mentions. If tomorrow
 * someone adds `defaultSort` to a `kon.json`, this fails until it is forwarded.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const REGISTRY = join(ROOT, "apps", "api", "src", "services", "admin-registry.ts");

/** The folders where the kons with manifests live. */
const ORIGINS = [join(ROOT, "packages", "kons"), join(ROOT, "packages", "core")];

/** Keys the mapping handles specially and that do not need literal forwarding. */
const STRUCTURALS = new Set(["id", "type", "title", "table", "component"]);

function keysUsedInViews(): Map<string, string[]> {
  const usages = new Map<string, string[]>();

  for (const origin of ORIGINS) {
    if (!existsSync(origin)) continue;

    for (const dir of readdirSync(origin)) {
      const manifest = join(origin, dir, "kon.json");
      if (!existsSync(manifest)) continue;

      let kon: { id?: string; admin?: { views?: Record<string, unknown>[] } };
      try {
        kon = JSON.parse(readFileSync(manifest, "utf-8"));
      } catch {
        continue;
      }

      const konId = kon.id || dir;
      for (const view of kon.admin?.views ?? []) {
        for (const key of Object.keys(view)) {
          usages.set(key, [...new Set([...(usages.get(key) ?? []), konId])]);
        }
      }
    }
  }

  return usages;
}

describe("the fields declared by the kons reach the panel", () => {
  const registry = readFileSync(REGISTRY, "utf-8");
  const used = keysUsedInViews();

  it("views to analyze were found", () => {
    expect(
      used.size,
      "no key of `admin.views` was read. If the shape of the " +
        "manifests changed, this test would pass empty without checking anything."
    ).toBeGreaterThan(4);
  });

  it("no used key gets lost along the way", () => {
    const lost: string[] = [];

    for (const [key, kons] of used) {
      if (STRUCTURALS.has(key)) continue;

      /**
       * Looks for `raw.<key>` — the shape the forwarding has. It is enough that
       * the mapping names it: if it names it, someone decided what to do with it.
       * What this chases is the oversight, not a specific signature.
       */
      if (!new RegExp(`raw\\.${key}\\b`).test(registry)) {
        lost.push(
          `«${key}» is declared by ${kons.join(", ")} and \`admin-registry.ts\` never ` +
            `mentions it, so it never leaves the server. The panel never sees it and ` +
            `there is no error: what the kon asked for simply does not happen.`
        );
      }
    }

    expect(lost, lost.join("\n\n")).toEqual([]);
  });

  it("`defaultFilter` travels, which is what separates one tab from another", () => {
    /**
     * The specific case, separately, so that if it breaks again the message says
     * exactly what is broken and not a generic failure.
     */
    expect(
      /raw\.defaultFilter\b/.test(registry),
      "without `defaultFilter`, «Published» and «Drafts» request the same table without " +
        "filtering and show the same thing: a draft appears under «Published»."
    ).toBe(true);
  });
});
