/**
 * Security audit 2026-11-19: export honors a key's per-dataset deny
 * ============================================================================
 *
 * `POST /api/datasets/export` (MCP `datasets__export-datasets`) is granted at
 * operation level (`admin`, `datasets:*`, `kon:datasets:export-datasets`…). A key
 * such as `["admin", "!datasets:payroll:*"]` passed that check, and the handler
 * then exported the payroll dataset's name, schema, calculated fields and
 * entries. docs/agents/permissions.md promises that the deny closes the dataset
 * on every path. Now the handler refuses a denied slug before reading anything.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../apps/api/src/lib/test-kon-context";
import { registerDatasetsPolicy } from "../../packages/core/datasets/datasets.policy";
import { createDatasetsRouter } from "../../packages/core/datasets/datasets.routes";

const ADMIN = { id: "u-admin", role: "admin" };
const AGENT_DENIED = {
  id: "ag-1",
  role: "agent",
  scopes: ["admin", "!datasets:payroll:*"],
};
const AGENT_DENIED_READ = {
  id: "ag-2",
  role: "agent",
  scopes: ["kon:datasets:export-datasets", "!datasets:payroll:read"],
};

let client: PGlite;
let app: Hono;

async function exportAs(user: Record<string, unknown>, datasets: string[]) {
  const res = await app.request("/export", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": JSON.stringify(user) },
    body: JSON.stringify({ datasets, includeSchema: true, includeCalculatedFields: true }),
  });
  return { status: res.status, text: await res.text() };
}

beforeEach(() => {
  registerDatasetsPolicy();
});

afterAll(async () => {
  await client?.close();
});

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE data_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(200) NOT NULL,
      slug VARCHAR(200) NOT NULL UNIQUE,
      description TEXT,
      icon VARCHAR(50),
      kon_id VARCHAR(100),
      kon_settings JSONB,
      schema JSONB DEFAULT '[]',
      display_config JSONB,
      policy_json JSONB,
      workflow_json JSONB,
      content_config JSONB,
      source_name VARCHAR(300),
      source_url TEXT,
      source_license TEXT,
      source_version VARCHAR(60),
      fetched_at TIMESTAMPTZ,
      source_caveats JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE data_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(500) NOT NULL,
      data_set_id UUID NOT NULL REFERENCES data_sets(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}',
      owner_id TEXT,
      status VARCHAR(50) DEFAULT 'published',
      sort_order INTEGER DEFAULT 0,
      thumbnail_id UUID,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      created_by_id TEXT,
      updated_by_id TEXT
    );
  `);
  await client.exec(
    readFileSync(
      join(__dirname, "../../packages/core/datasets/migrations/0001_calculated_fields.sql"),
      "utf8"
    )
  );

  const db = drizzle(client);
  const requireAuth = async (c: any, next: any) =>
    c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401);
  const requireRole = (roles: string[]) => async (c: any, next: any) =>
    roles.includes(c.get("user")?.role) ? next() : c.json({ error: "Forbidden" }, 403);
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: { requireAuth, requireRole, optionalAuth: requireAuth } as any,
  });

  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const raw = c.req.header("x-test-user");
    c.set("user" as never, (raw ? JSON.parse(raw) : null) as never);
    await next();
  });
  app.route("/", createDatasetsRouter(ctx));

  const create = async (slug: string, schema: unknown) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO data_sets (name, slug, schema, policy_json) VALUES ($1, $1, $2, $3) RETURNING id`,
        [
          slug,
          JSON.stringify(schema),
          JSON.stringify({ readAccess: "authenticated", writeAccess: "admin" }),
        ]
      )
    ).rows[0].id;
  const payroll = await create("payroll", [{ key: "salary-secret-field", type: "number" }]);
  const games = await create("games", [{ key: "name", type: "text" }]);
  await client.query(
    `INSERT INTO data_entries (title, data_set_id, data) VALUES ($1, $2, $3), ($4, $5, $6)`,
    [
      "Ana",
      payroll,
      JSON.stringify({ "salary-secret-field": 99999 }),
      "Zelda",
      games,
      JSON.stringify({ name: "Zelda" }),
    ]
  );
});

describe("export-datasets and a per-dataset deny", () => {
  it("an admin-scoped key with !datasets:payroll:* cannot export payroll", async () => {
    const r = await exportAs(AGENT_DENIED, ["payroll"]);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("salary-secret-field");
    expect(r.text).not.toContain("99999");
  });

  it("the deny is not dodged by listing the denied slug after an allowed one", async () => {
    const r = await exportAs(AGENT_DENIED, ["games", "payroll"]);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("salary-secret-field");
  });

  it("a read deny (!datasets:payroll:read) also closes export", async () => {
    const r = await exportAs(AGENT_DENIED_READ, ["payroll"]);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("salary-secret-field");
  });

  it("the same key still exports a dataset it is not denied", async () => {
    const r = await exportAs(AGENT_DENIED, ["games"]);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Zelda");
  });

  it("a human admin still exports payroll", async () => {
    const r = await exportAs(ADMIN, ["payroll"]);
    expect(r.status).toBe(200);
    expect(r.text).toContain("salary-secret-field");
  });
});
