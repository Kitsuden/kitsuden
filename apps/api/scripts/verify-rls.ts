/**
 * RLS verification at startup — isolation is TESTED, not declared
 * ============================================================================
 *
 * ── WHY IT IS NEEDED ───────────────────────────────────────────────────────
 *
 * Everything around RLS in this repo checks DECLARATIONS:
 *
 *   · `rls-coverage.test.ts` checks that every table with an owner is decided.
 *   · `start-with-check.sh` checks that the application role exists and is not a
 *     superuser.
 *   · The migrations check that the policies are created.
 *
 * None checks that isolation HAPPENS. And the four ways of breaking it
 * leave the system working just as well, only showing other people's data:
 *
 *   1. The app role turns out to be a superuser → Postgres ignores the policies.
 *   2. Someone grants `BYPASSRLS` to debug and does not remove it.
 *   3. A new table is born with `ENABLE` but without `FORCE`.
 *   4. A badly written policy that is always true.
 *
 * None of the four produces an error. They produce data. That is why this is not
 * a suite test: it is a STARTUP check, against the real database,
 * with the real role, at the moment of deployment.
 *
 * ── WHAT EXACTLY IT TESTS ──────────────────────────────────────────────────
 *
 * With the context set to a user that does not exist, an isolated table
 * must return ZERO rows. If it returns any, that user is seeing rows
 * of someone else and the deployment must not continue.
 *
 * Now the bar is «nothing that the anonymous user does not also see» (see
 * SHARED_WITH_SESSION below): there are tables with public rows by design.
 *
 * Careful with what it does NOT test: the EMPTY context (empty id AND role) is
 * the system and sees everything, on purpose: migrations, loaders and background tasks.
 * A route that does not go through `withTransactionalRLS()` runs that way. The core
 * routes that mount it and ALL of the kons' (module-loader) set the
 * context; this check verifies the database layer, it cannot
 * verify which routes use it.
 */

import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;

/** An id that cannot belong to anyone: if rows are seen with this, all are seen. */
const NOBODY = "rls-probe-user-that-does-not-exist-0000";

interface Leak {
  table: string;
  rows: number;
  /** With what context they were seen (`user` role, or empty role with a user). */
  as: string;
}

/**
 * ── PUBLIC IS NOT A LEAK ────────────────────────────────────────────────────
 *
 * Since the kons' routes run in their RLS transaction, there are tables
 * with rows that ANYONE reads by design: tier list templates, published
 * builds, entries of public datasets. A user who owns
 * nothing sees them, and that is not seeing rows «of someone else»: it is that everyone
 * sees them.
 *
 * So the yardstick is no longer «zero rows», but «nothing that the ANONYMOUS user
 * does not also see» (id '' and role `anonymous`, the context set by
 * `withTransactionalRLS()` without a session). A policy that lets an arbitrary user
 * see other people's rows that are not public still trips here.
 *
 * What is shared with any SESSION (not with the anonymous user) has to be
 * declared here, with the predicate that defines it. If undeclared, it counts as a
 * leak: better a startup halted by something legitimate that is declared in
 * one line, than a leak passing as legitimate.
 */
const SHARED_WITH_SESSION: Record<string, string> = {
  // Datasets with `readAccess: authenticated` (data_entries_dataset_read)
  data_entries: `data_set_id IN (SELECT id FROM data_sets WHERE policy_json->>'readAccess' = 'authenticated')`,
  // Assignment of a course to a GROUP (kon-academy-lms/0003): it belongs to no one
  assignments: `user_id IS NULL`,
};

/** The anonymous user of a request, as set by `withTransactionalRLS()`. */
const ANONYMOUS = { id: "", role: "anonymous" };

/**
 * The strangers it is measured with: an ordinary account, and the SAME account
 * with the role unset. The second is the one that caught the newsletter
 * hatch in production (empty role + user = «system»).
 */
const FOREIGN = [
  { id: NOBODY, role: "user", as: "any user" },
  { id: NOBODY, role: "", as: "user with the role unset" },
];

async function main() {
  if (!ADMIN_URL) {
    console.error("✗ RLS: there is no DATABASE_ADMIN_URL or DATABASE_URL");
    process.exit(1);
  }

  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const q = async <T>(text: string, values: unknown[] = []): Promise<T[]> =>
    (await db.query(text, values as never[])).rows as T[];

  try {
    /**
     * If the app runs with the same account that migrates and that account is
     * a superuser, there is nothing to measure: Postgres skips the policies
     * entirely and any test would come out green for the wrong reason.
     */
    const appUser = APP_URL ? decodeURIComponent(new URL(APP_URL).username) : null;
    if (appUser) {
      const [role] = await q<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
        [appUser]
      );
      if (!role) {
        console.error(`✗ RLS: the application role "${appUser}" does not exist`);
        process.exit(1);
      }
      if (role.rolsuper || role.rolbypassrls) {
        console.error(
          `✗ RLS: the role "${appUser}" is a superuser or has BYPASSRLS.\n` +
            "     Postgres ignores ALL policies for that role: isolation\n" +
            "     between users does not exist, even though the policies are created."
        );
        process.exit(1);
      }
    }

    // Tables with RLS enabled. Those with no rows cannot be checked:
    // an empty table returns zero because it is empty, not because it is isolated.
    const tables = await q<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
       ORDER BY c.relname`
    );

    if (!tables.length) {
      console.error("✗ RLS: no table has RLS enabled. Were the policies applied?");
      process.exit(1);
    }

    const withoutForce = tables.filter((t) => !t.forced).map((t) => t.relname);
    const withoutPolicy = await q<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = c.relname)`
    );

    const leaks: Leak[] = [];
    const publicByDesign: string[] = [];
    let tested = 0;
    let empty = 0;

    if (!appUser) {
      console.log("  RLS: without a separate application role, there is no isolation to measure");
    } else {
      for (const { relname } of tables) {
        const [{ n: total }] = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${relname}"`
        );
        if (Number(total) === 0) {
          empty++;
          continue;
        }

        /**
         * `SET LOCAL ROLE` inside a transaction: it is tested with the real
         * application role and undoes itself. Testing as the role that
         * migrates would be measuring the wrong person.
         */
        const shared = SHARED_WITH_SESSION[relname];
        const query =
          `SELECT count(*)::int AS n FROM "${relname}"` +
          (shared ? ` WHERE NOT COALESCE((${shared}), false)` : "");
        const visibleWith = async (id: string, role: string): Promise<number> => {
          await db.query("BEGIN");
          try {
            await db.query(`SET LOCAL ROLE "${appUser}"`);
            await db.query(
              "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)",
              [id, role]
            );
            const [r] = await q<{ n: number }>(query);
            return Number(r.n);
          } finally {
            await db.query("ROLLBACK");
          }
        };

        const publicItems = await visibleWith(ANONYMOUS.id, ANONYMOUS.role);
        if (publicItems > 0) publicByDesign.push(`${relname} (${publicItems})`);
        for (const stranger of FOREIGN) {
          const visible = await visibleWith(stranger.id, stranger.role);
          if (visible > publicItems) {
            leaks.push({ table: relname, rows: visible - publicItems, as: stranger.as });
          }
        }
        tested++;
      }
    }

    // ── Report ─────────────────────────────────────────────────────────────
    console.log(
      `  RLS: ${tables.length} tables protected · ${tested} checked with data` +
        (empty ? ` · ${empty} empty (not checkable)` : "")
    );

    let failure = false;

    if (withoutForce.length) {
      // Without FORCE, the table owner is exempt and the policies are
      // decorative for it. It is the bug that already bit us once.
      console.error(
        `✗ RLS: ${withoutForce.length} tables with ENABLE but without FORCE: ${withoutForce.join(", ")}`
      );
      failure = true;
    }
    if (withoutPolicy.length) {
      console.error(
        `✗ RLS: ${withoutPolicy.length} tables with RLS enabled and NO policy: ` +
          withoutPolicy.map((t) => t.relname).join(", ") +
          "\n     With RLS enabled and zero policies, the table returns NOTHING to the app."
      );
      failure = true;
    }
    if (publicByDesign.length) {
      // Informational: what the anonymous user reads by design. If a
      // personal-data table shows up here, the leak is the public policy.
      console.log(`  RLS: readable without a session (by policy): ${publicByDesign.join(", ")}`);
    }
    if (leaks.length) {
      console.error(
        `✗ RLS: ${leaks.length} cases of other people's rows visible beyond what is public:`
      );
      for (const f of leaks) console.error(`     ${f.table}: ${f.rows} extra rows (${f.as})`);
      console.error("     User isolation is NOT being applied.");
      failure = true;
    }

    if (failure) process.exit(1);
    console.log("  RLS: isolation verified against the real database");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("✗ RLS: verification failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
