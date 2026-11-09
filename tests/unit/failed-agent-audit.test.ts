/**
 * Failed agent authentication attempts ARE AUDITED (earlier
 * audit).
 *
 * With a nonexistent or malformed key, `authenticateAgent` wrote to
 * `agent_audit_logs` with `agent_id = 'unknown'`: FK violation (23503), the
 * INSERT failed, the log said "Failed to write agent audit log" and the attempt
 * was not recorded. Here real SQL (PGlite) is used, with the real DDL of the
 * table (migration 0037) plus 0044, and the real audit code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATIONS = resolve(__dirname, "../../apps/api/src/db/migrations");

const pg = new PGlite();
const testDatabase = drizzle(pg);
const errors: unknown[] = [];

vi.mock("../../apps/api/src/db", () => ({ db: testDatabase }));
vi.mock("../../apps/api/src/lib/logger", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => errors.push(args),
  },
}));
vi.mock("../../apps/api/src/services/agent-webhooks", () => ({
  notifyAuthSuccess: () => {},
  notifyAuthFailure: () => {},
  notifyRateLimited: () => {},
  notifyPermissionDenied: () => {},
}));

const { logAuthFailure } = await import("../../apps/api/src/services/agent-audit");
const { authenticateAgent } = await import("../../apps/api/src/services/agent-auth");

/** The CREATE TABLE of agent_audit_logs exactly as it is in 0037. */
function auditDdl(): string {
  const sql = readFileSync(
    resolve(MIGRATIONS, "0037_declared_tables_without_migration.sql"),
    "utf8"
  );
  const block = sql.match(/CREATE TABLE IF NOT EXISTS agent_audit_logs \([\s\S]*?\n\);/)?.[0];
  if (!block) throw new Error("Cannot find the DDL of agent_audit_logs in 0037");
  return block;
}

type Row = {
  agent_id: string | null;
  action: string;
  success: boolean;
  error_message: string;
  details: unknown;
};

async function rows(): Promise<Row[]> {
  const r = await pg.query<Row>(
    "SELECT agent_id, action, success, error_message, details FROM agent_audit_logs ORDER BY created_at"
  );
  return r.rows;
}

/** The write happens in the background: wait for it to appear (or to fail). */
async function waitForRows(n: number): Promise<Row[]> {
  for (let i = 0; i < 100; i++) {
    const f = await rows();
    if (f.length >= n || errors.length > 0) return f;
    await new Promise((r) => setTimeout(r, 10));
  }
  return rows();
}

beforeAll(async () => {
  // The minimum of agent_identities for the FK, and the real table.
  await pg.exec(`CREATE TABLE agent_identities (id text PRIMARY KEY);`);
  await pg.exec(auditDdl());
  await pg.exec(readFileSync(resolve(MIGRATIONS, "0044_agent_audit_without_agent.sql"), "utf8"));
  await pg.exec(`INSERT INTO agent_identities (id) VALUES ('real-agent');`);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  errors.length = 0;
  await pg.exec("DELETE FROM agent_audit_logs");
});

describe("authentication failures with no known agent", () => {
  it("a malformed key is audited with agent_id NULL", async () => {
    const r = await authenticateAgent("this-is-not-a-key", { ipAddress: "203.0.113.5" });
    expect(r.success).toBe(false);

    const f = await waitForRows(1);
    expect(errors).toEqual([]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      agent_id: null,
      action: "auth_failure",
      success: false,
      error_message: "Invalid API key format",
    });
  });

  it("logAuthFailure(null, …) writes; it stores the key's public id, not the secret", async () => {
    logAuthFailure(null, "Invalid or expired API key", "198.51.100.7", "curl", {
      attemptedKeyId: "0123456789abcdef",
    });
    const f = await waitForRows(1);
    expect(errors).toEqual([]);
    expect(f[0]?.agent_id).toBeNull();
    expect(f[0]?.details).toEqual({ attemptedKeyId: "0123456789abcdef" });
  });

  it("a failure of an agent that DOES exist still goes under its name", async () => {
    logAuthFailure("real-agent", "Agent is deactivated");
    const f = await waitForRows(1);
    expect(errors).toEqual([]);
    expect(f[0]?.agent_id).toBe("real-agent");
  });

  it("the FK still stands: a nonexistent id does not slip through", async () => {
    await expect(
      pg.query(
        "INSERT INTO agent_audit_logs (agent_id, action, success) VALUES ('unknown', 'auth_failure', false)"
      )
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("the code no longer writes 'unknown'", () => {
  it("authenticateAgent does not pass the string 'unknown' to logAuthFailure", () => {
    const source = readFileSync(
      resolve(__dirname, "../../apps/api/src/services/agent-auth.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/logAuthFailure\(\s*"unknown"/);
  });
});
