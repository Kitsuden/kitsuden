/**
 * Polymorphic links between entities of any kon.
 *
 * What has to be demonstrated here is not that a row gets inserted, but the four
 * decisions that make this a skeleton and not debt:
 *
 *   1. BOTH directions are read. `same_person` has no direction, and if only
 *      `from` were looked at, whoever saved the edge backwards would get zero
 *      results with no error.
 *   2. There are no duplicates, and an index guarantees it — not a
 *      prior check, which another request can slip in between.
 *   3. A type without a loader is SKIPPED instead of failing: it is a kon that is not
 *      installed, not an error.
 *   4. A row the loader does not return disappears. That is how
 *      orphans get filtered and how the destination table's RLS stays in charge.
 */

import { PGlite } from "@electric-sql/pglite";
import { link, unlink, unlinkAll, neighbors, resolveNeighbors } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { readSqlFile } from "../../apps/api/src/lib/sql-file";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);

  // Only the links migration: it is self-contained and does not depend on the rest of the
  // chain, which cannot run in PGlite for lack of pgvector.
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const route = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../apps/api/src/db/migrations/0032_links.sql"
  );

  for (const stmt of readSqlFile(route, "0032").statements) {
    await client.exec(stmt);
  }
});

beforeEach(async () => {
  const { sql } = await import("drizzle-orm");
  await db.execute(sql.raw("DELETE FROM kitsuden_links"));
});

const contact = { type: "crm_contacts", id: "c-1" };
const player = { type: "players", id: "p-1" };
const request = { type: "shop_orders", id: "o-1" };

describe("create and read", () => {
  it("links two entities of different kons", async () => {
    await link(contact, player, { relation: "same_person" }, db);
    const v = await neighbors(contact, {}, db);

    expect(v).toHaveLength(1);
    expect(v[0].type).toBe("players");
    expect(v[0].id).toBe("p-1");
    expect(v[0].relation).toBe("same_person");
  });

  it("it is read from the OTHER end without knowing the direction", async () => {
    // The central decision: whoever saved the edge does not have to remember
    // which direction they did it in.
    await link(contact, player, { relation: "same_person" }, db);
    const v = await neighbors(player, {}, db);

    expect(v).toHaveLength(1);
    expect(v[0].type).toBe("crm_contacts");
    expect(v[0].id).toBe("c-1");
  });

  it("stores metadata", async () => {
    await link(request, contact, { relation: "ordered_by", metadata: { channel: "web" } }, db);
    const v = await neighbors(request, {}, db);
    expect(v[0].metadata).toEqual({ channel: "web" });
  });

  it("filters by relation and by type", async () => {
    await link(contact, player, { relation: "same_person" }, db);
    await link(contact, request, { relation: "ordered_by" }, db);

    expect(await neighbors(contact, { relation: "same_person" }, db)).toHaveLength(1);
    expect(await neighbors(contact, { type: "shop_orders" }, db)).toHaveLength(1);
    expect(await neighbors(contact, {}, db)).toHaveLength(2);
  });
});

describe("integrity", () => {
  it("repeating the same edge does NOT create duplicates", async () => {
    // Without this, every later read would return the same entity N times.
    await link(contact, player, { relation: "same_person" }, db);
    await link(contact, player, { relation: "same_person" }, db);
    await link(contact, player, { relation: "same_person" }, db);

    expect(await neighbors(contact, {}, db)).toHaveLength(1);
  });

  it("the same pair with ANOTHER relation is a distinct edge", async () => {
    await link(contact, player, { relation: "same_person" }, db);
    await link(contact, player, { relation: "invited_by" }, db);
    expect(await neighbors(contact, {}, db)).toHaveLength(2);
  });

  it("an entity cannot link to itself", async () => {
    // An edge to itself means nothing and pollutes every neighbor
    // query. It is rejected in the API and also with a CHECK on the table.
    expect(link(contact, { ...contact }, {}, db)).rejects.toThrow(/cannot be linked to itself/);
  });

  it("rejects incomplete references instead of storing garbage", async () => {
    expect(link({ type: "", id: "x" }, player, {}, db)).rejects.toThrow(/from/);
    expect(link(contact, { type: "players", id: "" }, {}, db)).rejects.toThrow(/to/);
  });
});

describe("deletion", () => {
  it("unlink deletes in either direction", async () => {
    await link(contact, player, { relation: "same_person" }, db);
    // It is requested the opposite way from how it was stored: it must find it all the same.
    await unlink(player, contact, "same_person", db);
    expect(await neighbors(contact, {}, db)).toHaveLength(0);
  });

  it("unlinkAll clears both sides of an entity", async () => {
    await link(contact, player, { relation: "same_person" }, db);
    await link(request, contact, { relation: "ordered_by" }, db);

    await unlinkAll(contact, db);

    expect(await neighbors(contact, {}, db)).toHaveLength(0);
    expect(await neighbors(player, {}, db)).toHaveLength(0);
    expect(await neighbors(request, {}, db)).toHaveLength(0);
  });
});

describe("resolution: the engine does not know any table", () => {
  it("a type WITHOUT a loader is skipped — it is a kon that is not installed, not an error", async () => {
    await link(contact, player, { relation: "same_person" }, db);
    await link(contact, request, { relation: "ordered_by" }, db);

    const v = await neighbors(contact, {}, db);
    const r = await resolveNeighbors(v, {
      players: async (ids) => ids.map((id) => ({ id, nick: "Ana" })),
      // no loader for shop_orders: the shop is not installed
    });

    expect(r).toHaveLength(1);
    expect(r[0].entity).toEqual({ id: "p-1", nick: "Ana" });
  });

  it("a row the loader does not return DISAPPEARS", async () => {
    // That is how orphans get filtered (the row was deleted) and how the RLS of the
    // destination table stays in charge (you cannot see it, the loader does not give it to you).
    await link(contact, player, { relation: "same_person" }, db);

    const v = await neighbors(contact, {}, db);
    const r = await resolveNeighbors(v, {
      players: async () => [], // deleted, or no permission
    });

    expect(r).toHaveLength(0);
  });

  it("groups by type: one loader per type, not one per row", async () => {
    // If it called per row, a hundred neighbors would be a hundred queries.
    await link(contact, { type: "players", id: "p-1" }, {}, db);
    await link(contact, { type: "players", id: "p-2" }, {}, db);
    await link(contact, { type: "players", id: "p-3" }, {}, db);

    let calls = 0;
    const v = await neighbors(contact, {}, db);
    const r = await resolveNeighbors(v, {
      players: async (ids) => {
        calls++;
        return ids.map((id) => ({ id }));
      },
    });

    expect(calls).toBe(1);
    expect(r).toHaveLength(3);
  });
});
