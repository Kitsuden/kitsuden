/**
 * System: what administers the platform, not a kon
 * ============================================================================
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * Of the 120 tables in an installation, 45 do not belong to any kon. Most
 * already have their screen —datasets, media, blocks, brain, agents,
 * actions, settings, vault—, but a handful had none anywhere:
 * users, sessions, installed kons and the migration history.
 *
 * That was the only real justification for the generic table viewer
 * (`/data-viewer`), which has been removed: it was an interface over
 * `/api/explorer/<table>`, and that surface resolved ANY table —secrets
 * and credentials included— with just a session. A raw table browser
 * also does not fit an architecture where each kon owns its
 * data and decides how it is presented.
 *
 * What was missing was not "see any table", but a few specific
 * platform screens. That is what this is.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 *
 * Everything here requires the `admin` role, not just a session. These are the CMS's users and the
 * schema state: `requireAuth` —which only checks that a session exists— is
 * exactly the mistake that left the explorer open.
 *
 * And NOTHING from `auth_accounts` is ever returned: the credentials live there.
 */

import { count, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { db } from "../db";
import { authSessions, authUsers, installedKons, modules } from "../db/schema";
import { requireRole } from "../middleware/auth";

export const systemAdminRoutes = new Hono();

/** The same handlers under the paths they had before (`/api/sistema/...`). */

// `admin` role on ALL of them. There is no harmless read here.
systemAdminRoutes.use("/*", requireRole(["admin"]));

/** Rows of a raw result, which vary depending on the driver. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const withRows = result as { rows?: unknown };
  return Array.isArray(withRows?.rows) ? (withRows.rows as T[]) : [];
}

/**
 * GET /users: the CMS's users.
 *
 * Columns are selected ONE BY ONE on purpose. A bare `select()` would
 * return the whole row, and even though `auth_users` does not store the password today
 * —it is in `auth_accounts`— it is enough for someone to add a sensitive column
 * tomorrow for it to start traveling on its own. Enumerating is boring and does not make mistakes.
 */
async function listUsers(c: Context) {
  const users = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      role: authUsers.role,
      emailVerified: authUsers.emailVerified,
      createdAt: authUsers.createdAt,
    })
    .from(authUsers)
    .orderBy(authUsers.createdAt);

  return c.json({ data: users, total: users.length });
}
systemAdminRoutes.get("/users", listUsers);

/**
 * PATCH /users/:id/role: change someone's role.
 *
 * ── THE PROTECTION THAT MATTERS ────────────────────────────────────────────
 *
 * An administrator cannot remove their own role, and the installation cannot be left
 * with no administrator. Without those two, one click leaves the panel
 * unmanageable and the only way out is to get in through `psql` — something that someone
 * using a hosted CMS cannot always do.
 */
async function changeRole(c: Context) {
  const id = c.req.param("id") as string;
  const { role } = (await c.req.json()) as { role?: string };

  const valid = ["admin", "editor", "user"];
  if (!role || !valid.includes(role)) {
    return c.json({ error: `Invalid role. It must be one of: ${valid.join(", ")}` }, 400);
  }

  const me = c.get("user") as { id?: string } | undefined;
  if (me?.id === id && role !== "admin") {
    return c.json(
      {
        error: "You cannot remove your own administrator role",
        message: "Ask another administrator; that way nobody is locked out by one click.",
      },
      409
    );
  }

  const [target] = await db
    .select({ role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);

  if (!target) return c.json({ error: "User not found" }, 404);

  if (target.role === "admin" && role !== "admin") {
    const [{ value: admins }] = await db
      .select({ value: count() })
      .from(authUsers)
      .where(eq(authUsers.role, "admin"));

    if (Number(admins) <= 1) {
      return c.json(
        {
          error: "They are the last administrator",
          message:
            "Removing their role would leave the installation with no administrator and " +
            "the panel with nobody to administer it. Appoint another one first.",
        },
        409
      );
    }
  }

  await db
    .update(authUsers)
    .set({ role: role as "admin" | "editor" | "user" })
    .where(eq(authUsers.id, id));

  // A role change closes that person's sessions. Without this, whoever has the
  // admin role REMOVED kept their open session valid (and better-auth's cookie
  // session cache kept their old role). With the
  // sessions deleted, the cache expires on its own in ≤5 min and they have to
  // sign in again with the new role. The session of whoever makes the change is not touched: they can only
  // change themselves to admin, which they already are.
  if (target.role !== role && me?.id !== id) {
    await db.delete(authSessions).where(eq(authSessions.userId, id));
  }

  console.log(`[System] ${me?.id ?? "?"} changed the role of ${id} to ${role}`);
  return c.json({ success: true, id, role });
}
systemAdminRoutes.patch("/users/:id/role", changeRole);

/**
 * GET /status: health of the schema and of the kons.
 *
 * Gathers what used to be visible only in the container logs or by getting in through
 * `psql`: how many migrations have been applied and when the last one was, and which
 * kons are installed and active.
 *
 * It is read-only ON PURPOSE. The migration history is touched with the
 * runner, never from the browser: editing it silently desynchronizes history and schema,
 * and that state —"the migration is recorded as applied and its tables are
 * not there"— is exactly the one that cost a whole day of diagnosis.
 */
async function schemaStatus() {
  const migrations = rowsOf<{ name: string; applied_at: string; baselined: boolean }>(
    await db.execute(
      sql`SELECT name, applied_at, baselined FROM kitsuden_migrations ORDER BY applied_at DESC LIMIT 10`
    )
  );

  const totalMigrations =
    rowsOf<{ value: number }>(
      await db.execute(sql`SELECT count(*)::int AS value FROM kitsuden_migrations`)
    )[0]?.value ?? 0;

  const kons = await db
    .select({ key: modules.key, name: modules.name, enabled: modules.enabled })
    .from(modules)
    .orderBy(modules.key);

  const installed = await db
    .select({ konId: installedKons.konId, version: installedKons.version })
    .from(installedKons);

  return {
    migrations: {
      total: Number(totalMigrations),
      latest: migrations,
    },
    kons: {
      total: kons.length,
      active: kons.filter((k) => k.enabled).length,
      list: kons,
    },
    installed,
  };
}
systemAdminRoutes.get("/status", async (c) => c.json(await schemaStatus()));
