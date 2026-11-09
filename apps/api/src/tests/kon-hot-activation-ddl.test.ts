/**
 * Activating a kon on the fly, through the LIMITED DDL role
 * ============================================================================
 *
 * In production the API has no superuser: startup removes DATABASE_ADMIN_URL and leaves a limited
 * DDL role (DATABASE_DDL_URL, created by docker/start-with-check.sh: NOSUPERUSER, NOBYPASSRLS, CREATE
 * on the schema and nothing else). Switching a kon on from the panel applies its migrations with
 * that role. Nothing had ever run that path against a real Postgres. This does, with the same
 * grants as the startup script:
 *
 *   · the kon's tables are created, owned by the DDL role, and its history is written;
 *   · its row security is declared with the core's helpers (`kitsuden_rls_team`), which startup
 *     creates beforehand — the DDL role does not recreate them;
 *   · the role cannot alter a core table;
 *   · a migration renamed afterwards (declared in `history.json`) is adopted, not run again.
 */

import { mkdtempSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import pg from "pg";

import { db } from "../db";
import { applyKonMigrations } from "../lib/kon-migrations";
import { readSqlFile } from "../lib/sql-file";

import { isDatabaseAvailable } from "./setup";

const ROLE = "kitsuden_ddl_hot_test";
const PASSWORD = "ddl-hot-test-only";
const KON = "kon-hot-ddl-test";
const TABLE = "hot_ddl_items";

let hasBase = false;
let konDir: string;
const previous = {
  ddl: process.env.DATABASE_DDL_URL,
  admin: process.env.DATABASE_ADMIN_URL,
};

function urlFor(user: string, password: string): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function cleanup() {
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
  await db.execute(sql`DELETE FROM kitsuden_migrations WHERE name LIKE ${`${KON}/%`}`);
  await db.execute(
    sql.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'REASSIGN OWNED BY ${ROLE} TO CURRENT_USER';
        EXECUTE 'DROP OWNED BY ${ROLE}';
        EXECUTE 'DROP ROLE ${ROLE}';
      END IF;
    END $$`)
  );
}

beforeAll(async () => {
  hasBase = await isDatabaseAvailable();
  if (!hasBase) return;
  const url = new URL(process.env.DATABASE_URL as string);
  // Never against anything that is not a test database (AGENTS.md).
  if (!url.pathname.includes("test")) throw new Error("not a test database");
  await cleanup();

  // The core's agent functions and row-security helpers, as startup applies them (superuser).
  const functions = readSqlFile(
    resolve(import.meta.dir, "../db/agent-functions.sql"),
    "agent-functions.sql"
  );
  for (const stmt of functions.statements) await db.execute(sql.raw(stmt));

  // The limited DDL role, with exactly the grants of docker/start-with-check.sh.
  const dbName = url.pathname.slice(1);
  await db.execute(
    sql.raw(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`)
  );
  await db.execute(sql.raw(`GRANT CONNECT ON DATABASE "${dbName}" TO ${ROLE}`));
  await db.execute(sql.raw(`GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`));
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public TO ${ROLE}`
    )
  );
  await db.execute(sql.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`));

  // A kon whose migration uses the helpers.
  konDir = join(mkdtempSync(join(tmpdir(), "kon-hot-ddl-")), KON);
  mkdirSync(join(konDir, "migrations"), { recursive: true });
  writeFileSync(
    join(konDir, "kon.json"),
    JSON.stringify({ id: KON, name: "Hot DDL test", version: "0.1.0", tables: [{ name: TABLE }] })
  );
  writeFileSync(
    join(konDir, "migrations", "0000_first.sql"),
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id text PRIMARY KEY, status text NOT NULL);
SELECT kitsuden_rls_team('${TABLE}', 'hot-ddl-test', 'item:view', 'item:update');
SELECT kitsuden_rls_public_read('${TABLE}', $$status = 'published'$$);
`
  );

  process.env.DATABASE_DDL_URL = urlFor(ROLE, PASSWORD);
});

afterAll(async () => {
  if (previous.ddl === undefined) delete process.env.DATABASE_DDL_URL;
  else process.env.DATABASE_DDL_URL = previous.ddl;
  if (previous.admin === undefined) delete process.env.DATABASE_ADMIN_URL;
  else process.env.DATABASE_ADMIN_URL = previous.admin;
  if (hasBase) await cleanup();
});

describe("hot kon activation through the limited DDL role", () => {
  it("applies the kon's migrations with the DDL role, row security included", async () => {
    if (!hasBase) return;
    const r = await applyKonMigrations(KON, { installPath: konDir, declaredTables: [TABLE] });
    expect(r.connection).toBe("ddl");
    expect(r.applied).toEqual([`${KON}/0000_first.sql`]);
    expect(r.missingTables).toEqual([]);

    const owner = (await db.execute(
      sql`SELECT tableowner FROM pg_tables WHERE tablename = ${TABLE}`
    )) as unknown as { rows: { tableowner: string }[] };
    expect(owner.rows[0]?.tableowner).toBe(ROLE);

    const policies = (await db.execute(
      sql`SELECT policyname FROM pg_policies WHERE tablename = ${TABLE} ORDER BY policyname`
    )) as unknown as { rows: { policyname: string }[] };
    expect(policies.rows.map((p) => p.policyname)).toEqual([
      `${TABLE}_agent_changes`,
      `${TABLE}_agent_reads`,
      `${TABLE}_public_read`,
      `${TABLE}_team`,
    ]);

    const again = await applyKonMigrations(KON, { installPath: konDir });
    expect(again.applied).toEqual([]);
    expect(again.alreadyWere).toEqual([`${KON}/0000_first.sql`]);
  });

  it("the DDL role cannot alter a core table", async () => {
    if (!hasBase) return;
    const pool = new pg.Pool({ connectionString: urlFor(ROLE, PASSWORD), max: 1 });
    try {
      await expect(pool.query("ALTER TABLE modules ADD COLUMN hijack text")).rejects.toThrow(
        /must be owner/
      );
      await expect(pool.query("DROP TABLE modules")).rejects.toThrow(/must be owner/);
    } finally {
      await pool.end();
    }
  });

  it("a migration renamed later (history.json) is adopted, not run again", async () => {
    if (!hasBase) return;
    const dir = join(konDir, "migrations");
    renameSync(join(dir, "0000_first.sql"), join(dir, "0000_initial.sql"));
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify({ renamed: { "0000_initial.sql": "0000_first.sql" } })
    );
    const r = await applyKonMigrations(KON, { installPath: konDir });
    expect(r.applied).toEqual([]);
    expect(r.alreadyWere).toEqual([`${KON}/0000_initial.sql`]);

    const rows = (await db.execute(
      sql`SELECT name FROM kitsuden_migrations WHERE name LIKE ${`${KON}/%`}`
    )) as unknown as { rows: { name: string }[] };
    expect(rows.rows.map((x) => x.name)).toEqual([`${KON}/0000_initial.sql`]);
    expect(readFileSync(join(dir, "0000_initial.sql"), "utf8")).toContain(TABLE);
  });
});
