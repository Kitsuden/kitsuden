/**
 * User Context Enrichment Middleware
 *
 * Populates ACL-related fields in the Hono context after authentication.
 * Runs AFTER the global auth middleware (which sets `user` and `session`).
 *
 * Sources:
 *   - userRoleIds:    Derived from `user.role` (Better Auth enum → array)
 *   - userDepartmentId: Looked up from directory_employees table (if kon-directory installed)
 *
 * Graceful degradation:
 *   - If kon-directory is not installed → userDepartmentId = null
 *   - If user has no role → userRoleIds = []
 */

import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { db } from "../db";

/**
 * Does `directory_employees` exist (kon-directory installed)? It is checked at most
 * once a minute (performance, 2026-10-27).
 *
 * Before, the department query was fired on EVERY authenticated request
 * —agents' too— and, without kon-directory (the normal case), it always
 * failed: a round trip to Postgres and an ERROR in its log per request. When
 * kon-directory is installed, the department shows up in under a minute.
 */
let employeesTable: { exists: boolean; until: number } | null = null;
async function hasEmployeesTable(): Promise<boolean> {
  const now = Date.now();
  if (employeesTable && employeesTable.until > now) return employeesTable.exists;
  const r = await db.execute(
    sql`SELECT to_regclass('public.directory_employees') IS NOT NULL AS exists`
  );
  const exists = Boolean((r.rows as Array<{ exists: boolean }>)[0]?.exists);
  employeesTable = { exists, until: now + 60_000 };
  return exists;
}

/** For tests: look again whether the table exists. */
export function forgetEmployeeTable(): void {
  employeesTable = null;
}

export const enrichUserContext = createMiddleware(async (c, next) => {
  const user = c.get("user");

  // Not authenticated — nothing to enrich
  if (!user) {
    c.set("userRoleIds", []);
    c.set("userDepartmentId", null);
    return next();
  }

  // 1. Roles — Better Auth only stores a single role string
  const userRoleIds = user.role ? [String(user.role)] : [];
  c.set("userRoleIds", userRoleIds);

  // 2. Department — lookup in directory_employees (if table exists)
  let userDepartmentId: string | null = null;

  // An agent is not an employee (its id is not an account): there is nothing to look up.
  const isAgent = Boolean((c.get as (k: string) => unknown)("agent"));
  try {
    if (!isAgent && (await hasEmployeesTable())) {
      const result = await db.execute(
        sql`SELECT department_id FROM directory_employees WHERE user_id = ${user.id} LIMIT 1`
      );
      const rows = result.rows as Array<{ department_id: string | null }>;
      userDepartmentId = rows[0]?.department_id ?? null;
    }
  } catch {
    // kon-directory not installed or table missing → leave as null
  }

  c.set("userDepartmentId", userDepartmentId);
  await next();
});
