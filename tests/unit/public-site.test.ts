/**
 * Public site addresses: everything on a route, games at /<game>/
 * ============================================================================
 *
 * These functions are used by kon-games when creating the game, kon-wiki when creating the
 * wiki and the frontend when serving them, and that is why they live in `@kitsuden/shared`.
 * There are no subdomains anymore: the wiki is `/<game>/wiki/` and its
 * slug is only its name in the API.
 */

import { describe, expect, it } from "vitest";

import {
  invalidGameSlugReason,
  invalidWikiSlugReason,
  gameSlug,
  readReservedSegments,
  effectiveSiteName,
  RESERVED_SITE_SEGMENTS,
  DEFAULT_PUBLIC_URL,
  effectivePublicUrl,
} from "../../packages/shared/src/public-site";
import * as shared from "../../packages/shared/src/public-site";

describe("a wiki's slug", () => {
  it("accepts a normal slug", () => {
    expect(invalidWikiSlugReason("throne-and-liberty")).toBeNull();
    expect(invalidWikiSlugReason("d4")).toBeNull();
  });

  it("rejects what is malformed and says why", () => {
    expect(invalidWikiSlugReason("")).toMatch(/empty/);
    expect(invalidWikiSlugReason("-weapons")).toMatch(/hyphen/);
    expect(invalidWikiSlugReason("weapons--extra")).toMatch(/hyphen/);
    expect(invalidWikiSlugReason("Weapons")).toMatch(/lowercase/);
    expect(invalidWikiSlugReason("a.b")).toMatch(/lowercase/);
    expect(invalidWikiSlugReason("a".repeat(64))).toMatch(/63/);
  });

  it("there are no subdomain rules anymore: neither reserved ones nor a wiki URL", () => {
    // A wiki is called whatever it likes: its address comes from its GAME
    expect(invalidWikiSlugReason("admin")).toBeNull();
    for (const removed of [
      "wikiUrl",
      "wikiLabelFromHost",
      "RESERVED_SUBDOMAINS",
      "seccionDesdeHost",
      "sectionUrl",
    ]) {
      expect(removed in shared, removed).toBe(false);
    }
  });
});

describe("games at /<game>/", () => {
  it("a game cannot be named like a site route", () => {
    /**
     * Fixed routes win: a `blog` game would not give an error, simply nobody
     * would ever reach it.
     */
    for (const route of ["blog", "games", "api", "data", "wiki", "img", "media", "legal"]) {
      expect(invalidGameSlugReason(route)).toMatch(/site route/);
    }
  });

  it("the routes of ONE site are not in the core: they are passed in (KITSUDEN_RESERVED_SEGMENTS)", () => {
    // Before, the common list carried the sections of particular sites
    // (a shop, a guild, a tournaments page…): on any other installation they were
    // slugs forbidden for no reason.
    for (const own of ["my-site", "gachas", "tcg", "my-shop", "guild", "esports", "tournaments"]) {
      expect(RESERVED_SITE_SEGMENTS.has(own), own).toBe(false);
      expect(invalidGameSlugReason(own)).toBeNull();
    }
    const ownValues = readReservedSegments(" Tournaments, shop ,,");
    expect([...ownValues]).toEqual(["tournaments", "shop"]);
    expect(invalidGameSlugReason("tournaments", ownValues)).toMatch(/site route/);
    expect(invalidGameSlugReason("throne-and-liberty", ownValues)).toBeNull();
    expect(readReservedSegments(undefined).size).toBe(0);
  });

  it("the internal routes of the subdomains are no longer reserved: they no longer exist", () => {
    expect(RESERVED_SITE_SEGMENTS.has("wiki-host")).toBe(false);
    expect(RESERVED_SITE_SEGMENTS.has("esports-host")).toBe(false);
  });

  it("accepts a normal slug and rejects malformed ones", () => {
    expect(invalidGameSlugReason("throne-and-liberty")).toBeNull();
    expect(invalidGameSlugReason("-throne")).toMatch(/hyphens/);
    expect(invalidGameSlugReason("throne--liberty")).toMatch(/hyphens/);
    expect(invalidGameSlugReason("Throne")).toMatch(/lowercase/);
  });

  it("the automatic slug leaves no stray hyphens and does not delete accents", () => {
    // The previous one gave `-pok-mon-` for «¡Pokémon!»
    expect(gameSlug("¡Pokémon!")).toBe("pokemon");
    expect(gameSlug("Baldur's Gate 3")).toBe("baldurs-gate-3");
    expect(invalidGameSlugReason(gameSlug("  Throne and Liberty  "))).toBeNull();
  });
});

describe("which public URL wins: panel, environment or development", () => {
  it("the panel wins when someone wrote it", () => {
    expect(effectivePublicUrl("https://kitsuden.gg", "https://other.gg")).toBe(
      "https://kitsuden.gg"
    );
  });

  it("the column's default value does NOT count as chosen", () => {
    /**
     * The column is born with localhost:4321 in every database. If it won, a
     * deployment with SITE_URL set correctly would announce the site on localhost.
     */
    expect(effectivePublicUrl(DEFAULT_PUBLIC_URL, "https://kitsuden.gg")).toBe(
      "https://kitsuden.gg"
    );
  });

  it("an empty or misspelled panel value falls back to the environment", () => {
    expect(effectivePublicUrl("", "https://kitsuden.gg")).toBe("https://kitsuden.gg");
    expect(effectivePublicUrl("kitsuden dot gg", "https://kitsuden.gg")).toBe(
      "https://kitsuden.gg"
    );
    expect(effectivePublicUrl("javascript:alert(1)", "https://kitsuden.gg")).toBe(
      "https://kitsuden.gg"
    );
  });

  it("with nothing useful anywhere, the development one", () => {
    expect(effectivePublicUrl(null, undefined)).toBe(DEFAULT_PUBLIC_URL);
  });

  it("removes the trailing slash so as not to generate `//blog`", () => {
    expect(effectivePublicUrl("https://kitsuden.gg/", null)).toBe("https://kitsuden.gg");
  });
});

describe("public site name", () => {
  it("the panel's wins when someone wrote it", () => {
    expect(effectiveSiteName("My site", "Other")).toBe("My site");
  });

  it("the CMS name does not count as chosen", () => {
    // A freshly installed site cannot present itself as «Kitsuden»
    expect(effectiveSiteName("Kitsuden", "My site")).toBe("My site");
    expect(effectiveSiteName("Kitsuden CMS", "My site")).toBe("My site");
  });

  it("empty or only spaces falls back to the deployment's", () => {
    expect(effectiveSiteName("   ", "My site")).toBe("My site");
    expect(effectiveSiteName(null, undefined)).toBe("Kitsuden");
  });
});
