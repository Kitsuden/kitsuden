/**
 * Per-request RLS: the engine's common piece and A2's public policies
 * ============================================================================
 *
 * PGlite with a NON-superuser role (otherwise Postgres skips RLS and everything
 * would be green by chance). It is tested with the SAME pieces the
 * host mounts in front of each kon (`rlsTransaction`, `theRequestDb`,
 * `asSystem`, `background`):
 *
 *   · which id/role Postgres sees for the anonymous, an account and an account without a role;
 *   · that `asSystem` clears id AND role and restores afterwards;
 *   · that `background` leaves the transaction;
 *   · that a route that fails (exception or 5xx) does not commit what it wrote;
 *   · that two mounts do not open two transactions;
 *   · and the new policies: tier list templates and builds published
 *     readable without a session, ownerless decks, orders that the anonymous does NOT see.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveExecutor } from "../../packages/engine/src/request-scope";
import {
  asSystem,
  rlsContextOf,
  theRequestDb,
  background,
  rlsTransaction,
} from "../../packages/engine/src/rls-request";

const ROOT = resolve(__dirname, "../..");
const read = (route: string) => readFileSync(resolve(ROOT, route), "utf8");

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let app: Hono;

/** Who is asking, by header (like the host's session, BEFORE the transaction). */
const session: MiddlewareHandler = async (c, next) => {
  const who = c.req.header("x-who");
  if (who === "ana") c.set("user" as never, { id: "ana", role: "user" } as never);
  if (who === "norole") c.set("user" as never, { id: "norole" } as never);
  if (who === "edi") c.set("user" as never, { id: "edi", role: "editor" } as never);
  await next();
};

const rows = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? r) as Record<string, unknown>[];

beforeAll(async () => {
  client = new PGlite();
  // Minimal schema of the affected kons, with their REAL migrations.
  for (const m of [
    "packages/kons/kon-tierlist/migrations/0001_tierlist.sql",
    "packages/kons/kon-tierlist/migrations/0002_tierlist.sql",
    "packages/kons/kon-character-builder/migrations/0001_builder.sql",
    "packages/kons/kon-character-builder/migrations/0002_builds_publicas.sql",
    "packages/kons/kon-cardsim/migrations/0001_cardsim.sql",
    "packages/kons/kon-ecommerce/migrations/0001_shop.sql",
    "packages/kons/kon-ecommerce/migrations/0002_pedidos_seguros.sql",
  ]) {
    await client.exec(read(m));
  }
  // The core's ownership policies, and AFTER them the new ones (the runner's real
  // order is the reverse on each startup, but they are independent).
  await client.exec(read("apps/api/src/db/rls-owned-tables.sql"));
  for (const m of [
    "packages/kons/kon-tierlist/migrations/0003_plantillas_publicas_rls.sql",
    "packages/kons/kon-character-builder/migrations/0003_lectura_publica_rls.sql",
    "packages/kons/kon-cardsim/migrations/0004_mazos_sin_dueno_rls.sql",
    "packages/kons/kon-ecommerce/migrations/0003_sistema_sin_usuario.sql",
  ]) {
    await client.exec(read(m));
  }
  await client.exec(`
    CREATE TABLE test_writes (id text PRIMARY KEY);
    INSERT INTO tier_lists (id, kind, slug, title, tiers, items) VALUES
      ('template', 'template', 'p', 'Template', '[]', '[]');
    INSERT INTO tier_lists (id, kind, title, tiers, items, owner_id) VALUES
      ('personal-ana', 'personal', 'Ana''s', '[]', '[]', 'ana');
    INSERT INTO builder_builds (id, builder_id, name, build, code, visibility, owner_id) VALUES
      ('b-pub', 'x', 'p', '{}', 'c1', 'public', 'ana'),
      ('b-oc', 'x', 'o', '{}', 'c2', 'unlisted', 'ana'),
      ('b-priv', 'x', 'v', '{}', 'c3', 'private', 'ana');
    INSERT INTO cardsim_decks (id, game_id, name, cards, owner_id) VALUES
      ('m-free', 'g', 'free', '[]', NULL), ('m-ana', 'g', 'Ana''s', '[]', 'ana');
    INSERT INTO shop_orders (id, number, fulfillment_type, customer_email)
      VALUES ('order-1', 'P-1', 'pickup', 'customer@example.com');
    CREATE ROLE rls_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO rls_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_app;
    SET ROLE rls_app;
  `);
  const r = await client.query<{ su: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS su FROM pg_roles WHERE rolname = current_user`
  );
  expect(r.rows[0]?.su).toBe(false);

  db = drizzle(client);
  const kon = theRequestDb(db);
  const context = async () =>
    rows(
      await kon.execute(
        sql`SELECT coalesce(current_setting('app.current_user_id', true), '<null>') AS id,
                   coalesce(current_setting('app.current_user_role', true), '<null>') AS role`
      )
    )[0];

  const routes = new Hono();
  routes.get("/context", async (c) => c.json(await context()));
  routes.get("/system", async (c) => {
    const inside = await asSystem(context);
    return c.json({ inside, after: await context() });
  });
  // Inside the request the executor is the transaction; in `background`,
  // the global connection. (Identity is compared and not queried: PGlite is
  // ONE connection, and a query outside the open transaction would wait for
  // it to finish. With the real pool it goes over another connection.)
  routes.get("/background", (c) =>
    c.json({
      inside: resolveExecutor(db) !== db,
      outside: background(() => resolveExecutor(db) === db),
    })
  );
  routes.post("/write-and-fail", async () => {
    await kon.execute(sql`INSERT INTO test_writes VALUES ('after-exception')`);
    throw new Error("the route fails");
  });
  routes.post("/write-and-500", async (c) => {
    await kon.execute(sql`INSERT INTO test_writes VALUES ('after-500')`);
    return c.json({ error: "x" }, 500);
  });
  routes.post("/write-ok", async (c) => {
    await kon.execute(sql`INSERT INTO test_writes VALUES ('ok')`);
    return c.json({ ok: true }, 201);
  });
  routes.get("/count/:table", async (c) => {
    const table = c.req.param("table");
    if (!/^[a-z_]+$/.test(table)) return c.json({}, 400);
    const r = await kon.execute(sql.raw(`SELECT id FROM ${table} ORDER BY id`));
    return c.json(rows(r).map((f) => f.id));
  });

  app = new Hono();
  app.use("*", session);
  // Two mounts that overlap, such as `/x` and `/x/*`: they must not nest.
  app.use("*", rlsTransaction(db));
  app.use("/k/*", rlsTransaction(db));
  app.route("/k", routes);
});

afterAll(async () => {
  await client?.close();
});

const request = (route: string, who?: string, method = "GET") =>
  app.request(route, { method, headers: who ? { "x-who": who } : {} });

describe("context that Postgres sees", () => {
  it("anonymous: id '' and role anonymous (NOT the system)", async () => {
    expect(await (await request("/k/context")).json()).toEqual({ id: "", role: "anonymous" });
  });
  it("an account: its id and its role", async () => {
    expect(await (await request("/k/context", "ana")).json()).toEqual({ id: "ana", role: "user" });
  });
  it("an account without a role counts as `user`, not as anonymous or system", async () => {
    expect(await (await request("/k/context", "norole")).json()).toEqual({
      id: "norole",
      role: "user",
    });
    expect(rlsContextOf({ id: "x", role: "" })).toEqual({ userId: "x", userRole: "user" });
  });
  it("asSystem clears id AND role, and restores them on exit", async () => {
    expect(await (await request("/k/system", "ana")).json()).toEqual({
      inside: { id: "", role: "" },
      after: { id: "ana", role: "user" },
    });
  });
  it("background leaves the transaction (system connection, no context)", async () => {
    expect(await (await request("/k/background", "ana")).json()).toEqual({
      inside: true,
      outside: true,
    });
  });
});

describe("a route that fails does not commit what it wrote", () => {
  it("exception → rolled back; 500 → rolled back; 201 → committed", async () => {
    expect((await request("/k/write-and-fail", "ana", "POST")).status).toBe(500);
    expect((await request("/k/write-and-500", "ana", "POST")).status).toBe(500);
    expect((await request("/k/write-ok", "ana", "POST")).status).toBe(201);
    expect(await (await request("/k/count/test_writes", "ana")).json()).toEqual(["ok"]);
  });
});

describe("new public policies (A2)", () => {
  it("tier lists: anyone sees the template; the personal one, only its owner", async () => {
    expect(await (await request("/k/count/tier_lists")).json()).toEqual(["template"]);
    expect(await (await request("/k/count/tier_lists", "edi")).json()).toEqual(["template"]);
    expect(await (await request("/k/count/tier_lists", "ana")).json()).toEqual([
      "personal-ana",
      "template",
    ]);
  });
  it("builds: public and hidden for everyone; the private one, only its owner", async () => {
    expect(await (await request("/k/count/builder_builds")).json()).toEqual(["b-oc", "b-pub"]);
    expect(await (await request("/k/count/builder_builds", "ana")).json()).toEqual([
      "b-oc",
      "b-priv",
      "b-pub",
    ]);
  });
  it("decks: one without an owner belongs to everyone; Ana's, only to Ana", async () => {
    expect(await (await request("/k/count/cardsim_decks")).json()).toEqual(["m-free"]);
    expect(await (await request("/k/count/cardsim_decks", "ana")).json()).toEqual([
      "m-ana",
      "m-free",
    ]);
  });
  it("orders: the anonymous user NO longer goes through system; the team does see them", async () => {
    expect(await (await request("/k/count/shop_orders")).json()).toEqual([]);
    expect(await (await request("/k/count/shop_orders", "ana")).json()).toEqual([]);
    expect(await (await request("/k/count/shop_orders", "edi")).json()).toEqual(["order-1"]);
  });
});
