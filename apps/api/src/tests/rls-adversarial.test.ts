/**
 * RLS Adversarial Tests — the "Titanium Wall" under attack
 * ============================================================================
 *
 * Unlike `rls.test.ts` (which only verifies that set_config/current_setting
 * round-trip) and `rls-ownerId.test.ts` (which does string-matching of the
 * source code), this suite ATTACKS the RLS policy at the PostgreSQL level and
 * demands that the database engine physically filter the rows.
 *
 * Threat model covered:
 *   1. User B tries to READ User A's data (cross-tenant read).
 *   2. User B tries to MODIFY / DELETE User A's rows.
 *   3. User B tries to INSERT a row spoofing owner_id = A.
 *   4. A query without RLS context (empty owner_id) sees EVERYTHING — the trap that
 *      makes the protection depend entirely on the middleware.
 *   5. SQL injection in the value of app.current_user_id does not break isolation.
 *   6. The public_read policy does not over-filter (does not expose private rows).
 *   7. The admin role sees everything (intentional escape hatch).
 *   8. The connection role must be NON-SUPERUSER, or RLS is nullified.
 *
 * CRITICAL POINT (superusers):
 *   PostgreSQL IGNORES RLS policies for superuser roles or those with BYPASSRLS,
 *   even with FORCE ROW LEVEL SECURITY. The official Postgres image creates
 *   POSTGRES_USER as a superuser, so if the app connects with that role
 *   the "Titanium Wall" filters NOTHING. For these tests to measure the real
 *   policy, we run the protected queries under a dedicated unprivileged role
 *   (`kitsuden_rls_test`) via `SET LOCAL ROLE`. This also DOCUMENTS the production
 *   requirement: the app must connect with a non-superuser role.
 *
 * Requires real PostgreSQL (skipped with pg-mem). Start it with:
 *   pnpm test:db:up  &&  KITSUDEN_TEST_DB=postgres bun test src/tests/rls-adversarial.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql, type SQL } from "drizzle-orm";

import { db } from "../db";

import { isDatabaseAvailable } from "./setup";

let dbAvailable = false;

// Unprivileged role under which the "application" queries run.
const APP_ROLE = "kitsuden_rls_test";

// Unique identifiers per run so as not to collide with existing data.
const RUN = `adv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER_A = `${RUN}-user-a`;
const USER_B = `${RUN}-user-b`;
const OUTSIDER = `${RUN}-user-c`;
const DATASET_ID = crypto.randomUUID();

let entryAId = "";
let entryBId = "";
let entryPublicId = "";
let entryLegacyAId = ""; // owner_id NULL, data.ownerId = USER_A (legacy record)

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Runs `fn` inside a transaction, under the unprivileged role
 * `kitsuden_rls_test` and with the RLS context (`app.current_user_id` / `_role`)
 * injected. It mirrors what `withTransactionalRLS()` does but guarantees
 * that RLS really applies (non-superuser role).
 */
async function runAs<T>(
  userId: string | null,
  role: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId ?? ""}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);
    return fn(tx);
  });
}

/** SELECT of the visible ids in the test dataset, under the given context. */
async function visibleIdsAs(userId: string | null, role: string): Promise<string[]> {
  return runAs(userId, role, async (tx) => {
    const res = await tx.execute<{ id: string }>(
      sql`SELECT id FROM data_entries WHERE data_set_id = ${DATASET_ID}`
    );
    return (res.rows ?? []).map((r) => r.id);
  });
}

/** Runs a mutation under a context and returns the number of rows affected. */
async function mutateAs(userId: string | null, role: string, query: SQL): Promise<number> {
  return runAs(userId, role, async (tx) => {
    const res = await tx.execute(query);
    return (res as unknown as { rowCount: number | null }).rowCount ?? 0;
  });
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

describe("RLS Adversarial — Titanium Wall", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    // 1. Apply the *real* RLS policies shipped in the repo. The policies are pre-dropped
    //    so the file can be re-run idempotently.
    await db.execute(sql`ALTER TABLE data_entries ENABLE ROW LEVEL SECURITY`);
    await db.execute(sql`ALTER TABLE data_entries FORCE ROW LEVEL SECURITY`);
    await db.execute(sql`DROP POLICY IF EXISTS data_entries_owner_isolation ON data_entries`);
    await db.execute(sql`DROP POLICY IF EXISTS data_entries_public_read ON data_entries`);
    await db.execute(
      sql`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_memories') THEN
          EXECUTE 'DROP POLICY IF EXISTS ai_memories_user_isolation ON ai_memories';
        END IF;
      END $$`
    );
    const policySql = await Bun.file("src/db/rls-policies.sql").text();
    await db.execute(sql.raw(policySql));

    // 2. Application role WITHOUT privileges (RLS does apply to it).
    //
    // A `DO $$ … $$` block does not accept parameters (`$1`): Postgres responded
    // «bind message supplies 2 parameters, but prepared statement "" requires
    // 0» and the whole suite fell over in beforeAll. The role name is a
    // constant of this file, so it goes in as a literal (with its guard).
    if (!/^[a-z_]+$/.test(APP_ROLE)) throw new Error(`Unexpected APP_ROLE: ${APP_ROLE}`);
    const literalRole = sql.raw(`'${APP_ROLE}'`);
    await db.execute(
      sql`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literalRole}) THEN
          EXECUTE format('CREATE ROLE %I NOLOGIN', ${literalRole});
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`
    );
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.raw(APP_ROLE)}`);
    await db.execute(
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON data_entries TO ${sql.raw(APP_ROLE)}`
    );
    // `data_entries_dataset_read` looks at `data_sets.policy_json`: the role
    // that queries needs to read `data_sets`, like the app's real role.
    await db.execute(sql`GRANT SELECT ON data_sets TO ${sql.raw(APP_ROLE)}`);
    // The connection must be able to assume the role (if it is not a superuser, it needs membership).
    await db.execute(
      sql`DO $$ BEGIN
        EXECUTE format('GRANT %I TO %I', ${literalRole}, current_user);
      EXCEPTION WHEN OTHERS THEN NULL; END $$`
    );

    // 3. Fixtures: two real users + an outsider, a dataset, and entries.
    await db.execute(sql`
      INSERT INTO auth_users (id, name, email, role)
      VALUES
        (${USER_A}, 'RLS User A', ${`${USER_A}@example.com`}, 'user'),
        (${USER_B}, 'RLS User B', ${`${USER_B}@example.com`}, 'user'),
        (${OUTSIDER}, 'RLS Outsider', ${`${OUTSIDER}@example.com`}, 'user')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO data_sets (id, name, slug, schema)
      VALUES (${DATASET_ID}, 'RLS Adversarial DS', ${`${RUN}-ds`}, '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);

    entryAId = crypto.randomUUID();
    entryBId = crypto.randomUUID();
    entryPublicId = crypto.randomUUID();
    entryLegacyAId = crypto.randomUUID();

    await db.execute(sql`
      INSERT INTO data_entries (id, title, data_set_id, owner_id, data, status)
      VALUES
        (${entryAId}, 'Secret A', ${DATASET_ID}, ${USER_A},
          ${JSON.stringify({ secret: "user-a-data", ownerId: USER_A })}::jsonb, 'published'),
        (${entryBId}, 'Secret B', ${DATASET_ID}, ${USER_B},
          ${JSON.stringify({ secret: "user-b-data", ownerId: USER_B })}::jsonb, 'published'),
        (${entryPublicId}, 'Public Post', ${DATASET_ID}, NULL,
          ${JSON.stringify({ isPublic: true, body: "hello world" })}::jsonb, 'published'),
        (${entryLegacyAId}, 'Legacy A', ${DATASET_ID}, NULL,
          ${JSON.stringify({ ownerId: USER_A, secret: "legacy" })}::jsonb, 'published')
    `);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.execute(sql`DELETE FROM data_entries WHERE data_set_id = ${DATASET_ID}`);
    await db.execute(sql`DELETE FROM data_sets WHERE id = ${DATASET_ID}`);
    await db.execute(sql`DELETE FROM auth_users WHERE id IN (${USER_A}, ${USER_B}, ${OUTSIDER})`);
  });

  // ── 0. Precondition: the enforcement role CANNOT be a superuser ──────

  describe("Security precondition", () => {
    it("the application role is not a superuser and does not have BYPASSRLS", async () => {
      if (!dbAvailable) return;
      const res = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}`
      );
      const row = res.rows?.[0];
      expect(row).toBeDefined();
      // If this fails, RLS protects NOTHING: PostgreSQL skips the policies
      // for superusers and BYPASSRLS roles.
      expect(row!.rolsuper).toBe(false);
      expect(row!.rolbypassrls).toBe(false);
    });

    it("data_entries has RLS enabled and forced", async () => {
      if (!dbAvailable) return;
      const res = await db.execute<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'data_entries'`
      );
      const row = res.rows?.[0];
      expect(row?.relrowsecurity).toBe(true);
      // FORCE is what makes the table owner get filtered too.
      expect(row?.relforcerowsecurity).toBe(true);
    });

    it("diagnostic: reports whether the CONNECTION role bypasses RLS (risk in prod)", async () => {
      if (!dbAvailable) return;
      const res = await db.execute<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        sql`SELECT current_user, rolsuper, rolbypassrls
            FROM pg_roles WHERE rolname = current_user`
      );
      const row = res.rows?.[0];
      if (row?.rolsuper || row?.rolbypassrls) {
        console.warn(
          `⚠️  [RLS] The connection role '${row?.current_user}' is superuser/bypassrls: ` +
            `in production RLS would filter NOTHING under this role. The app must connect ` +
            `with an unprivileged role. (These tests force '${APP_ROLE}' to measure the real policy.)`
        );
      }
      // This is not a failure of the policy itself; we only guarantee that the query ran.
      expect(typeof row?.current_user).toBe("string");
    });
  });

  // ── 1. Read isolation (cross-tenant read) ─────────────────────────

  describe("Read isolation", () => {
    it("A sees their own entry but NOT B's", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs(USER_A, "user");
      expect(ids).toContain(entryAId);
      expect(ids).not.toContain(entryBId);
    });

    it("B can NOT read A's entry (cross-tenant attack)", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs(USER_B, "user");
      expect(ids).not.toContain(entryAId);
      expect(ids).toContain(entryBId);
    });

    it("an outsider with no data only sees public entries", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs(OUTSIDER, "user");
      expect(ids).not.toContain(entryAId);
      expect(ids).not.toContain(entryBId);
      expect(ids).toContain(entryPublicId);
    });
  });

  // ── 2. Write isolation (update / delete / insert) ────────────────

  describe("Write isolation", () => {
    it("B can NOT UPDATE A's row (0 rows affected)", async () => {
      if (!dbAvailable) return;
      const affected = await mutateAs(
        USER_B,
        "user",
        sql`UPDATE data_entries SET title = 'hacked-by-b' WHERE id = ${entryAId}`
      );
      expect(affected).toBe(0);

      // A's row remains intact (read as A).
      const stillThere = await runAs(USER_A, "user", async (tx) => {
        const r = await tx.execute<{ title: string }>(
          sql`SELECT title FROM data_entries WHERE id = ${entryAId}`
        );
        return r.rows?.[0]?.title;
      });
      expect(stillThere).toBe("Secret A");
    });

    it("B can NOT DELETE A's row (0 rows affected)", async () => {
      if (!dbAvailable) return;
      const affected = await mutateAs(
        USER_B,
        "user",
        sql`DELETE FROM data_entries WHERE id = ${entryAId}`
      );
      expect(affected).toBe(0);

      const exists = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM data_entries WHERE id = ${entryAId}`
      );
      expect(exists.rows?.[0]?.n).toBe(1);
    });

    it("B can NOT INSERT a row spoofing owner_id = A (WITH CHECK)", async () => {
      if (!dbAvailable) return;
      const spoofId = crypto.randomUUID();
      const attempt = runAs(USER_B, "user", async (tx) => {
        await tx.execute(sql`
          INSERT INTO data_entries (id, title, data_set_id, owner_id, data, status)
          VALUES (${spoofId}, 'Spoofed', ${DATASET_ID}, ${USER_A}, '{}'::jsonb, 'published')
        `);
      });
      // The WITH CHECK policy must reject the insert with a foreign owner.
      await expect(attempt).rejects.toThrow();

      // And no spoofed row must have been left behind.
      const leaked = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM data_entries WHERE id = ${spoofId}`
      );
      expect(leaked.rows?.[0]?.n).toBe(0);
    });

    it("B CAN insert a row of their own (owner_id = B)", async () => {
      if (!dbAvailable) return;
      const ownId = crypto.randomUUID();
      await runAs(USER_B, "user", async (tx) => {
        await tx.execute(sql`
          INSERT INTO data_entries (id, title, data_set_id, owner_id, data, status)
          VALUES (${ownId}, 'B own row', ${DATASET_ID}, ${USER_B}, '{}'::jsonb, 'published')
        `);
      });
      const ids = await visibleIdsAs(USER_B, "user");
      expect(ids).toContain(ownId);
      // Local cleanup.
      await db.execute(sql`DELETE FROM data_entries WHERE id = ${ownId}`);
    });
  });

  // ── 3. The empty-context trap (defense depends on the middleware) ──────

  describe("Escape hatch: empty RLS context sees EVERYTHING", () => {
    it("with neither id NOR role (the system), a query sees all users' rows", async () => {
      if (!dbAvailable) return;
      // This is why the RLS middleware is MANDATORY on every
      // route that touches data_entries: if the context is not injected, the connection
      // is the system's and the policy opens the door to EVERYTHING.
      const ids = await visibleIdsAs("", "");
      expect(ids).toContain(entryAId);
      expect(ids).toContain(entryBId);
    });

    it("a request's ANONYMOUS user (id '' and role anonymous) is NOT the system", async () => {
      if (!dbAvailable) return;
      // Before, the hatch only looked at the empty id, and the anonymous user that
      // withTransactionalRLS() sets went through the policy as the system
      // (closed in data_entries too).
      const ids = await visibleIdsAs("", "anonymous");
      expect(ids).not.toContain(entryAId);
      expect(ids).not.toContain(entryBId);
    });
  });

  // ── 4. SQL injection in the context value ─────────────────────────────

  describe("Injection in the RLS context", () => {
    it("a malicious user_id is treated as a literal and does not break isolation", async () => {
      if (!dbAvailable) return;
      const malicious = "x' OR '1'='1";
      const ids = await visibleIdsAs(malicious, "user");
      // It matches no real owner → only public rows, never A or B.
      expect(ids).not.toContain(entryAId);
      expect(ids).not.toContain(entryBId);
      expect(ids).toContain(entryPublicId);
    });

    it("a malicious role ('admin' spoofed by string) still goes through as a parameter", async () => {
      if (!dbAvailable) return;
      // Note: whoever controls the ROLE controls the admin bypass. This test documents
      // that the role comes from the server-side context, not from user input.
      const ids = await visibleIdsAs(USER_B, "not-admin");
      expect(ids).not.toContain(entryAId);
    });
  });

  // ── 5. The public_read policy does not over-filter ──────────────────────────────

  describe("public_read policy", () => {
    it("public rows (owner NULL + isPublic) are visible to anyone", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs(USER_B, "user");
      expect(ids).toContain(entryPublicId);
    });

    it("public_read does NOT expose private rows that have an owner (non-null owner_id)", async () => {
      if (!dbAvailable) return;
      // entryA has owner_id = A: the public_read policy requires owner_id IS NULL,
      // so it must never leak to B this way.
      const ids = await visibleIdsAs(USER_B, "user");
      expect(ids).not.toContain(entryAId);
    });
  });

  // ── 6. Legacy records (owner_id NULL + data->>'ownerId') ────────────────

  describe("Legacy compatibility (data.ownerId)", () => {
    it("A sees their legacy record via data->>'ownerId'", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs(USER_A, "user");
      expect(ids).toContain(entryLegacyAId);
    });

    it("B does NOT see A's legacy record", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs(USER_B, "user");
      expect(ids).not.toContain(entryLegacyAId);
    });
  });

  // ── 7. Admin escape hatch (intentional) ───────────────────────────────────

  describe("Admin role", () => {
    it("admin sees the entries of ALL users", async () => {
      if (!dbAvailable) return;
      const ids = await visibleIdsAs("some-admin-id", "admin");
      expect(ids).toContain(entryAId);
      expect(ids).toContain(entryBId);
      expect(ids).toContain(entryPublicId);
    });

    it("admin can update any user's row", async () => {
      if (!dbAvailable) return;
      const affected = await mutateAs(
        "some-admin-id",
        "admin",
        sql`UPDATE data_entries SET title = 'touched-by-admin' WHERE id = ${entryBId}`
      );
      expect(affected).toBe(1);
      // Restore.
      await db.execute(sql`UPDATE data_entries SET title = 'Secret B' WHERE id = ${entryBId}`);
    });
  });
});
