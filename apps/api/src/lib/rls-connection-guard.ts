/**
 * The API connection cannot be a superuser
 * ============================================================================
 *
 * Postgres **ignores RLS policies when the one querying is a superuser**.
 * It does not disable them or warn: it evaluates them as if they did not exist. An installation
 * with every policy correctly applied —`RLS active on 3 tables
 * (3 with FORCE)`— isolates absolutely nothing if the API connects with that
 * account.
 *
 * It is the worst form of security failure: everything works. Queries
 * return data, tests pass, the healthcheck gives 200. The only thing that does not
 * happen is isolation, and that is not seen until one tenant reads another's data.
 *
 * ── WHY HERE AND NOT IN THE MIGRATIONS ─────────────────────────────────────
 *
 * Migrating DOES need a superuser: creating extensions, tables and roles. That is why
 * `docker/start-with-check.sh` uses two connections —`DATABASE_ADMIN_URL` to
 * administer and `DATABASE_URL` to serve— and this check looks only at the
 * second, which is the one that handles requests.
 *
 * ── WHY IT FAILS INSTEAD OF WARNING ────────────────────────────────────────
 *
 * Because warning was already tried. Startup printed the warning, in red and with
 * all the letters, and it went unnoticed throughout the whole deployment: among
 * hundreds of lines of migrations and kon loading, a warning stops
 * nobody. In production this stops startup; outside production it is still
 * a warning, because in development connecting as a superuser is convenient and there is
 * nobody's data.
 */

import { sql } from "drizzle-orm";

/** The minimum we need from the connection: running a query. */
type Connection = { execute: (query: never) => Promise<unknown> };

/** Extracts rows from the result, which varies between drizzle drivers. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const withRows = result as { rows?: unknown };
  return Array.isArray(withRows?.rows) ? (withRows.rows as Record<string, unknown>[]) : [];
}

export interface ConnectionStatus {
  user: string | null;
  isSuperuser: boolean;
  /** `BYPASSRLS`: not a superuser, and the policies are just as ignored. */
  bypassesRls: boolean;
}

/** Asks Postgres which role we are connected as and whether it is a superuser. */
export async function connectionStatus(db: Connection): Promise<ConnectionStatus> {
  const result = await db.execute(
    sql`SELECT current_user AS role_name, usesuper AS is_superuser, usebypassrls AS bypasses_rls
        FROM pg_user WHERE usename = current_user` as never
  );
  const row = rowsOf(result)[0];
  return {
    user: (row?.role_name as string) ?? null,
    // Postgres returns booleans as `true` or as `"t"` depending on the driver.
    isSuperuser: row?.is_superuser === true || row?.is_superuser === "t",
    bypassesRls: row?.bypasses_rls === true || row?.bypasses_rls === "t",
  };
}

export interface GuardOptions {
  /** `true` in production: instead of warning, it throws. */
  strict: boolean;
}

/**
 * Checks the connection and decides what to do.
 *
 * Returns the status so the caller can record it. Throws only in
 * strict mode, and with a message that says what to do, not just what is happening.
 */
export async function verifyRlsConnection(
  db: Connection,
  { strict: strictItem }: GuardOptions
): Promise<ConnectionStatus> {
  let status: ConnectionStatus;
  try {
    status = await connectionStatus(db);
  } catch (err) {
    // Outside production, if we do not know whether it is a superuser, we warn and carry on.
    // In production an unverifiable connection is a refusal: RLS would be silently
    // off, and the README promises the API does not start like that.
    const reason = err instanceof Error ? err.message : String(err);
    if (strictItem) throw new Error(`Could not verify the role of the API connection (${reason}).`);
    console.warn(`  ⚠  Could not check the connection role (${reason}).`);
    return { user: null, isSuperuser: false, bypassesRls: false };
  }

  if (!status.isSuperuser && !status.bypassesRls) return status;

  const explanation =
    `The API is connected as '${status.user}', which is ${status.isSuperuser ? "SUPERUSUARIO" : "BYPASSRLS"}.\n` +
    `Postgres ignores RLS policies for that role: isolation\n` +
    `between tenants is NOT enforced, however well defined they are.\n\n` +
    `Fix: leave POSTGRES_USER for administration (migrations) and define\n` +
    `APP_DB_USER / APP_DB_PASSWORD for the API. The role is created automatically at\n` +
    `startup, with just the permissions it needs. See docker/start-with-check.sh.`;

  if (strictItem) throw new Error(`RLS cannot be enforced.\n\n${explanation}`);

  console.warn(`\n  ⚠  ${explanation}\n`);
  return status;
}
