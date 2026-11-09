/**
 * Wiki links: page slug, `[[links]]` and their rendering
 * ============================================================================
 *
 * They used to live in the kon-wiki engine. They moved here because TWO sides
 * have to apply exactly the same rule:
 *
 *   · the server, which indexes the links on save (backlinks, "requested");
 *   · the public frontend, which renders them as `<a>` inside the subdomain.
 *
 * With a copy on each side, the day one of them changed, the frontend would
 * link to slugs the server never indexed: "requested" pages that already exist
 * and links that lead to a 404. kon-wiki re-exports them under their usual
 * names (`slugify`, `extractLinks`, `renderLinks`).
 */

import { safeMarkdown } from "./render-blocks";

// ── Slugs ────────────────────────────────────────────────────────────────────

/**
 * Title → stable slug.
 *
 * Strips accents but keeps letters: "Baldur's Gate 3" → "baldurs-gate-3",
 * "Pokémon Cards" → "pokemon-cards". The slug is the page's IDENTITY
 * — two titles that normalize the same ARE the same page, which is what
 * prevents "Long Sword" and "long sword" from being duplicated.
 */
export function wikiPageSlug(title: string): string {
  return (
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // Apostrophes are DELETED, not turned into a separator: "Baldur's
      // Gate" is `baldurs-gate`, not `baldur-s-gate`. They are everywhere in
      // game and item titles, and splitting the word gives an ugly slug
      // that also breaks prefix search.
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120)
  );
}

// ── Wiki links ───────────────────────────────────────────────────────────────

export interface WikiLink {
  /** Text as written: "Long Sword". */
  target: string;
  /** Target slug. */
  slug: string;
  /** Text to display if it differs: `[[Long Sword|the sword]]`. */
  label: string | null;
}

/**
 * Extracts the `[[links]]` from a text.
 *
 * Backlinks are computed from HERE: when a revision is saved its links are
 * indexed, and "which pages point to this one" is a query, not a crawl. A link
 * to a nonexistent page is VALID — it is the wiki mechanic of creating a page
 * by writing the link first.
 */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  const seen = new Set<string>();
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[1].trim();
    if (!target) continue;
    const slug = wikiPageSlug(target);
    if (!slug || seen.has(slug)) continue; // one backlink per page, not per mention
    seen.add(slug);
    links.push({ target, slug, label: match[2]?.trim() ?? null });
  }
  return links;
}

/** Replaces `[[links]]` with the HTML from the renderer passed in. */
export function renderWikiLinks(content: string, render: (link: WikiLink) => string): string {
  return content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (raw, target: string, label?: string) => {
      const trimmed = target.trim();
      if (!trimmed) return raw;
      return render({
        target: trimmed,
        slug: wikiPageSlug(trimmed),
        label: label?.trim() ?? null,
      });
    }
  );
}

// ── Full page ────────────────────────────────────────────────────────────────

/**
 * Content of a wiki page → HTML ready to render.
 *
 * `[[links]]` are converted to MARKDOWN links, not to a hand-written `<a>`,
 * and then everything goes through `safeMarkdown`. This is on purpose: if HTML
 * were inserted before converting, the escaping of `<` (which is what stops
 * tags from sneaking into a page anyone can edit) would break it, and removing
 * that escaping to let it through would open the door to everything else.
 *
 * `pageHref` decides the address: in the wiki's subdomain it is `/<slug>`.
 */
export function renderWikiPage(content: string, pageHref: (slug: string) => string): string {
  const withLinks = renderWikiLinks(content, (link) => {
    // Brackets in the text would break the markdown link syntax
    const text = (link.label ?? link.target).replace(/([\[\]])/g, "\$1");
    return `[${text}](${pageHref(link.slug)})`;
  });
  return safeMarkdown(withLinks);
}
