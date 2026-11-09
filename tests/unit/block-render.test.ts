/**
 * The block renderer, actually executed
 * ============================================================================
 *
 * ── WHAT IT FIXES ──────────────────────────────────────────────────────────
 *
 * `blog_posts.blocks` was edited, saved, served by the API… and nobody
 * rendered it. Searching for `PageBlock` across the whole tree only showed up in
 * panel components. You added a gallery, looked at the preview and it came out
 * identical to a post without blocks — which does not read as "this is not
 * supported" but as "it has not been saved".
 *
 * ── WHY THIS TEST EXECUTES AND DOES NOT LOOK AT THE CODE ───────────────────
 *
 * The other tests in this folder guard that certain code stays written in a
 * certain way, because they guard contracts between files. This one does not:
 * here there is a pure function that transforms data into HTML, so the right
 * thing is to give it data and look at the HTML. A grep cannot tell escaping
 * from not escaping.
 *
 * What matters most are the last three cases: a renderer that emits
 * HTML from what someone wrote in an editor is, if neglected, a
 * stored XSS on every page of the blog.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderBlocks, safeUrl, escapeHtml } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

describe("blocks that render completely", () => {
  it("a gallery comes out with its images, not with a gap", () => {
    const { html, interactive } = renderBlocks([
      {
        id: "1",
        type: "image-gallery",
        order: 0,
        data: {
          layout: "grid",
          columns: 2,
          images: [
            { url: "https://example.test/a.jpg", alt: "First", caption: "Caption" },
            { url: "https://example.test/b.jpg", alt: "Second" },
          ],
        },
      },
    ]);

    expect(html).toContain('src="https://example.test/a.jpg"');
    expect(html).toContain('alt="First"');
    expect(html).toContain("<figcaption>Caption</figcaption>");
    expect(html).toContain('src="https://example.test/b.jpg"');
    expect(interactive, "a gallery does not need hydration").toEqual([]);
  });

  it("the order is dictated by `order`, not by the position in the array", () => {
    /**
     * `blocks` is jsonb: whoever writes through the API does not have to respect the
     * order of the array. If it were rendered in the received order, a post edited by
     * script would come out out of order without anything failing.
     */
    const { html } = renderBlocks([
      { id: "b", type: "callout", order: 2, data: { content: "SECOND", variant: "info" } },
      { id: "a", type: "callout", order: 1, data: { content: "FIRST", variant: "info" } },
    ]);

    expect(html.indexOf("FIRST")).toBeLessThan(html.indexOf("SECOND"));
  });

  it("a caller can replace the markdown converter", () => {
    /**
     * The option still exists for specific cases —a site with its own
     * dialect, for example— but it is NO LONGER necessary to pass it: the default
     * lives in the renderer. See the block "preview and published cannot
     * diverge": when each caller brought its own, each left a different half
     * and the result stopped matching without anything failing.
     */
    const { html } = renderBlocks(
      [{ id: "1", type: "richtext", order: 0, data: { content: "# Hello", format: "markdown" } }],
      { markdownToHtml: (md) => `<h2>${md.replace(/^# /, "")}</h2>` }
    );

    expect(html).toContain("<h2>Hello</h2>");
  });
});

describe("blocks that need the site", () => {
  it("they are emitted as a gap, declared and with their configuration", () => {
    const { html, interactive } = renderBlocks([
      {
        id: "1",
        type: "smart-grid",
        order: 0,
        data: { datasetId: "weapons", columns: ["name"], enableGrouping: false },
      },
    ]);

    expect(interactive, "the caller has to know this is a gap").toEqual(["smart-grid"]);
    expect(html).toContain('data-kitsuden-block="smart-grid"');
    expect(html, "the configuration travels so the site can hydrate").toContain("weapons");
  });

  it("they are not pretended to be rendered", () => {
    /**
     * A map with thousands of markers, zoom and layers cannot be solved with static
     * HTML. Emitting something that pretends to is worse than the gap: layout is done
     * on top of a result nobody is going to publish.
     */
    const { interactive } = renderBlocks([
      { id: "1", type: "game-map", order: 0, data: { mapSlug: "elden-ring" } },
      { id: "2", type: "tier-list", order: 1, data: { templateSlug: "patch-12" } },
      { id: "3", type: "dynamic-carousel", order: 2, data: { source: "games", limit: 5 } },
    ]);

    expect(interactive.sort()).toEqual(["dynamic-carousel", "game-map", "tier-list"]);
  });

  it("an unknown type is reported and not swallowed", () => {
    const { html, unknownAll } = renderBlocks([
      { id: "1", type: "invented-in-the-future", order: 0, data: {} },
    ]);

    expect(unknownAll).toEqual(["invented-in-the-future"]);
    expect(html, "better to render nothing than to render garbage").toBe("");
  });
});

describe("what prevents a stored XSS", () => {
  it("the data's text is escaped", () => {
    const { html } = renderBlocks([
      {
        id: "1",
        type: "hero",
        order: 0,
        data: { title: "<script>alert(1)</script>", subtitle: '" onload="alert(2)' },
      },
    ]);

    expect(html, "the script cannot come out as a tag").not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html, "nor break out of the attribute to inject a handler").not.toContain('onload="');
  });

  it("a `javascript:` in a link is dropped", () => {
    /**
     * An `href="javascript:…"` executes on click. A hero's CTA is text
     * someone types into a form, so it is exactly where it would
     * get in.
     */
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeUrl("vbscript:msgbox(1)")).toBe("");

    // And the legitimate ones still pass.
    expect(safeUrl("https://example.test/a")).toBe("https://example.test/a");
    expect(safeUrl("/blog/my-post")).toBe("/blog/my-post");
    expect(safeUrl("mailto:hello@example.test")).toBe("mailto:hello@example.test");

    const { html } = renderBlocks([
      {
        id: "1",
        type: "hero",
        order: 0,
        data: { title: "T", ctaLabel: "Click", ctaUrl: "javascript:alert(1)" },
      },
    ]);
    expect(html).not.toContain("javascript:");
  });

  it("without a sanitizer, a richtext's HTML is ESCAPED instead of emitted", () => {
    /**
     * It is the module's most important design decision: whoever forgets to pass
     * the sanitizer gets ugly content, not an XSS on every page. It
     * fails on the safe side.
     */
    const { html } = renderBlocks([
      {
        id: "1",
        type: "richtext",
        order: 0,
        data: { content: '<img src=x onerror="alert(1)">', format: "html" },
      },
    ]);

    /**
     * The property that matters is NOT that the string "onerror" does not appear: it is
     * that NO tag is created from the input. Here it comes out as
     * text inside a <pre>, with the < > and the quotes escaped, so
     * the browser has no element to hang a handler on.
     */
    expect(html, "an img tag cannot be built").not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html, "escaped quotes prevent closing the attribute").toContain("&quot;");
  });

  it("with a sanitizer, the sanitizer is used", () => {
    const { html } = renderBlocks(
      [
        {
          id: "1",
          type: "richtext",
          order: 0,
          data: { content: "<b>bold</b><script>bad()</script>", format: "html" },
        },
      ],
      { sanitizeHtml: (h) => h.replace(/<script[\s\S]*?<\/script>/gi, "") }
    );

    expect(html).toContain("<b>bold</b>");
    expect(html).not.toContain("bad()");
  });

  it("escapeHtml covers the five that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

describe("preview and published cannot diverge", () => {
  const ROOT = join(__dirname, "..", "..");
  const API = join(ROOT, "packages", "kons", "kon-blog", "src", "routes.ts");
  const PANEL = join(ROOT, "packages", "admin", "src", "lib", "components", "LivePreview.svelte");

  /**
   * ── THE FAILURE THIS PREVENTS ─────────────────────────────────────────────
   *
   * The renderer was born with the options in the hands of each caller. Each one
   * left a different half out:
   *
   *     API   : { sanitizeHtml }        → markdown not converted
   *     Panel : { markdownToHtml }     → markdown converted
   *
   * Measured on the same block:
   *
   *     API   : <div class="ks-richtext"><pre># Hello</pre></div>
   *     Panel : <div class="ks-richtext"><h1>Hello</h1></div>
   *
   * The preview showed a heading and the site published the raw markdown.
   * Nothing failed. It is exactly what the module existed to prevent, and it
   * crept in because "remembering to pass the same thing in two files" is not a
   * guarantee, it is an intention.
   *
   * The solution was not to pass the same options: it was that there be no
   * options to pass. This test guards that.
   */
  it("no caller passes its own options", () => {
    for (const [name, route] of [
      ["the API", API],
      ["the panel", PANEL],
    ] as const) {
      const source = readFileSync(route, "utf-8");
      const calls = [...source.matchAll(/renderBlocks\(([^)]*)\)/g)];

      expect(calls.length, `the call was not found in ${name}`).toBeGreaterThan(0);

      for (const call of calls) {
        expect(
          call[1].includes("{"),
          `${name} passes options to renderBlocks. As soon as the two sides ` +
            `pass different options, the preview stops showing what is ` +
            `going to be published — and nothing fails, so nobody finds out. The ` +
            `defaults live in the renderer precisely for this.`
        ).toBe(false);
      }
    }
  });

  it("markdown is converted by default, without anyone asking", () => {
    const { html } = renderBlocks([
      { id: "1", type: "richtext", order: 0, data: { content: "# Hello", format: "markdown" } },
    ]);

    expect(html, "passing nothing, the markdown has to be converted").toContain("<h1");
    expect(html).not.toContain("<pre># Hello</pre>");
  });

  it("default markdown does not let tags through", () => {
    /**
     * `marked` does NOT sanitize —since v5 it has no `sanitize` option— and markdown
     * admits inline HTML. Without escaping first, a `<script>` written in the
     * post body would come out as is on every page where it appears.
     */
    const { html } = renderBlocks([
      {
        id: "1",
        type: "richtext",
        order: 0,
        data: { content: "text <script>alert(1)</script> more text", format: "markdown" },
      },
    ]);

    expect(html, "the tag cannot be formed").not.toContain("<script");
    expect(html).toContain("&lt;script");
  });

  it("markdown quotes keep working", () => {
    /**
     * Only the `<` is escaped. Escaping the `>` too would neutralize quotes,
     * which in markdown start right there — the security fix
     * would have taken a normal editor function with it.
     */
    const { html } = renderBlocks([
      { id: "1", type: "richtext", order: 0, data: { content: "> a quote", format: "markdown" } },
    ]);

    expect(html).toContain("<blockquote");
  });
});

describe("edge cases that cannot blow up", () => {
  it("an empty or missing list gives empty HTML", () => {
    expect(renderBlocks([]).html).toBe("");
    expect(renderBlocks(null).html).toBe("");
    expect(renderBlocks(undefined).html).toBe("");
  });

  it("a block without `data` does not break the render", () => {
    /**
     * The column is jsonb and nothing in the database forces each
     * block to carry `data`. An old post, or one written through the API, may not have
     * it — and if that throws, the whole post stops being served.
     */
    expect(() =>
      renderBlocks([
        { id: "1", type: "hero", order: 0 },
        { id: "2", type: "divider", order: 1 },
        { id: "3", type: "image-gallery", order: 2 },
      ])
    ).not.toThrow();
  });
});

describe('the "Facebook Group" block', () => {
  const paint = (data: Record<string, unknown>) =>
    renderBlocks([{ id: "fb", type: "facebook-group", order: 0, data }]).html;

  it("it is a card with a link: no iframe or Facebook script", () => {
    const html = paint({ url: "https://www.facebook.com/groups/example" });
    expect(html).toContain('href="https://www.facebook.com/groups/example"');
    expect(html).toContain("Join the group");
    expect(html).not.toMatch(/<iframe|<script/i);
    expect(html).toContain('rel="noopener"');
  });

  it("uses the title, text and button it is given, escaped", () => {
    const html = paint({
      url: "https://facebook.com/groups/123",
      title: "Builds <b>in a group</b>",
      description: "Questions & tips",
      ctaLabel: "Log in",
    });
    expect(html).toContain("Builds &lt;b&gt;in a group&lt;/b&gt;");
    expect(html).toContain("Questions &amp; tips");
    expect(html).toContain(">Log in<");
  });

  it("only accepts facebook.com links: no other sites or dangerous schemes", () => {
    for (const url of [
      "https://evil.example/groups/1",
      "https://facebook.com.evil.example/groups/1",
      "javascript:alert(1)",
      "http://facebook.com/groups/1",
      "",
    ]) {
      expect(paint({ url }), url).toBe("");
    }
  });
});
