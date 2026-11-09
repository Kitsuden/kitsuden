/**
 * Test bench for the internal kons: PGlite with REAL RLS and five
 * actors (anonymous, A, B, staff, admin).
 *
 * ── WHY A NON-SUPERUSER ROLE ───────────────────────────────────────────────
 *
 * PGlite connects as `postgres`, a superuser, and Postgres skips RLS
 * for a superuser even if the table has FORCE. A test like that would take the
 * policies as good without ever having executed them. After migrating (as
 * superuser, like the real runner) it does `SET ROLE` to a normal role
 * —the equivalent of `kitsuden_app`— and EVERYTHING else runs with it.
 *
 * User ids have the better-auth shape (text, NOT uuid) on
 * purpose: that way `uuid` columns that cannot store them get caught.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { MiddlewareHandler } from "hono";

export const USERS = {
  a: { id: "usrA7kq2Lm9PzX4nT8vB1cD3eF5gH6jK", role: "user", email: "a@example.com", name: "Ana" },
  b: { id: "usrB2wE4rT6yU8iO0pA1sD3fG5hJ7kL", role: "user", email: "b@example.com", name: "Beto" },
  staff: {
    id: "usrS9zX7cV5bN3mQ1wE2rT4yU6iO8pA",
    role: "editor",
    email: "s@example.com",
    name: "Sara",
  },
  admin: {
    id: "usrAdm1nQ2wE3rT4yU5iO6pA7sD8fG9",
    role: "admin",
    email: "ad@example.com",
    name: "Root",
  },
} as const;

export type Actor = keyof typeof USERS | "anon";

const HEADER = "x-test-user";
const AGENT_HEADER = "x-test-agent";

/** The user of the request: an agent (`role: "agent"` with its scopes) or one of USERS. */
function headerUser(value: string | undefined, agent?: string) {
  if (agent) return { id: "test-agent", role: "agent", scopes: agent.split(",") };
  if (!value || !(value in USERS)) return null;
  return { ...USERS[value as keyof typeof USERS] };
}

/** `ctx.auth` doubles that read the actor from a test header. */
export function testAuth() {
  const optionalAuth: MiddlewareHandler = async (c, next) => {
    const u = headerUser(c.req.header(HEADER), c.req.header(AGENT_HEADER));
    if (u) c.set("user" as never, u as never);
    await next();
  };
  const requireAuth: MiddlewareHandler = async (c, next) => {
    const u = headerUser(c.req.header(HEADER), c.req.header(AGENT_HEADER));
    if (!u) return c.json({ error: "Unauthorized - Authentication required" }, 401);
    c.set("user" as never, u as never);
    await next();
  };
  const requireRole =
    (roles: string[]): MiddlewareHandler =>
    async (c, next) => {
      const u = headerUser(c.req.header(HEADER), c.req.header(AGENT_HEADER));
      if (!u) return c.json({ error: "Unauthorized" }, 401);
      if (!roles.includes(u.role)) return c.json({ error: "Forbidden" }, 403);
      c.set("user" as never, u as never);
      await next();
    };
  return {
    optionalAuth,
    requireAuth,
    requireRole,
    getSession: async () => null,
    usersById: async () => new Map(),
  };
}

/** Request as an actor. */
export function requestAs(app: {
  request: (u: string, i?: RequestInit) => Response | Promise<Response>;
}) {
  return (actor: Actor | { agent: string[] }, method: string, route: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (typeof actor === "object") headers[AGENT_HEADER] = actor.agent.join(",");
    else if (actor !== "anon") headers[HEADER] = actor;
    if (body !== undefined) headers["content-type"] = "application/json";
    return app.request(route, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  };
}

export const APP_ROLE = "kon_test_app";

/**
 * PGlite with the kon's migrations applied as superuser and the session
 * switched afterwards to a role WITHOUT special privileges.
 */
export async function databaseWithRls(kon: string, migrations: string[]) {
  const client = new PGlite();
  // The core's agent functions and row-security helpers, before any kon migration, as the
  // real runner does (kon policies call them).
  await client.exec(
    readFileSync(resolve(__dirname, "../../../apps/api/src/db/agent-functions.sql"), "utf8")
  );
  for (const m of migrations) {
    const route = resolve(__dirname, `../../../packages/kons/${kon}/migrations/${m}`);
    await client.exec(readFileSync(route, "utf8"));
  }
  await client.exec(`
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
  `);
  return client;
}

/** Switches the session to the app role (after seeding as superuser). */
export async function asAppRole(client: PGlite) {
  await client.exec(`SET ROLE ${APP_ROLE}`);
  const r = await client.query<{ su: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS su FROM pg_roles WHERE rolname = current_user`
  );
  // If this were a superuser, every RLS test would be decorative.
  if (r.rows[0]?.su !== false) throw new Error("the test role skips RLS");
  return drizzle(client);
}

/** Runs raw SQL with an actor's RLS context (inside a transaction). */
export async function sqlAs<T = Record<string, unknown>>(
  client: PGlite,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const u = actor === "anon" ? null : USERS[actor];
  return client.transaction(async (tx) => {
    await tx.query(
      `select set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)`,
      [u?.id ?? "anonymous", u?.role ?? "anon"]
    );
    const r = await tx.query<T>(query, params);
    return r.rows;
  });
}
