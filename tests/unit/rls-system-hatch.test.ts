/**
 * Core RLS on real Postgres (PGlite) and a NON-superuser role.
 * Earlier audit.
 *
 *  1. The «no context = system» hatch in `rls-owned-tables.sql` let the
 *     ANONYMOUS user through: `withTransactionalRLS()` sets id '' (and role
 *     'anonymous'), and the policy only looked at the id. It now requires an empty role.
 *  2. `rls-system-only.sql`: secrets, credentials, audit and
 *     `auth_users` cannot be read from an RLS transaction without being admin (or the
 *     row's own user, in `auth_users`); the tokens in `auth_verifications`, not even
 *     admin.
 *
 * The REAL FILES are applied, not a copy of the policy.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let pg: PGlite;
const read = (f: string) => readFileSync(resolve(__dirname, "../../apps/api/src/db", f), "utf8");

type Ctx = { id: string; role: string } | null;
const ANONYMOUS: Ctx = { id: "", role: "anonymous" };
const ANA: Ctx = { id: "u-ana", role: "user" };
const ADMIN: Ctx = { id: "u-admin", role: "admin" };

async function count(table: string, ctx: Ctx): Promise<number> {
  await pg.exec("BEGIN; SET LOCAL ROLE app_test;");
  try {
    if (ctx) {
      await pg.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.id]);
      await pg.query("SELECT set_config('app.current_user_role', $1, true)", [ctx.role]);
    }
    const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0]!.n;
  } finally {
    await pg.exec("ROLLBACK");
  }
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE builder_builds (id text PRIMARY KEY, owner_id text);
    CREATE TABLE auth_users (id text PRIMARY KEY, email text);
    CREATE TABLE auth_verifications (id text PRIMARY KEY, value text);
    CREATE TABLE data_sources (id text PRIMARY KEY, password text);
    CREATE TABLE kitsuden_secrets (id text PRIMARY KEY);
    INSERT INTO builder_builds VALUES ('b1', 'u-ana'), ('b2', 'u-other');
    INSERT INTO auth_users VALUES ('u-ana', 'ana@example.com'), ('u-other', 'other@example.com');
    INSERT INTO auth_verifications VALUES ('v1', 'live-token');
    INSERT INTO data_sources VALUES ('d1', 'password');
    INSERT INTO kitsuden_secrets VALUES ('s1');
  `);
  // Twice: idempotent
  for (let i = 0; i < 2; i++) {
    await pg.exec(read("rls-owned-tables.sql"));
    await pg.exec(read("rls-system-only.sql"));
  }
  await pg.exec(`
    CREATE ROLE app_test NOLOGIN;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test;
  `);
});

afterAll(async () => {
  await pg?.close();
});

describe("system hatch (rls-owned-tables.sql)", () => {
  test("the anonymous user with context does NOT see other people's rows (before: all of them)", async () => {
    expect(await count("builder_builds", ANONYMOUS)).toBe(0);
  });

  test("with no context (system) it still sees everything; the owner, their own; admin, everything", async () => {
    expect(await count("builder_builds", null)).toBe(2);
    expect(await count("builder_builds", ANA)).toBe(1);
    expect(await count("builder_builds", ADMIN)).toBe(2);
  });

  test("context cleared to '' / '' (clearRLSContext) counts as system", async () => {
    expect(await count("builder_builds", { id: "", role: "" })).toBe(2);
  });
});

describe("core tables for system/admin only (rls-system-only.sql)", () => {
  test("a user or an anonymous visitor cannot see secrets or credentials", async () => {
    for (const ctx of [ANA, ANONYMOUS]) {
      expect(await count("data_sources", ctx)).toBe(0);
      expect(await count("kitsuden_secrets", ctx)).toBe(0);
    }
    expect(await count("data_sources", ADMIN)).toBe(1);
    expect(await count("data_sources", null)).toBe(1);
  });

  test("auth_users: the own row; admin and system, all of them; anonymous, none", async () => {
    expect(await count("auth_users", ANA)).toBe(1);
    expect(await count("auth_users", ADMIN)).toBe(2);
    expect(await count("auth_users", null)).toBe(2);
    expect(await count("auth_users", ANONYMOUS)).toBe(0);
  });

  test("auth_verifications: system only (not even admin)", async () => {
    expect(await count("auth_verifications", ADMIN)).toBe(0);
    expect(await count("auth_verifications", ANA)).toBe(0);
    expect(await count("auth_verifications", null)).toBe(1);
  });
});
