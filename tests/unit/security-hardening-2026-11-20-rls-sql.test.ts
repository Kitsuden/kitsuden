/**
 * Core RLS SQL hardening (H44/H51, H50, H54, 2026-11-20). The text is checked here; the
 * policies themselves run in the API suite on real Postgres.
 *
 *   · kitsuden_links: the system hatch needs an empty id AND an empty role (an anonymous
 *     request carries role `anonymous`), and a row without owner is written only by the
 *     system and `admin`.
 *   · is_rls_active, current_rls_user_id, set_rls_context, clear_rls_context run as the
 *     caller with a fixed search_path, never SECURITY DEFINER.
 *   · kitsuden_rls_owned compares the owner column as text, so a uuid column works.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DB = join(__dirname, "../../apps/api/src/db");
const read = (p: string) => readFileSync(join(DB, p), "utf8");
const MIGRATION = read("migrations/0093_links_system_hatch_and_rls_helpers.sql");
const POLICIES = read("rls-policies.sql");
const FUNCTIONS = read("agent-functions.sql");

const HELPERS = ["is_rls_active", "current_rls_user_id", "set_rls_context", "clear_rls_context"];

/** The body of `CREATE OR REPLACE FUNCTION name(...)` up to its LANGUAGE line. */
function definition(sqlText: string, name: string): string {
  const start = sqlText.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = sqlText.indexOf("LANGUAGE plpgsql", start);
  return sqlText.slice(start, sqlText.indexOf("\n", end));
}

describe("kitsuden_links policy (0093)", () => {
  const policy = MIGRATION.slice(MIGRATION.indexOf("CREATE POLICY kitsuden_links_owner_isolation"));
  const using = policy.slice(0, policy.indexOf("WITH CHECK"));
  const check = policy.slice(policy.indexOf("WITH CHECK"), policy.indexOf(");") + 2);

  it("is dropped and created again", () => {
    expect(MIGRATION).toContain(
      "DROP POLICY IF EXISTS kitsuden_links_owner_isolation ON kitsuden_links"
    );
  });

  it("the system is id AND role empty, in both clauses", () => {
    for (const clause of [using, check]) {
      expect(clause).toContain("COALESCE(current_setting('app.current_user_role', true), '') = ''");
    }
  });

  it("an ownerless row is read only with a session and never written by a non-admin", () => {
    expect(using).toContain(
      "(owner_id IS NULL AND COALESCE(current_setting('app.current_user_id', true), '') <> '')"
    );
    expect(check).not.toContain("owner_id IS NULL");
  });
});

describe("RLS helper functions", () => {
  for (const [file, text] of [
    ["0093", MIGRATION],
    ["rls-policies.sql", POLICIES],
  ] as const) {
    it(`${file}: run as the caller with a fixed search_path`, () => {
      for (const name of HELPERS) {
        const def = definition(text, name);
        expect(def, name).not.toContain("SECURITY DEFINER");
        expect(def, name).toContain("SECURITY INVOKER SET search_path = pg_catalog, pg_temp");
      }
    });
  }
});

describe("kitsuden_rls_owned", () => {
  it("compares the owner column as text", () => {
    const def = FUNCTIONS.slice(
      FUNCTIONS.indexOf("CREATE OR REPLACE FUNCTION kitsuden_rls_owned(")
    );
    expect(def.slice(0, def.indexOf("$FN$;"))).toContain(
      "AND %I::text = current_setting(''app.current_user_id'', true)"
    );
  });
});
