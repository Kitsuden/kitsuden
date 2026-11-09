/**
 * SMOKE E2E — Full Vibecoder flow (integration, requires test PostgreSQL)
 *
 * Validates the beta's critical path end to end against the real app
 * (in-process via app.request, same pattern as auth-http.test.ts):
 *
 *   1. Sign-up + promotion to admin
 *   2. Activate grimoire → settings reflect activeGrimoire
 *      + theme contract (config.theme consumed by applyGrimoireTheme)
 *   3. Enable a kon → /api/modules reports it enabled
 *      (contract consumed by the dynamic sidebar)
 *   4. /api/admin/registry/:konId responds with views config
 *      (contract consumed by GrimoirePage at /g/kon-x)
 *   5. KITSUDEN Vault: real CREATE TABLE → row CRUD → read via Graphify
 *   6. Secrets Manager: create → HOT INJECTION verified in process.env → delete
 *
 * Run with: pnpm test:api:all (starts the test DB on port 5434)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { installedKon } from "../lib/installed-kons";

// The flow uses kon-crm, an INSTALLABLE kon (kitsuden-kons).
const itWithCrm = installedKon("kon-crm")?.path ? it : it.skip;

import { app } from "../index";

import { isDatabaseAvailable, clearTestData, generateTestId, enterAs } from "./setup";

let dbAvailable = false;

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

const testId = generateTestId();
const email = `vibecoder-${testId}@example.com`;
const password = "VibecoderSmoke123!";
const collection = `smoke_${testId.toLowerCase().replace(/[^a-z0-9_]/g, "")}`;
const secretKey = "VIBE_SMOKE_SECRET";

let cookie = "";
let vaultWasEnabled: string | undefined;

describe("SMOKE E2E — vibecoder flow", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    await clearTestData();
    // Vault is flag-gated: enable it only during this smoke test
    vaultWasEnabled = process.env.KITSUDEN_VAULT_ENABLED;
    process.env.KITSUDEN_VAULT_ENABLED = "true";
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // Best-effort cleanup (ignores errors if some step did not get to create anything)
    try {
      await app.request(
        req(`/api/admin/vault/${collection}?confirm=${collection}`, { method: "DELETE" }, cookie)
      );
    } catch {
      /* noop */
    }
    try {
      await app.request(req(`/api/admin/secrets/${secretKey}`, { method: "DELETE" }, cookie));
    } catch {
      /* noop */
    }
    try {
      await app.request(
        req(
          "/api/system/grimoire-state",
          { method: "POST", body: JSON.stringify({ action: "deactivate" }) },
          cookie
        )
      );
    } catch {
      /* noop */
    }
    if (vaultWasEnabled === undefined) delete process.env.KITSUDEN_VAULT_ENABLED;
    else process.env.KITSUDEN_VAULT_ENABLED = vaultWasEnabled;
    await clearTestData();
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 1 — Sign-up and promotion to admin
  // ─────────────────────────────────────────────────────────────
  it("1. registers a user and promotes them to admin", async () => {
    if (!dbAvailable) return;

    // Sign-up + verified email + admin role in the database + sign-in, with its
    // own IP (the /api/admin/* endpoints require admin; see tests/setup.ts for
    // email verification and the per-IP sign-up limit). Sign-up no longer
    // returns a usable session: without a confirmed email there is no sign-in.
    ({ cookie } = await enterAs(app, {
      email,
      password,
      name: `Vibecoder ${testId}`,
      role: "admin",
    }));
    expect(cookie.length).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 2 — Grimoire: activation + theme contract
  // ─────────────────────────────────────────────────────────────
  it("2. activates a grimoire and exposes its theme (applyGrimoireTheme contract)", async () => {
    if (!dbAvailable) return;

    const activate = await app.request(
      req(
        "/api/system/grimoire-state",
        {
          method: "POST",
          body: JSON.stringify({ action: "activate", grimoireId: "grimoire-default" }),
        },
        cookie
      )
    );
    expect(activate.status).toBe(200);

    const settingsRes = await app.request(req("/api/settings", {}, cookie));
    expect(settingsRes.status).toBe(200);
    const settings = (await settingsRes.json()) as {
      activeGrimoire?: string | null;
      activeTheme?: string | null;
    };
    expect(settings.activeGrimoire || settings.activeTheme).toBe("grimoire-default");
  });

  // Contract with the panel: `applyGrimoireTheme` (packages/admin/src/lib/theme.svelte.ts)
  // reads `config.theme` of the active grimoire. Before, the API did not return it.
  it("2b. GET /api/system/grimoires exposes config.theme of the active grimoire", async () => {
    if (!dbAvailable) throw new Error("no database: nothing to check");

    // Theme contract: the panel reads config.theme of the active grimoire
    const grimoiresRes = await app.request(req("/api/system/grimoires", {}, cookie));
    expect(grimoiresRes.status).toBe(200);
    const grimoires = (await grimoiresRes.json()) as Array<{
      id: string;
      config?: { theme?: { primary_color?: string } };
    }>;
    const active = grimoires.find((g) => g.id === "grimoire-default");
    expect(active).toBeDefined();
    expect(active?.config?.theme?.primary_color).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 3 — An enabled kon appears in the sidebar contract
  // ─────────────────────────────────────────────────────────────
  itWithCrm(
    "3. enables kon-crm and /api/modules reports it enabled (sidebar contract)",
    async () => {
      if (!dbAvailable) return;

      const toggle = await app.request(
        req(
          "/api/modules/kon-crm",
          { method: "PATCH", body: JSON.stringify({ enabled: true }) },
          cookie
        )
      );
      expect([200, 201]).toContain(toggle.status);

      const modulesRes = await app.request(req("/api/modules", {}, cookie));
      expect(modulesRes.status).toBe(200);
      const data = (await modulesRes.json()) as {
        categories: Record<string, { modules: Array<{ key: string; enabled: boolean }> }>;
      };
      const all = Object.values(data.categories).flatMap((cat) => cat.modules ?? []);
      const crm = all.find((m) => m.key === "kon-crm");
      expect(crm).toBeDefined();
      expect(crm?.enabled).toBe(true);
    }
  );

  // ─────────────────────────────────────────────────────────────
  // STEP 4 — /g/kon-x: contract consumed by GrimoirePage
  // ─────────────────────────────────────────────────────────────
  itWithCrm("4. /api/admin/registry/kon-crm returns views config for /g/kon-crm", async () => {
    if (!dbAvailable) return;

    const res = await app.request(req("/api/admin/registry/kon-crm", {}, cookie));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      success: boolean;
      kon?: { id: string; views: unknown[]; defaultView: string };
      grimoire?: { id: string; views: unknown[]; defaultView: string };
    };
    expect(data.success).toBe(true);
    const config = data.kon ?? data.grimoire;
    expect(config?.id).toBe("kon-crm");
    expect(Array.isArray(config?.views)).toBe(true);
    expect(config?.views.length ?? 0).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 5 — Real Vault DDL + CRUD + read via Graphify
  // ─────────────────────────────────────────────────────────────
  it("5a. Vault creates a REAL table with RLS", async () => {
    if (!dbAvailable) return;

    const res = await app.request(
      req(
        "/api/admin/vault",
        {
          method: "POST",
          body: JSON.stringify({
            collection,
            columns: [
              { name: "title", type: "text", required: true },
              { name: "points", type: "integer", indexed: true },
            ],
          }),
        },
        cookie
      )
    );
    const data = (await res.json()) as { success: boolean; table: string; graphify: string };
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.table).toBe(`vault_${collection}`);
    expect(data.graphify).toBe(`/api/graph/vault_${collection}`);
  });

  let rowId = "";

  it("5b. inserts and updates rows (parameterized, under RLS)", async () => {
    if (!dbAvailable) return;

    const insert = await app.request(
      req(
        `/api/admin/vault/${collection}/rows`,
        { method: "POST", body: JSON.stringify({ title: "First vibecoder row", points: 10 }) },
        cookie
      )
    );
    expect(insert.status).toBe(201);
    const inserted = (await insert.json()) as { success: boolean; row: { id: string } };
    expect(inserted.success).toBe(true);
    rowId = inserted.row.id;

    const patch = await app.request(
      req(
        `/api/admin/vault/${collection}/rows/${rowId}`,
        { method: "PATCH", body: JSON.stringify({ points: 42 }) },
        cookie
      )
    );
    expect(patch.status).toBe(200);
  });

  it("5c. Graphify serves the Vault collection (automatic relational read)", async () => {
    if (!dbAvailable) return;

    // The graph includes the vault_* table
    const graph = await app.request(req("/api/graph", {}, cookie));
    expect(graph.status).toBe(200);
    const graphData = (await graph.json()) as { success: boolean; tables: string[] };
    expect(graphData.tables).toContain(`vault_${collection}`);

    // Listing with an equality filter
    const list = await app.request(
      req(`/api/graph/vault_${collection}?points=42&limit=10`, {}, cookie)
    );
    expect(list.status).toBe(200);
    const listData = (await list.json()) as {
      success: boolean;
      rows: Array<{ id: string; title: string; points: number }>;
    };
    expect(listData.success).toBe(true);
    expect(listData.rows.length).toBe(1);
    expect(listData.rows[0]!.title).toBe("First vibecoder row");
    expect(listData.rows[0]!.points).toBe(42);

    // Single record
    const single = await app.request(req(`/api/graph/vault_${collection}/${rowId}`, {}, cookie));
    expect(single.status).toBe(200);
  });

  it("5d. hot ALTER TABLE + DROP with confirmation", async () => {
    if (!dbAvailable) return;

    const addCol = await app.request(
      req(
        `/api/admin/vault/${collection}/columns`,
        { method: "POST", body: JSON.stringify({ name: "notes", type: "text" }) },
        cookie
      )
    );
    expect(addCol.status).toBe(200);

    // DROP without confirmation must be rejected
    const dropNoConfirm = await app.request(
      req(`/api/admin/vault/${collection}`, { method: "DELETE" }, cookie)
    );
    expect(dropNoConfirm.status).toBe(400);

    const drop = await app.request(
      req(`/api/admin/vault/${collection}?confirm=${collection}`, { method: "DELETE" }, cookie)
    );
    expect(drop.status).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 6 — Secrets Manager: REAL hot injection into process.env
  // ─────────────────────────────────────────────────────────────
  it("6. creates a secret and verifies hot injection into process.env", async () => {
    if (!dbAvailable) return;

    delete process.env[secretKey];

    const create = await app.request(
      req(
        "/api/admin/secrets",
        {
          method: "POST",
          body: JSON.stringify({
            key: secretKey,
            value: "value-smoke-123",
            category: "general",
            injectNow: true,
          }),
        },
        cookie
      )
    );
    expect(create.status).toBe(200);

    // The Prefect-style promise: the process already sees the value WITHOUT restarting
    expect(process.env[secretKey]).toBe("value-smoke-123");

    // The list only exposes the masked hint, never the value
    const list = await app.request(req("/api/admin/secrets", {}, cookie));
    const listData = (await list.json()) as {
      secrets: Array<{ key: string; hint: string }>;
    };
    const found = listData.secrets.find((s) => s.key === secretKey);
    expect(found).toBeDefined();
    expect(found?.hint).not.toContain("value-smoke-123");

    // Deleting cleans up the DB and process.env
    const of = await app.request(
      req(`/api/admin/secrets/${secretKey}`, { method: "DELETE" }, cookie)
    );
    expect(of.status).toBe(200);
    expect(process.env[secretKey]).toBeUndefined();
  });
});
