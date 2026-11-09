/**
 * Reading a grimoire's manifest — with the legacy fallback BOUNDED
 * ============================================================================
 *
 * In `packages/grimoires/<id>/` TWO manifests coexist that are NOT the same:
 *
 *   grimoire.json → the grimoire.  type: "grimoire", id: "grimoire-corporate",
 *                                 kons, optional_kons, konConfig, seed
 *   kitsuden.json → the THEME.     type: "theme",    id: "kitsuden-corporate",
 *                                 css_entry, theme_type
 *
 * Six different places read the second as a fallback for the first, in the
 * form `grimoire.json || kitsuden.json`. And the theme fits just enough to
 * sneak in: it has `id`, `name` and `version`, so no validation fired.
 * What it lacks is `kons`. The result of a missing or unreadable
 * `grimoire.json` was not an error, it was a grimoire registered with the THEME's id
 * (`kitsuden-corporate` instead of `grimoire-corporate`) and with ZERO kons mounted.
 * A total, silent failure with every appearance of having gone fine.
 *
 * The fallback is kept —there are old grimoires that only bring
 * `kitsuden.json`— but now it is only accepted if what is inside is truly a
 * grimoire. A `type: "theme"` is rejected.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The types a manifest declares in Kitsuden. */
const KNOWN_TYPES = new Set(["grimoire", "kon", "module", "theme"]);

export interface GrimoireManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  kons?: string[];
  optional_kons?: string[];
  bundled_modules?: string[];
  [key: string]: unknown;
}

/**
 * Is this JSON the manifest of the expected type?
 *
 * A manifest WITHOUT `type` is accepted: it is the legacy form and there is no
 * reason to break it. What is rejected is one that declares itself as something else.
 */
export function manifestIsOfType(json: unknown, expected: "grimoire" | "kon"): boolean {
  if (!json || typeof json !== "object") return false;

  const m = json as GrimoireManifest;
  if (typeof m.id !== "string" || m.id.length === 0) return false;

  const type = typeof m.type === "string" ? m.type : null;
  if (type === null) return true; // legacy: no `type` declared
  if (!KNOWN_TYPES.has(type)) return true; // foreign type: not ours to judge

  return expected === "kon" ? type === "kon" || type === "module" : type === "grimoire";
}

/**
 * Reads the manifest of the grimoire found in `dirGrimoire`.
 *
 * Returns `null` if none is usable. Broken JSON or a manifest that turns out
 * to be the theme's are reported on the console: they are states that someone
 * has to fix, not normal program paths.
 */
export async function readGrimoireManifest(dirGrimoire: string): Promise<GrimoireManifest | null> {
  for (const name of ["grimoire.json", "kitsuden.json"]) {
    const route = join(dirGrimoire, name);

    let raw: string;
    try {
      raw = await readFile(route, "utf8");
    } catch {
      continue; // does not exist: normal, kitsuden.json is optional
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      console.warn(`[Grimoire] ${route} is not valid JSON: ${(err as Error).message}`);
      continue;
    }

    if (!manifestIsOfType(json, "grimoire")) {
      // kitsuden.json being the theme is EXPECTED, not a warning.
      if (name !== "kitsuden.json") {
        console.warn(`[Grimoire] ${route} is not a grimoire manifest; ignored.`);
      }
      continue;
    }

    return json as GrimoireManifest;
  }

  return null;
}

/**
 * Kons that a grimoire ships bundled (the required ones, not the optional ones).
 */
export async function readGrimoireKons(dirGrimoire: string): Promise<string[]> {
  const manifest = await readGrimoireManifest(dirGrimoire);
  if (!manifest) return [];
  return manifest.kons || manifest.bundled_modules || [];
}

// ═══════════════════════════════════════════════════════════════════════════
// MANIFEST OF A KON
// ═══════════════════════════════════════════════════════════════════════════

export interface KonManifest {
  id: string;
  name: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Reads the `kon.json` of a directory.
 *
 * It lives here and not in module-loader for two reasons. One: it is the same
 * operation as the one for grimoires and shares the type check. Two, and more
 * important: module-loader pulls in `../db` and uses `Bun.file`, so its
 * version can NOT be exercised from the vitest suite — and a manifest read
 * that nobody can test is exactly the kind that filled up with `catch {}`.
 *
 * "There is no kon.json" is normal and returns null silently. "It exists but
 * is broken" or "it exists but declares something else" are faults, and they warn.
 */
export async function readKonJsonManifest(dirKon: string): Promise<KonManifest | null> {
  const route = join(dirKon, "kon.json");

  let raw: string;
  try {
    raw = await readFile(route, "utf8");
  } catch {
    return null; // does not exist: most directories are not kons
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.warn(`  ⚠️  ${route} is not valid JSON: ${(err as Error).message}`);
    return null;
  }

  if (!manifestIsOfType(json, "kon")) {
    console.warn(`  ⚠️  ${route} does not declare a kon; ignored.`);
    return null;
  }

  return json as KonManifest;
}
