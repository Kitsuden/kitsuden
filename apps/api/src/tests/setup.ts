/**
 * Test Setup and Utilities
 *
 * Provides test database setup, teardown, and utility functions
 * for all test suites.
 */

import { eq, sql } from "drizzle-orm";

import { db, isPgMem } from "../db";
import { authUsers } from "../db/schema-core";

// Test database URL from environment
export const TEST_DATABASE_URL = process.env.DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Run the tests with pnpm test:api, or for one file: " +
      "node ../../scripts/test-db.mjs exec -- bun test <file>. They read .env.test."
  );
}

/**
 * Check if a REAL PostgreSQL database is available.
 * Returns false when falling back to pg-mem, since pg-mem
 * does not fully support drizzle-orm 0.45.x for integration tests.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return !isPgMem;
  } catch {
    return false;
  }
}

/**
 * Clear all test data
 */
export async function clearTestData() {
  // Delete in correct order to avoid foreign key constraints
  await db.execute(sql`DELETE FROM "data_entries"`);
  await db.execute(sql`DELETE FROM "data_sets"`);
  await db.execute(sql`DELETE FROM "auth_users" WHERE email LIKE 'test-%@example.com'`);
  await db.execute(sql`DELETE FROM "api_keys" WHERE name LIKE 'Test%'`);
}

/**
 * Setup test environment
 */
export async function setupTestEnv() {
  const isAvailable = await isDatabaseAvailable();

  if (!isAvailable) {
    console.error("❌ Database not available. Skipping tests that require DB.");
    console.error(`Expected database at: ${TEST_DATABASE_URL?.replace(/\/\/[^@]*@/, "//***@")}`);
    return false;
  }

  console.log("✅ Database connected, running tests...");
  return true;
}

/**
 * The application role (`kitsuden_app`) in the TEST database.
 *
 * The tests that measure RLS «on its own» connect as the test database's
 * user, which in Docker and in CI is a SUPERUSER, and a superuser skips
 * RLS. They do `SET LOCAL ROLE kitsuden_app`, the role the API serves with
 * in production (created by docker/start-with-check.sh)… which in a freshly
 * started test database did not exist: they failed with «role does not exist».
 *
 * This creates it if missing (no login, no superuser, no BYPASSRLS) with the
 * same permissions as in production, including the tables that only allow
 * INSERT (the queue and the traces). Idempotent; without a superuser it does nothing.
 */
export async function ensureAppRole(): Promise<boolean> {
  const [su] = (await db.execute(sql`SELECT current_setting('is_superuser') AS su`)).rows as Array<{
    su: string;
  }>;
  if (su?.su !== "on") return false;
  await db.execute(
    sql.raw(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    CREATE ROLE kitsuden_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$`)
  );
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO kitsuden_app`));
  await db.execute(
    sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kitsuden_app`)
  );
  await db.execute(
    sql.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kitsuden_app`)
  );
  // Like migrations 0056 and 0057: the queue and the traces, INSERT only.
  for (const table of ["kitsuden_outbox", "kitsuden_request_traces"]) {
    await db.execute(
      sql.raw(`DO $$ BEGIN
      IF to_regclass('public.${table}') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON ${table} FROM kitsuden_app';
        EXECUTE 'GRANT INSERT ON ${table} TO kitsuden_app';
      END IF;
    END $$`)
    );
  }
  return true;
}

/**
 * Generate unique test IDs
 */
export function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create test user data
 */
export function createTestUserData() {
  const id = generateTestId();
  return {
    email: `${id}@example.com`,
    password: "TestPassword123!",
    name: `Test User ${id}`,
  };
}

/**
 * Create test dataset data
 */
export function createTestDatasetData() {
  const id = generateTestId();
  return {
    name: `Test Dataset ${id}`,
    slug: `test-dataset-${id}`,
    description: "A test dataset",
    schema: [{ fieldName: "title", fieldType: "text", required: true }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNING IN AS A TEST USER
// ═══════════════════════════════════════════════════════════════════════════
//
// Integration tests sign up and sign in over HTTP
// (`/api/auth/sign-up/email` + `/api/auth/sign-in/email`). Since the security
// round, that no longer works as is, for two reasons that
// are CORRECT in production and that have to be worked around here without touching them:
//
//   1. `requireEmailVerification: true` (lib/auth.ts): whoever has just signed
//      up cannot sign in with a password (403) until they confirm the email. In a
//      test there is no email to click: `emailVerified` is set in the database.
//
//   2. The limiter (lib/rate-limiter.ts) allows 5 sign-ups per hour and 10 sign-ins
//      every 5 minutes PER IP. `app.request(...)` has no socket, so
//      all the requests of the whole suite were the same «unknown» client
//      (lib/client-ip.ts) and the 429 started at the sixth sign-up. Each sign-up and
//      each sign-in carries its own IP in `X-Forwarded-For`.
//
// The IPs are from the DOCUMENTATION ranges (RFC 5737), which `isPrivate()` treats
// as public: a private one would be skipped and would count as «unknown» again.
// The starting point is random so that two consecutive runs against the
// same Valkey do not repeat the same sequence of buckets.

const DOCUMENTATION_RANGES = ["198.51.100", "203.0.113", "192.0.2"];
let nextIp = Math.floor(Math.random() * 3 * 254);

/** A different public documentation IP on each call. */
export function testIp(): string {
  const n = nextIp++ % (3 * 254);
  return `${DOCUMENTATION_RANGES[Math.floor(n / 254)]}.${(n % 254) + 1}`;
}

export interface TestUser {
  email: string;
  password: string;
  name: string;
  /** Role set in the database before signing in (default `user`). */
  role?: "admin" | "editor" | "user";
}

/** Only the session cookie (`…session_token=…`), without the session cache. */
export function sessionCookie(headers: Headers): string {
  const all =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  const session = all.find((c) => c.includes("session_token=")) ?? all[0] ?? "";
  return session.split(";")[0]!.trim();
}

/**
 * Signs the user up, leaves them verified (and with `role` if requested) and signs in.
 *
 * The session cache cookie (`session_data`) is not passed: it stores the role
 * for 5 minutes, and a test that changes the role midway would see the old one.
 */
export async function enterAs(
  app: { request: (input: Request) => Response | Promise<Response> },
  user: TestUser
): Promise<{ cookie: string; userId: string }> {
  const request = (route: string, body: unknown) =>
    new Request(`http://localhost:3000${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp() },
      body: JSON.stringify(body),
    });

  const high = await app.request(
    request("/api/auth/sign-up/email", {
      email: user.email,
      password: user.password,
      name: user.name,
    })
  );
  if (high.status !== 200) {
    throw new Error(`enterAs: sign-up responded ${high.status}: ${await high.text()}`);
  }

  const [row] = await db
    .update(authUsers)
    .set({ emailVerified: true, ...(user.role ? { role: user.role } : {}) })
    .where(eq(authUsers.email, user.email.toLowerCase()))
    .returning({ id: authUsers.id });
  if (!row) throw new Error(`enterAs: ${user.email} does not appear in auth_users`);

  const input = await app.request(
    request("/api/auth/sign-in/email", { email: user.email, password: user.password })
  );
  if (input.status !== 200) {
    throw new Error(`enterAs: sign-in responded ${input.status}: ${await input.text()}`);
  }

  return { cookie: sessionCookie(input.headers), userId: row.id };
}
