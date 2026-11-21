/**
 * data_entries_dataset_read honours an agent's per-dataset denial (H87, 2026-11-20)
 * ============================================================================
 *
 * The policy opened every entry of a public dataset to anyone, agents included,
 * so `!datasets:<slug>:read` was enforced only by the application
 * (canViewDataset). Migration 0092 and rls-policies.sql add the denial to the
 * policy. This suite runs the real policy under an unprivileged role, because
 * Postgres skips RLS for superusers.
 *
 * Requires real PostgreSQL (skipped with pg-mem):
 *   pnpm test:db:up  &&  KITSUDEN_TEST_DB=postgres bun test src/tests/security-hardening-2026-11-20-dataset-read-denial.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";

import { isDatabaseAvailable } from "./setup";

const APP_ROLE = "kitsuden_rls_test";
const RUN = `h87-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DATASET_ID = crypto.randomUUID();
const SLUG = `${RUN}-public`;
const AGENT_ID = `${RUN}-agent`;

let dbAvailable = false;

/** Entries of the test dataset an agent with these scopes sees, under the real policies. */
async function visibleToAgent(scopes: string[]): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${AGENT_ID}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_role', 'agent', true)`);
    await tx.execute(sql`SELECT set_config('app.agent_scopes', ${scopes.join(",")}, true)`);
    const r = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM data_entries WHERE data_set_id = ${DATASET_ID}`
    );
    return r.rows?.[0]?.n ?? 0;
  });
}

/** The same for a signed-in human (no agent scopes). */
async function visibleToHuman(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${`${RUN}-human`}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_role', 'user', true)`);
    const r = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM data_entries WHERE data_set_id = ${DATASET_ID}`
    );
    return r.rows?.[0]?.n ?? 0;
  });
}

describe("data_entries_dataset_read and agent denials", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    // The migration under test, applied again: it is idempotent by design.
    const migration = readFileSync(
      resolve(import.meta.dir, "../db/migrations/0092_dataset_read_honours_agent_denials.sql"),
      "utf8"
    );
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));

    const literalRole = sql.raw(`'${APP_ROLE}'`);
    await db.execute(
      sql`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literalRole}) THEN
          EXECUTE format('CREATE ROLE %I NOLOGIN', ${literalRole});
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`
    );
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.raw(APP_ROLE)}`);
    await db.execute(sql`GRANT SELECT ON data_entries TO ${sql.raw(APP_ROLE)}`);
    await db.execute(sql`GRANT SELECT ON data_sets TO ${sql.raw(APP_ROLE)}`);
    await db.execute(
      sql`DO $$ BEGIN
        EXECUTE format('GRANT %I TO %I', ${literalRole}, current_user);
      EXCEPTION WHEN OTHERS THEN NULL; END $$`
    );

    await db.execute(sql`
      INSERT INTO data_sets (id, name, slug, schema, policy_json)
      VALUES (${DATASET_ID}, 'H87 public', ${SLUG}, '[]'::jsonb,
              '{"readAccess":"public","writeAccess":"admin"}'::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO data_entries (id, title, data_set_id, owner_id, data, status)
      VALUES (${crypto.randomUUID()}, 'Public row', ${DATASET_ID}, NULL, '{}'::jsonb, 'published')
    `);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.execute(sql`DELETE FROM data_entries WHERE data_set_id = ${DATASET_ID}`);
    await db.execute(sql`DELETE FROM data_sets WHERE id = ${DATASET_ID}`);
  });

  it("a public dataset stays readable to humans and to agents without a denial", async () => {
    if (!dbAvailable) return;
    expect(await visibleToHuman()).toBe(1);
    // `mcp:connect` alone opens nothing by scope: only data_entries_dataset_read lets it in.
    expect(await visibleToAgent(["mcp:connect"])).toBe(1);
  });

  it("an agent denial on the dataset closes it in the database", async () => {
    if (!dbAvailable) return;
    expect(await visibleToAgent(["mcp:connect", `!datasets:${SLUG}:read`])).toBe(0);
    expect(await visibleToAgent(["mcp:connect", `!datasets:${SLUG}:*`])).toBe(0);
    expect(await visibleToAgent(["mcp:connect", "!datasets:*"])).toBe(0);
  });

  it("a denial of another action or another dataset does not close reading", async () => {
    if (!dbAvailable) return;
    expect(await visibleToAgent(["mcp:connect", `!datasets:${SLUG}:write`])).toBe(1);
    expect(await visibleToAgent(["mcp:connect", "!datasets:some-other-slug:read"])).toBe(1);
  });
});
