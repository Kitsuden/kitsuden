/**
 * Engine fixes for the CodeQL alerts of 2026-11-22
 * ============================================================================
 *
 * - LIKE patterns and YAML strings escape the backslash too.
 * - Trailing-slash trims, Markdown headings and ```json fences no longer use
 *   regexes that turn quadratic on long runs of `/` or spaces.
 * - `htmlToText` strips markup in one pass (so `</script >` closes the block and
 *   nothing is reassembled) and decodes entities once.
 */

import { describe, expect, it } from "vitest";

import { buildContentTree } from "../../packages/engine/src/brain/content-tree";
import { createHttpEmbeddingProvider } from "../../packages/engine/src/brain/embeddings";
import { headings } from "../../packages/engine/src/brain/extraction";
import { parseHeading } from "../../packages/engine/src/brain/markdown-heading";
import { escapeYaml } from "../../packages/engine/src/brain/wiki";
import { escapeLike } from "../../packages/engine/src/like-pattern";
import { extractJson } from "../../packages/engine/src/llm/structured";
import { htmlToText } from "../../packages/engine/src/mail/templates";
import { trimTrailingSlashes } from "../../packages/engine/src/trim-slashes";

const N = 100_000;

function fast(fn: () => unknown, ms = 500): void {
  const t0 = performance.now();
  fn();
  expect(performance.now() - t0).toBeLessThan(ms);
}

describe("escapeLike", () => {
  it("escapes the escape character before the wildcards", () => {
    expect(escapeLike("50%_off")).toBe("50\\%\\_off");
    expect(escapeLike("C:\\dir")).toBe("C:\\\\dir");
    expect(escapeLike("a\\%")).toBe("a\\\\\\%");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("escapeYaml", () => {
  it("escapes backslash and quote and flattens newlines", () => {
    expect(escapeYaml('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeYaml("C:\\x")).toBe("C:\\\\x");
    // A trailing backslash can no longer swallow the closing quote.
    expect(escapeYaml('x\\"')).toBe('x\\\\\\"');
    expect(escapeYaml("a\nb")).toBe("a b");
  });
});

describe("trimTrailingSlashes", () => {
  it("removes every trailing slash and nothing else", () => {
    expect(trimTrailingSlashes("https://x.dev/v1//")).toBe("https://x.dev/v1");
    expect(trimTrailingSlashes("/api/kons/x")).toBe("/api/kons/x");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("is linear on a long run of slashes", () => {
    fast(() => trimTrailingSlashes(`a${"/".repeat(N)}b`));
    fast(() => trimTrailingSlashes("/".repeat(N)));
  });

  it("the HTTP embedding provider calls {url}/embeddings once", async () => {
    let called = "";
    const provider = createHttpEmbeddingProvider({
      url: "https://emb.example/v1///",
      model: "m",
      fetchImpl: (async (url: string) => {
        called = url;
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      }) as unknown as typeof fetch,
    });
    await provider.embed("x");
    expect(called).toBe("https://emb.example/v1/embeddings");
  });
});

describe("Markdown headings", () => {
  it("parses like the old /^(#{1,6})\\s+(.+?)\\s*$/", () => {
    expect(parseHeading("## Gear per phase  ")).toEqual({ level: 2, title: "Gear per phase" });
    expect(parseHeading("#\tTabbed")).toEqual({ level: 1, title: "Tabbed" });
    expect(parseHeading("####### seven")).toBeNull();
    expect(parseHeading("#nospace")).toBeNull();
    expect(parseHeading("plain")).toBeNull();
    expect(parseHeading("#    ")).toBeNull();
  });

  it("headings() and buildContentTree() keep their output", () => {
    const md = "# Guide\nintro\n## Phase 1 \ntext\n```\n# not a heading\n```\n### Gear\n";
    expect(headings(md)).toEqual(["Guide", "Phase 1", "not a heading", "Gear"]);
    const tree = buildContentTree(md, { sourceId: "g" });
    expect(tree.root[0].title).toBe("Guide");
    expect(tree.root[0].children[0].title).toBe("Phase 1");
    expect(tree.root[0].children[0].children[0].title).toBe("Gear");
  });

  it("is linear on a line of many spaces", () => {
    const line = `#${" ".repeat(N)}x`;
    fast(() => parseHeading(`${line}\u2028`));
    fast(() => headings(`# ${" ".repeat(N)}!\n`));
    fast(() => buildContentTree(`#${" ".repeat(N)}`, { sourceId: "s" }));
  });
});

describe("extractJson fences", () => {
  it("reads a ```json block and a bare ``` block", () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```\nbye')).toEqual({ a: 1 });
    expect(extractJson("```\n[1,2]\n``` trailing")).toEqual([1, 2]);
  });

  it("is linear on ``` followed by many spaces", () => {
    fast(() => {
      try {
        extractJson(`\`\`\`${" ".repeat(N)}x`);
      } catch {
        // no JSON: only the time matters
      }
    });
  });
});

/** The regex chain `htmlToText` used before; reference for well-formed mail HTML. */
function previousHtmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

describe("htmlToText", () => {
  it("keeps the old output for normal mail HTML", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body>" +
      "<h1>Hi &lt;Ana&gt; &amp; co</h1><p>Line one<br>line two<br/>three</p>" +
      '<a href="https://x.dev/a?b=1&amp;c=2" style="x">Sign in</a>' +
      "<table><tr><td>Plan</td><td>Pro</td></tr></table>&nbsp;&quot;q&quot; it&#39;s</body></html>";
    const text = htmlToText(html);
    expect(text).toBe(previousHtmlToText(html));
    expect(text).toContain("Hi <Ana> & co\nLine one\nline two\nthree\n");
    expect(text).toContain("Sign in (https://x.dev/a?b=1&c=2)");
  });

  it("drops script and style blocks even with odd end tags", () => {
    expect(htmlToText("a<script>alert(1)</script >b")).toBe("ab");
    expect(htmlToText("a<SCRIPT type=x>alert(1)</SCRIPT\n>b")).toBe("ab");
    expect(htmlToText("a<style>x{}</style foo>b")).toBe("ab");
    expect(htmlToText("<scr<script>x</script>ipt>alert(1)")).not.toContain("<script");
  });

  it("decodes entities once (&amp; is not decoded twice)", () => {
    expect(htmlToText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("is linear on repeated <head", () => {
    fast(() => htmlToText("<head".repeat(N / 5)));
    fast(() => htmlToText("<a href='x'".repeat(N / 10)));
    fast(() => htmlToText("</".repeat(N)));
  });
});
