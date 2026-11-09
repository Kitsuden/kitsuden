/**
 * The SQL file splitter.
 *
 * The whole migrations runner depends on this: if it splits wrongly, a `DO $$ … $$`
 * reaches Postgres in pieces and the migration fails for a reason that has
 * nothing to do with its SQL. It already happened twice while it was being built —once with
 * dollar-quoted bodies, once with drizzle's own separator— and
 * that is why there are tests.
 */

import { describe, it, expect } from "bun:test";

import { readSqlFile, splitStatements } from "../lib/sql-file";

describe("simple statements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("SELECT 1;\nSELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("drops comments and blank lines", () => {
    const r = splitStatements("-- a comment\n\nSELECT 1;\n-- another\nSELECT 2;");
    expect(r).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("keeps a final statement without a semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("an empty file produces no statements", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("-- comments only\n\n")).toEqual([]);
  });

  it("cuts even if the semicolon has a comment after it", () => {
    // Found while running rls-policies.sql: the line
    // `ALTER TABLE x FORCE ROW LEVEL SECURITY; -- note` does not end in `;`, so
    // that was merged with the next statement and Postgres received both
    // things together.
    const r = splitStatements(
      "ALTER TABLE x FORCE ROW LEVEL SECURITY; -- applies to the owner\nSELECT 1;"
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toContain("ALTER TABLE x");
    expect(r[1]).toContain("SELECT 1");
  });

  it("a `--` inside a string is NOT a comment", () => {
    // If it were trimmed here, the statement would be cut in the middle of the string.
    const r = splitStatements("SELECT '-- not a comment' AS t\nFROM x;");
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("FROM x");
  });

  it("escaped quotes ('') do not throw off detection", () => {
    const r = splitStatements("SELECT 'it''s fine'; -- note\nSELECT 2;");
    expect(r).toHaveLength(2);
  });
});

describe("dollar-quoted bodies", () => {
  it("does NOT split on the semicolons inside a DO", () => {
    // This is the original failure: splitting here hands Postgres an unclosed `DO $$`
    // and an orphan `END $$;`.
    const sql = `DO $$
BEGIN
  CREATE TYPE x AS ENUM ('a');
  RAISE NOTICE 'done';
END $$;`;
    const r = splitStatements(sql);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("RAISE NOTICE");
  });

  it("handles several consecutive blocks", () => {
    const sql = `DO $$ BEGIN CREATE TYPE a AS ENUM ('x'); END $$;
DO $$ BEGIN CREATE TYPE b AS ENUM ('y'); END $$;`;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it("a $$ tag INSIDE a $POLICY$ is content, not a delimiter", () => {
    // The previous version counted markers without remembering which one opened: this
    // case threw off the counter and from then on it split the
    // ENTIRE file wrongly, not just this statement.
    const sql = `DO $POLICY$
BEGIN
  EXECUTE format($$ SELECT 1 $$);
END $POLICY$;
SELECT 'next one';`;
    const r = splitStatements(sql);
    expect(r).toHaveLength(2);
    expect(r[0]).toContain("$POLICY$");
    expect(r[1]).toContain("next one");
  });

  it("a function body with several ; stays whole", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$
BEGIN
  UPDATE t SET a = 1;
  UPDATE t SET b = 2;
END;
$$ LANGUAGE plpgsql;`;
    expect(splitStatements(sql)).toHaveLength(1);
  });
});

describe("drizzle separator", () => {
  it("uses --> statement-breakpoint when present", () => {
    // Drizzle lines end in `;--> statement-breakpoint`, not in `;`,
    // so the semicolon heuristic saw the whole file as ONE
    // statement and handed it to Postgres in one piece.
    const sql = `DO $$ BEGIN CREATE TYPE a AS ENUM ('x'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE t (id int);--> statement-breakpoint
CREATE TABLE u (id int);`;
    const r = splitStatements(sql);
    expect(r).toHaveLength(3);
    expect(r[0]).toContain("CREATE TYPE a");
    expect(r[1]).toContain("CREATE TABLE t");
    expect(r[2]).toContain("CREATE TABLE u");
  });

  it("leaves no empty fragments", () => {
    const sql = `SELECT 1;--> statement-breakpoint\n--> statement-breakpoint\nSELECT 2;`;
    expect(splitStatements(sql).every((s) => s.trim().length > 0)).toBe(true);
  });
});

describe("the repository's real migrations", () => {
  const cases = [
    ["drizzle/0000_amusing_lethal_legion.sql", "../../drizzle/0000_amusing_lethal_legion.sql"],
    [
      "migrations/0029_rename_kitsuden_and_kons.sql",
      "../db/migrations/0029_rename_kitsuden_and_kons.sql",
    ],
    ["migrations/0022_critical_features.sql", "../db/migrations/0022_critical_features.sql"],
  ] as const;

  for (const [name, rel] of cases) {
    it(`${name} is split into several statements`, async () => {
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const path = resolve(dirname(fileURLToPath(import.meta.url)), rel);
      const f = readSqlFile(path, name);

      // The symptom of broken splitting is exactly this: a single GIANT
      // statement with the whole file inside.
      expect(f.statements.length).toBeGreaterThan(1);
      expect(f.checksum).toMatch(/^[0-9a-f]{16}$/);
      // And no statement should be left empty.
      expect(f.statements.every((s) => s.trim().length > 0)).toBe(true);
    });
  }

  it("0029 keeps its DO blocks whole", async () => {
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../db/migrations/0029_rename_kitsuden_and_kons.sql"
    );
    const f = readSqlFile(path, "0029");

    // Each DO block has to be complete: if one opens and does not close, the
    // splitting broke it.
    for (const s of f.statements) {
      const opens = (s.match(/DO \$\$/g) ?? []).length;
      const closes = (s.match(/END \$\$/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

describe("checksum", () => {
  it("changes if the content changes", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "kits-sql-"));
    const p = join(dir, "0001_x.sql");

    writeFileSync(p, "SELECT 1;");
    const a = readSqlFile(p, "0001_x.sql").checksum;
    writeFileSync(p, "SELECT 2;");
    const b = readSqlFile(p, "0001_x.sql").checksum;

    // It is what makes it possible to detect that an ALREADY APPLIED migration changed, which is
    // the warning that the database and the repository say different things.
    expect(a).not.toBe(b);
  });
});
