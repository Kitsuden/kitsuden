/**
 * Security (data): kon-datasets authorizes each operation itself
 * ============================================================================
 *
 * In production `/api/datasets/*` only required a SESSION (the `requireAuth` of
 * `datasets-query`, which covers the whole prefix) and account sign-up is
 * public. With a freshly created account one could:
 *
 *   · rewrite, move to another dataset or delete ANY entry (IDOR by id);
 *   · create datasets and change the `policyJson` of someone else's (`PATCH {...body}`);
 *   · read entries of private datasets by id, search them, export them;
 *   · save computed fields (which were also executed with `new Function`).
 *
 * These tests mount the kon's router on PGlite (real SQL, no Docker) and
 * play the part of the "session middleware" with a test header. They fail with the
 * previous router: the normal account got 200/201 where there is now 403/404.
 */
import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../apps/api/src/lib/test-kon-context";
import { registerDatasetsPolicy } from "../../packages/core/datasets/datasets.policy";
import { createDatasetsRouter } from "../../packages/core/datasets/datasets.routes";

const ADMIN = { id: "u-admin", role: "admin" };
const EDITOR = { id: "u-editor", role: "editor" };
const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };

let client: PGlite;
let app: Hono;

const g = globalThis as Record<string, unknown>;

let PUBLIC = "";
let PRIVATE = "";
let COMMUNITY = "";
let PUBLIC_INPUT = "";
let PRIVATE_INPUT = "";

async function request(
  method: string,
  route: string,
  user: Record<string, unknown> | null,
  bodyValue?: unknown
): Promise<{ status: number; body: any }> {
  const res = await app.request(route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    body: bodyValue === undefined ? undefined : JSON.stringify(bodyValue),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body };
}

beforeEach(() => {
  registerDatasetsPolicy();
  delete g.__sec_data_pwned;
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
  // The computed fields table comes from the kon's migration.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
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
  // Plays the host's global session middleware.
  app.use("*", async (c, next) => {
    const raw = c.req.header("x-test-user");
    c.set("user" as never, (raw ? JSON.parse(raw) : null) as never);
    await next();
  });
  app.route("/", createDatasetsRouter(ctx));

  const create = async (slug: string, policyJson: unknown) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO data_sets (name, slug, policy_json) VALUES ($1, $1, $2) RETURNING id`,
        [slug, JSON.stringify(policyJson)]
      )
    ).rows[0].id;

  PUBLIC = await create("public", {
    readAccess: "public",
    writeAccess: "admin",
    enableRLS: false,
  });
  PRIVATE = await create("private", {
    readAccess: "admin",
    writeAccess: "admin",
    enableRLS: false,
  });
  COMMUNITY = await create("community", {
    readAccess: "public",
    writeAccess: "authenticated",
    enableRLS: false,
  });

  const input = async (ds: string, title: string, data: unknown) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO data_entries (title, data_set_id, data) VALUES ($1, $2, $3) RETURNING id`,
        [title, ds, JSON.stringify(data)]
      )
    ).rows[0].id;

  PUBLIC_INPUT = await input(PUBLIC, "Sword", { damage: 10 });
  PRIVATE_INPUT = await input(PRIVATE, "Secret", { key: "must-not-show" });
});

describe("dataset definition: team only, and the policy admin only", () => {
  it("a normal account does not create datasets", async () => {
    const r = await request("POST", "/", ANA, { name: "Mine", slug: "mine" });
    expect(r.status).toBe(403);
  });

  it("a normal account does not change the policy of someone else's dataset", async () => {
    const r = await request("PATCH", `/${PRIVATE}`, ANA, { policyJson: { readAccess: "public" } });
    expect(r.status).toBe(404); // it does not even see it
    const r2 = await request("PATCH", `/${PUBLIC}`, ANA, {
      policyJson: { readAccess: "public", writeAccess: "authenticated" },
    });
    expect(r2.status).toBe(403);
    const row = await client.query<{ policy_json: any }>(
      `SELECT policy_json FROM data_sets WHERE id = $1`,
      [PUBLIC]
    );
    expect(row.rows[0].policy_json.writeAccess).toBe("admin");
  });

  it("an editor edits, but not the policy or internal fields", async () => {
    const r = await request("PATCH", `/${PUBLIC}`, EDITOR, {
      policyJson: { readAccess: "public", writeAccess: "authenticated" },
    });
    expect(r.status).toBe(403);
    const r2 = await request("PATCH", `/${PUBLIC}`, EDITOR, {
      description: "new",
      id: "00000000-0000-0000-0000-000000000000",
      createdAt: "2000-01-01T00:00:00Z",
    });
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(PUBLIC);
    expect(r2.body.description).toBe("new");
    expect(new Date(r2.body.createdAt).getUTCFullYear()).not.toBe(2000);
  });

  it("admin can change the policy", async () => {
    const r = await request("PATCH", `/${COMMUNITY}`, ADMIN, {
      policyJson: { readAccess: "public", writeAccess: "authenticated", enableRLS: false },
    });
    expect(r.status).toBe(200);
  });

  it("the list and the detail do not show private datasets", async () => {
    const list = await request("GET", "/", null);
    const slugs = list.body.docs.map((d: { slug: string }) => d.slug);
    expect(slugs).toContain("public");
    expect(slugs).not.toContain("private");
    expect((await request("GET", `/${PRIVATE}`, ANA)).status).toBe(404);
    expect((await request("GET", `/slug/private`, null)).status).toBe(404);
    expect((await request("GET", `/${PRIVATE}`, EDITOR)).status).toBe(200);
  });
});

describe("entries: IDOR, mass assignment and owner", () => {
  it("a normal account does not write to an admin-only dataset", async () => {
    const r = await request("POST", `/${PUBLIC}/entries`, ANA, { title: "Spam", data: {} });
    expect(r.status).toBe(403);
    const r2 = await request("PATCH", `/${PUBLIC}/entries/${PUBLIC_INPUT}`, ANA, {
      title: "Hacked",
    });
    expect(r2.status).toBe(403);
    const r3 = await request("DELETE", `/${PUBLIC}/entries/${PUBLIC_INPUT}`, ANA);
    expect(r3.status).toBe(403);
    const row = await client.query<{ title: string }>(
      `SELECT title FROM data_entries WHERE id = $1`,
      [PUBLIC_INPUT]
    );
    expect(row.rows[0].title).toBe("Sword");
  });

  it("a private entry is not read by id through a public dataset", async () => {
    const r = await request("GET", `/${PUBLIC}/entries/${PRIVATE_INPUT}`, null);
    expect(r.status).toBe(404);
    const r2 = await request("GET", `/${PRIVATE}/entries/${PRIVATE_INPUT}`, ANA);
    expect(r2.status).toBe(404);
  });

  it("not even the team moves an entry from a dataset through another one's URL", async () => {
    const r = await request("PATCH", `/${PUBLIC}/entries/${PRIVATE_INPUT}`, EDITOR, {
      title: "x",
    });
    expect(r.status).toBe(404);
    const r2 = await request("PATCH", `/${PUBLIC}/entries/${PUBLIC_INPUT}`, EDITOR, {
      dataSetId: PRIVATE,
      title: "Sword+",
    });
    expect(r2.status).toBe(200);
    expect(r2.body.dataSetId).toBe(PUBLIC);
  });

  it("in a community dataset everyone writes THEIR OWN", async () => {
    const createdOne = await request("POST", `/${COMMUNITY}/entries`, ANA, {
      title: "Ana's build",
      data: { weapon: "bow" },
      ownerId: BEA.id, // attempt to attribute it to someone else
      status: "featured", // attempt to skip moderation
    });
    expect(createdOne.status).toBe(201);
    expect(createdOne.body.ownerId).toBe(ANA.id);
    expect(createdOne.body.status).toBe("published");

    const foreign = await request("PATCH", `/${COMMUNITY}/entries/${createdOne.body.id}`, BEA, {
      title: "Bea's",
    });
    expect(foreign.status).toBe(403);
    const remove = await request("DELETE", `/${COMMUNITY}/entries/${createdOne.body.id}`, BEA);
    expect(remove.status).toBe(403);

    const own = await request("PATCH", `/${COMMUNITY}/entries/${createdOne.body.id}`, ANA, {
      title: "Ana's build v2",
      ownerId: BEA.id,
    });
    expect(own.status).toBe(200);
    expect(own.body.ownerId).toBe(ANA.id);
  });

  it("without a session nothing is written", async () => {
    expect((await request("POST", `/${COMMUNITY}/entries`, null, { title: "x" })).status).toBe(401);
  });
});

describe("bulk reads: search, comparison, export, snapshots", () => {
  it("no searching or comparing in a private dataset", async () => {
    expect((await request("GET", `/${PRIVATE}/search?q=secret`, null)).status).toBe(404);
    expect((await request("GET", `/${PRIVATE}/search?q=secret`, ANA)).status).toBe(404);
    const cmp = await request("POST", `/${PRIVATE}/compare`, ANA, {
      entryIds: [PRIVATE_INPUT, PUBLIC_INPUT],
    });
    expect(cmp.status).toBe(404);
    expect(
      (await request("GET", `/${PRIVATE}/entries/${PRIVATE_INPUT}/snapshots`, ANA)).status
    ).toBe(404);
  });

  it("exporting is for the team", async () => {
    const r = await request("POST", "/export", ANA, { datasets: [PRIVATE] });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("must-not-show");
  });

  it("restoring a snapshot is for the team", async () => {
    const r = await request("POST", `/${PUBLIC}/entries/${PUBLIC_INPUT}/restore`, ANA, {
      timestamp: "2020-01-01",
    });
    expect(r.status).toBe(403);
  });

  it("index statistics are for administration", async () => {
    expect((await request("GET", "/indexes/stats", ANA)).status).toBe(403);
    expect((await request("POST", "/indexes/report", EDITOR)).status).toBe(403);
  });

  it("too many filters in a search is a 400, not work for the database", async () => {
    const filters = Array.from({ length: 30 }, (_, i) => `c${i}:x`).join(",");
    expect((await request("GET", `/${PUBLIC}/search?filters=${filters}`, null)).status).toBe(400);
  });
});

describe("computed fields: team only, and they never execute code", () => {
  it("a normal account does not create or delete computed fields", async () => {
    const r = await request("POST", `/${PUBLIC}/calculated-fields`, ANA, {
      name: "x",
      label: "x",
      type: "formula",
      config: { expression: "1" },
    });
    expect(r.status).toBe(403);
    expect((await request("GET", `/${PRIVATE}/calculated-fields`, ANA)).status).toBe(404);
  });

  it("an editor's formula is interpreted, not executed", async () => {
    const r = await request("POST", `/${PUBLIC}/calculated-fields`, EDITOR, {
      name: "trap",
      label: "trap",
      type: "formula",
      config: { expression: "globalThis.__sec_data_pwned = 1" },
    });
    expect(r.status).toBe(201);
    const r2 = await request("POST", `/${PUBLIC}/calculated-fields`, EDITOR, {
      name: "double",
      label: "double",
      type: "formula",
      config: { expression: "{damage} * 2" },
    });
    expect(r2.status).toBe(201);

    const list = await request("GET", `/${PUBLIC}/entries?includeCalculated=true`, null);
    expect(list.status).toBe(200);
    expect(g.__sec_data_pwned).toBeUndefined();
    const sword = list.body.docs.find((d: { id: string }) => d.id === PUBLIC_INPUT);
    expect(sword._calculated.trap).toBeNull();
    expect(sword._calculated.double).toBe(20);
  });
});
