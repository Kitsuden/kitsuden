#!/usr/bin/env bun
/**
 * Backups, with verification
 * ============================================================================
 *
 * WHY IT EXISTS
 *
 * There was none. No `pg_dump`, no retention, no written restore
 * procedure. For a product that stores third parties' data that is not
 * a missing feature: it is the risk that can take the company
 * down.
 *
 * THE PART ALMOST NOBODY DOES
 *
 * Each dump is VERIFIED right after it is written, by reading its index with
 * `pg_restore --list`. A backup that has never been read is not a backup: it is
 * a file. The day you find out it is corrupt is, by definition, the
 * worst possible day.
 *
 * FORMAT
 *
 * `-Fc` (custom): compressed, and it allows restoring single tables. A plain `.sql`
 * can only be restored whole.
 *
 * USAGE
 *   bun run scripts/backup.ts                  create (and verify)
 *   bun run scripts/backup.ts --list           list the backups (dumps and base backups)
 *   bun run scripts/backup.ts --verify <f>     re-verify one
 *   bun run scripts/backup.ts --restore <f>    restore (asks for confirmation)
 *   bun run scripts/backup.ts --base           base backup for point-in-time restore,
 *                                              if one is due (add --force to take it now)
 *
 * VARIABLES
 *   DATABASE_URL          required
 *   BACKUP_DIR            destination (default ./backups)
 *   BACKUP_KEEP           how many to keep (default 7)
 *   BACKUP_BASE_DAYS      days between base backups (default 7)
 *   BACKUP_BASE_KEEP      base backups kept (default 2, minimum 1)
 *   WAL_ARCHIVE_DIR       the WAL archive the database writes (default /wal-archive)
 *
 * POINT-IN-TIME RESTORE (`--base`, KITSUDEN_PITR=on)
 *
 * A dump restores the database as it was at ONE moment, the dump's. With the
 * database archiving every WAL segment (docker/wal-archive.sh) and a physical base
 * backup (`pg_basebackup`), Postgres can replay up to ANY moment after the base:
 * "the state at 10:41, just before the bad DELETE". The base lands in
 * `<BACKUP_DIR>/base/base-<stamp>/` (base.tar.gz, pg_wal.tar.gz, backup_manifest,
 * start-wal), is checked (both archives readable, backup_label inside), and the
 * WAL archive is pruned to what the OLDEST kept base needs, the same rule as
 * `pg_archivecleanup`. Restoring: docker/pitr-restore.sh and
 * docs/install/high-availability.md.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(process.env.BACKUP_DIR ?? "./backups");
const KEEP = Number(process.env.BACKUP_KEEP ?? 7);
const URL_BD = process.env.DATABASE_URL;

const PREFIX = "kitsuden-";
const EXT = ".dump";

const BASE_DIR = join(DIR, "base");
const BASE_PREFIX = "base-";
const WAL_DIR = resolve(process.env.WAL_ARCHIVE_DIR ?? "/wal-archive");
const BASE_DAYS = Number(process.env.BACKUP_BASE_DAYS ?? 7);
const BASE_KEEP = Math.max(1, Number(process.env.BACKUP_BASE_KEEP ?? 2));

function requireUrl(): string {
  if (!URL_BD || URL_BD === "lite") {
    console.error(
      "\n  ✗ DATABASE_URL pointing to a real Postgres is required.\n" +
        "    Lite mode (PGlite) stores data on local disk: copy it with the file\n" +
        "    system, not with pg_dump.\n"
    );
    process.exit(1);
  }
  return URL_BD;
}

/**
 * Checks that the tool exists BEFORE promising a backup.
 *
 * `pg_dump` must be of a version >= the server's; if it is lower it refuses to
 * dump. It is the most common failure when taking backups from a different machine.
 */
function requireTool(name: string) {
  const r = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (r.error) {
    console.error(
      `\n  ✗ Cannot find '${name}'. Install the PostgreSQL client.\n` +
        `    In the API container: apt-get install -y postgresql-client\n`
    );
    process.exit(1);
  }
  return (r.stdout || "").trim();
}

function stamp(): string {
  // No colons: Windows does not allow them in file names.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function list(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(EXT))
    .sort()
    .reverse();
}

function size(f: string): string {
  const b = statSync(join(DIR, f)).size;
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
}

/**
 * Reads the dump's index. If `pg_restore --list` cannot read it, the
 * file is no good — and it is much better to know now.
 */
function verify(route: string): { ok: boolean; objects: number; error?: string } {
  const r = spawnSync("pg_restore", ["--list", route], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { ok: false, objects: 0, error: (r.stderr || "").trim().split("\n")[0] };
  }
  const objects = (r.stdout || "").split("\n").filter((l) => l && !l.startsWith(";")).length;
  // A dump that reads but contains nothing is as useless as a broken one.
  if (objects === 0) return { ok: false, objects: 0, error: "the dump contains no objects" };
  return { ok: true, objects };
}

function prune() {
  const copies = list();
  const extras = copies.slice(KEEP);
  for (const f of extras) {
    unlinkSync(join(DIR, f));
    console.log(`  pruned  ${f}`);
  }
  if (extras.length > 0) {
    console.log(`  (keeping the ${KEEP} most recent; BACKUP_KEEP changes it)`);
  }
}

/**
 * The URL without its password, and the password in `PGPASSWORD`: on the
 * command line it showed in `ps` to every user of the host (security review
 * 2026-11-03).
 */
export function connection(raw: string): { url: string; env: NodeJS.ProcessEnv } {
  // Anything that is not a postgres URL (a `host=… password=…` keyword string,
  // a typo) is refused instead of being passed on as is: it would reach argv
  // with whatever secret it holds (security review F77).
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid postgresql:// URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must start with postgresql:// or postgres://");
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  // libpq also accepts `?password=` in the URL: it stays out of argv too.
  const fromQuery = parsed.searchParams.get("password");
  if (fromQuery !== null) parsed.searchParams.delete("password");
  const password = parsed.password ? decode(parsed.password) : fromQuery;
  parsed.password = "";
  return {
    url: parsed.toString(),
    env: password ? { ...process.env, PGPASSWORD: password } : process.env,
  };
}

function create() {
  const { url, env } = connection(requireUrl());
  console.log(`  ${requireTool("pg_dump")}`);
  requireTool("pg_restore");

  // A dump holds password hashes and the encrypted vault: owner only.
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const name = `${PREFIX}${stamp()}${EXT}`;
  const route = join(DIR, name);

  console.log(`\nDumping to ${name} …`);
  const t0 = Date.now();
  const r = spawnSync(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", "--file", route, url],
    {
      encoding: "utf8",
      stdio: ["ignore", "inherit", "pipe"],
      env,
    }
  );
  if (existsSync(route)) chmodSync(route, 0o600);

  if (r.status !== 0) {
    // Without this a half-written file that looks like a valid backup would remain.
    if (existsSync(route)) unlinkSync(route);
    console.error(`\n  ✗ pg_dump failed:\n    ${(r.stderr || "").trim()}\n`);
    process.exit(1);
  }

  const v = verify(route);
  if (!v.ok) {
    unlinkSync(route);
    console.error(
      `\n  ✗ The dump was written but CANNOT be read: ${v.error}\n    It has been deleted.\n`
    );
    process.exit(1);
  }

  console.log(`  ok  ${name}  (${size(name)}, ${v.objects} objects, ${Date.now() - t0}ms)`);
  console.log(`  verified with pg_restore --list`);
  prune();
}

function restore(file: string) {
  const url = requireUrl();
  requireTool("pg_restore");

  const route = file.includes("/") || file.includes("\\") ? file : join(DIR, file);
  if (!existsSync(route)) {
    console.error(`\n  ✗ Does not exist: ${route}\n`);
    process.exit(1);
  }

  const v = verify(route);
  if (!v.ok) {
    console.error(`\n  ✗ That dump is not readable: ${v.error}\n`);
    process.exit(1);
  }

  // Restoring OVERWRITES data. It must never happen through a tab-completion.
  if (!process.argv.includes("--yes-i-am-sure")) {
    const target = url.replace(/:\/\/[^@]*@/, "://***@");
    console.log(
      `\n  You are about to restore ${v.objects} objects onto:\n    ${target}\n\n` +
        `  This OVERWRITES the current data. If that is what you want, repeat with:\n` +
        `    bun run scripts/backup.ts --restore ${file} --yes-i-am-sure\n`
    );
    process.exit(1);
  }

  console.log(`\nRestoring ${route} …`);
  const r = spawnSync(
    "pg_restore",
    [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      connection(url).url,
      route,
    ],
    { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"], env: connection(url).env }
  );

  // pg_restore returns != 0 for benign warnings (objects that did not exist when
  // doing --clean). They are shown, but not treated as a failure.
  const err = (r.stderr || "").trim();
  if (err)
    console.log(
      `\n  pg_restore warnings:\n${err
        .split("\n")
        .slice(0, 12)
        .map((l) => "    " + l)
        .join("\n")}`
    );
  console.log(`\n  Restore finished. Now run the migrations:\n    bun run db:migrate\n`);
}

// ── Base backups (point-in-time restore) ─────────────────────────────────────

/** Complete base backups, newest first. A `.partial` directory is a crash mid-backup. */
function bases(): string[] {
  if (!existsSync(BASE_DIR)) return [];
  return readdirSync(BASE_DIR)
    .filter((f) => f.startsWith(BASE_PREFIX) && !f.endsWith(".partial"))
    .filter((f) => existsSync(join(BASE_DIR, f, "start-wal")))
    .sort()
    .reverse();
}

function baseDue(): boolean {
  const [newest] = bases();
  if (!newest) return true;
  const age = Date.now() - statSync(join(BASE_DIR, newest, "start-wal")).mtimeMs;
  return age >= BASE_DAYS * 86_400_000;
}

/** One value from the server, through psql (same password handling as pg_dump). */
function sqlValue(query: string): string {
  const { url, env } = connection(requireUrl());
  const r = spawnSync("psql", [url, "-tAX", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
    env,
  });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n")[0] || "psql failed");
  return (r.stdout || "").trim();
}

/**
 * Is the database archiving, and is the archive healthy? A base backup without
 * archived WAL after it restores to its own moment only: no better than a dump,
 * and much bigger. Better to fail here, loudly.
 */
function checkArchiving() {
  const mode = sqlValue("SHOW archive_mode");
  if (mode !== "on" && mode !== "always") {
    throw new Error(
      `the database has archive_mode=${mode}. Set KITSUDEN_PITR=on for the database service too and restart it (docs/install/high-availability.md).`
    );
  }
  const failing = sqlValue(
    "SELECT coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false) FROM pg_stat_archiver"
  );
  if (failing === "t") {
    const last = sqlValue(
      "SELECT last_failed_wal || ' at ' || last_failed_time FROM pg_stat_archiver"
    );
    throw new Error(
      `WAL archiving is failing (last failure: ${last}). Postgres keeps those segments in pg_wal until it succeeds: check the database log and the /wal-archive volume.`
    );
  }
}

/** `START WAL LOCATION: 0/2000028 (file 000000010000000000000002)` → the file name. */
export function startWalOf(backupLabel: string): string | null {
  const m = /START WAL LOCATION: .*\(file ([0-9A-F]{24})\)/.exec(backupLabel);
  return m ? m[1]! : null;
}

/**
 * Names in the WAL archive older than `startWal` (what the oldest kept base needs
 * first): segments and `.backup` files only. Timeline history files are tiny and
 * every restore needs them: never pruned. Same comparison as `pg_archivecleanup`.
 */
export function prunableWal(names: readonly string[], startWal: string): string[] {
  return names.filter((n) => /^[0-9A-F]{24}/.test(n) && n.slice(0, 24) < startWal);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: (r.stderr || "").trim() };
}

function createBase(force: boolean) {
  if (!force && !baseDue()) {
    console.log(`  base backup not due (every ${BASE_DAYS} days; --force takes one now)`);
    return;
  }
  const { url, env } = connection(requireUrl());
  console.log(`  ${requireTool("pg_basebackup")}`);
  requireTool("psql");

  try {
    checkArchiving();
  } catch (err) {
    console.error(`\n  ✗ No base backup: ${(err as Error).message}\n`);
    process.exit(1);
  }

  mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  const name = `${BASE_PREFIX}${stamp()}`;
  const final = join(BASE_DIR, name);
  const partial = `${final}.partial`;

  console.log(`\nBase backup to base/${name} …`);
  const t0 = Date.now();
  // -Ft -z: one gzip tar per tablespace plus pg_wal.tar.gz; -X stream: the WAL
  // written DURING the copy travels with it, so the base is consistent on its own.
  const r = run(
    "pg_basebackup",
    [
      "-d",
      url,
      "-D",
      partial,
      "-Ft",
      "-z",
      "-X",
      "stream",
      "--checkpoint=fast",
      "--label",
      `kitsuden ${name}`,
    ],
    env
  );
  if (!r.ok) {
    rmSync(partial, { recursive: true, force: true });
    console.error(`\n  ✗ pg_basebackup failed:\n    ${r.stderr}\n`);
    if (/replication/i.test(r.stderr)) {
      console.error(
        "    If it says «no pg_hba.conf entry for replication connection»: restart the\n" +
          "    database service once with KITSUDEN_PITR=on (docker/postgres-entrypoint.sh adds it).\n"
      );
    }
    process.exit(1);
  }

  // Checked like a dump: a backup nobody has read is a file, not a backup.
  const problems: string[] = [];
  for (const f of ["base.tar.gz", "pg_wal.tar.gz", "backup_manifest"]) {
    if (!existsSync(join(partial, f))) problems.push(`${f} missing`);
  }
  const label = problems.length
    ? null
    : run("tar", ["-xzOf", join(partial, "base.tar.gz"), "backup_label"]);
  const startWal = label?.ok ? startWalOf(label.stdout) : null;
  if (!problems.length && !startWal) problems.push("backup_label unreadable in base.tar.gz");
  if (!problems.length && !run("tar", ["-tzf", join(partial, "pg_wal.tar.gz")]).ok) {
    problems.push("pg_wal.tar.gz unreadable");
  }
  if (problems.length || !startWal) {
    rmSync(partial, { recursive: true, force: true });
    console.error(
      `\n  ✗ The base backup was written but does not check out: ${problems.join(", ")}\n`
    );
    process.exit(1);
  }

  writeFileSync(join(partial, "start-wal"), `${startWal}\n`, { mode: 0o600 });
  renameSync(partial, final);
  const mb = (f: string) => statSync(join(final, f)).size / 1024 / 1024;
  console.log(
    `  ok  base/${name}  (${(mb("base.tar.gz") + mb("pg_wal.tar.gz")).toFixed(1)} MB, starts at ${startWal}, ${Date.now() - t0}ms)`
  );

  pruneBases();
  writeFileSync(join(DIR, ".base-last-ok"), `${Math.floor(Date.now() / 1000)}\n`);
}

/** Keeps BACKUP_BASE_KEEP bases, then the WAL the oldest of them needs. */
function pruneBases() {
  const kept = bases();
  for (const old of kept.slice(BASE_KEEP)) {
    rmSync(join(BASE_DIR, old), { recursive: true, force: true });
    console.log(`  pruned  base/${old}`);
  }
  const oldest = kept.slice(0, BASE_KEEP).at(-1);
  if (!oldest || !existsSync(WAL_DIR)) return;
  const startWal = readFileSync(join(BASE_DIR, oldest, "start-wal"), "utf8").trim();
  const gone = prunableWal(readdirSync(WAL_DIR), startWal);
  for (const f of gone) unlinkSync(join(WAL_DIR, f));
  if (gone.length) console.log(`  pruned  ${gone.length} WAL file(s) older than ${startWal}`);
  // Point-in-time restore reaches back to the oldest kept base.
  console.log(`  restorable from base/${oldest} onwards`);
}

// ── Input ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const idx = (f: string) => args.indexOf(f);

if (!import.meta.main) {
  // Imported by a test for its pure helpers: no command runs.
} else if (args.includes("--list")) {
  const copies = list();
  if (copies.length === 0) {
    console.log(`\nNo backups in ${DIR}\n`);
  } else {
    console.log(`\n${copies.length} backup(s) in ${DIR}:\n`);
    for (const f of copies) console.log(`  ${f}  ${size(f)}`);
    console.log();
  }
  const baseCopies = bases();
  if (baseCopies.length > 0) {
    console.log(`${baseCopies.length} base backup(s) for point-in-time restore in ${BASE_DIR}:\n`);
    for (const f of baseCopies) {
      console.log(
        `  ${f}  starts at ${readFileSync(join(BASE_DIR, f, "start-wal"), "utf8").trim()}`
      );
    }
    console.log();
  }
} else if (args.includes("--base")) {
  createBase(args.includes("--force"));
} else if (idx("--verify") >= 0) {
  const f = args[idx("--verify") + 1];
  const route = f?.includes("/") || f?.includes("\\") ? f : join(DIR, f ?? "");
  const v = verify(route);
  console.log(
    v.ok ? `\n  ok  ${f} — ${v.objects} readable objects\n` : `\n  ✗  ${f} — ${v.error}\n`
  );
  process.exit(v.ok ? 0 : 1);
} else if (idx("--restore") >= 0) {
  restore(args[idx("--restore") + 1]);
} else {
  create();
}
