/**
 * CodeQL alerts of 2026-11-22 in shared, sdk, testing, core/blocks and create-kitsuden
 * ============================================================================
 *
 * Polynomial regexes replaced with index loops and a linear `[[link]]` scanner, the
 * prototype guard of the SDK's toon decoder, console-safe server text, the iframe
 * extraction that repeats until nothing changes, and the mock cache's `*` patterns.
 * Each rewrite keeps the old output for normal input; the long inputs below took
 * seconds (or minutes) with the old regexes.
 */

import { describe, expect, it } from "vitest";

import { sanitizeBlockContent } from "../../packages/core/blocks/blocks.sanitize";
import { instanceFromName } from "../../packages/create-kitsuden/src/index.mjs";
import { logSafe } from "../../packages/sdk/src/realtime";
import { decodeToonProtocol } from "../../packages/sdk/src/toon-protocol";
import {
  effectivePublicUrl,
  extractWikiLinks,
  gameSlug,
  renderWikiLinks,
  wikiPageSlug,
} from "../../packages/shared/src/index";
import { createTestContext } from "../../packages/testing/src/context";

const OLD_LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** What the old regex-based `renderWikiLinks` produced. */
function oldRender(content: string): string {
  return content.replace(OLD_LINK, (raw, target: string, label?: string) => {
    const trimmed = target.trim();
    if (!trimmed) return raw;
    return `<${trimmed}|${label?.trim() ?? "-"}>`;
  });
}

const newRender = (content: string) =>
  renderWikiLinks(content, (l) => `<${l.target}|${l.label ?? "-"}>`);

/** Deterministic pseudo-random text over the characters that matter to the parser. */
function randomTexts(count: number): string[] {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  const alphabet = ["[", "]", "|", "a", "b", " ", "[[", "]]", "-", "\n"];
  return Array.from({ length: count }, () => {
    const length = next() % 40;
    return Array.from({ length }, () => alphabet[next() % alphabet.length]).join("");
  });
}

describe("[[links]] scanner", () => {
  it("matches the old regex on thousands of random texts", () => {
    for (const text of randomTexts(5000)) {
      expect(newRender(text), JSON.stringify(text)).toBe(oldRender(text));
    }
  });

  it("keeps the usual cases", () => {
    expect(extractWikiLinks("See [[Long Sword|the sword]] and [[Bow]] and [[Bow]].")).toEqual([
      { target: "Long Sword", slug: "long-sword", label: "the sword" },
      { target: "Bow", slug: "bow", label: null },
    ]);
    expect(newRender("[[a|b|c]] [[|x]] [[ ]] [[x]")).toBe(oldRender("[[a|b|c]] [[|x]] [[ ]] [[x]"));
  });

  it("is linear on many [[ with no closing", () => {
    for (const text of [
      "[[".repeat(50_000),
      `[[${"[[\\".repeat(50_000)}`,
      `[[a|${"[[b|".repeat(50_000)}`,
      `${"[[a]".repeat(50_000)}`,
    ]) {
      const t0 = performance.now();
      expect(extractWikiLinks(text)).toEqual([]);
      newRender(text);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});

describe("slugs and URL trims without quadratic regexes", () => {
  const long = `a${"-".repeat(100_000)}!`;

  it("keeps the old slugs", () => {
    expect(wikiPageSlug("Baldur's Gate 3")).toBe("baldurs-gate-3");
    expect(wikiPageSlug("--Pokémon Cards--")).toBe("pokemon-cards");
    expect(gameSlug("¡Pokémon!")).toBe("pokemon");
    expect(gameSlug(`${"x".repeat(119)} y`)).toBe("x".repeat(119));
    expect(effectivePublicUrl("https://example.com///", null)).toBe("https://example.com");
  });

  it("is fast on long runs of '-' and '/'", () => {
    const t0 = performance.now();
    expect(wikiPageSlug(long)).toBe("a");
    expect(gameSlug(long)).toBe("a");
    expect(instanceFromName(long)).toBe("a");
    expect(effectivePublicUrl(`https://example.com/${"/".repeat(100_000)}x`, null)).toContain(
      "example.com"
    );
    expect(effectivePublicUrl(`https://example.com${"/".repeat(100_000)}`, null)).toBe(
      "https://example.com"
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("create-kitsuden keeps its instance names", () => {
    expect(instanceFromName("My App!")).toBe("my-app");
    expect(instanceFromName("--x")).toBe("x");
    expect(instanceFromName("***")).toBe("kitsuden");
  });
});

describe("SDK", () => {
  it("toon decoding never writes through __proto__, constructor or prototype", () => {
    for (const path of ["__proto__.polluted", "constructor.prototype.polluted", "a.__proto__.x"]) {
      decodeToonProtocol({ json: { a: {} }, meta: { [path]: "NaN" } });
      decodeToonProtocol({ json: { a: {} }, refs: { [path]: "a" } });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // Normal paths still work
    expect(decodeToonProtocol({ json: { a: { n: null } }, meta: { "a.n": "NaN" } })).toEqual({
      a: { n: NaN },
    });
  });

  it("server text reaches the console as one capped line", () => {
    expect(logSafe("bad\nFAKE LOG LINE\r x")).toBe("bad FAKE LOG LINE  x");
    expect(logSafe("y".repeat(10_000)).length).toBeLessThanOrEqual(501);
    expect(logSafe(undefined)).toBe("");
  });
});

describe("embed iframes", () => {
  const embed = (code: string) =>
    (sanitizeBlockContent("embed", { code }) as { code: string }).code;

  it("leaves no iframe when removing one joins the text into another", () => {
    const out = embed(`<ifr<iframe src="https://evil.example/">ame src="https://evil.example/">`);
    expect(out.toLowerCase()).not.toContain("<iframe");
  });

  it("keeps an allowed iframe as before", () => {
    expect(embed(`<iframe src="https://www.youtube.com/embed/x" width="1"></iframe>`)).toBe(
      `<iframe src="https://www.youtube.com/embed/x" width="1"></iframe>`
    );
  });
});

describe("@kitsuden/testing cache.invalidate", () => {
  it("treats every * as a wildcard, not only the first", async () => {
    const ctx = (await createTestContext("codeql")) as unknown as {
      cache: {
        get: (k: string) => Promise<unknown>;
        set: (k: string, v: unknown) => Promise<void>;
        invalidate: (p: string) => Promise<void>;
      };
    };
    await ctx.cache.set("games:1:list", 1);
    await ctx.cache.set("games:2:detail", 2);
    await ctx.cache.set("posts:1:list", 3);
    await ctx.cache.invalidate("games:*:list");
    expect(await ctx.cache.get("games:1:list")).toBeNull();
    expect(await ctx.cache.get("games:2:detail")).toBe(2);
    await ctx.cache.invalidate("*:*:list");
    expect(await ctx.cache.get("posts:1:list")).toBeNull();
    await ctx.cache.invalidate("games");
    expect(await ctx.cache.get("games:2:detail")).toBeNull();
  });
});
