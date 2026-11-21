/**
 * Static agent keys die with their creator's admin role (hardening 2026-11-21, H59)
 * ============================================================================
 *
 * `agent_api_keys` did not record who minted a key, so the keys an admin minted
 * kept working after that admin was demoted or deleted. Migration 0094 adds
 * `created_by`; every minting route sets it; losing `admin` revokes the live
 * static keys that person created (`revoked_by = 'system:demotion'`, one audit
 * entry per key), and authentication refuses (and revokes) a key whose creator
 * is no longer an admin even when the role changed somewhere else. Keys with no
 * `created_by` (minted before 0094) keep working.
 *
 * Real SQL (PGlite), the real migration 0094 and the real audit writer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS = resolve(ROOT, "apps/api/src/db/migrations");

const pg = new PGlite();
const testDatabase = drizzle(pg);

vi.mock("../../apps/api/src/db", () => ({ db: testDatabase }));
vi.mock("../../apps/api/src/lib/logger", () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../apps/api/src/services/agent-webhooks", () => ({
  notifyAuthSuccess: () => {},
  notifyAuthFailure: () => {},
  notifyRateLimited: () => {},
  notifyPermissionDenied: () => {},
}));

const { agentApiKeys, agentIdentities } = await import("../../apps/api/src/db/schema-core");
const auth = await import("../../apps/api/src/services/agent-auth");
const { authenticateAgent, agentContextForApproval, generateAgentApiKey } = auth;
const { revokeKeysOfFormerAdmin, creatorKeepsKeys, DEMOTION_REVOKER, forgetKeyChecks } = auth;

/** CREATE TABLE from the Drizzle definition, leaving out `skip` (added by a migration). */
function ddlOf(table: Parameters<typeof getTableConfig>[0], skip: string[] = []): string {
  const { name, columns } = getTableConfig(table);
  const cols = columns
    .filter((c) => !skip.includes(c.name))
    .map((c) => `"${c.name}" ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}`);
  return `CREATE TABLE ${name} (${cols.join(", ")});`;
}

function auditDdl(): string {
  const sql = readFileSync(
    resolve(MIGRATIONS, "0037_declared_tables_without_migration.sql"),
    "utf8"
  );
  const block = sql.match(/CREATE TABLE IF NOT EXISTS agent_audit_logs \([\s\S]*?\n\);/)?.[0];
  if (!block) throw new Error("Cannot find the DDL of agent_audit_logs in 0037");
  return block;
}

beforeAll(async () => {
  await pg.exec(`CREATE TABLE auth_users (id text PRIMARY KEY, role text NOT NULL);`);
  await pg.exec(ddlOf(agentIdentities));
  await pg.exec(ddlOf(agentApiKeys, ["created_by"]));
  // The migration under test, on the table as it was before it.
  await pg.exec(readFileSync(resolve(MIGRATIONS, "0094_agent_api_keys_created_by.sql"), "utf8"));
  await pg.exec(auditDdl());
  await pg.exec(readFileSync(resolve(MIGRATIONS, "0044_agent_audit_without_agent.sql"), "utf8"));
  await pg.exec(readFileSync(resolve(MIGRATIONS, "0088_audit_chain.sql"), "utf8"));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  forgetKeyChecks();
  await pg.exec(`ALTER TABLE agent_audit_logs DISABLE TRIGGER USER;
    DELETE FROM agent_audit_logs; DELETE FROM agent_audit_checkpoints;
    ALTER TABLE agent_audit_logs ENABLE TRIGGER USER;
    DELETE FROM agent_api_keys; DELETE FROM agent_identities; DELETE FROM auth_users;`);
  await pg.exec(`INSERT INTO auth_users (id, role) VALUES ('admin-a', 'admin'), ('admin-b', 'admin');
    INSERT INTO agent_identities (id, name, scopes, rate_limit, allowed_tools, mcp_settings,
      require_dpop, is_active)
    VALUES ('agent-1', 'one', '["admin"]', 60, '[]', '{}', false, true);`);
});

/** Mints a real static key for agent-1 and stores it with this creator. */
async function mint(createdBy: string | null, algorithmOverride?: string) {
  const k = await generateAgentApiKey("custom");
  const id = crypto.randomUUID();
  await pg.query(
    `INSERT INTO agent_api_keys (id, agent_id, key_id, key_hash, key_prefix, algorithm, created_by)
     VALUES ($1, 'agent-1', $2, $3, $4, $5, $6)`,
    [id, k.keyId, k.keyHash, k.keyPrefix, algorithmOverride ?? k.algorithm, createdBy]
  );
  return { id, plainKey: k.plainKey };
}

async function keyRow(id: string) {
  const r = await pg.query<{ revoked_at: Date | null; revoked_by: string | null }>(
    "SELECT revoked_at, revoked_by FROM agent_api_keys WHERE id = $1",
    [id]
  );
  return r.rows[0]!;
}

async function auditFor(keyId: string) {
  for (let i = 0; i < 100; i++) {
    const r = await pg.query<{ action: string; details: Record<string, unknown> }>(
      "SELECT action, details FROM agent_audit_logs WHERE resource_id = $1",
      [keyId]
    );
    if (r.rows.length) return r.rows;
    await new Promise((res) => setTimeout(res, 10));
  }
  return [];
}

describe("migration 0094", () => {
  it("adds created_by with no foreign key, and is idempotent", async () => {
    await pg.exec(readFileSync(resolve(MIGRATIONS, "0094_agent_api_keys_created_by.sql"), "utf8"));
    const fk = await pg.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'agent_api_keys' AND constraint_type = 'FOREIGN KEY'`
    );
    expect(fk.rows).toHaveLength(0);
  });
});

describe("revokeKeysOfFormerAdmin", () => {
  it("revokes the creator's live static keys, with system:demotion and an audit entry", async () => {
    const mine = await mint("admin-a");
    const other = await mint("admin-b");
    const legacy = await mint(null);
    const oauth = await mint("admin-a", "oauth");

    const revoked = await revokeKeysOfFormerAdmin("admin-a", "demoted", "admin-b");
    expect(revoked).toEqual([mine.id]);

    const row = await keyRow(mine.id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(DEMOTION_REVOKER);
    expect(DEMOTION_REVOKER).toBe("system:demotion");
    for (const untouched of [other.id, legacy.id, oauth.id]) {
      expect((await keyRow(untouched)).revoked_at).toBeNull();
    }

    const audit = await auditFor(mine.id);
    expect(audit[0]?.action).toBe("config_change");
    expect(audit[0]?.details).toMatchObject({
      revoked: true,
      revokedBy: "system:demotion",
      reason: "creator_demoted",
      createdBy: "admin-a",
      by: "admin-b",
    });
  });

  it("only an admin keeps the keys they minted", () => {
    expect(creatorKeepsKeys("admin")).toBe(true);
    for (const role of ["editor", "user", null, undefined])
      expect(creatorKeepsKeys(role)).toBe(false);
  });
});

describe("authentication re-checks the creator", () => {
  it("a key whose creator is still an admin authenticates", async () => {
    const k = await mint("admin-a");
    const r = await authenticateAgent(k.plainKey);
    expect(r.success).toBe(true);
  });

  it("a key minted before 0094 (no created_by) keeps working", async () => {
    const k = await mint(null);
    expect((await authenticateAgent(k.plainKey)).success).toBe(true);
  });

  it("creator demoted outside the role route: refused, and all their keys revoked", async () => {
    const k = await mint("admin-a");
    const sibling = await mint("admin-a");
    await pg.exec(`UPDATE auth_users SET role = 'editor' WHERE id = 'admin-a'`);

    const r = await authenticateAgent(k.plainKey);
    expect(r).toMatchObject({ success: false, code: "KEY_REVOKED" });
    for (const id of [k.id, sibling.id]) {
      expect((await keyRow(id)).revoked_by).toBe("system:demotion");
    }
    expect((await auditFor(k.id))[0]?.details).toMatchObject({ reason: "creator_demoted" });
  });

  it("creator account deleted: refused", async () => {
    const k = await mint("admin-a");
    await pg.exec(`DELETE FROM auth_users WHERE id = 'admin-a'`);
    expect(await authenticateAgent(k.plainKey)).toMatchObject({
      success: false,
      code: "KEY_REVOKED",
    });
    expect((await auditFor(k.id))[0]?.details).toMatchObject({ reason: "creator_deleted" });
  });

  it("an approved proposal made with such a key does not run", async () => {
    const k = await mint("admin-a");
    expect((await agentContextForApproval("agent-1", k.id)).ok).toBe(true);
    await pg.exec(`UPDATE auth_users SET role = 'user' WHERE id = 'admin-a'`);
    expect(await agentContextForApproval("agent-1", k.id)).toEqual({
      ok: false,
      reason: "key_revoked",
    });
  });
});

/** Every non-test source file under apps/api/src. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests" || name === "tests-unit" || name === "node_modules") continue;
      out.push(...sources(p));
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("every place that mints a key records who did", () => {
  it("each insert into agent_api_keys sets createdBy", () => {
    const missing: string[] = [];
    for (const file of sources(resolve(ROOT, "apps/api/src"))) {
      const src = readFileSync(file, "utf8");
      let at = src.indexOf("insert(agentApiKeys)");
      while (at !== -1) {
        const values = src.slice(at, src.indexOf("})", at));
        if (!values.includes("createdBy")) missing.push(`${file}:${at}`);
        at = src.indexOf("insert(agentApiKeys)", at + 1);
      }
    }
    expect(missing).toEqual([]);
  });

  it("POST /api/keys passes the admin's id to createAgent", () => {
    const src = readFileSync(resolve(ROOT, "apps/api/src/routes/api-keys.ts"), "utf8");
    expect(src).toMatch(/createdBy: c\.get\("user"\)\?\.id/);
  });

  it("the role route revokes the demoted admin's keys", () => {
    const src = readFileSync(resolve(ROOT, "apps/api/src/routes/admin-system.ts"), "utf8");
    const route = src.slice(
      src.indexOf("async function changeRole"),
      src.indexOf("systemAdminRoutes.patch")
    );
    expect(route).toMatch(
      /if \(target\.role === "admin" && role !== "admin"\) \{\s*revokedKeys = \(await revokeKeysOfFormerAdmin\(id, "demoted"/
    );
  });
});
