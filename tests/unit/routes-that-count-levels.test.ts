/**
 * No route is computed by counting directory levels
 * ============================================================================
 *
 * ── THE FAILURE, AND WHY IT ONLY SHOWED UP IN PRODUCTION ───────────────────
 *
 * `kon-migrations.ts` resolved the monorepo root like this:
 *
 *     resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
 *
 * Four levels up from `apps/api/src/lib`. In development that is exact.
 *
 * But the image runs `dist/index.js`, a SINGLE bundled file. From
 * `/app/apps/api/dist`, four levels up is `/`. So it looked for each kon's
 * migrations in `/packages/kons/<kon>/migrations`, a path that does not
 * exist, and the panel said:
 *
 *     'kon-character-builder' ships no migration files, so nothing creates its tables
 *
 * A checkable lie: `0001_builder.sql` was in the repo AND inside the
 * image. It was just being looked for where it was not.
 *
 * ── WHY THIS IS THE WORST CLASS OF FAILURE ─────────────────────────────────
 *
 * Because in development EVERYTHING works. The tests pass, the kon activates, and
 * the problem appears only once compiled — exactly where nobody is watching the
 * console. And the symptom («ships no migrations») points at the kon, which is fine,
 * instead of at path resolution, which is what is broken.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * A path is not deduced from the depth of the file: it is SEARCHED for. Walking up until
 * a marker (`packages/kons`) is found works from the source, from a bundle
 * at any depth and from a script launched in a subdirectory,
 * because it assumes nothing about the shape of the tree — it checks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = join(ROOT, "apps", "api", "src", "lib", "kon-migrations.ts");

describe("resolving the monorepo root", () => {
  const source = withoutComments(readFileSync(MIGRATIONS, "utf-8"));

  it("a fixed number of levels is not walked up", () => {
    /**
     * Looks for `resolve(dirname(...), "..", "..", ...)` — the signature of the failure.
     * Two `..` in a row is already counting; with a single one there is room for a legitimate use
     * (`join(dir, "..")` for a sibling), so two or more are required.
     */
    const counting = /resolve\([^)]*dirname\([^)]*\)[^)]*(?:"\.\."\s*,\s*){2,}/.test(source);

    expect(
      counting,
      "The repo root cannot come from counting `..` from the file: in the " +
        "production bundle the code lives at a different depth and the path " +
        "points outside the project. Walk up until you find `packages/kons`."
    ).toBe(false);
  });

  it("a real marker is looked for on disk", () => {
    expect(
      source.includes('join(dir, "packages", "kons")') ||
        /existsSync\(join\([^)]*"packages"[^)]*"kons"/.test(source),
      "the candidate folder must be checked to contain `packages/kons` " + "before accepting it."
    ).toBe(true);
  });

  it("there is more than one starting point", () => {
    /**
     * The module alone is not enough: a script can live outside the expected tree.
     * `process.cwd()` alone is not enough either: it runs from subdirectories. Both
     * together cover the real cases that have occurred in this repo.
     */
    expect(source).toContain("process.cwd()");
    expect(source).toContain("import.meta.url");
  });
});

describe("the kons' migrations are actually found", () => {
  /**
   * And this is the check that matters: not that the code has a certain shape,
   * but that the files show up. The real function is executed.
   */
  it("every kon that declares tables has locatable migrations", async () => {
    const { migrationsDir, migrationsOf, cleanRootCache } =
      await import("../../apps/api/src/lib/kon-migrations");

    cleanRootCache();

    const { readdirSync, existsSync, readFileSync: read } = await import("node:fs");
    const KONS = join(ROOT, "packages", "kons");

    const problems: string[] = [];

    for (const dir of readdirSync(KONS)) {
      const manifest = join(KONS, dir, "kon.json");
      if (!existsSync(manifest)) continue;

      let kon: { id?: string; tables?: unknown[] };
      try {
        kon = JSON.parse(read(manifest, "utf-8"));
      } catch {
        continue;
      }

      const tables = kon.tables ?? [];
      if (tables.length === 0) continue; // stores nothing of its own

      const konId = kon.id || dir;
      const dirName = migrationsDir(konId);
      const files = dirName ? migrationsOf(konId) : [];

      if (files.length === 0) {
        problems.push(
          `${konId} declares ${tables.length} table(s) and no ` +
            `migration found for it (folder: ${dirName ?? "not found"}). ` +
            `Activating it would leave its screens returning errors.`
        );
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });
});
