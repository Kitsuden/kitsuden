/**
 * The «day 2» of defineModel with EXISTING rows
 * ============================================================================
 *
 * `models-makemigrations.test.ts` covers the diff and an ALTER on one row.
 * This covers what is only seen with real data in the table, applying the generated
 * SQL on PGlite, just like the runner (one transaction per file):
 *
 *   1. Making an optional field required:
 *        · with `isDefault`: the generator fills the NULLs before SET NOT NULL;
 *        · without it: it warns, and applying it with NULLs FAILS… leaving nothing half-done.
 *      The path that works: fill in (a data migration) and then
 *      make it required.
 *   2. Making a field with duplicates unique: fails entirely, nothing half-done.
 *   3. Narrowing the values (a CHECK) with rows that no longer comply: fails.
 *   4. A NEW required field with a default value: old rows take it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  field,
  defineModel,
  generateModelMigration,
  modelsSnapshot,
  type Model,
} from "@kitsuden/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const KON = "day2";

function task(fields: Model["fields"]): Model {
  return defineModel({
    name: "task",
    description: "A task.",
    fields,
    access: { read: "public", write: "staff" },
  });
}

const v1 = task({
  title: field.text({ max: 200, required: true }),
  owner: field.text({ max: 80 }),
  code: field.text({ max: 20 }),
  status: field.enum(["todo", "doing", "done", "dropped"], {
    required: true,
    defaultValue: "todo",
  }),
});

let pg: PGlite;

/** Like the runner: the whole file in ONE transaction. */
async function apply(sql: string): Promise<void> {
  await pg.exec(`BEGIN;\n${sql}\nCOMMIT;`).catch(async (e) => {
    await pg.exec("ROLLBACK").catch(() => {});
    throw e;
  });
}

async function columns(): Promise<Record<string, { nullable: string; def: string | null }>> {
  const r = await pg.query<{
    column_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'tasks'"
  );
  return Object.fromEntries(
    r.rows.map((c) => [c.column_name, { nullable: c.is_nullable, def: c.column_default }])
  );
}

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(resolve(ROOT, "apps/api/src/db/agent-functions.sql"), "utf8"));
  await apply(generateModelMigration(null, [v1], { kon: KON }).sql);
  // Rows from «last week»: owner NULL, repeated codes, a state that is later removed.
  await pg.exec(`INSERT INTO tasks (title, owner, code, status) VALUES
    ('a', NULL, 'X', 'todo'), ('b', 'ana', 'X', 'dropped'), ('c', 'luis', 'Y', 'done')`);
});

afterEach(async () => {
  await pg.close();
});

const before = () => modelsSnapshot([v1], KON);

describe("day 2 with existing rows", () => {
  it("optional → required WITH a default value: fills the NULLs and applies", async () => {
    const v2 = task({
      ...v1.fields,
      owner: field.text({ max: 80, required: true, defaultValue: "nobody" }),
    });
    const r = generateModelMigration(before(), [v2], { kon: KON });
    expect(r.sql).toContain(`UPDATE "tasks" SET "owner" = 'nobody' WHERE "owner" IS NULL;`);
    await apply(r.sql);
    const rows = await pg.query<{ owner: string }>("SELECT owner FROM tasks ORDER BY title");
    expect(rows.rows.map((f) => f.owner)).toEqual(["nobody", "ana", "luis"]);
    expect((await columns()).owner?.nullable).toBe("NO");
  });

  it("optional → required WITHOUT a default value: warns, fails with NULLs and leaves nothing half-done", async () => {
    const v2 = task({ ...v1.fields, owner: field.text({ max: 80, required: true }) });
    const r = generateModelMigration(before(), [v2], { kon: KON });
    expect(r.warnings.join("\n")).toMatch(/fill them first/);
    await expect(apply(r.sql)).rejects.toThrow(/null/i);
    expect((await columns()).owner?.nullable).toBe("YES");
  });

  it("…the path that works: fill in first (data migration) and then make it required", async () => {
    await apply(`UPDATE tasks SET owner = 'unassigned' WHERE owner IS NULL;`);
    const v2 = task({ ...v1.fields, owner: field.text({ max: 80, required: true }) });
    await apply(generateModelMigration(before(), [v2], { kon: KON }).sql);
    expect((await columns()).owner?.nullable).toBe("NO");
  });

  it("making a field with duplicates unique fails entirely, without leaving the index half-done", async () => {
    const v2 = task({ ...v1.fields, code: field.text({ max: 20, unique: true }) });
    const r = generateModelMigration(before(), [v2], { kon: KON });
    await expect(apply(r.sql)).rejects.toThrow(/duplicate|unique/i);
    const constraints = await pg.query(
      "SELECT conname FROM pg_constraint WHERE conname LIKE 'tasks_code%'"
    );
    expect(constraints.rows).toHaveLength(0);
  });

  it("narrowing the values with rows that no longer comply fails (and the old CHECK stays)", async () => {
    const v2 = task({
      ...v1.fields,
      status: field.enum(["todo", "doing", "done"], { required: true, defaultValue: "todo" }),
    });
    const r = generateModelMigration(before(), [v2], { kon: KON });
    await expect(apply(r.sql)).rejects.toThrow(/check/i);
    // The earlier CHECK is still in place: 'dropped' is valid, made-up values are not.
    await pg.exec("INSERT INTO tasks (title, status) VALUES ('d', 'dropped')");
    await expect(
      pg.exec("INSERT INTO tasks (title, status) VALUES ('e', 'made-up')")
    ).rejects.toThrow(/check/i);
  });

  it("a NEW required field with a default value: old rows take it", async () => {
    const v2 = task({
      ...v1.fields,
      points: field.integer({ min: 0, required: true, defaultValue: 1 }),
    });
    await apply(generateModelMigration(before(), [v2], { kon: KON }).sql);
    const rows = await pg.query<{ points: number }>("SELECT points FROM tasks");
    expect(rows.rows.every((f) => f.points === 1)).toBe(true);
  });
});
