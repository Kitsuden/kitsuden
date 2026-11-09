/**
 * The three pieces just added to the blog editor
 * ============================================================================
 *
 * Categories, autosave and concurrent-edit detection. All three have a
 * failure mode that is NOT seen: they do not blow up, they do something else.
 * This test guards exactly that.
 *
 * ── 1. THE PRECISION TRAP ──────────────────────────────────────────────────
 *
 * `blog_posts.updated_at` is `timestamptz(6)` — Postgres stores MICROSECONDS.
 * On its way out through the API it passes through a JavaScript `Date`, which
 * only reaches MILLISECONDS:
 *
 *     in the database   2026-08-28T23:05:45.919009Z
 *     in the editor     2026-08-28T23:05:45.919Z
 *
 * Comparing those two with `=` never matches. Written like that, the protection
 * against overwrites rejected EVERY save —a single person editing,
 * no conflict— with a 409 saying "someone else has changed it".
 *
 * It was detected by running it against the real database, not by reading it:
 * in the code the two versions read exactly as well.
 *
 * ── 2. ZOD DROPS SILENTLY ──────────────────────────────────────────────────
 *
 * Keys the schema does not declare do NOT raise an error: they are thrown away.
 * If `categoryIds` is missing from the schema, the post is saved without
 * categories and nobody is told. It already happened in this same editor with
 * `tags` instead of `tagIds`, and the symptom was "tags are not saved", which
 * does not lead you to look at the validator.
 *
 * ── 3. A DRAFT THAT DELETES ITSELF IS NOT A DRAFT ──────────────────────────
 *
 * Autosave protects against closing the tab. If on unmounting the component
 * `clearCurrentAutosave` were called instead of `stopAutosave`, leaving the
 * screen would destroy exactly what this is meant to protect.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const ROUTES = join(ROOT, "packages", "kons", "kon-blog", "src", "routes.ts");
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

describe("concurrent editing of posts", () => {
  const routes = withoutComments(readFileSync(ROUTES, "utf-8"));

  it("the version comparison truncates to milliseconds", () => {
    /**
     * What is forbidden is the direct `=` against the column. `date_trunc`
     * equalizes the two precisions; without it, every save returns 409.
     */
    expect(
      routes.includes("date_trunc('milliseconds'"),
      "The `expectedUpdatedAt` condition must truncate `updated_at` to " +
        "milliseconds. The column is timestamptz(6) and what comes back from the editor " +
        "went through a JavaScript Date, which only has milliseconds: compared " +
        "raw they NEVER match and ANY save is rejected with a 409 " +
        "that blames a nonexistent other person."
    ).toBe(true);

    expect(
      /eq\(\s*blogPosts\.updatedAt\s*,/.test(routes),
      "`eq(blogPosts.updatedAt, …)` compares microseconds against milliseconds and " +
        "never matches. Use the `date_trunc` comparison."
    ).toBe(false);
  });

  it("a conflict writes nothing and is distinguished from a nonexistent post", () => {
    // The blog is an SDK kon: PATCH /:id is the `editar-entrada` operation.
    const patch = routes.slice(routes.indexOf('id: "editar-entrada"'));
    const body = patch.slice(0, patch.indexOf('id: "borrar-entrada"'));

    expect(body.length, "the PATCH /:id handler was not found").toBeGreaterThan(0);

    // The condition goes in the UPDATE's WHERE: if the filter were applied after
    // writing, the overwrite would already have happened.
    expect(
      body.indexOf("const condicion") < body.indexOf(".update(blogPosts)"),
      "the version condition has to be part of the UPDATE's WHERE, not " +
        "checked afterwards: afterwards it has already been overwritten."
    ).toBe(true);

    // 409 and 404 are not the same: one sends you to resolve a conflict, the other to
    // look for a post that does exist.
    expect(body).toContain("currentUpdatedAt");
    expect(body).toMatch(/409/);
    expect(body).toMatch(/"Post not found"/);
  });

  it("sending the version is optional", () => {
    /**
     * Without `expectedUpdatedAt` the behavior has to be the usual one.
     * Making it mandatory would suddenly break every existing consumer —
     * scripts, integrations, the panel itself before reloading.
     */
    expect(
      routes.includes("expectedUpdatedAt\n        ? and(") ||
        /expectedUpdatedAt\s*\n?\s*\?/.test(routes),
      "the condition has to be a ternary on `expectedUpdatedAt`: whoever does not " +
        "sends it keeps the previous behavior."
    ).toBe(true);
  });
});

describe("blog categories", () => {
  const routes = withoutComments(readFileSync(ROUTES, "utf-8"));
  const editor = readFileSync(EDITOR, "utf-8");

  it("`categoryIds` is declared in the validation schema", () => {
    /**
     * Without this zod DROPS it without complaint: the post is saved, the categories
     * are not, and there is neither an error nor a warning. The silent failure is
     * worse than the 400.
     */
    const create = routes.slice(
      routes.indexOf("const createPostSchema"),
      routes.indexOf("const categoriaSchema")
    );

    expect(
      create.includes("categoryIds"),
      "`categoryIds` is missing from createPostSchema/updatePostSchema. Zod drops " +
        "keys it does not know WITHOUT complaining: categories would be lost " +
        "on every save without a single message."
    ).toBe(true);
  });

  it("they are synced on create and on update, not just on one", () => {
    const times = [
      ...routes.matchAll(
        /blogPostsToCategories\)?\s*\n?\s*\.values\(|insert\(blogPostsToCategories\)/g
      ),
    ];
    expect(
      times.length,
      "categories have to be saved both in POST / and in PATCH /:id. " +
        "With only one, creating a post with categories works and editing it loses them."
    ).toBeGreaterThanOrEqual(2);
  });

  it("`GET /:id` returns the post's categories", () => {
    /**
     * It is the half that was missing with tags: they were saved and on reopening
     * the post came out empty, which reads as "it has none" and not as "I did not
     * bring them".
     */
    expect(
      routes.includes("categoryIds: categorias.map"),
      "`GET /api/blog/:id` has to return `categoryIds`. Otherwise the editor " +
        "shows the post WITHOUT categories however many it has, and the next " +
        "save really deletes them."
    ).toBe(true);
  });

  it("the editor sends the list even when empty", () => {
    /**
     * `[]` means "remove them all" and omitting the key means "do not
     * touch them". If the editor only sent it when there are some, removing the
     * last category of a post would be impossible: it would look removed and come
     * back on reload.
     */
    expect(
      editor.includes("if (postId || categoryIds.length > 0) postData.categoryIds = categoryIds;"),
      "when editing an existing post, `categoryIds` has to ALWAYS travel, " +
        "even empty: otherwise removing the last category is never saved."
    ).toBe(true);
  });
});

describe("inserting images in the text", () => {
  const editor = readFileSync(EDITOR, "utf-8");
  const EDITORS = join(ROOT, "packages", "admin", "src", "lib", "components", "editor");
  const fast = readFileSync(join(EDITORS, "SlashCommandEditor.svelte"), "utf-8");
  const markdown = readFileSync(join(EDITORS, "MdxEditor.svelte"), "utf-8");

  it("`/image` opens the library instead of writing a gap", () => {
    /**
     * The command inserted the text `![alt](url)` and that was it. That is not
     * inserting an image: it is leaving homework — go to another screen, find the
     * file, copy its URL and come back to paste it. With the media library ALREADY
     * LOADED on this very screen, which was used for the cover image.
     *
     * It is the usual pattern in this repo: the piece exists, works, and is not
     * plugged in where it is needed.
     */
    expect(
      fast.includes('command.id === "image" && onRequestImage'),
      "the `/image` command has to open the media picker, not insert " +
        "`![alt](url)` for someone to fill in the URL by hand."
    ).toBe(true);
  });

  it("both writing modes can insert", () => {
    /**
     * Markdown is CodeMirror and Quick is a textarea: inserting at the cursor
     * position is done differently in each. If only one supported it, the
     * button would stop working when switching modes without any warning.
     */
    expect(fast).toContain("export function insertImage");
    expect(markdown).toContain("export function insertImage");
    expect(editor).toContain("bind:this={quickEditor}");
    expect(editor).toContain("bind:this={editorMarkdown}");
  });

  it("the library knows whether the image goes to the cover or to the text", () => {
    /**
     * It is the SAME modal for both things. Without distinguishing the destination,
     * picking an image for the article body would change the post's cover
     * —silently— and vice versa.
     */
    expect(editor).toContain("imageTarget");

    const open = [...editor.matchAll(/showMediaModal = true/g)].length;
    const pinnedItems = [...editor.matchAll(/imageTarget = "(portada|contenido)"/g)].length;
    expect(
      pinnedItems >= open,
      "every place that opens the library has to set the destination first. The " +
        "one that does not inherits that of the previous use: asking for the cover would end up " +
        "inserting into the text."
    ).toBe(true);
  });

  it("the `alt` comes from the library, it does not stay as «alt»", () => {
    /**
     * Written by hand, the alternative text almost always stays at the placeholder.
     * And the `alt` is accessibility and it is SEO — two things this
     * same editor scores in its own bar.
     */
    expect(
      editor.includes("media.alt || media.filename"),
      "when inserting, the `alt` the file already has in the " +
        "library has to be used, with the file name as a fallback."
    ).toBe(true);
  });

  it("the cursor position is saved before opening the modal", () => {
    /**
     * Opening the modal takes focus away from the textarea. Relying on
     * `selectionStart` surviving the blur is fragile: it is enough for the modal to
     * focus something for the image to appear at the start of the text instead of
     * where one was writing.
     */
    expect(fast).toContain("savedPosition");
  });
});

describe("editor autosave", () => {
  const editor = readFileSync(EDITOR, "utf-8");

  it("leaving the screen does NOT delete the draft", () => {
    expect(
      editor.includes("onDestroy(() => autosaveStore.stopAutosave())"),
      "`onDestroy` has to STOP the autosave, not clear it. With " +
        "`clearCurrentAutosave` here, leaving the screen would destroy the " +
        "draft — exactly what this protects."
    ).toBe(true);

    const destroy = editor.slice(editor.indexOf("onDestroy("), editor.indexOf("onDestroy(") + 120);
    expect(
      destroy.includes("clearCurrentAutosave"),
      "`clearCurrentAutosave` in `onDestroy` deletes the draft on exit."
    ).toBe(false);
  });

  it("the draft is cleared only after really saving", () => {
    const save = editor.slice(editor.indexOf("async function handleSave"));
    const body = save.slice(0, save.indexOf("async function handleDelete"));

    const iSaved = Math.max(body.indexOf("api.updatePost"), body.indexOf("api.createPost"));
    const iCleanup = body.indexOf("clearCurrentAutosave");

    expect(iCleanup, "the draft has to be cleared after saving").toBeGreaterThan(-1);
    expect(
      iCleanup > iSaved,
      "the draft is cleared AFTER the API confirms. Before that, a network " +
        "failure would take away the only copy left of what was written."
    ).toBe(true);

    // And it must NOT be cleared in the catch: that is exactly when it is needed most.
    const capture = body.slice(body.indexOf("} catch"));
    expect(
      capture.includes("clearCurrentAutosave"),
      "if saving fails, the local draft is the only thing that keeps the " +
        "work: do not touch it."
    ).toBe(false);
  });

  it("change tracking does not fight with itself", () => {
    /**
     * The store is reactive. An `$effect` that writes to it and reads it gets into
     * feedback. It already happened in this same panel's data explorer,
     * and the symptom —the interface undoing what its user does— looks nothing
     * like the cause.
     */
    expect(
      editor.includes("untrack(() => autosaveStore.updateData(dataValue))"),
      "the write to the store inside the `$effect` has to go in `untrack`."
    ).toBe(true);
  });

  it("restoring a version from the history moves the form", () => {
    /**
     * `VersionHistory` (the indicator's dropdown) restores by calling
     * `restoreVersion`, which just leaves the data in
     * `autosaveStore.restoredData`. The store paints nothing.
     *
     * Without an effect that reads it, the "Restore" button exists, gets pressed,
     * gives no error and NOTHING HAPPENS — the same pattern the blocks tab had
     * before being connected: complete code and unplugged. A failure like this is
     * not seen by any type check.
     */
    expect(
      editor.includes("autosaveStore.restoredData"),
      "the editor has to react to `restoredData`: otherwise the button " +
        "«Restore» of the version history does absolutely nothing."
    ).toBe(true);

    expect(
      editor.includes("applySnapshot(recovered)"),
      "what was restored has to be applied to the form."
    ).toBe(true);
  });

  it("a draft is only offered for recovery if it is NEWER than the server's", () => {
    expect(
      editor.includes("last.timestamp > savedOnServer"),
      "offering a draft older than what is saved is proposing to lose work, " + "not recovering it."
    ).toBe(true);
  });
});
