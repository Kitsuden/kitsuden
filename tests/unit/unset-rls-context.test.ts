/**
 * «No context» has to include «never set»
 * ============================================================================
 *
 * This project's RLS policies fail OPEN when there is no user:
 * migrations, seeds, workers and loaders run with nobody
 * authenticated and have to keep working. The condition that allowed it
 * was this:
 *
 *     current_setting('app.current_user_id', true) = ''
 *
 * And that was the hole: on a connection where NOBODY has set the variable,
 * `current_setting(..., true)` does not return `''`, it returns NULL. `NULL = ''` is not
 * false, it is NULL — and a policy that gives NULL does not let the row through.
 *
 * Since connections come from a pool, the result depended on where
 * each connection had been before:
 *
 *   · freshly opened connection    → NULL → zero rows
 *   · connection already used by a
 *     route with context           → ''   → all rows
 *
 * The real symptom: a game's team builder came out with zero options
 * —the 1188 records existed and were public— and on reload it came out fine. The same
 * anonymous GET returned two different things, without an error in any log.
 *
 * ── THE OTHER HALF: THE CONTEXT CANNOT BE SESSION-LEVEL ────────────────────
 *
 * `set_config(key, value, is_local)`. With `is_local = false` the value
 * stays on the connection after the request, so the next request that reuses it
 * and sets no context inherits the previous one's user. That is not a performance
 * quirk: it is an identity leak between requests.
 *
 * ── AND WHY POLICIES ARE DROPPED BEFORE BEING CREATED ──────────────────────
 *
 * The RLS applier swallows «already exists» errors (reapplying is
 * normal). Without a `DROP POLICY IF EXISTS` in front, fixing this file
 * changed NOTHING on a database that already had it applied: the fix was
 * "deployed" and the failure stayed there.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const lee = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

const POLICIES = lee("apps", "api", "src", "db", "rls-policies.sql");
const OWN_ITEMS = lee("apps", "api", "src", "db", "rls-owned-tables.sql");
const MEDIUM = lee("apps", "api", "src", "middleware", "transactional-rls.ts");
const ENGINE = lee("packages", "engine", "src", "rls-request.ts");

/**
 * Every `CREATE POLICY <name> ON <table>` in the file. Those in
 * `rls-owned-tables.sql` are generated with `format(... %I ...)` inside a
 * loop, so there the name and the table are literally `%I`.
 */
const policiesOf = (sql: string) =>
  [...sql.matchAll(/CREATE POLICY\s+(%I|\w+)\s+ON\s+(%I|\w+)/gi)].map((m) => ({
    name: m[1],
    table: m[2],
  }));

describe("a connection without context is treated as anonymous, not as an intruder", () => {
  it("every empty-context escape hatch accounts for NULL", () => {
    for (const sql of [POLICIES, OWN_ITEMS]) {
      // Every `= ''` on the user id has its `IS NULL` in sight
      const chunks = sql.split(/current_setting\('app\.current_user_id', true\) = ''/);
      for (let i = 1; i < chunks.length; i++) {
        const around = chunks[i - 1].slice(-220) + chunks[i].slice(0, 220);
        expect(around, `an «= ''» without a nearby NULL check:\n${around}`).toContain(
          "current_setting('app.current_user_id', true) IS NULL"
        );
      }
    }
  });

  it("the function that says whether RLS is active does not end up as NULL", () => {
    expect(POLICIES).toMatch(
      /COALESCE\(current_setting\('app\.current_user_id', true\), ''\) != ''/
    );
  });
});

describe("the policies file can be fixed", () => {
  it("every policy is dropped before being created", () => {
    for (const sql of [POLICIES, OWN_ITEMS]) {
      for (const { name: name, table: table } of policiesOf(sql)) {
        const deleted = new RegExp(
          `DROP POLICY IF EXISTS\\s+(${name}|%I)\\s+ON\\s+(${table}|%I)`,
          "i"
        );
        expect(sql, `${name} is created without being dropped first`).toMatch(deleted);
      }
    }
  });

  it("there are real policies to check (otherwise the above proves nothing)", () => {
    expect(policiesOf(POLICIES).length).toBeGreaterThan(0);
    expect(policiesOf(OWN_ITEMS).length).toBeGreaterThan(0);
  });
});

describe("the RLS context does not outlive the request", () => {
  it("inside the transaction it is set LOCAL", () => {
    // `setRLSContext` delegates to the engine's shared piece (the same one the kons
    // use), and that is where the context is set.
    const body = MEDIUM.slice(MEDIUM.indexOf("export async function setRLSContext"));
    expect(body.slice(0, body.indexOf("\n}"))).toContain("setRlsContext(tx, user)");
    const set = ENGINE.slice(ENGINE.indexOf("async function set("));
    const until = set.slice(0, set.indexOf("\n}"));
    expect(until).toMatch(/set_config\('app\.current_user_id', \$\{userId\}, true\)/);
    expect(until).toMatch(/set_config\('app\.current_user_role', \$\{userRole\}, true\)/);
    expect(until).not.toContain(", false)");
  });

  it("no helper sets the context at session level or as a made-up admin", () => {
    // Removed 2026-11-04 (security review 2026-11-03): no callers, and a
    // session-level context on a pooled connection leaks to the next request.
    expect(existsSync(join(ROOT, "apps", "api", "src", "middleware", "rls-context.ts"))).toBe(
      false
    );
    expect(existsSync(join(ROOT, "apps", "api", "src", "lib", "agent-rls.ts"))).toBe(false);
    expect(MEDIUM).not.toMatch(/export (async )?function (withRLSContextOnly|withAdminRLS)\b/);
    expect(MEDIUM).not.toContain(", false)");
  });
});
