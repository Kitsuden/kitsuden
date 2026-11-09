/**
 * The generic surfaces do not reach credentials (security review 2026-11-04)
 * ============================================================================
 *
 * F10/F69: `GET/POST /api/relations/<parent>/inlines/<id>?inline=<child>` read
 * and wrote any table with an FK to the parent (with `auth_users` as the
 * parent, `auth_accounts` with hashes and OAuth tokens, and `auth_sessions`),
 * with column names chosen by the caller.
 *
 * F12/F13: GraphQL left `auth_*` tables outside `FORBIDDEN_TABLES` in the
 * graph, the universal `items` field and `collections` reached every table of
 * the merged schema with every column, and a mutation's free JSON `input`
 * could write a secret column the types leave out.
 *
 * Real Postgres (PGlite) and the real routes; only the database, the
 * authentication (each request says who it is in a header), the kon scanner
 * and Valkey are replaced.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pg = new PGlite();
const testDb = drizzle(pg);

// ── The merged schema GraphQL sees ──
const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  role: text("role"),
  name: text("name"),
});
const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  providerId: text("provider_id"),
  password: text("password"),
  accessToken: text("access_token"),
});
// Not in FORBIDDEN_TABLES: caught only by the `auth_*` rule.
const authPasskeys = pgTable("auth_passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  publicKey: text("public_key"),
});
const media = pgTable("media", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  title: text("title"),
  uploadToken: text("upload_token"),
  createdAt: timestamp("created_at"),
});
const modules = pgTable("modules", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  name: text("name"),
});
const actions = pgTable("actions", { id: text("id").primaryKey(), name: text("name") });
const dataSets = pgTable("data_sets", {
  id: text("id").primaryKey(),
  slug: text("slug"),
  name: text("name"),
});
const dataEntries = pgTable("data_entries", {
  id: text("id").primaryKey(),
  dataSetId: text("data_set_id"),
});

const SCHEMA = { authUsers, authAccounts, authPasskeys, media, modules, actions };

vi.mock("../../apps/api/src/db", () => ({ db: testDb, mergedSchema: SCHEMA }));
vi.mock("../../apps/api/src/db/schema-core", () => ({ dataSets, dataEntries }));
vi.mock("../../apps/api/src/lib/schema-merger", () => ({ buildMergedSchema: async () => SCHEMA }));
vi.mock("../../apps/api/src/lib/valkey", () => ({
  getValkeyClient: async () => {
    throw new Error("no valkey in tests");
  },
}));
vi.mock("../../apps/api/src/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock("../../apps/api/src/services/scanner", () => ({ scanPackages: async () => [] }));
vi.mock("@kitsuden/engine", () => ({
  resolveExecutor: (f: unknown) => f,
  messageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
// `graphql-type-json` is CommonJS and does `require("graphql")` (the .js copy);
// vitest resolves graphql.ts's `import "graphql"` to the .mjs: two copies, and
// "Cannot use GraphQLScalarType from another realm". Bun does not have this.
// Here the same scalar, built with the `graphql` that graphql.ts resolves. By
// path: the repository root has neither `graphql` nor `graphql-type-json`.
vi.mock("../../apps/api/node_modules/graphql-type-json", async () => {
  const { GraphQLScalarType, valueFromASTUntyped } =
    await import("../../apps/api/node_modules/graphql");
  return {
    default: new GraphQLScalarType({
      name: "JSON",
      serialize: (v) => v,
      parseValue: (v) => v,
      parseLiteral: (ast, variables) => valueFromASTUntyped(ast, variables),
    }),
  };
});
const pass = async (_c: unknown, next: () => Promise<void>) => next();
vi.mock("../../apps/api/src/middleware/auth", () => ({ requireAuth: pass }));
vi.mock("../../apps/api/src/middleware/auth-guard", () => ({
  protectRoute: pass,
  requireAdmin: pass,
}));
vi.mock("../../apps/api/src/middleware/transactional-rls", () => ({
  withTransactionalRLS: () => pass,
}));

const tables = await import("../../apps/api/src/lib/explorable-tables");
const { inlineRelationsRoutes } = await import("../../apps/api/src/routes/inline-relations");
const { inlineRecordsProblem } = await import("../../apps/api/src/services/inline-relations");
const { graphqlRoutes } = await import("../../apps/api/src/routes/graphql");

type Who = "admin" | "agent-admin" | "editor";

/** The app with the identity the global middleware sets, chosen by header. */
function app(mount: string, routes: Hono<any>): Hono {
  const a = new Hono();
  a.use("*", async (c, next) => {
    const who = c.req.header("x-who") as Who | undefined;
    if (who === "admin") c.set("user" as never, { id: "u1", role: "admin" } as never);
    if (who === "editor") c.set("user" as never, { id: "u2", role: "editor" } as never);
    if (who === "agent-admin") {
      c.set("agent" as never, { agentId: "ag1", scopes: ["admin"] } as never);
      c.set("user" as never, { id: "ag1", role: "agent", scopes: ["admin"] } as never);
    }
    await next();
  });
  a.route(mount, routes);
  return a;
}

const relationsApp = app("/api/relations", inlineRelationsRoutes as never);
const graphApp = app("/api/graphql", graphqlRoutes as never);

async function gql(who: Who, query: string) {
  const r = await graphApp.request("/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", "x-who": who },
    body: JSON.stringify({ query }),
  });
  return (await r.json()) as { data?: any; errors?: { message: string }[] };
}

beforeAll(async () => {
  await pg.exec(`
    create table auth_users (id text primary key, role text, name text);
    create table auth_accounts (id text primary key, user_id text references auth_users(id),
      provider_id text, password text, access_token text);
    create table auth_sessions (id text primary key, user_id text references auth_users(id), token text);
    create table auth_passkeys (id text primary key, user_id text references auth_users(id), public_key text);
    create table media (id text primary key, owner_id text references auth_users(id), title text,
      upload_token text, created_at timestamp default now());
    create table modules (id text primary key, owner_id text references auth_users(id), name text);
    create table actions (id text primary key, name text);
    create table data_sets (id text primary key, slug text, name text);
    create table data_entries (id text primary key, data_set_id text);

    insert into auth_users values ('u1', 'admin', 'Ana');
    insert into auth_accounts values ('ac1', 'u1', 'credential', 'SECRET-HASH', 'OAUTH-TOKEN');
    insert into auth_sessions values ('s1', 'u1', 'SESSION-TOKEN');
    insert into auth_passkeys values ('pk1', 'u1', 'PASSKEY-PUBLIC');
    insert into media (id, owner_id, title, upload_token) values ('md1', 'u1', 'Cover', 'UPLOAD-TOKEN');
    insert into modules values ('m1', 'u1', 'kon-blog');
    insert into actions values ('a1', 'action');
  `);
});
afterAll(async () => pg.close());

// ═══════════════════════════════════════════════════════════════════════════
describe("the shared rule (explorable-tables)", () => {
  it("forbids the deny-list and every auth_* table except auth_users", () => {
    for (const t of [
      "auth_accounts",
      "auth_sessions",
      "auth_verifications",
      "api_keys",
      "kitsuden_secrets",
      "auth_whatever",
    ]) {
      expect(tables.isForbiddenNativeTable(t), t).toBe(true);
    }
    for (const t of ["auth_users", "media", "modules"]) {
      expect(tables.isForbiddenNativeTable(t), t).toBe(false);
    }
  });

  it("writing: forbidden and own-route tables never; admin tables only for a human admin", () => {
    expect(tables.whyNativeTableIsNotWritable("auth_accounts", true)).toBe("forbidden");
    expect(tables.whyNativeTableIsNotWritable("actions", true)).toBe("only-via-own-route");
    expect(tables.whyNativeTableIsNotWritable("modules", false)).toBe("requires-human-admin");
    expect(tables.whyNativeTableIsNotWritable("auth_users", false)).toBe("requires-human-admin");
    expect(tables.whyNativeTableIsNotWritable("modules", true)).toBeNull();
    expect(tables.whyNativeTableIsNotWritable("media", false)).toBeNull();
  });

  it("an agent key with `admin` is not a human admin", () => {
    const ctx = (vars: Record<string, unknown>) => ({ get: (k: string) => vars[k] });
    expect(tables.isHumanAdmin(ctx({ user: { role: "admin" } }))).toBe(true);
    expect(tables.isHumanAdmin(ctx({ user: { role: "editor" } }))).toBe(false);
    expect(
      tables.isHumanAdmin(ctx({ agent: { scopes: ["admin"] }, user: { role: "admin" } }))
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("inline relations (F10/F69)", () => {
  const get = (path: string, who: Who = "admin") =>
    relationsApp.request(`/api/relations${path}`, { headers: { "x-who": who } });
  const post = (path: string, body: unknown, who: Who = "admin") =>
    relationsApp.request(`/api/relations${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-who": who },
      body: JSON.stringify(body),
    });

  it("credential tables are nobody's children", async () => {
    const r = await get("/auth_users/inlines/config");
    expect(r.status).toBe(200);
    const { inlines } = (await r.json()) as { inlines: { table: string; fields: string[] }[] };
    const names = inlines.map((i) => i.table);
    expect(names).toContain("media");
    expect(names).not.toContain("auth_accounts");
    expect(names).not.toContain("auth_sessions");
    expect(names).not.toContain("auth_passkeys");
    // Not one secret column among the proposed fields.
    expect(inlines.find((i) => i.table === "media")!.fields).not.toContain("upload_token");

    const rel = (await (await get("/auth_users")).json()) as {
      relations: { relatedTable: string }[];
    };
    expect(rel.relations.map((x) => x.relatedTable)).not.toContain("auth_accounts");
  });

  it("GET ?inline=auth_accounts returns no hashes: it does not exist", async () => {
    for (const child of ["auth_accounts", "auth_sessions"]) {
      const r = await get(`/auth_users/inlines/u1?inline=${child}`);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("SECRET");
    }
  });

  it("a forbidden table cannot be a parent either", async () => {
    expect((await get("/auth_accounts")).status).toBe(404);
    const r = await get("/auth_accounts/inlines/config");
    expect(((await r.json()) as { inlines: unknown[] }).inlines).toEqual([]);
  });

  it("rows leave without secret columns", async () => {
    const r = await get("/auth_users/inlines/u1?inline=media");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Cover");
    expect(body).not.toContain("UPLOAD-TOKEN");
    expect(body).not.toContain("upload_token");
  });

  it("POST does not rewrite credentials: forbidden child, secret or unknown column", async () => {
    expect(
      (
        await post("/auth_users/inlines/u1?inline=auth_accounts", {
          records: [{ id: "ac1", password: "x" }],
        })
      ).status
    ).toBe(404);
    expect(
      (
        await post("/auth_users/inlines/u1?inline=media", {
          records: [{ id: "md1", upload_token: "x" }],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await post("/auth_users/inlines/u1?inline=media", {
          records: [{ id: "md1", does_not_exist: "x" }],
        })
      ).status
    ).toBe(400);
    const { rows } = await pg.query<{ password: string }>(
      "select password from auth_accounts where id = 'ac1'"
    );
    expect(rows[0]!.password).toBe("SECRET-HASH");
    const { rows: m } = await pg.query<{ upload_token: string }>(
      "select upload_token from media where id = 'md1'"
    );
    expect(m[0]!.upload_token).toBe("UPLOAD-TOKEN");
  });

  it("POST with real columns works", async () => {
    const r = await post("/auth_users/inlines/u1?inline=media", {
      records: [{ id: "md1", title: "New" }],
    });
    expect(r.status).toBe(200);
    const { rows } = await pg.query<{ title: string }>("select title from media where id = 'md1'");
    expect(rows[0]!.title).toBe("New");
  });

  it("`modules` (admin write) is written only by a human admin", async () => {
    const body = { records: [{ id: "m1", name: "kon-x" }] };
    expect((await post("/auth_users/inlines/u1?inline=modules", body, "agent-admin")).status).toBe(
      403
    );
    expect((await post("/auth_users/inlines/u1?inline=modules", body, "editor")).status).toBe(403);
    expect((await post("/auth_users/inlines/u1?inline=modules", body, "admin")).status).toBe(200);
  });

  it("inlineRecordsProblem validates the shape", () => {
    const cols = new Set(["id", "title"]);
    expect(inlineRecordsProblem([{ title: "a" }], [], cols)).toBeNull();
    expect(inlineRecordsProblem("x", [], cols)).toMatch(/array/);
    expect(inlineRecordsProblem([], [1], cols)).toMatch(/deletedIds/);
    expect(inlineRecordsProblem([{ password: "a" }], [], new Set(["password"]))).toMatch(
      /cannot be written/
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GraphQL (F12/F13)", () => {
  it("forbidden tables have no query, including auth_* outside the deny-list", async () => {
    const r = await gql("admin", "{ authaccounts { docs { id password } } }");
    expect(r.errors?.[0]?.message).toMatch(/Cannot query field/);
    expect(JSON.stringify(r)).not.toContain("SECRET-HASH");
    const p = await gql("admin", "{ authpasskeys { docs { id publicKey } } }");
    expect(p.errors?.[0]?.message).toMatch(/Cannot query field/);
  });

  it("secret columns are not fields of the type", async () => {
    const ok = await gql("admin", "{ medias { docs { id title } } }");
    expect(ok.errors).toBeUndefined();
    expect(ok.data.medias.docs[0].id).toBe("md1");
    const r = await gql("admin", "{ medias { docs { uploadToken } } }");
    expect(r.errors?.[0]?.message).toMatch(/Cannot query field/);
  });

  it("`items` and `collections` do not reach forbidden tables or show secrets", async () => {
    const r = await gql(
      "admin",
      '{ a: items(collection: "authAccounts") b: items(collection: "media") c: items(collection: "authPasskeys") collections }'
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.a).toBeNull();
    expect(r.data.c).toBeNull();
    expect(JSON.stringify(r.data.b)).not.toContain("UPLOAD-TOKEN");
    expect(JSON.stringify(r.data.b)).toContain("md1");
    const names = r.data.collections.tables.map((t: { dbName: string }) => t.dbName);
    expect(names).toContain("media");
    expect(names).not.toContain("auth_accounts");
    expect(names).not.toContain("auth_passkeys");
    expect(JSON.stringify(r)).not.toContain("SECRET-HASH");
  });

  it("no mutations for forbidden or own-route tables", async () => {
    const r = await gql("admin", '{ __type(name: "Mutation") { fields { name } } }');
    const names = r.data.__type.fields.map((f: { name: string }) => f.name);
    expect(names).toContain("updateMedia");
    expect(names.some((n: string) => /authaccounts|authpasskeys/i.test(n))).toBe(false);
    expect(names).not.toContain("updateActions");
  });

  // The English core is stricter than the cms here: admin-write tables have no
  // GraphQL mutation at all, not even for a human admin (own admin routes only).
  it("`modules` and `auth_users` are not modified through GraphQL by an agent key", async () => {
    const agent = await gql(
      "agent-admin",
      'mutation { updateModules(id: "m1", input: { name: "kon-bad" }) { id } }'
    );
    expect(agent.errors?.[0]?.message).toMatch(/Cannot query field/);
    const role = await gql(
      "agent-admin",
      'mutation { updateAuthusers(id: "u1", input: { role: "admin" }) { id } }'
    );
    expect(role.errors?.[0]?.message).toMatch(/Cannot query field/);
    const human = await gql(
      "admin",
      'mutation { updateModules(id: "m1", input: { name: "kon-bad" }) { id } }'
    );
    expect(human.errors?.[0]?.message).toMatch(/Cannot query field/);
    const { rows } = await pg.query<{ name: string }>("select name from modules where id = 'm1'");
    expect(rows[0]!.name).not.toBe("kon-bad");
  });

  it("a mutation does not write a secret column", async () => {
    const r = await gql(
      "admin",
      'mutation { updateMedia(id: "md1", input: { uploadToken: "x" }) { id } }'
    );
    expect(r.errors?.[0]?.message).toMatch(/cannot be written/);
    const c = await gql(
      "admin",
      'mutation { createMedia(input: { id: "md2", title: "t", uploadToken: "x" }) { id } }'
    );
    expect(c.errors?.[0]?.message).toMatch(/cannot be written/);
    const { rows } = await pg.query<{ upload_token: string }>(
      "select upload_token from media where id = 'md1'"
    );
    expect(rows[0]!.upload_token).toBe("UPLOAD-TOKEN");
    const { rows: none } = await pg.query("select id from media where id = 'md2'");
    expect(none).toHaveLength(0);
  });
});
