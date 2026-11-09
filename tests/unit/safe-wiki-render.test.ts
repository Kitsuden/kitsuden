/**
 * Wiki pages in the frontend: links that resolve and nothing that executes
 * ============================================================================
 *
 * A wiki page is edited by ANY session and served on its subdomain.
 * What is pinned down here are the two promises of `renderWikiPage`:
 *
 *   1. `[[Link]]` leads to the same slug the server indexes on save —
 *      which is why the link engine lives in `@kitsuden/shared` and is not copied.
 *   2. Neither smuggled HTML nor `javascript:` in a markdown link reaches the
 *      page. `marked` has not sanitized by itself since version 5.
 */

import { describe, expect, it } from "vitest";

import { extractWikiLinks, safeMarkdown, renderWikiPage } from "../../packages/shared/src/index";

const toRoot = (slug: string) => `/${slug}`;

describe("[[links]] in the public page", () => {
  it("they point to the same slug the server indexes", () => {
    const content = "See [[Long Sword]] and [[Baldur's Gate 3]].";
    const html = renderWikiPage(content, toRoot);

    for (const link of extractWikiLinks(content)) {
      expect(html).toContain(`href="/${link.slug}"`);
    }
    expect(html).toContain('href="/baldurs-gate-3"');
  });

  it("they use the alternate label when there is one", () => {
    const html = renderWikiPage("[[Long Sword|the sword]]", toRoot);
    expect(html).toContain('<a href="/long-sword">the sword</a>');
  });

  it("brackets in the text do not break the link", () => {
    const html = renderWikiPage("[[Weapons|Weapons [T1]]]", toRoot);
    expect(html).toContain('href="/weapons"');
  });
});

describe("nothing executable reaches the page", () => {
  it("HTML written in the page comes out as text", () => {
    const html = renderWikiPage('<script>alert(1)</script><img src=x onerror="alert(1)">', toRoot);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]+onerror/i);
  });

  it("a markdown link to javascript: stays as text", () => {
    /**
     * This was the gap: escaping `<` does not touch markdown syntax, and `marked`
     * turned this into an `<a href="javascript:…">` that executed on click.
     */
    const html = renderWikiPage("[click](javascript:alert(1))", toRoot);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain("click");
  });

  it("neither data: nor vbscript: get through, not even in images", () => {
    const html = safeMarkdown(
      "[a](data:text/html,<b>x</b>) [b](vbscript:msgbox) ![c](javascript:alert(1))"
    );
    expect(html).not.toMatch(/(href|src)="(data|vbscript|javascript):/i);
  });

  it("normal links keep working", () => {
    const html = safeMarkdown(
      "[web](https://kitsuden.gg) and [internal](/weapons) ![logo](/logo.png)"
    );
    expect(html).toContain('<a href="https://kitsuden.gg">web</a>');
    expect(html).toContain('<a href="/weapons">internal</a>');
    expect(html).toContain('<img src="/logo.png" alt="logo">');
  });

  it("quotes stay quotes (the > is not escaped)", () => {
    expect(safeMarkdown("> a quote")).toContain("<blockquote>");
  });
});
