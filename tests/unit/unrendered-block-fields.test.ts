/**
 * Every field type that a block declares is one the editor knows how to paint
 * ============================================================================
 *
 * ── THE FAILURE THIS CHASES ────────────────────────────────────────────────
 *
 * `BlockEditor.svelte` paints fields with a chain of `{#if field.type ===
 * "..."}`. If the registry declares a type that this chain does not cover, the
 * field **is not painted**: no error, no gap, no warning. The block simply
 * does not have that option, and whoever configures it cannot know it existed.
 *
 * It is the most expensive family in this panel —what is declared but does not arrive— and it has already
 * claimed `defaultFilter`, `singularName` and a view's `readonly`. Here
 * it happens between two files that nobody looks at together: one describes the fields and
 * the other decides how they are drawn.
 *
 * ── WHY LOOKING AT THE TYPE UNION IS NOT ENOUGH ────────────────────────────
 *
 * Because the union can declare types that no block uses yet, and requiring
 * them to be painted would be noise. What matters is what some block really USES:
 * that is what someone is going to open and not find.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const REGISTRY = join(ROOT, "packages", "admin", "src", "types", "blocks.ts");
const EDITOR = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "builder",
  "BlockEditor.svelte"
);

const registry = readFileSync(REGISTRY, "utf-8");
const editor = readFileSync(EDITOR, "utf-8");

/** The `type: "..."` entries that appear inside field definitions. */
function usedTypes(): string[] {
  const from = registry.indexOf("export const BLOCK_REGISTRY");
  expect(from, "`BLOCK_REGISTRY` not found").toBeGreaterThan(-1);

  const body = registry.slice(from);

  /**
   * Only the ones next to a `key:` are looked for, which is the shape of a field
   * definition. A bare `type:` also identifies the block, and
   * counting it would put «hero» or «comments» in the list of field types.
   */
  const types = new Set<string>();
  for (const m of body.matchAll(/key:\s*"[^"]+",\s*\n\s*label:[^\n]*\n\s*type:\s*"([^"]+)"/g)) {
    types.add(m[1]);
  }
  // The short one-line form: `{ key: "x", label: "Y", type: "number" }`.
  for (const m of body.matchAll(/\{\s*key:\s*"[^"]+",\s*label:\s*"[^"]*",\s*type:\s*"([^"]+)"/g)) {
    types.add(m[1]);
  }

  return [...types];
}

describe("the declared fields get painted", () => {
  const used = usedTypes();

  it("field types to review were found", () => {
    /**
     * Without this, changing the shape of the registry would leave the test walking
     * an empty list and passing green while guarding nothing.
     */
    expect(used.length, `only these were read: ${used.join(", ")}`).toBeGreaterThan(5);
  });

  it("the editor handles all of them", () => {
    const withoutPainting = used.filter((t) => !editor.includes(`field.type === "${t}"`));

    expect(
      withoutPainting,
      `The block registry uses ${withoutPainting.map((t) => `«${t}»`).join(", ")} y ` +
        `\`BlockEditor.svelte\` has no branch for that type. The field is not painted: ` +
        `no error, no gap and no warning. Whoever configures the block will not be able to ` +
        `fill it in and will not know it existed.`
    ).toEqual([]);
  });
});

describe("choose from a list, do not type an identifier", () => {
  /**
   * ── WHY THIS IS A RULE AND NOT A PREFERENCE ────────────────────────────────
   *
   * The tier list block asked for the slug in a text field, with
   * `placeholder: "meta-5-4"`. Mistyping it gives **no error**: the
   * page saves calmly and comes out without the tier list. And the comments
   * block asked for the subject type the same way, where `post` and `blog_post`
   * open two different threads on the same article.
   *
   * It is the same family that produced «Add All Gam»: a string
   * typed by hand where there was a list to choose from.
   */
  const REFERENCES = [
    ["tier-list", "templateSlug"],
    ["character-builder", "definitionSlug"],
    ["comments", "subjectType"],
  ] as const;

  for (const [block, field] of REFERENCES) {
    it(`${block}: «${field}» is chosen`, () => {
      const i = registry.indexOf(`type: "${block}"`);
      expect(i, `block not found ${block}`).toBeGreaterThan(-1);

      const chunk = registry.slice(i, i + 2500);
      const j = chunk.indexOf(`key: "${field}"`);
      expect(j, `${block} does not declare the field ${field}`).toBeGreaterThan(-1);

      const definition = chunk.slice(j, j + 300);

      expect(
        /type:\s*"(select|remote-select)"/.test(definition),
        `«${field}» points to other content by its identifier. With a text ` +
          `field, mistyping it does not fail: the page is saved and comes out empty. ` +
          `Use \`select\` if the options are fixed, or \`remote-select\` if they live ` +
          `en la base.`
      ).toBe(true);
    });
  }

  it("remote options say where they come from", () => {
    /**
     * A `remote-select` without `source` is a dropdown that never fills: it looks
     * the same as «none created yet», and sends people to create something that
     * already exists.
     */
    const withoutSource: string[] = [];
    for (const m of registry.matchAll(
      /key:\s*"([^"]+)"[\s\S]{0,200}?type:\s*"remote-select"([\s\S]{0,300}?)(?=\n\s{6}\}|\n\s{6}\{)/g
    )) {
      if (!/source:\s*\{/.test(m[2])) withoutSource.push(m[1]);
    }

    expect(
      withoutSource,
      `${withoutSource.join(", ")}: a \`remote-select\` without \`source\` never gets ` +
        `filled, and an empty dropdown reads as «there are none».`
    ).toEqual([]);
  });
});
