/**
 * Repository (Drizzle + sugar) — integration tests.
 * DB-gated: skipped with pg-mem, runs with real Postgres.
 *   pnpm test:db:up && KITSUDEN_TEST_DB=postgres bun test src/tests/repository.test.ts
 */

import { repo } from "@kitsuden/engine";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { dataSets } from "../db/schema-core";

import { isDatabaseAvailable, generateTestId } from "./setup";

let dbAvailable = false;
const RUN = `repo-${generateTestId()}`;

async function cleanup() {
  await db.execute(sql`DELETE FROM data_sets WHERE name LIKE ${`${RUN}%`}`);
}

describe("Repository — Drizzle chainable sugar", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await cleanup();
  });
  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it("create + find + filter + orderBy + paginate", async () => {
    if (!dbAvailable) return;

    // create
    for (let i = 0; i < 5; i++) {
      await repo(dataSets).create({
        name: `${RUN}-ds-${i}`,
        slug: `${RUN}-ds-${i}`,
        schema: [],
      } as any);
    }

    // count with a raw filter (like)
    const total = await repo(dataSets)
      .where(sql`name LIKE ${`${RUN}%`}`)
      .count();
    expect(total).toBe(5);

    // filter (Django-style equality) + first
    const one = await repo(dataSets)
      .filter({ slug: `${RUN}-ds-2` } as any)
      .first();
    expect(one?.name).toBe(`${RUN}-ds-2`);

    // find by id
    const byId = await repo(dataSets).find(one!.id);
    expect(byId?.id).toBe(one!.id);

    // orderBy desc + limit
    const ordered = await repo(dataSets)
      .where(sql`name LIKE ${`${RUN}%`}`)
      .orderBy("-name")
      .limit(2)
      .all();
    expect(ordered).toHaveLength(2);
    expect(ordered[0].name).toBe(`${RUN}-ds-4`);

    // paginate
    const p1 = await repo(dataSets)
      .where(sql`name LIKE ${`${RUN}%`}`)
      .orderBy("name")
      .paginate(1, 2);
    expect(p1.total).toBe(5);
    expect(p1.pages).toBe(3);
    expect(p1.docs).toHaveLength(2);
    expect(p1.hasNext).toBe(true);
    expect(p1.hasPrev).toBe(false);
  });

  it("update + delete by filter", async () => {
    if (!dbAvailable) return;

    await repo(dataSets).create({
      name: `${RUN}-mut`,
      slug: `${RUN}-mut`,
      schema: [],
    } as any);

    const updated = await repo(dataSets)
      .filter({ slug: `${RUN}-mut` } as any)
      .update({ description: "updated" } as any);
    expect(updated[0]?.description).toBe("updated");

    const deleted = await repo(dataSets)
      .filter({ slug: `${RUN}-mut` } as any)
      .delete();
    expect(deleted).toBe(1);

    const gone = await repo(dataSets)
      .filter({ slug: `${RUN}-mut` } as any)
      .first();
    expect(gone).toBeNull();
  });
});
