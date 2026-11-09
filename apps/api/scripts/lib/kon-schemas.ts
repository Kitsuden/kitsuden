/**
 * The Drizzle schemas of the kons that are ACTIVE
 * ============================================================================
 *
 * It serves the startup schema verifier, which until now only looked at
 * `schema-core.ts` and so did not notice that `game_collections` was missing two
 * declared columns.
 *
 * ── WHAT COUNTS AS «ACTIVE» ────────────────────────────────────────────────
 *
 * The union of two sources, because in this repo there are two and they do not match:
 *
 *   · `kitsuden.config.ts` — what the factory installation ships.
 *   · the `modules` table   — what the user turned on from the panel.
 *
 * Looking only at the first was the origin of the state that motivated all this: five
 * kons turned on from the panel, none migrated, because the startup runner
 * read the file and the panel wrote to the database.
 *
 * ── WHY THE FILE IS IMPORTED AND NOT READ AS TEXT ──────────────────────────
 *
 * Because what is needed are the `pgTable` objects with their columns, and only the evaluated
 * module gives that. Importing a kon's schema is cheap: they are
 * definitions, not connections.
 *
 * An import that fails does NOT stop startup. A kon's schema may
 * depend on something unavailable in this context, and being left unverified
 * is worse than not starting because of a check.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import { db } from "../../src/db";
import { installedKon, listInstalledKons } from "../../src/lib/installed-kons";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface KonSchema {
  kon: string;
  mod: Record<string, unknown>;
}

/** Kons marked as active in the `modules` table, if that table already exists. */
async function enabledInDatabase(): Promise<string[]> {
  try {
    const res = await db.execute(sql.raw(`SELECT key FROM modules WHERE enabled = true`));
    const rows =
      (res as unknown as { rows?: { key: string }[] }).rows ??
      (res as unknown as { key: string }[]);
    return (rows ?? []).map((f) => f.key);
  } catch {
    // First startup: the table does not exist yet. It is not an error.
    return [];
  }
}

/** Kons that the configuration declares enabled. */
async function enabledInConfiguration(): Promise<string[]> {
  try {
    const config = await import(resolve(HERE, "..", "..", "kitsuden.config.ts"));
    const staticConfig = config.staticConfig ?? config.default ?? config;
    return staticConfig.kons ?? staticConfig.modules ?? [];
  } catch {
    return [];
  }
}

/**
 * A kon's schema file.
 *
 * There is no single convention —`dms.schema.ts`, `members.schema.ts`,
 * `src/schema.ts`—, so it is found by pattern instead of building the name.
 * Building it would have failed silently for all that did not fit, which
 * is exactly the failure mode this check exists to close.
 */
function schemaFile(dir: string): string | null {
  const candidates = [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".schema.ts"))
      .map((f) => join(dir, f)),
    join(dir, "src", "schema.ts"),
    join(dir, "schema.ts"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * All the kons in the repository, active or not.
 *
 * For CI, together with `migrate.ts --all-kons`. An off kon has its
 * migration chain run by nobody until a user activates it
 * on a server — which is where the three kons whose SQL schema
 * did not exist and the two whose SQL did not even parse were discovered.
 */
function allKons(): string[] {
  // The INSTALLED ones (kitsuden.kons.json + KITSUDEN_KONS), not the folder.
  return listInstalledKons()
    .filter((k) => k.source !== "core" && k.path)
    .map((k) => k.id);
}

export async function activeKonSchemas(): Promise<KonSchema[]> {
  const active = new Set(
    // `--todos-los-kons`: the earlier spelling of the flag, kept as an alias.
    process.argv.includes("--all-kons") || process.argv.includes("--todos-los-kons")
      ? allKons()
      : [...(await enabledInConfiguration()), ...(await enabledInDatabase())]
  );

  const schemas: KonSchema[] = [];

  for (const id of active) {
    const kon = installedKon(id);
    if (!kon || kon.source === "core" || !kon.path) continue;
    const dir = kon.path;

    const file = schemaFile(dir);
    if (!file) continue;

    try {
      const mod = (await import(file)) as Record<string, unknown>;
      schemas.push({ kon: id, mod });
    } catch (err) {
      console.warn(
        `   ⚠  Could not read the schema of ${id} ` +
          `(${err instanceof Error ? err.message : err}). Their tables are not verified.`
      );
    }
  }

  return schemas;
}
