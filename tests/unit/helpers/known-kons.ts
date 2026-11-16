/**
 * Which kons exist for the core guards
 * ============================================================================
 *
 * Kons live in the kitsuden-kons repo and are installed in packages/kons/<kon>/
 * (`kitsuden kon add`). The core kon guards check what is INSTALLED; in
 * a clean clone nothing is installed and those that only assert «there are kons
 * to review» are skipped (the same guards run over all the kons in
 * kitsuden-kons, tests/guards).
 *
 * To check that a kon NAME exists (grimoires, panel links) without
 * having it installed, the sibling checkout ../kitsuden-kons is consulted, if present.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

function idsIn(dir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const f of ["kon.json", "package.json"]) {
      const p = join(dir, e.name, f);
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        const id = f === "kon.json" ? j.id : j.kitsuden?.id;
        if (typeof id === "string") ids.add(id);
        if (f === "kon.json" && typeof id === "string") break;
      } catch {
        // unreadable manifest: the manifest guards report it
      }
    }
  }
  return ids;
}

/** Installed kons (copies in packages/kons) and core modules (packages/core). */
export const INSTALLED_KONS = new Set([
  ...idsIn(join(ROOT, "packages", "kons")),
  ...idsIn(join(ROOT, "packages", "core")),
]);

/** Is any kon installed besides the core ones? */
export const HAS_INSTALLED_KONS = idsIn(join(ROOT, "packages", "kons")).size > 0;

/**
 * How many kons `kitsuden.kons.json` declares AND have their folder in packages/kons.
 *
 * The guards that ask «are there kons to review?» used to expect more than 20: true when
 * all of kitsuden-kons was installed, false with any partial install (15 kons failed five
 * guards that had nothing wrong). Comparing with what is declared still catches a broken
 * discovery, which is what those checks are for, whatever the number installed.
 */
export const DECLARED_INSTALLED_KONS: number = (() => {
  const file = join(ROOT, "kitsuden.kons.json");
  if (!existsSync(file)) return 0;
  try {
    const kons = JSON.parse(readFileSync(file, "utf8"))?.kons ?? {};
    return Object.keys(kons).filter((id) => existsSync(join(ROOT, "packages", "kons", id))).length;
  } catch {
    return 0;
  }
})();

/** The floor for «there are kons to review»: every declared kon, and at least one. */
export const MIN_KONS_TO_REVIEW = Math.max(1, DECLARED_INSTALLED_KONS);

/** The kons of the sibling kitsuden-kons checkout, or `null` if it is not there. */
export const SIBLING_REPO_KONS: Set<string> | null = existsSync(
  join(ROOT, "..", "kitsuden-kons", "kons")
)
  ? idsIn(join(ROOT, "..", "kitsuden-kons", "kons"))
  : null;

/**
 * Is this id a kon that exists? Installed or core: yes. Otherwise the
 * sibling repo says so; without it there is no way to know and it is taken as good (`unknown`).
 */
export function konStatus(id: string): "exists" | "does-not-exist" | "unknown" {
  if (INSTALLED_KONS.has(id)) return "exists";
  if (SIBLING_REPO_KONS) return SIBLING_REPO_KONS.has(id) ? "exists" : "does-not-exist";
  return "unknown";
}
