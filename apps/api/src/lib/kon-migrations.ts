/**
 * Hot migrations of a kon
 * ============================================================================
 *
 * ── THE FAILURE THIS REPLACES ──────────────────────────────────────────────
 *
 * Activating a kon from the panel NEVER created a table. Not once.
 *
 * `runKonMigrations` looked for exactly one file: `migrations/init.sql`.
 * No kon in the repo is named that — they all use `0000_initial.sql`,
 * `0001_members.sql`, `0003_diagrams.sql`. The function found nothing, exited
 * without a sound, and its caller marked the kon as enabled anyway:
 *
 *     try { await runModuleMigrations(key); }
 *     catch (err) { console.error(...); }        // ← and carried on
 *     await db.update(modules).set({ enabled: true });
 *
 * The result measured in the database: five kons with `enabled = true` and ZERO of their
 * tables. Academy declared eleven and none existed. From the panel this
 * looked like "No fields available" and like a 500 on every screen of the kon — never
 * like "this is not installed", which is what was really happening.
 *
 * ── A SINGLE IMPLEMENTATION ────────────────────────────────────────────────
 *
 * There were two ways to "apply a kon's migrations": this one and the one in the
 * startup runner (`scripts/migrate.ts`). Only one was exercised, and the other
 * rotted without anything noticing.
 *
 * Now both share discovery, chunking (`readSqlFile`) and the
 * history (`kitsuden_migrations`), and with the SAME name per file
 * —`kon-booking/0000_initial.sql`—, so neither re-applies what the
 * other did.
 *
 * ── WHY A SEPARATE CONNECTION IS NEEDED ────────────────────────────────────
 *
 * The API connects as `kitsuden_app`, a role WITHOUT the CREATE privilege on the
 * schema. This is deliberate: it is what makes RLS actually apply (Postgres
 * skips policies for a superuser). A `CREATE TABLE` with that role
 * fails, and it must fail.
 *
 * That is why migrations are applied over their own connection, opened and
 * closed within the same operation: the LIMITED DDL role (`DATABASE_DDL_URL`)
 * if it exists, otherwise the admin one (see lib/ddl-connection.ts: since
 * then the production image no longer leaves the superuser to the API). If neither is defined, the normal connection is tried and the
 * permission error is propagated with an explanation instead of turning into a
 * half-installed kon.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { db } from "../db";

import {
  HINT_WITHOUT_DDL,
  ddlConnectionConfigured,
  type DdlConnectionType,
} from "./ddl-connection";
import { installedKon, konRoute } from "./installed-kons";
import { adoptRenamed, type AppliedRow } from "./migration-history";
import { readSqlFile, type SqlFile } from "./sql-file";

/** Core agent SQL functions (see the file): before a kon's. */
const AGENT_FUNCTIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../db/agent-functions.sql"
);

const { Pool } = pg;

/** Minimal executor: works for both the app connection and an admin one. */
interface Executor {
  execute(query: ReturnType<typeof sql.raw>): Promise<unknown>;
}

export interface MigrationResult {
  konId: string;
  /** Files applied in this call. */
  applied: string[];
  /** Files that were already in the history. */
  alreadyWere: string[];
  /** Tables the manifest declares that still do not exist after migrating. */
  missingTables: string[];
  /** Which role they were applied with. For the diagnostic message. */
  connection: DdlConnectionType;
}

/**
 * Monorepo root: the folder that contains `packages/kons`.
 *
 * ── WHY LEVELS ARE NOT COUNTED ─────────────────────────────────────────────
 *
 * This used `resolve(dirname(…), "..", "..", "..", "..")`, four levels
 * up from `apps/api/src/lib`. And in development it is exact.
 *
 * In PRODUCTION it is not: the image runs `dist/index.js`, a single bundled
 * file. From `/app/apps/api/dist`, four levels up is `/`, so
 * it looked for migrations in `/packages/kons/<kon>/migrations` — a path
 * that does not exist. The result was this message, with the file right in front of it:
 *
 *     'kon-character-builder' has no migration files, so nothing creates its tables
 *
 * And it was a lie: `0001_builder.sql` was in the repo AND inside the image.
 * It was simply looking where it was not. A failure that ONLY shows up compiled,
 * which is the worst kind: in development everything works and the kon cannot be activated
 * exactly where it matters.
 *
 * ── HOW IT IS RESOLVED NOW ─────────────────────────────────────────────────
 *
 * It walks up from two starting points —the module itself and the working
 * directory— until it finds a folder that contains `packages/kons`. That works
 * the same from source, from a bundle at any depth and from a
 * script launched in a subdirectory, because it assumes nothing about the shape of the
 * tree: it checks.
 *
 * `fileURLToPath(import.meta.url)` and not `import.meta.dir`: the latter is Bun-specific
 * and under Node it is `undefined`.
 */
let cacheRoot: string | null = null;

function repoRoot(): string {
  if (cacheRoot) return cacheRoot;

  const marker = (dir: string) => existsSync(join(dir, "packages", "kons"));

  const matches = [dirname(fileURLToPath(import.meta.url)), process.cwd()];

  for (const match of matches) {
    let dir = resolve(match);
    // The ceiling is the system root: `dirname("/")` returns `"/"`.
    for (let i = 0; i < 30; i++) {
      if (marker(dir)) {
        cacheRoot = dir;
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  /**
   * Without a marker no path is invented: the working directory is returned,
   * which is what the kon loader uses and what was correct in the
   * container. And `migrationsDir` will return `null`, which the caller
   * already knows how to tell apart from "there are migrations and they failed".
   */
  cacheRoot = process.cwd();
  return cacheRoot;
}

/** For tests: forget the cached root. */
export function cleanRootCache(): void {
  cacheRoot = null;
}

/**
 * Migrations folder of a kon.
 *
 * Accepts the id with and without the `kon-` prefix because manifests are not
 * consistent: `kon.json` declares `"id": "kon-games"` but the `modules` table
 * stores `games` for that same kon.
 */
export function migrationsDir(konId: string, installPath?: string): string | null {
  // Without an explicit path, that of the INSTALLED kon (kitsuden.kons.json /
  // KITSUDEN_KONS), which may be in packages/kons, in node_modules or linked
  // from another repo. The two in packages/kons remain as a fallback.
  // Core ones (packages/core) are migrated by the runner under its own name
  // in the history (`core-<package>/…`): they are not touched here.
  if (!installPath && installedKon(konId)?.source === "core") return null;
  const installed = installPath ?? konRoute(konId);
  const candidates = installed
    ? [join(installed, "migrations")]
    : [
        join(repoRoot(), "packages", "kons", konId, "migrations"),
        join(repoRoot(), "packages", "kons", `kon-${konId}`, "migrations"),
      ];

  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * A kon's `.sql` files, in order and with the name they go into the history under.
 *
 * The 4-digit numeric prefix is mandatory, same as in the startup
 * runner: without it the order would be whatever `readdir` gives, which is not an order.
 */
export function migrationsOf(konId: string, installPath?: string): SqlFile[] {
  const dir = migrationsDir(konId, installPath);
  if (!dir) return [];

  // The name in the history ALWAYS uses the real folder, not the id, so that it
  // matches what `scripts/migrate.ts` writes.
  const dirName = dir.split(/[\\/]/).at(-2)!;

  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      if (!/^\d{4}_/.test(f)) {
        throw new Error(
          `${dirName}/${f} has no 4-digit numeric prefix. Without it, the ` +
            `apply order would be arbitrary and not reproducible.`
        );
      }
      return readSqlFile(join(dir, f), `${dirName}/${f}`);
    });
}

async function createHistoryTable(executor: Executor): Promise<void> {
  await executor.execute(
    sql.raw(`
      CREATE TABLE IF NOT EXISTS kitsuden_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER,
        baselined   BOOLEAN NOT NULL DEFAULT false
      )
    `)
  );
}

async function alreadyApplied(executor: Executor): Promise<Map<string, AppliedRow>> {
  const res = (await executor.execute(
    sql.raw(`SELECT name, checksum FROM kitsuden_migrations`)
  )) as unknown as { rows?: AppliedRow[] } | AppliedRow[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return new Map(rows.map((f) => [f.name, f]));
}

/**
 * Which tables of this list already exist?
 *
 * It is queried with the NORMAL connection on purpose: what matters is whether the API
 * —with its role— can see the table. A table created by the admin and without
 * permissions for `kitsuden_app` is as broken as one that does not exist, and this is
 * the only place where that difference is noticed before the user sees it.
 */
export async function existingTables(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  const list = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
  const res = (await db.execute(
    sql.raw(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN (${list})`
    )
  )) as unknown as { rows?: { table_name: string }[] } | { table_name: string }[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return new Set(rows.map((f) => f.table_name));
}

/**
 * Opens an admin connection if the environment offers one.
 *
 * Also returns how to close it: leaving a pool open for each kon installation
 * exhausts the server's connections, and the symptom would appear much later
 * and elsewhere.
 */
function connectionToMigrate(): {
  executor: Executor;
  close: () => Promise<void>;
  type: DdlConnectionType;
} {
  // Limited DDL role before superuser: see lib/ddl-connection.ts.
  const configured = ddlConnectionConfigured();

  if (!configured) {
    return { executor: db as unknown as Executor, close: async () => {}, type: "app" };
  }

  const pool = new Pool({ connectionString: configured.url, max: 1 });
  const connection = drizzle(pool);
  return {
    executor: connection as unknown as Executor,
    close: () => pool.end(),
    type: configured.type,
  };
}

/**
 * Explains a "permission denied" instead of leaving it bare.
 *
 * It lives apart because the first version put this hint ONLY inside the statement
 * loop, and the most likely failure happens BEFORE: creating the history
 * table. Without `DATABASE_ADMIN_URL`, activating a kon returned
 *
 *     Failed query: CREATE TABLE IF NOT EXISTS kitsuden_migrations (…)
 *
 * which is technically noisy and says nothing: neither what is missing nor what to do. An
 * error with no way out is almost as costly as a silent failure.
 */
function withDiagnosis(e: unknown, type: DdlConnectionType, context: string): Error {
  /**
   * The REAL reason is in `cause`, not in `message`.
   *
   * Drizzle wraps the Postgres error and its `message` is just
   * `Failed query: CREATE TABLE …` — the `permission denied for schema public`
   * and the `42501` code live in `cause`. Looking for the hint only in
   * `message` found nothing and the diagnostic never showed up, which is
   * how this was discovered.
   */
  const causa = (e as { cause?: { message?: string; code?: string } })?.cause;
  const detail = e instanceof Error ? e.message : String(e);
  const reason = [detail, causa?.message].filter(Boolean).join(" — ");
  const code = causa?.code ?? (e as { code?: string })?.code;

  const withoutPermission = code === "42501" || /permission denied|must be owner/i.test(reason);
  const hint = !withoutPermission
    ? ""
    : type === "app"
      ? HINT_WITHOUT_DDL
      : type === "ddl"
        ? `\n\n  The limited DDL role (DATABASE_DDL_URL) only creates new objects: this` +
          `\n  migration touches something that is not its own (a core table, an extension).` +
          `\n  Apply it with the admin account, outside the API process:` +
          `\n\n      bun run scripts/migrate.ts --kon <id>   (or restart the container)\n`
        : "";

  return new Error(`${context}\n  ${reason}${hint}`);
}

/**
 * Applies a kon's pending migrations.
 *
 * Throws if any fails. The caller must NOT swallow that error: a kon whose
 * migrations failed is not installed, and marking it as enabled produces
 * exactly the state that motivated this file.
 */
export async function applyKonMigrations(
  konId: string,
  options: { installPath?: string; declaredTables?: string[] } = {}
): Promise<MigrationResult> {
  const files = migrationsOf(konId, options.installPath);
  const { executor, close, type: type } = connectionToMigrate();

  const applied: string[] = [];
  const alreadyWere: string[] = [];

  try {
    let history: Map<string, AppliedRow>;
    try {
      await createHistoryTable(executor);
      history = await alreadyApplied(executor);
      // A file renamed after being applied (its folder's `history.json`) is not run again: its
      // history row takes the new name, the same as the startup runner does.
      await adoptRenamed(files, history, (q) => executor.execute(q as ReturnType<typeof sql.raw>));
    } catch (e) {
      throw withDiagnosis(
        e,
        type,
        `Could not prepare the migration history to install '${konId}'.`
      );
    }

    let readyFunctions = false;
    for (const f of files) {
      if (history.has(f.name)) {
        alreadyWere.push(f.name);
        continue;
      }

      // The core agent functions, before the first migration of the
      // kon being applied: its policies may use them.
      // With the limited DDL role they are not redone: startup creates them (migrate.ts,
      // superuser) and their owner is someone else; a CREATE OR REPLACE would give "must be owner".
      if (!readyFunctions && type !== "ddl") {
        for (const stmt of readSqlFile(AGENT_FUNCTIONS, "agent-functions.sql").statements) {
          try {
            await executor.execute(sql.raw(stmt));
          } catch (e) {
            throw withDiagnosis(e, type, `agent-functions.sql failed before migrating '${konId}'`);
          }
        }
        readyFunctions = true;
      }

      const t0 = Date.now();
      for (const [i, stmt] of f.statements.entries()) {
        try {
          await executor.execute(sql.raw(stmt));
        } catch (e) {
          const first = stmt.split("\n")[0]!.slice(0, 90);
          throw withDiagnosis(
            e,
            type,
            `${f.name} failed at statement ${i + 1}/${f.statements.length}\n  ${first}…`
          );
        }
      }

      await executor.execute(
        sql.raw(
          `INSERT INTO kitsuden_migrations (name, checksum, duration_ms)
             VALUES ('${f.name}', '${f.checksum}', ${Date.now() - t0})
           ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum`
        )
      );
      applied.push(f.name);
    }
  } finally {
    await close();
  }

  // Migrating without error does not guarantee the kon has its tables: it may bring no
  // migrations, or incomplete ones. It is checked against what the
  // manifest declares, which is the only explicit promise the kon makes.
  const declaredMany = options.declaredTables ?? [];
  const exist = await existingTables(declaredMany);
  const missingTables = declaredMany.filter((t) => !exist.has(t));

  return { konId, applied, alreadyWere, missingTables, connection: type };
}
