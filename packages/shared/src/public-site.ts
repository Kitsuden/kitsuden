/**
 * Public site addresses
 * ============================================================================
 *
 * EVERYTHING is path-based, inside the domain of its website:
 *
 *   1. A game lives in the first segment: `<domain>/<game>/`, and everything
 *      about it hangs from there, its wiki included (`/<game>/wiki/`).
 *   2. So do the site's sections: `/esports/`, `/tournaments`, `/wikis`…
 *
 * Previously each wiki (`<wiki>.<domain>`) and esports
 * (`esports.<domain>`) had their own subdomain. A subdomain is another origin:
 * it shares neither session nor `localStorage`, it has to be registered in CORS and
 * the search engine treats it almost as another site. They were removed so that everything counts toward a
 * single domain.
 *
 * That is why what remains here is about PATHS: which first segment cannot be
 * a game, what a valid slug looks like and which public URL wins. kon-games uses it
 * when creating a game and the frontend when serving it; with a copy on each side,
 * the panel would end up accepting a game that the site cannot open.
 *
 * Everything is pure: no network, no environment. The caller passes the public URL.
 */

// ─── Wikis ────────────────────────────────────────────────────────────────

/** Wiki slug: lowercase letters and digits separated by single hyphens. */
const WIKI_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why a slug is NOT valid for a wiki, or `null` if it is.
 *
 * A wiki's slug is no longer an address (the address comes from its game:
 * `/<game>/wiki/`), but its name in the API: `/api/wiki/wikis/<slug>`. That is
 * why it is enough for it to be a clean slug. It returns the reason instead of a
 * boolean because the wiki creator shows it as is.
 */
export function invalidWikiSlugReason(slug: string): string | null {
  if (typeof slug !== "string" || slug.length === 0) return "The slug is empty.";
  if (slug.length > 63) return "The slug cannot exceed 63 characters.";
  if (!WIKI_SLUG.test(slug)) {
    return "Only lowercase letters, numbers and single hyphens, with no hyphen at the start or end.";
  }
  return null;
}

// ─── Games in the first segment ───────────────────────────────────────────

/**
 * First path segments a game cannot occupy.
 *
 * The frontend serves each game at `/<slug>/`, and fixed routes beat
 * dynamic ones: a game with the slug `blog` would NOT raise an error — it is just that nobody
 * would ever reach it, because `/blog/` is the blog. That is why it is prevented when creating
 * the game, which is the only moment when anyone can do something
 * about it.
 *
 * Only the routes that ANY site built with Kitsuden has go here (those
 * of the starters, those of Astro and the web's conventions). Each site's own
 * pages (`/tournaments`, `/shop`…) belong to that site: they are
 * declared in the API with `KITSUDEN_RESERVED_SEGMENTS` (comma-separated
 * list, see `readReservedSegments`) and the frontend passes its own to
 * `invalidGameSlugReason`.
 */
export const RESERVED_SITE_SEGMENTS: ReadonlySet<string> = new Set([
  "academy",
  "api",
  "blog",
  "data",
  "games",
  "share",
  "wiki",
  "admin",
  "login",
  "logout",
  "register",
  "search",
  "feed",
  "rss",
  "sitemap",
  "robots",
  "favicon",
  "_astro",
  "_image",
  "_app",
  "_actions",
  "_server-islands",
  // Images and media served by the site itself (kitsuden-starter-basic)
  "img",
  "media",
  /**
   * `/legal` and its documents: a game called `legal` would cover the legal notice
   * and the privacy policy, the pages the law requires to be findable.
   */
  "legal",
  /**
   * The sitemap and `robots.txt`. `sitemap` really takes up a segment
   * (`/sitemap/<section>.xml`), so a game with that slug would cover it; the
   * other two contain a dot and could not be a slug, but are reserved anyway
   * so that the check for "every top-level page" is complete.
   */
  "sitemap-index.xml",
  "robots.txt",
]);

/**
 * Reserved segments of ONE site, from a comma-separated list (the API's
 * `KITSUDEN_RESERVED_SEGMENTS` variable). Ignores whitespace,
 * uppercase and empty entries.
 */
export function readReservedSegments(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Game slug: lowercase letters and digits separated by single hyphens. */
const GAME_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why a slug is NOT valid for a game, or `null` if it is.
 *
 * `ownValues` are the reserved segments of the specific site (in addition to
 * `SITE_RESERVED_SEGMENTS`, which apply to everyone).
 */
export function invalidGameSlugReason(
  slug: string,
  ownValues: Iterable<string> = []
): string | null {
  if (typeof slug !== "string" || slug.length === 0) return "The slug is empty.";
  if (slug.length > 120) return "The slug cannot exceed 120 characters.";
  if (!GAME_SLUG.test(slug)) {
    return "The slug only allows lowercase letters, numbers and single hyphens between words.";
  }
  if (RESERVED_SITE_SEGMENTS.has(slug) || new Set(ownValues).has(slug)) {
    return `«${slug}» is a site route: the game would be unreachable at /${slug}/.`;
  }
  return null;
}

/**
 * Game slug from a title.
 *
 * The previous one (`toLowerCase().replace(/[^a-z0-9]+/g, "-")`) left hyphens at
 * the ends and deleted accented letters: "¡Pokémon!" gave `-pok-mon-`.
 */
export function gameSlug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

// ─── Which public URL wins ────────────────────────────────────────────────

/**
 * The default value of `site_settings.site_url`. It exists in ALL
 * installations even if nobody wrote it, so it cannot be treated as
 * a decision by whoever administers.
 */
export const DEFAULT_PUBLIC_URL = "http://localhost:4321";

/**
 * The effective public URL: the panel's (General settings → Site URL) if
 * someone wrote it, otherwise the environment's, and otherwise the development one.
 *
 * The panel wins because it is where people change it. But the column is born with
 * `http://localhost:4321` in every database: if that value always won, a
 * deployment with `SITE_URL` set correctly and the panel untouched would announce the
 * site at `localhost`. That is why the default value does NOT count as chosen,
 * and neither does anything that is not an http(s) URL: a typo in the panel
 * cannot take down the addresses.
 *
 * It is used by the API and the frontend. If each side prioritized differently, changing
 * the domain in the panel would leave one of the two with the old one.
 */
export function effectivePublicUrl(
  ofThePanel: string | null | undefined,
  ofTheEnvironment: string | null | undefined
): string {
  const valid = (value: string | null | undefined): string | null => {
    const clean = value?.trim();
    if (!clean) return null;
    try {
      const url = new URL(clean);
      return url.protocol === "http:" || url.protocol === "https:"
        ? clean.replace(/\/+$/, "")
        : null;
    } catch {
      return null;
    }
  };

  const panel = valid(ofThePanel);
  if (panel && panel !== DEFAULT_PUBLIC_URL) return panel;

  return valid(ofTheEnvironment) ?? DEFAULT_PUBLIC_URL;
}

// ─── Name of the public site ──────────────────────────────────────────────

/**
 * Values `site_settings.site_name` is born with (the column's and the one the
 * panel form wrote when left empty). Same as with the
 * URL: being in the database does not mean someone chose it.
 */
export const DEFAULT_SITE_NAMES: ReadonlySet<string> = new Set(["Kitsuden", "Kitsuden CMS"]);

/**
 * The name the visitor sees: the panel's (General settings → Site
 * Name) if someone wrote it; otherwise, whatever the deployment brings.
 *
 * "Kitsuden" is the CMS, not the site. If the default value won, a
 * freshly installed site would introduce itself to its visitors with the name of the software
 * that runs it.
 */
export function effectiveSiteName(
  ofThePanel: string | null | undefined,
  ofTheEnvironment: string | null | undefined
): string {
  const panel = ofThePanel?.trim();
  if (panel && !DEFAULT_SITE_NAMES.has(panel)) return panel;

  const environment = ofTheEnvironment?.trim();
  return environment || "Kitsuden";
}
