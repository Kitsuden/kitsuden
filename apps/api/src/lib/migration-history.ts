/**
 * Renamed and reworded migrations: `migrations/history.json`
 * ============================================================================
 *
 * The migration history is keyed by FILE NAME (`kon-shop/0002_secure_orders.sql`) and guarded by a
 * checksum of the file. Both are what make a chain reproducible, and both get in the way of an
 * honest cleanup: renaming a file makes it look new (it would run again on a database that already
 * has it), and translating a comment makes it look edited after being applied (the runner stops).
 *
 * A folder of migrations may carry a `history.json` that says what changed, explicitly:
 *
 *   {
 *     "renamed": { "0002_secure_orders.sql": "0002_pedidos_seguros.sql" },
 *     "previousChecksums": { "0002_secure_orders.sql": ["9f2c…", "41ab…"] }
 *   }
 *
 *   · `renamed` (new name → old name): a database that applied the OLD name is taken to have
 *     applied the new one, and its history row is renamed. The file does not run again. When a
 *     kon absorbs another, the old name is the other kon's full key:
 *     `"0006_deckshow_initial.sql": "kon-deckshow/0000_initial.sql"`.
 *   · `previousChecksums`: checksums the file had before its text changed without its SQL
 *     changing (a comment translated, a line ending). A history row with one of them is not drift,
 *     and is brought up to the current checksum.
 *
 * Nothing is guessed: a rename that is not declared is still a new migration, and a recorded
 * checksum that is not declared is still drift. Both runners use this module: the startup one
 * (scripts/migrate.ts) and the hot one (kon-migrations.ts), so neither re-applies what the other
 * adopted.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { sql, type SQL } from "drizzle-orm";

export interface MigrationHistoryFile {
  renamed?: Record<string, string>;
  previousChecksums?: Record<string, string[]>;
}

/** The part of a migration file this module reads. */
export interface NamedMigration {
  /** History key: `<folder>/<file>`. */
  name: string;
  /** Path on disk: its folder holds the `history.json`. */
  path: string;
  checksum: string;
}

/**
 * Read once per version of the file: keyed by path AND modification time, because the API is a
 * long-lived process and a kon can be updated under it (`kitsuden kon add --force`) before it is
 * switched on. A cache by path alone kept the first answer — "no history.json" — for good.
 */
const cache = new Map<string, { stamp: number; value: MigrationHistoryFile }>();

/** The `history.json` next to this migration, or an empty one. A malformed file is an error. */
export function historyOf(file: Pick<NamedMigration, "path">): MigrationHistoryFile {
  const path = join(dirname(file.path), "history.json");
  const stamp = existsSync(path) ? statSync(path).mtimeMs : -1;
  const hit = cache.get(path);
  if (hit && hit.stamp === stamp) return hit.value;
  let parsed: MigrationHistoryFile = {};
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as MigrationHistoryFile;
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [k, v] of Object.entries(parsed.renamed ?? {})) {
      // The old name is a file of this folder (`0002_x.sql`) or, when a kon absorbed another,
      // the full history key of the other kon's file (`kon-deckshow/0000_initial.sql`).
      if (
        typeof v !== "string" ||
        !/^\d{4}_.+\.sql$/.test(k) ||
        !/^([a-z0-9][a-z0-9-]*\/)?\d{4}_[^/]+\.sql$/.test(v)
      ) {
        throw new Error(
          `${path}: "renamed" maps file names with a 4-digit prefix (${k} → ${String(v)})`
        );
      }
    }
    for (const [k, v] of Object.entries(parsed.previousChecksums ?? {})) {
      if (!Array.isArray(v) || v.some((c) => typeof c !== "string")) {
        throw new Error(`${path}: "previousChecksums.${k}" must be a list of checksums`);
      }
    }
  }
  cache.set(path, { stamp, value: parsed });
  return parsed;
}

/** The history key this file had before it was renamed, or `null`. */
export function previousName(file: NamedMigration): string | null {
  const old = historyOf(file).renamed?.[basename(file.path)];
  if (!old) return null;
  // A full key: the file came from another kon's folder.
  if (old.includes("/")) return old;
  const folder = file.name.slice(0, file.name.lastIndexOf("/") + 1);
  return `${folder}${old}`;
}

/** Is this recorded checksum one the file is declared to have had? */
export function hadChecksum(file: NamedMigration, recorded: string): boolean {
  return historyOf(file).previousChecksums?.[basename(file.path)]?.includes(recorded) ?? false;
}

export interface AppliedRow {
  name: string;
  checksum: string;
}

/**
 * Renames, in the history, the rows of migrations that were applied under their old name. Returns
 * the names adopted. The row keeps its checksum unless it is a declared previous one, which is
 * updated to the current file's; any other checksum is left for the drift check to report.
 *
 * `execute` runs one statement on the connection that owns the history.
 */
export async function adoptRenamed<T extends AppliedRow>(
  files: NamedMigration[],
  applied: Map<string, T>,
  execute: (query: SQL) => Promise<unknown>
): Promise<string[]> {
  const adopted: string[] = [];
  for (const f of files) {
    if (applied.has(f.name)) continue;
    const old = previousName(f);
    const row = old ? applied.get(old) : undefined;
    if (!old || !row) continue;
    const checksum = hadChecksum(f, row.checksum) ? f.checksum : row.checksum;
    await execute(
      sql`UPDATE kitsuden_migrations SET name = ${f.name}, checksum = ${checksum} WHERE name = ${old}`
    );
    applied.delete(old);
    applied.set(f.name, { ...row, name: f.name, checksum });
    adopted.push(`${old} → ${f.name}`);
  }
  return adopted;
}
