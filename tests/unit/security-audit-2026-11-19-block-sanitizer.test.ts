/**
 * Security audit 2026-11-19: the page-builder sanitizer.
 *
 *   · core-blocks-sanitizer-skips-nested-grid-item-content: grid items carry
 *     full block content, but only their URL keys were cleaned, so raw HTML in
 *     `items[].content.text` or `.code` reached the starter's `set:html`.
 *   · core-blocks-callout-plain-format-skips-sanitize-but-rendered-as-markdown:
 *     `format: "plain"` skipped sanitizing for every block type, while the
 *     starter renders a callout as Markdown whatever its format.
 */
import { describe, expect, it } from "vitest";

import { sanitizeBlockContent } from "../../packages/core/blocks/blocks.sanitize";

const PAYLOAD = "<img src=x onerror=alert(document.domain)>";

type Obj = Record<string, unknown>;
const items = (out: unknown) => (out as Obj).items as Obj[];
const inner = (out: unknown, i = 0) => items(out)[i]!.content as Obj;

describe("sanitizeBlockContent: grid items", () => {
  it("sanitizes HTML text in a typed grid item", () => {
    const out = sanitizeBlockContent("grid", {
      columns: 2,
      items: [{ id: "a", columnSpan: 6, type: "text", content: { text: PAYLOAD, format: "html" } }],
    });
    expect(String(inner(out).text)).not.toMatch(/onerror/i);
  });

  it("sanitizes text in an untyped grid item (guessed as text)", () => {
    const out = sanitizeBlockContent("grid", {
      columns: 2,
      items: [{ id: "a", columnSpan: 6, content: { content: `hi ${PAYLOAD}` } }],
    });
    expect(String(inner(out).content)).not.toMatch(/onerror/i);
  });

  it("reduces nested embed code with the embed rules", () => {
    const out = sanitizeBlockContent("grid", {
      columns: 2,
      items: [
        { id: "a", columnSpan: 6, content: { code: `<script>alert(1)</script>${PAYLOAD}` } },
        {
          id: "b",
          columnSpan: 6,
          type: "embed",
          content: { code: '<iframe src="https://evil.example/x"></iframe>' },
        },
      ],
    });
    expect(String(inner(out, 0).code)).not.toMatch(/<script|onerror/i);
    expect(String(inner(out, 1).code)).not.toContain("evil.example");
  });

  it("sanitizes a nested callout marked plain and grids inside grids", () => {
    const out = sanitizeBlockContent("grid", {
      items: [
        { id: "a", type: "callout", content: { content: PAYLOAD, format: "plain" } },
        {
          id: "b",
          type: "grid",
          content: { items: [{ id: "c", content: { text: PAYLOAD, format: "html" } }] },
        },
      ],
    });
    expect(String(inner(out, 0).content)).not.toMatch(/onerror/i);
    expect(String(inner(inner(out, 1)).text)).not.toMatch(/onerror/i);
  });

  it("keeps plain text of a nested text item as written (the frontend escapes it)", () => {
    const out = sanitizeBlockContent("grid", {
      items: [{ id: "a", type: "text", content: { text: "a <b> c", format: "plain" } }],
    });
    expect(inner(out).text).toBe("a <b> c");
  });

  it("keeps safe nested HTML and item metadata", () => {
    const out = sanitizeBlockContent("grid", {
      columns: 3,
      items: [
        { id: "a", columnSpan: 4, type: "text", content: { text: "<p>Hello</p>", format: "html" } },
      ],
    });
    expect((out as Obj).columns).toBe(3);
    expect(items(out)[0]).toMatchObject({ id: "a", columnSpan: 4, type: "text" });
    expect(inner(out).text).toBe("<p>Hello</p>");
  });
});

describe("sanitizeBlockContent: format plain", () => {
  it("does not let format plain skip sanitizing a callout", () => {
    const out = sanitizeBlockContent("callout", {
      title: "Note",
      content: PAYLOAD,
      format: "plain",
      variant: "info",
    }) as Obj;
    expect(String(out.content)).not.toMatch(/onerror/i);
  });

  it("still leaves plain text of text and richtext blocks alone", () => {
    expect((sanitizeBlockContent("text", { text: "a <b> c", format: "plain" }) as Obj).text).toBe(
      "a <b> c"
    );
    expect(
      (sanitizeBlockContent("richtext", { content: "x <i> y", format: "plain" }) as Obj).content
    ).toBe("x <i> y");
  });
});
