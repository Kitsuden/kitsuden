/**
 * The image gallery is picked, not typed by hand
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * The "Image Gallery" block declared its field like this:
 *
 *     { key: "images", label: "Images (JSON)", type: "json" }
 *
 * That is: a text box with `[]` inside. To build a carousel you had to go to
 * the media library, copy the URL of each image, come back and compose the
 * array by hand — with the library one click away and a selector (`MediaPicker`)
 * already written, with search and upload, used in three other places in the panel.
 *
 * Once again the piece existed and was not plugged in where it was needed.
 *
 * ── WHAT THIS TEST GUARDS ──────────────────────────────────────────────────
 *
 * What matters is not that the field exists, but that the TWO HALVES fit:
 * what the editor writes has to be what the renderer reads. If the
 * editor saved `{ src }` and the renderer read `{ url }`, the gallery would
 * edit fine, save fine and come out empty on the site — without a single
 * error in between. It is exactly what happened with `tags` versus `tagIds`, and
 * with `name` versus `title` in collections.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderBlocks } from "@kitsuden/shared";

const ROOT = join(__dirname, "..", "..");
const ADMIN = join(ROOT, "packages", "admin", "src");
const BLOCKS = join(ADMIN, "types", "blocks.ts");
const EDITOR = join(ADMIN, "lib", "components", "builder", "BlockEditor.svelte");
const PICKER = join(ADMIN, "lib", "components", "media", "MediaPicker.svelte");

describe("the gallery field", () => {
  const blocks = readFileSync(BLOCKS, "utf-8");
  const editor = readFileSync(EDITOR, "utf-8");

  it("no longer asks for hand-written JSON", () => {
    const gallery = blocks.slice(
      blocks.indexOf('type: "image-gallery"'),
      blocks.indexOf('type: "tier-list"')
    );

    expect(gallery.length, "the `image-gallery` block was not found").toBeGreaterThan(0);

    expect(
      /key: "images",[\s\S]{0,120}type: "json"/.test(gallery),
      "the `images` field cannot be `json`: it forces composing the array by hand " +
        "with the media library right next to it."
    ).toBe(false);

    expect(gallery).toContain('type: "gallery"');
  });

  it("the editor renders it and opens the media picker", () => {
    expect(editor).toContain('field.type === "gallery"');

    /**
     * And with the picker in multiple mode: if it opened the single one, picking
     * eight images would be eight openings.
     */
    const picker = editor.slice(editor.indexOf("galleryChoosing !== null"));
    expect(
      picker.includes("multiple"),
      "the gallery has to open `MediaPicker` in multiple mode."
    ).toBe(true);
  });

  it("it can be reordered: in a carousel the order is the content", () => {
    expect(editor).toContain("function moveImage");
  });

  it("each image stores its alt text", () => {
    /**
     * The `alt` is accessibility and it is SEO. Typing the JSON by hand it
     * stayed empty almost always; with a field next to the thumbnail, it does not.
     */
    expect(editor).toContain('editImage(field.key, i, "alt"');
  });
});

describe("picker's multiple mode", () => {
  const picker = readFileSync(PICKER, "utf-8");

  it("does not change the behavior for those who already used it", () => {
    /**
     * `MediaPicker` is used by the blog editor, the datasets form and the
     * blocks' image fields, all single-selection. The new mode
     * has to be optional and off by default.
     */
    expect(picker).toContain("multiple = false");
  });

  it("when several are uploaded, all of them go in", () => {
    /**
     * Before, it kept `subidos[0]`. Dragging eight images for a carousel
     * uploaded all eight to the library and put ONE in the block: from the
     * outside it looks like the upload half-failed.
     */
    expect(picker).toContain("for (const medium of uploaded) onSelect(medium)");
  });
});

describe("what the editor writes is what the renderer reads", () => {
  it("a gallery with the editor's shape renders in full", () => {
    /**
     * The check that really matters, and that is why it runs the real
     * renderer instead of looking at the code: the EXACT object that
     * `toggleInGallery` saves —`{ url, alt, mediaId }`— plus a `caption` is built,
     * and passed through `renderBlocks`.
     */
    const { html, interactive } = renderBlocks([
      {
        id: "1",
        type: "image-gallery",
        order: 0,
        data: {
          layout: "grid",
          columns: 3,
          images: [
            { url: "https://example.test/a.jpg", alt: "First", mediaId: "m1" },
            { url: "https://example.test/b.jpg", alt: "Second", caption: "Caption", mediaId: "m2" },
          ],
        },
      },
    ]);

    expect(html).toContain('src="https://example.test/a.jpg"');
    expect(html).toContain('alt="First"');
    expect(html).toContain('src="https://example.test/b.jpg"');
    expect(html, "the caption has to come out").toContain("<figcaption>Caption</figcaption>");

    expect(interactive, "a gallery renders in full, it is not a gap").toEqual([]);

    /**
     * `mediaId` belongs to the editor —it is used to mark what is picked in the
     * picker— and the renderer does not need it. What it cannot do is
     * end up printed on the page.
     */
    expect(html, "`mediaId` is for the editor's internal use").not.toContain("m1");
  });
});
