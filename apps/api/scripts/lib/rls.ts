/**
 * Application and verification of RLS policies.
 * ============================================================================
 *
 * It lives here, and not inside `apply-rls.ts`, because now two places use it:
 * the manual script and the migration runner. RLS has to be applied on every
 * deployment, not when someone remembers to run a script.
 */

import { existsSync } from "node:fs";

import { sql } from "drizzle-orm";

import { db } from "../../src/db";
import { readSqlFile } from "../../src/lib/sql-file";

import { detailError } from "./db-error";

export interface RlsResult {
  applied: number;
  skippedItems: number;
  tablesWithRls: number;
  tablesWithForce: number;
  withoutForce: string[];
}

/** Runs the policy files. Idempotent: it runs after every migration. */
export async function applyRlsPolicies(files: string[]): Promise<void> {
  for (const path of files) {
    if (!existsSync(path)) continue;
    const f = readSqlFile(path, path.split(/[\\/]/).pop()!);

    for (const stmt of f.statements) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (error) {
        const msg = detailError(error);
        // "already exists" is the normal result of reapplying; anything else
        // is a real failure and is not swallowed.
        if (/already exists|duplicate/i.test(msg)) continue;
        throw new Error(`RLS ${f.name}: ${msg}\n  en: ${stmt.slice(0, 120)}…`);
      }
    }
  }
}

/**
 * Checks against the Postgres catalog what actually ended up active.
 *
 * ENABLE without FORCE is a DECORATIVE policy: the table's owner role —which
 * is often the app's own role— is exempt and reads it all. It is the most
 * expensive failure in this area because it gives no error: it simply does not isolate.
 */
export async function verifyRls(): Promise<RlsResult> {
  const res = await db.execute(sql`
    SELECT c.relname, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity = true
    ORDER BY c.relname
  `);

  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
    relname: string;
    relforcerowsecurity: boolean;
  }>;

  const withoutForce = rows.filter((r) => !r.relforcerowsecurity).map((r) => r.relname);

  return {
    applied: 0,
    skippedItems: 0,
    tablesWithRls: rows.length,
    tablesWithForce: rows.length - withoutForce.length,
    withoutForce,
  };
}

/**
 * RLS is decorative if the app connects as a superuser: Postgres skips
 * the policies for that role, FORCE and all. It deserves a loud warning, not
 * a note in a README nobody reads.
 */
export async function checkSuperuser(): Promise<string | null> {
  try {
    const res = await db.execute(sql`
      SELECT current_user AS role_name, usesuper AS is_super
      FROM pg_user WHERE usename = current_user
    `);
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
      role_name: string;
      is_super: boolean;
    }>;
    return rows[0]?.is_super ? rows[0].role_name : null;
  } catch {
    // pg_user is not always readable (PGlite, restricted roles). It does not abort.
    return null;
  }
}

export function reportRls(r: RlsResult, superusuario: string | null): void {
  console.log(`  RLS active on ${r.tablesWithRls} tables (${r.tablesWithForce} with FORCE).`);

  if (r.withoutForce.length > 0) {
    console.warn(
      `  ⚠  ${r.withoutForce.length} table(s) with ENABLE without FORCE — the owner role ignores them:`
    );
    for (const t of r.withoutForce) console.warn(`     · ${t}`);
  }

  if (superusuario) {
    /**
     * Applying the policies DOES need a superuser, and so does migrating. What
     * cannot be a superuser is the connection the API SERVES
     * requests with: Postgres ignores RLS for superusers.
     *
     * That is why the message distinguishes the two cases. When a separate
     * application connection exists (`DATABASE_ADMIN_URL` defined), this is expected, and
     * raising it as an alarm would be lying. A warning that shouts when nothing is wrong
     * teaches people to ignore warnings — and that is how the real problem, a
     * single superuser account for everything, went unnoticed through an entire
     * deployment.
     *
     * The one that really decides is `src/lib/rls-connection-guard.ts`: it checks the
     * API's connection at startup and, in production, stops it.
     */
    const hasApplicationRole = Boolean(process.env.DATABASE_ADMIN_URL);

    if (hasApplicationRole) {
      console.log(
        `  - Migrated as '${superusuario}' (superuser), which is correct:\n` +
          `    creating extensions and roles requires it. The API will serve with the\n` +
          `    application role, so the RLS policies will be applied.`
      );
    } else {
      console.warn(
        `\n  !  The connection uses '${superusuario}', which is a SUPERUSER, and there is no\n` +
          `     DATABASE_ADMIN_URL defined: the API will serve with this SAME account.\n` +
          `     Postgres ignores RLS for superusers, so the policies\n` +
          `     are decorative and tenant isolation is NOT applied.\n` +
          `     Define APP_DB_USER / APP_DB_PASSWORD and DATABASE_ADMIN_URL.`
      );
    }
  }
}
