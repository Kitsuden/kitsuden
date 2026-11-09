/**
 * Enum filters that come from outside
 * ============================================================================
 *
 * This pattern was repeated 25 times in 15 files:
 *
 *     if (status) conditions.push(eq(table.status, status as any));
 *
 * `status` comes from the query string. With a value that does not belong to the enum, the
 * query does NOT return zero rows: Postgres fails with
 * `invalid input value for enum ...`. A typo in the URL produced a 500 with
 * the internal type name in the message.
 *
 * These tests run against PGlite —real Postgres— because the
 * behavior being pinned down belongs to the engine, not to Drizzle: a double would not
 * have shown that without the filter the query BLOWS UP.
 */

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { eqEnum } from "../../packages/engine/src/db-conditions";

const statusEnum = pgEnum("doc_status", ["draft", "published", "archived"]);
const docs = pgTable("docs", {
  id: text("id").primaryKey(),
  title: text("title"),
  status: statusEnum("status"),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);
  await client.exec(`CREATE TYPE doc_status AS ENUM ('draft','published','archived')`);
  await client.exec(`CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, status doc_status)`);
  await client.exec(
    `INSERT INTO docs (id, title, status) VALUES ('a','one','draft'), ('b','two','published')`
  );
});

describe("eqEnum", () => {
  it("a valid value filters", async () => {
    const rows = await db.select().from(docs).where(eqEnum(docs.status, "draft"));
    expect(rows.map((f: { id: string }) => f.id)).toEqual(["a"]);
  });

  it("a value that does not belong to the enum does NOT blow up: it is ignored", async () => {
    // This is what used to give 500.
    const rows = await db
      .select()
      .from(docs)
      .where(and(eqEnum(docs.status, "live")));
    expect(rows).toHaveLength(2);
  });

  it("the `as any` being replaced DOES blow up — the reason for this to exist", async () => {
    // Drizzle wraps the error ("Failed query: ...") and leaves the Postgres one in
    // `cause`. What matters is that it THROWS: with the old pattern, a
    // misspelled parameter did not return zero rows, it took the request down.
    let failure: unknown;
    try {
      await db
        .select()
        .from(docs)
        .where(eq(docs.status, "live" as any));
    } catch (e) {
      failure = e;
    }

    expect(failure).toBeInstanceOf(Error);
    const string = `${(failure as Error).message} ${String((failure as Error).cause ?? "")}`;
    expect(string).toMatch(/invalid input value for enum|doc_status/i);
  });

  it("undefined and empty string do not filter", async () => {
    expect(eqEnum(docs.status, undefined)).toBeUndefined();
    expect(eqEnum(docs.status, "")).toBeUndefined();
    expect(eqEnum(docs.status, 42)).toBeUndefined();
  });

  it("on a normal text column it compares as is", async () => {
    // Without `enumValues` there is no list to validate against: returning undefined
    // would silence a legitimate filter.
    const rows = await db.select().from(docs).where(eqEnum(docs.title, "one"));
    expect(rows.map((f: { id: string }) => f.id)).toEqual(["a"]);
  });

  it("reads the values from the column itself, with no parallel list", () => {
    // If the schema adds a state, the filter accepts it without touching anything here.
    expect(eqEnum(docs.status, "archived")).toBeDefined();
    expect(eqEnum(docs.status, "pending")).toBeUndefined();
  });
});
