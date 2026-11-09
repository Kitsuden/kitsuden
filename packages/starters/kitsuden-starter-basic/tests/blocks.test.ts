/**
 * Render test of the page-builder blocks (Astro Container API, no server, no API)
 *
 * Every block type this site claims to render is rendered from the shapes
 * Kitsuden really stores (both the page-builder palette and the admin editor
 * vocabularies), plus the edge cases that used to break pages: missing
 * fields, unsafe links, unknown types, and the Inti markup that must appear
 * ONLY for an editor.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";

import { BLOCKS, RENDERED_TYPES } from "../src/blocks";
import { PALETTE } from "../src/blocks/palette";
import BlockRenderer from "../src/components/BlockRenderer.astro";
import type { BlockRow } from "../src/lib/kitsuden";
import { imageSrc, mediaUrl } from "../src/lib/media";
import { safeHref, textToHtml, videoEmbedUrl } from "../src/lib/text";

const MEDIA = "0f8fad5b-d9cb-469f-a165-70867728950e";
let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

let n = 0;
const row = (type: string, content: Record<string, unknown>): BlockRow => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  type,
  sortOrder: n,
  content,
});

const render = (blocks: BlockRow[], editable = false) =>
  container.renderToString(BlockRenderer, {
    props: { blocks, documentId: "11111111-2222-4333-8444-555555555555", editable },
  });

describe("core blocks", () => {
  it("hero (palette shape) with image, focal point and buttons", async () => {
    const html = await render([
      row("hero", {
        headline: "Welcome",
        subheadline: "Sub",
        description: "Desc",
        mediaId: MEDIA,
        focalPoint: { x: 0.2, y: 0.8 },
        primaryButton: { label: "Start", url: "/start", variant: "primary" },
        secondaryButton: { label: "Docs", url: "https://example.com/docs" },
      }),
    ]);
    expect(html).toMatch(/<h1[^>]*>Welcome<\/h1>/);
    expect(html).toContain(`/img/${MEDIA}/hero`);
    expect(html).toContain("object-position:20% 80%");
    expect(html).toContain('href="/start"');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('loading="eager"');
  });

  it("hero (admin shape: title, subtitle, ctaLabel) and only the first hero is <h1>", async () => {
    const html = await render([
      row("hero", { title: "First", ctaLabel: "Go", ctaUrl: "/go" }),
      row("hero", { title: "Second", subtitle: "S2" }),
    ]);
    expect(html).toMatch(/<h1[^>]*>First<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>Second<\/h2>/);
    expect(html).toContain('href="/go"');
  });

  it("text in html, markdown and plain", async () => {
    const html = await render([
      row("text", { text: "<p>Hello <strong>html</strong></p>", format: "html" }),
      row("text", { text: "## Title\n\n- a\n- b", format: "markdown" }),
      row("text", { text: "<b>not bold</b>\n\nsecond", format: "plain" }),
      row("richtext", { content: "**bold** text" }),
    ]);
    expect(html).toContain("<strong>html</strong>");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<li>b</li>");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain("<strong>bold</strong> text");
  });

  it("image with srcset, caption and link; gallery", async () => {
    const html = await render([
      row("image", {
        mediaId: MEDIA,
        altText: "Alt",
        caption: "Cap",
        linkUrl: "https://example.com",
        openInNewTab: true,
      }),
      row("image-gallery", {
        images: [{ url: "/media/uploads/a.webp", alt: "A" }, { url: "javascript:alert(1)" }],
        columns: 2,
      }),
    ]);
    expect(html).toContain(`/img/${MEDIA}/large`);
    expect(html).toContain(`/img/${MEDIA}/small 400w`);
    expect(html).toContain('alt="Alt"');
    expect(html).toContain("Cap</figcaption>");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('src="/media/uploads/a.webp"');
    expect(html).not.toContain("javascript:");
  });

  it("video, cards, quote, cta, embed, callout, divider, spacer, grid", async () => {
    const html = await render([
      row("video", { embedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      row("cards", {
        columns: 2,
        cards: [{ id: "a", title: "Card A", tags: ["x"], linkUrl: "/a" }, { id: "b" }],
      }),
      row("quote", { quote: "Q", author: "Ada", authorTitle: "Engineer", authorImageId: MEDIA }),
      row("cta", { title: "Ready", buttonLabel: "Go", buttonUrl: "/go", buttonVariant: "outline" }),
      row("embed", { code: "<p>embedded</p>" }),
      row("embed", { url: "https://vimeo.com/123456789", caption: "Vid" }),
      row("callout", { title: "Note", content: "Be **careful**", variant: "warning" }),
      row("divider", { style: "dashed", width: "partial" }),
      row("spacer", { height: "xl" }),
      row("grid", {
        columns: 2,
        items: [
          { id: "g1", content: { headline: "In grid" } },
          { id: "g2", content: { text: "<p>Cell</p>" } },
        ],
      }),
    ]);
    expect(html).toContain("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(html).toContain("Card A");
    expect(html).toContain('href="/a"');
    expect(html).not.toContain(">undefined<");
    expect(html).toContain("<blockquote");
    expect(html).toContain(`/img/${MEDIA}/thumbnail`);
    expect(html).toContain("button--outline");
    expect(html).toContain("<p>embedded</p>");
    expect(html).toContain("https://player.vimeo.com/video/123456789");
    expect(html).toContain('role="alert"');
    expect(html).toContain("<strong>careful</strong>");
    expect(html).toContain("divider--dashed");
    expect(html).toContain("height:5rem");
    expect(html).toMatch(/<h2[^>]*>In grid<\/h2>/);
    expect(html).toContain("<p>Cell</p>");
  });

  it("empty or broken content renders nothing instead of throwing", async () => {
    const html = await render([
      row("hero", {}),
      row("image", { mediaId: "not-a-uuid" }),
      row("cards", { cards: "oops" }),
      row("quote", { quote: 42 }),
      row("cta", { buttonLabel: "x", buttonUrl: "javascript:alert(1)" }),
      row("video", { embedUrl: "https://evil.example/video" }),
      row("grid", { items: [null, { content: "x" }] }),
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<img");
  });

  it("unknown types (kon blocks) render nothing outside dev", async () => {
    const html = await render([row("tier-list", { tiers: [] })]);
    expect(html).toContain("block--tier-list");
    expect(html).not.toContain("tiers");
  });

  it("row styling is applied only with clean values", async () => {
    const styled: BlockRow = {
      ...row("spacer", {}),
      backgroundColor: "#112233",
      padding: "lg",
      cssClass: 'one two bad"class',
    };
    const dirty: BlockRow = { ...row("spacer", {}), backgroundColor: "red;background:url(x)" };
    const html = await render([styled, dirty]);
    expect(html).toContain("--block-bg:#112233");
    expect(html).toContain("--block-pad:3rem");
    expect(html).toMatch(/class="[^"]*\bone\b[^"]*\btwo\b/);
    expect(html).not.toContain("url(x)");
  });
});

describe("Inti markup", () => {
  const blocks = () => [
    row("hero", { headline: "Edit me" }),
    row("text", { text: "plain", format: "plain" }),
  ];

  it("is absent for a visitor", async () => {
    const html = await render(blocks(), false);
    expect(html).not.toContain("data-inti-");
  });

  it("is present for an editor: block, document, index, fields and JSON", async () => {
    const rows = blocks();
    const html = await render(rows, true);
    expect(html).toContain('data-inti-block="hero"');
    expect(html).toContain(`data-inti-block-id="${rows[0].id}"`);
    expect(html).toContain('data-inti-document-id="11111111-2222-4333-8444-555555555555"');
    expect(html).toContain('data-inti-block-index="1"');
    expect(html).toContain('data-inti-block-total="2"');
    expect(html).toContain('data-inti-field="headline"');
    expect(html).toContain('data-inti-field="text"');
    expect(html).toContain(
      '<script type="application/json" data-inti-block-json>{"headline":"Edit me"}</script>'
    );
  });
});

describe("registry and palette", () => {
  it("every palette type has a component", () => {
    for (const block of PALETTE) expect(RENDERED_TYPES).toContain(block.nativeType);
  });
  it("the 12 core types of /api/page-builder/block-types are covered except custom", () => {
    const core = [
      "hero",
      "text",
      "image",
      "video",
      "grid",
      "cards",
      "quote",
      "cta",
      "embed",
      "divider",
      "spacer",
    ];
    for (const type of core) expect(RENDERED_TYPES).toContain(type);
    expect(Object.keys(BLOCKS)).not.toContain("custom");
  });
});

describe("helpers", () => {
  it("imageSrc accepts ids, API paths and https only", () => {
    expect(imageSrc(MEDIA)).toBe(`/img/${MEDIA}/large`);
    expect(imageSrc(`/api/media/preset/${MEDIA}/small`)).toBe(`/img/${MEDIA}/small`);
    expect(imageSrc("/media/uploads/x.png")).toBe("/media/uploads/x.png");
    expect(imageSrc("/media/../etc/passwd")).toBeNull();
    expect(imageSrc("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(imageSrc("http://cdn.example.com/a.png")).toBeNull();
    expect(imageSrc("data:image/png;base64,AAAA")).toBeNull();
    expect(mediaUrl("nope")).toBeNull();
  });
  it("safeHref and videoEmbedUrl", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/ok")).toBe("/ok");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(videoEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
    expect(videoEmbedUrl("https://example.com/v")).toBeNull();
  });
  it("plain text is escaped", () => {
    expect(textToHtml("<script>x</script>", "plain")).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });
});
