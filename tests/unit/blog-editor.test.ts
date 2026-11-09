/**
 * The blog editor saves, and there is only ONE
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * Three editing components spread over two screens, and the one that opened
 * was useless:
 *
 *   · `EditorView` — markdown with preview. It was what «New Post» and edit
 *     post opened, via `/content/edit` -> `/g/system-tools/editor`.
 *     It IGNORED `?collection` and `?id` —it started with its demo text— and
 *     its «Save Draft» button HAD NO `onclick`. A decorative button.
 *   · `BlogPostEditor` — full CRUD against `/api/blog`. Nothing linked to it.
 *   · `PageBuilder` — blocks. On a third screen.
 *
 * So: creating a post was impossible, and editing one opened a sample
 * document. None of it raised an error: nothing simply happened when you
 * pressed save.
 *
 * ── WHAT THIS TEST GUARDS ──────────────────────────────────────────────────
 *
 * That the editor still knows how to save and that a second editor does not
 * reappear. It does not check the symptom («the button does nothing») but the
 * three properties that caused it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const EDITOR = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "blog",
  "BlogPostEditor.svelte"
);
const ROUTE = join(ROOT, "packages", "admin", "src", "routes", "content", "edit", "+page.svelte");

describe("blog editor", () => {
  const editor = withoutComments(readFileSync(EDITOR, "utf-8"));

  it("the editor route renders the editor that saves", () => {
    expect(
      existsSync(ROUTE),
      "/content/edit no longer renders anything. It is where «New Post» and the " +
        "click on a row in the post list go."
    ).toBe(true);

    const route = withoutComments(readFileSync(ROUTE, "utf-8"));
    expect(
      /BlogPostEditor/.test(route),
      "/content/edit has to mount `BlogPostEditor`, the only one that " +
        "loads the post by id and saves it."
    ).toBe(true);
    expect(
      /searchParams\.get\("id"\)/.test(route),
      "the route has to read `?id`: without it, editing an existing post would open " +
        "a blank one — which is exactly what the previous editor did."
    ).toBe(true);
  });

  it("save is wired to a handler", () => {
    // The original failure was not an exception: it was a `<button>` without `onclick`.
    // We check that the save button has a handler AND that the function
    // that calls the API exists.
    expect(
      /api\.(createPost|updatePost)\(/.test(editor),
      "the editor no longer calls `api.createPost` / `api.updatePost`."
    ).toBe(true);

    const save = editor.match(/onclick=\{[^}]*handleSave[^}]*\}/);
    expect(
      save,
      "no editor button calls `handleSave`. The previous editor had " +
        "a «Save Draft» button without `onclick`, which is why it saved nothing."
    ).toBeTruthy();
  });

  it("blocks travel with the post", () => {
    // The blocks tab edits the `blocks` column. If it is not included in the
    // request, edits are made and lost: decorative, like the button before.
    // The cut is searched AFTER `const postData`: there is an `if (postId)` before it,
    // in `onMount`, and searching from the start returned an empty slice — the
    // test failed with `blocks` correctly in place.
    const start = editor.indexOf("const postData");
    expect(start, "the body sent on save was not found").toBeGreaterThan(-1);
    const dispatch = editor.slice(start, editor.indexOf("if (postId)", start));
    expect(
      /\bblocks\b/.test(dispatch),
      "`blocks` does not travel in the body that is saved: the blocks tab" + "would be decorative."
    ).toBe(true);
  });

  it("a second content editor has not reappeared", () => {
    expect(
      existsSync(join(ROOT, "packages", "admin", "src", "views", "EditorView.svelte")),
      "`EditorView` is back. Its markdown editor now lives INSIDE " +
        "BlogPostEditor as a writing mode; a separate screen opens the " +
        "door again to an editor that does not save."
    ).toBe(false);
  });
});

/**
 * The body the editor sends has to fit the API schema
 * ============================================================================
 *
 * Three real mismatches, and none was visible from reading the code on one side:
 *
 *   · `publishedAt: null` and `featuredImageId: null` gave **400**. The schema
 *     declares them `.optional()`, which in zod is `undefined`, NOT `null`. Saving
 *     a draft without an image —a new post, the most common case— always
 *     failed.
 *   · The editor sent `tags` and the schema expects `tagIds`. Zod drops
 *     what it does not know instead of complaining, so the tags were lost
 *     SILENTLY: the post was saved and the tags were not.
 *
 * They were found by passing the real body through the real schema, not by
 * reading. This test keeps that check where it would break.
 */
describe("the body it saves fits the API", () => {
  const editor = withoutComments(readFileSync(EDITOR, "utf-8"));
  const apiRoutes = withoutComments(
    readFileSync(join(ROOT, "packages", "kons", "kon-blog", "src", "routes.ts"), "utf-8")
  );

  it("nulls are not sent where the schema expects optionals", () => {
    const dispatch = editor.slice(
      editor.indexOf("const postData"),
      editor.indexOf("if (postId)", editor.indexOf("const postData"))
    );

    for (const field of ["publishedAt", "featuredImageId", "authorId"]) {
      expect(
        new RegExp(`${field}:\s*[^,\n]*\bnull\b`).test(dispatch),
        `The editor is sending \`${field}\` as null again. The API schema ` +
          `declares it \`.optional()\`, which in zod means \`undefined\`: a null gives ` +
          `400 «Validation failed». Omit the field when there is no value.`
      ).toBe(false);
    }
  });

  it("tags are sent under the name the API expects", () => {
    expect(
      /tagIds/.test(editor),
      "the editor no longer sends `tagIds`. Sending `tags` does not error: zod drops " +
        "the key and the tags are lost without warning."
    ).toBe(true);

    expect(
      /tagIds:\s*z\.array/.test(apiRoutes),
      "the API no longer declares `tagIds` in its schema; check what it is called now " +
        "and update the editor at the same time."
    ).toBe(true);
  });

  it("the post returns its tags when opened", () => {
    // `GET /:id` returned the raw row, and the tags live in a relation
    // table: opening an existing post always showed it without tags.
    expect(
      /tagIds:\s*etiquetas\.map/.test(apiRoutes),
      "`GET /api/blog/:id` no longer returns `tagIds`. Without it the editor opens all " +
        "posts without tags and they can be neither seen nor removed."
    ).toBe(true);
  });
});

/**
 * The blocks tab has to be COMPLETE
 * ============================================================================
 *
 * The blocks panel was written and its button was not: the script that inserted
 * both aborted halfway and only the panel part was rerun. Result — a perfectly
 * working panel that could not be reached from anywhere, and a tab bar with
 * Content / SEO / Settings and nothing else.
 *
 * No error was raised: `activeTab` simply never equaled "blocks".
 */
describe("blocks tab", () => {
  const editor = withoutComments(readFileSync(EDITOR, "utf-8"));

  it("the button and the panel exist", () => {
    expect(
      /activeTab = "blocks"/.test(editor),
      'there is no button that sets `activeTab` to "blocks": the blocks ' +
        "panel exists but is unreachable."
    ).toBe(true);

    expect(
      /activeTab === "blocks"/.test(editor),
      'there is no panel for `activeTab === "blocks"`: the tab would lead to an' + "empty screen."
    ).toBe(true);

    expect(/<PageBuilder/.test(editor), "the blocks tab no longer mounts `PageBuilder`.").toBe(
      true
    );
  });
});

/**
 * The first thing you see when opening the editor is where to write
 * ============================================================================
 *
 * The post body was the FOURTH field —after title, slug, featured image and
 * excerpt— and sat below the fold: you opened «New Post» and could not
 * see where to write. The image and the excerpt are metadata; the body is
 * what you come here for.
 */
describe("order of the editor fields", () => {
  const editor = readFileSync(EDITOR, "utf-8");

  it("the body goes before the featured image and the excerpt", () => {
    const content = editor.indexOf("<!-- Content Editor -->");
    const image = editor.indexOf("<!-- Featured Image -->");
    const excerpt = editor.indexOf("<!-- Excerpt -->");

    expect(content, "the content editor was not found").toBeGreaterThan(-1);
    expect(
      content < image && content < excerpt,
      "the field where the post is written is below the metadata again. " +
        "It is the only thing you come here to do: it goes first."
    ).toBe(true);
  });
});
