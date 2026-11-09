/**
 * The kon authoring helpers: `actsAsUserIn` and the row-security one-liners
 * ============================================================================
 *
 * `kitsuden_rls_team`, `kitsuden_rls_owned` and `kitsuden_rls_public_read` (agent-functions.sql)
 * replace policies kons used to write by hand. They run here on PGlite with a NON-superuser role
 * — with a superuser the policies filter nothing and this would prove nothing — and with the
 * context set the way the host sets it for each request.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actsAsUserIn } from "../../packages/engine/src/effective-actor";

describe("actsAsUserIn", () => {
  const rule = actsAsUserIn("booking");
  it("a human account passes; nobody without an id does", () => {
    expect(rule({ id: "u1", role: "user" })).toBe(true);
    expect(rule(null)).toBe(false);
    expect(rule({ role: "user" })).toBe(false);
  });
  it("an agent passes with user:act, admin or a scope of the kon, and a denial does not count", () => {
    expect(rule({ id: "a", role: "agent", scopes: ["user:act"] })).toBe(true);
    expect(rule({ id: "a", role: "agent", scopes: ["admin"] })).toBe(true);
    expect(rule({ id: "a", role: "agent", scopes: ["booking:list"] })).toBe(true);
    expect(rule({ id: "a", role: "agent", scopes: ["kon:booking:create"] })).toBe(true);
    expect(rule({ id: "a", role: "agent", scopes: ["blog:*"] })).toBe(false);
    expect(rule({ id: "a", role: "agent", scopes: ["!booking:*"] })).toBe(false);
    expect(rule({ id: "a", role: "agent", scopes: "booking:*" })).toBe(false);
  });
});

let pg: PGlite;
const APP = "rls_helpers_app";

type Who = { id: string; role: string; scopes?: string } | null;
const ANON: Who = { id: "", role: "anonymous" };
const USER_A: Who = { id: "user-a", role: "user" };
const USER_B: Who = { id: "user-b", role: "user" };
const EDITOR: Who = { id: "ed", role: "editor" };
const agent = (scopes: string): Who => ({ id: "agent-1", role: "agent", scopes });

async function as<T>(who: Who, fn: (q: (sql: string) => Promise<T[]>) => Promise<unknown>) {
  await pg.exec(`BEGIN; SET LOCAL ROLE ${APP};`);
  try {
    if (who) {
      await pg.query("SELECT set_config('app.current_user_id', $1, true)", [who.id]);
      await pg.query("SELECT set_config('app.current_user_role', $1, true)", [who.role]);
      if (who.scopes)
        await pg.query("SELECT set_config('app.agent_scopes', $1, true)", [who.scopes]);
    }
    return await fn(async (sql) => (await pg.query<T>(sql)).rows);
  } finally {
    await pg.exec("ROLLBACK;");
  }
}
const count = async (who: Who, table: string) =>
  (await as<{ n: number }>(who, (q) =>
    q(`SELECT count(*)::int AS n FROM ${table}`)
  )) as unknown as {
    n: number;
  }[];
const n = async (who: Who, table: string) => Number((await count(who, table))[0].n);
const canInsert = async (who: Who, sql: string) => {
  try {
    await as(who, (q) => q(sql));
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    readFileSync(resolve(__dirname, "../../apps/api/src/db/agent-functions.sql"), "utf8")
  );
  await pg.exec(`
    CREATE TABLE invoices (id text PRIMARY KEY, amount int);
    CREATE TABLE notes (id text PRIMARY KEY, owner_id text NOT NULL, body text);
    CREATE TABLE posts (id text PRIMARY KEY, status text NOT NULL);
    INSERT INTO invoices VALUES ('i1', 10);
    INSERT INTO notes VALUES ('n1', 'user-a', 'mine'), ('n2', 'user-b', 'theirs');
    INSERT INTO posts VALUES ('p1', 'published'), ('p2', 'draft');
    SELECT kitsuden_rls_team('invoices', 'billing', 'invoice:view', 'invoice:update');
    SELECT kitsuden_rls_owned('notes', 'owner_id', 'notes', NULL, NULL);
    SELECT kitsuden_rls_team('posts', 'blog', 'post:view', 'post:update');
    SELECT kitsuden_rls_public_read('posts', $$status = 'published'$$);
    -- Idempotent: a later migration can call them again.
    SELECT kitsuden_rls_team('invoices', 'billing', 'invoice:view', 'invoice:update');
    CREATE ROLE ${APP} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP};
  `);
});

afterAll(async () => {
  await pg?.close();
});

describe("kitsuden_rls_team", () => {
  it("the team and the system read; an anonymous request or a customer does not", async () => {
    expect(await n(EDITOR, "invoices")).toBe(1);
    expect(await n(null, "invoices")).toBe(1); // the system: no user and no role
    expect(await n(ANON, "invoices")).toBe(0);
    expect(await n(USER_A, "invoices")).toBe(0);
  });
  it("an agent reads with the view scope, writes only with the change scope, and a denial wins", async () => {
    expect(await n(agent("invoice:view"), "invoices")).toBe(1);
    expect(await n(agent("billing:*"), "invoices")).toBe(1);
    expect(await n(agent("blog:*"), "invoices")).toBe(0);
    expect(await n(agent("billing:*,!billing:*"), "invoices")).toBe(0);
    expect(await canInsert(agent("invoice:view"), "INSERT INTO invoices VALUES ('i2', 1)")).toBe(
      false
    );
    expect(await canInsert(agent("invoice:update"), "INSERT INTO invoices VALUES ('i3', 1)")).toBe(
      true
    );
  });
});

describe("kitsuden_rls_owned", () => {
  it("a user reads and writes only their own rows; the team reads all", async () => {
    expect(await n(USER_A, "notes")).toBe(1);
    expect(await n(USER_B, "notes")).toBe(1);
    expect(await n(ANON, "notes")).toBe(0);
    expect(await n(EDITOR, "notes")).toBe(2);
    expect(await canInsert(USER_A, "INSERT INTO notes VALUES ('n3', 'user-a', 'x')")).toBe(true);
    expect(await canInsert(USER_A, "INSERT INTO notes VALUES ('n4', 'user-b', 'x')")).toBe(false);
  });
});

describe("kitsuden_rls_public_read", () => {
  it("anyone reads what meets the condition, and writes nothing", async () => {
    expect(await n(ANON, "posts")).toBe(1);
    expect(await n(USER_A, "posts")).toBe(1);
    expect(await n(EDITOR, "posts")).toBe(2);
    expect(await canInsert(ANON, "INSERT INTO posts VALUES ('p3', 'published')")).toBe(false);
  });
});
