/**
 * The runtime guard, put to the test
 * ============================================================================
 *
 * A guard without a test that deliberately breaks it is a statement of
 * intent. Here the two things that need checking are checked:
 *
 *   1. That it fires.
 *   2. That it fires IN THE CASE THE REGEX DOES NOT SEE — the filter split between
 *      functions. That is what justifies having two guards and not one.
 *
 * And a third, just as important: that it does NOT fire on correct use,
 * because a guard that gives false positives ends up disabled.
 */

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { DoubleWhereError } from "./guard-drizzle-where";

const things = pgTable("things", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  type: text("type"),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);
  await client.exec(`CREATE TABLE things (id TEXT PRIMARY KEY, org_id TEXT, type TEXT)`);
  await client.exec(
    `INSERT INTO things (id, org_id, type) VALUES ('a','org-A','x'), ('b','org-B','x')`
  );
});

describe("double .where() guard", () => {
  it("lets the correct form through: a single call", async () => {
    const conditions = [eq(things.orgId, "org-A"), eq(things.type, "x")];
    const rows = await db
      .select()
      .from(things)
      .where(and(...conditions));

    expect(rows.map((f: { id: string }) => f.id)).toEqual(["a"]);
  });

  it("throws on direct chaining", () => {
    const q = db.select().from(things).where(eq(things.orgId, "org-A"));
    expect(() => q.where(eq(things.type, "x"))).toThrow(DoubleWhereError);
  });

  it("throws even when the filter is applied FROM A HELPER FUNCTION", () => {
    // This is the form the text guard cannot see: the file has no
    // `q = q.where(...)`, only two calls to `apply`. For the
    // regular expression this is invisible; for Drizzle it is the same error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apply = (constructor: any, condition: any) => constructor.where(condition);

    let q = db.select().from(things);
    q = apply(q, eq(things.orgId, "org-A"));

    expect(() => apply(q, eq(things.type, "x"))).toThrow(DoubleWhereError);
  });

  it("throws in a loop over the fields of a filter", () => {
    // The other real form: walking a `where` object and calling once per field.
    // It is what `batch.ts` and `batch-api.ts` did with WRITES.
    const filter = { orgId: "org-A", type: "x" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.delete(things);

    expect(() => {
      for (const [field, value] of Object.entries(filter)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        q = q.where(eq((things as any)[field], value));
      }
    }).toThrow(DoubleWhereError);
  });

  it("also guards UPDATE and DELETE, not just SELECT", () => {
    const up = db.update(things).set({ type: "y" }).where(eq(things.id, "a"));
    expect(() => up.where(eq(things.orgId, "org-A"))).toThrow(DoubleWhereError);

    const of = db.delete(things).where(eq(things.id, "a"));
    expect(() => of.where(eq(things.orgId, "org-A"))).toThrow(DoubleWhereError);
  });

  it("the message says what to do, not just what happened", () => {
    const q = db.select().from(things).where(eq(things.id, "a"));
    let message = "";
    try {
      q.where(eq(things.type, "x"));
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("REPLACES");
    expect(message).toContain("and(...conditions)");
    // The way out when the filter crosses functions: pass conditions, not builders.
    expect(message).toContain("not the builder");
  });

  it("distinct builders are independent", () => {
    // Tracking is PER INSTANCE: two queries in a row on the same
    // handler cannot interfere, or the guard would be useless.
    const a = db.select().from(things).where(eq(things.id, "a"));
    const b = db.select().from(things).where(eq(things.id, "b"));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});
