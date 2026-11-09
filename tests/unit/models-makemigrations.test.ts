/**
 * `kitsuden makemigrations` over defineModel: the diff produces the right ALTER
 * ============================================================================
 *
 * Two levels:
 *
 *   1. The pure diff (`generateModelMigration`): from the saved snapshot
 *      of the demo kon to a changed model. The generated SQL is APPLIED
 *      on PGlite on top of 0000_models.sql and the resulting table is checked.
 *   2. The real CLI (`generateModelMigrations`, which loads the models
 *      with bun): on a copy of the fixture it writes a 0000 identical to the repo's,
 *      writes nothing if there are no changes, and after editing the model file
 *      writes 0001 with the ALTER. It needs `bun` on the PATH and
 *      `@kitsuden/shared` built (`pnpm --filter @kitsuden/shared build`).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  field,
  defineModel,
  generateModelMigration,
  modelsSnapshot,
  type Snapshot,
} from "@kitsuden/shared";
import { afterAll, describe, expect, it } from "vitest";

import {
  generateModelMigrations,
  makeModel,
  nextNumber,
} from "../../packages/cli/src/commands/models";

import { category, note } from "./fixtures/kon-notes/notes.model";

const ROOT = resolve(__dirname, "../..");
const FIXTURE = join(__dirname, "fixtures", "kon-notes");
// Normalized: the generator writes LF, and git may check the fixture out with CRLF.
const read = (route: string) => readFileSync(route, "utf8").replaceAll("\r\n", "\n");
const snapshot = JSON.parse(read(join(FIXTURE, "migrations", "models.snapshot.json"))) as Snapshot;

/** The notes model, changed the way someone would change it a week later. */
const noteV2 = defineModel({
  name: "note",
  tag: "Note",
  description: "A personal note. Each account sees only its own.",
  fields: {
    title: field.text({ max: 300, required: true }), // 200 → 300
    content: field.longText({ before: "body" }), // renamed
    status: field.enum(["draft", "published", "archived"], {
      required: true,
      defaultValue: "draft",
    }), // + archived
    priority: field.integer({ min: 0, max: 10, required: true, defaultValue: 0 }), // max 5 → 10
    pinned: field.boolean({ required: true, defaultValue: false }),
    dueAt: field.date(),
    slug: field.text({ max: 80 }), // no longer unique
    color: field.text({ max: 20, required: true, defaultValue: "gray" }), // new, required with a value
    // meta: removed → destructive, comes out commented
  },
  access: { read: "owner", write: "owner" },
});

describe("the diff (pure)", () => {
  it("no changes, no migration", () => {
    const r = generateModelMigration(snapshot, [note, category], { kon: "notes" });
    expect(r.sql).toBe("");
    expect(r.changes).toEqual([]);
  });

  it("the repo's snapshot is that of the declared models", () => {
    expect(modelsSnapshot([category, note], "notes")).toEqual(snapshot);
  });

  const r = generateModelMigration(snapshot, [noteV2, category], { kon: "notes" });

  it("produces the ALTERs for each change, and nothing for what did not change", () => {
    expect(r.sql).toContain(
      'ALTER TABLE "notes" ALTER COLUMN "title" TYPE varchar(300) USING "title"::varchar(300);'
    );
    expect(r.sql).toContain('ALTER TABLE "notes" RENAME COLUMN "body" TO "content";');
    expect(r.sql).toContain('ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_status_check";');
    expect(r.sql).toContain(
      `ADD CONSTRAINT "notes_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));`
    );
    expect(r.sql).toContain(
      `ADD CONSTRAINT "notes_priority_check" CHECK ("priority" >= 0 AND "priority" <= 10);`
    );
    expect(r.sql).toContain('ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_slug_key";');
    expect(r.sql).toContain(
      `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "color" varchar(20) NOT NULL DEFAULT 'gray';`
    );
    expect(r.sql).toContain(
      '-- DESTRUCTIVE (skipped; re-run with --allow-destructive to emit it): ALTER TABLE "notes" DROP COLUMN IF EXISTS "meta";'
    );
    expect(r.sql).not.toContain('"categories"');
    expect(r.sql).not.toContain("CREATE POLICY"); // the policy did not change
    expect(r.warnings.join("\n")).toMatch(/meta/);
  });

  it("applied on top of 0000 it leaves the table the new model describes", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(read(resolve(ROOT, "apps/api/src/db/agent-functions.sql")));
      await pg.exec(read(join(FIXTURE, "migrations", "0000_models.sql")));
      await pg.exec(
        "INSERT INTO notes (title, body, owner_id) VALUES ('before', 'old body', 'ana')"
      );
      await pg.exec(r.sql);
      const cols = await pg.query<{ column_name: string; data_type: string; len: number | null }>(
        "SELECT column_name, data_type, character_maximum_length AS len FROM information_schema.columns WHERE table_name = 'notes' ORDER BY column_name"
      );
      const by = Object.fromEntries(cols.rows.map((c) => [c.column_name, c]));
      expect(by.title?.len).toBe(300);
      expect(by.content).toBeDefined();
      expect(by.body).toBeUndefined();
      expect(by.meta).toBeDefined(); // the DROP came out commented
      // The rename keeps the data; the new field takes its default value.
      const row = await pg.query<{ content: string; color: string }>(
        "SELECT content, color FROM notes"
      );
      expect(row.rows[0]).toEqual({ content: "old body", color: "gray" });
      // The new CHECK admits «archived» and still rejects everything else.
      await pg.exec(
        "INSERT INTO notes (title, status, priority, owner_id) VALUES ('x', 'archived', 9, 'ana')"
      );
      await expect(
        pg.exec("INSERT INTO notes (title, status, owner_id) VALUES ('x', 'deleted', 'ana')")
      ).rejects.toThrow(/check/);
      // slug is no longer unique.
      await pg.exec(
        "INSERT INTO notes (title, slug, owner_id) VALUES ('a', 's', 'ana'), ('b', 's', 'ana')"
      );
    } finally {
      await pg.close();
    }
  });

  it("with --allow-destructive the DROP really comes out", () => {
    const d = generateModelMigration(snapshot, [noteV2, category], {
      kon: "notes",
      allowDestructive: true,
    });
    expect(d.sql).toMatch(/^ALTER TABLE "notes" DROP COLUMN IF EXISTS "meta";$/m);
  });

  it("a NEW required field without a default value is refused (it would fail with rows)", () => {
    const bad = defineModel({
      name: "note",
      description: "x",
      fields: { ...note.fields, owner2: field.text({ required: true }) },
      access: note.access,
    });
    expect(() => generateModelMigration(snapshot, [bad, category], { kon: "notes" })).toThrow(
      /default/
    );
  });

  it("changing the access policy rebuilds the four RLS policies", () => {
    const publicModel = defineModel({
      name: "category",
      plural: "categories",
      tag: category.tag,
      description: category.description,
      fields: category.fields,
      access: { read: "public", write: "staff" },
    });
    const other = defineModel({
      name: "note",
      description: note.description,
      fields: note.fields,
      access: { read: "owner", write: "staff" },
    });
    const c = generateModelMigration(snapshot, [other, publicModel], { kon: "notes" });
    expect(c.changes).toEqual(["access policy of note: read=owner, write=staff"]);
    expect(c.sql.match(/CREATE POLICY/g)).toHaveLength(4);
    expect(c.sql).toContain("kitsuden_effective_staff('notes')");
  });

  it("removing a model does not delete its table unless asked to", () => {
    const c = generateModelMigration(snapshot, [note], { kon: "notes" });
    expect(c.sql).toContain(
      '-- DESTRUCTIVE (skipped; re-run with --allow-destructive to emit it): DROP TABLE IF EXISTS "categories";'
    );
  });
});

// ── The real CLI ────────────────────────────────────────────────────────────

const COPY = join(__dirname, "fixtures", `.tmp-makemigrations-${process.pid}`);
afterAll(() => rmSync(COPY, { recursive: true, force: true }));

describe("kitsuden makemigrations (CLI, loads the models with bun)", () => {
  it("on a copy without migrations it writes a 0000 identical to the repo's; with no changes it writes nothing; after editing, 0001 with the ALTER", async () => {
    mkdirSync(COPY, { recursive: true });
    cpSync(join(FIXTURE, "kon.json"), join(COPY, "kon.json"));
    cpSync(join(FIXTURE, "notes.model.ts"), join(COPY, "notes.model.ts"));

    const [first] = await generateModelMigrations({ dir: COPY });
    expect(first?.target.kon).toBe("notes");
    expect(first?.file).toBe(join(COPY, "migrations", "0000_models.sql"));
    expect(read(first!.file!)).toBe(read(join(FIXTURE, "migrations", "0000_models.sql")));
    expect(JSON.parse(read(join(COPY, "migrations", "models.snapshot.json")))).toEqual(snapshot);
    // The one-off script is deleted.
    expect(existsSync(join(COPY, `__kitsuden_makemigrations_${process.pid}.ts`))).toBe(false);

    const [second] = await generateModelMigrations({ dir: COPY });
    expect(second?.file).toBeNull();

    const model = read(join(COPY, "notes.model.ts"));
    writeFileSync(
      join(COPY, "notes.model.ts"),
      model.replace("max: 200, required: true", "max: 300, required: true")
    );
    const [third] = await generateModelMigrations({ dir: COPY, name: "longer titles" });
    expect(third?.file).toBe(join(COPY, "migrations", "0001_longer_titles.sql"));
    expect(third?.changes).toEqual(["change type of note.title: varchar(200) → varchar(300)"]);
    expect(read(third!.file!)).toContain(
      'ALTER TABLE "notes" ALTER COLUMN "title" TYPE varchar(300)'
    );
    expect(nextNumber(join(COPY, "migrations"))).toBe("0002");

    // --dry-run does not write.
    writeFileSync(
      join(COPY, "notes.model.ts"),
      model.replace("max: 200, required: true", "max: 400, required: true")
    );
    const [dryRun] = await generateModelMigrations({ dir: COPY, dryRun: true });
    expect(dryRun?.sql).toContain("varchar(400)");
    expect(existsSync(dryRun!.file!)).toBe(false);
  }, 120_000);

  it("make model generates a model that declares without errors (and requires where it goes)", async () => {
    mkdirSync(COPY, { recursive: true });
    const notes = await makeModel("TaskItem", { dir: join(COPY, "models") });
    expect(notes[0]).toContain("task-item.model.ts");
    const mod = (await import(join(COPY, "models", "task-item.model.ts"))) as Record<
      string,
      { name: string; access: unknown }
    >;
    expect(mod.taskItem?.name).toBe("task-item");
    expect(mod.taskItem?.access).toEqual({ read: "owner", write: "owner" });
    await expect(makeModel("x", {})).rejects.toThrow(/--kon|--dir/);
    await expect(makeModel("TaskItem", { dir: join(COPY, "models") })).rejects.toThrow(
      /Already exists/
    );
  });
});
