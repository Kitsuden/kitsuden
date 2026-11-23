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
import { trimChar } from "./utils";

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
  const hyphenated = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Apostrophes are DELETED, not turned into a separator: "Baldur's
    // Gate" is `baldurs-gate`, not `baldur-s-gate`. They are everywhere in
    // game and item titles, and splitting the word gives an ugly slug
    // that also breaks prefix search.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-");
  // A loop, not `/^-+|-+$/`: that regex is quadratic on a long run of '-'.
  return trimChar(hyphenated, "-").slice(0, 120);
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

interface RawWikiLink {
  start: number;
  end: number;
  target: string;
  label: string | undefined;
}

/**
 * Every `[[target]]` / `[[target|label]]` in `content`: exactly the matches of
 * `/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g`, found in linear time.
 *
 * That regex backtracks: a text with many `[[` and no closing `]]` made it rescan the
 * rest of the text from every `[[`. Here each search for `]` or `|` resumes from its
 * last result, so the text is read a bounded number of times.
 */
function scanWikiLinks(content: string): RawWikiLink[] {
  const found: RawWikiLink[] = [];
  // The first `]` / `|` at or after the last query. Queries only move forward, so a
  // cached position is still the first one while it is not behind the new query.
  let close = -2;
  let pipe = -2;
  const nextClose = (from: number): number => {
    if (close !== -1 && close < from) close = content.indexOf("]", from);
    return close;
  };
  const nextPipe = (from: number): number => {
    if (pipe !== -1 && pipe < from) pipe = content.indexOf("|", from);
    return pipe;
  };

  let from = 0;
  while (from < content.length) {
    const start = content.indexOf("[[", from);
    if (start === -1) break;
    const body = start + 2;
    const c = nextClose(body);
    const p = nextPipe(body);
    // The target runs up to the first `]` or `|`, and is not empty.
    const stop = c === -1 ? p : p === -1 ? c : Math.min(c, p);
    if (stop === -1) break; // no `]` or `|` left: nothing further can match
    if (stop > body) {
      if (stop === c) {
        if (content[c + 1] === "]") {
          found.push({ start, end: c + 2, target: content.slice(body, c), label: undefined });
          from = c + 2;
          continue;
        }
      } else {
        // After `|`, the label runs up to the next `]`, is not empty, and `]]` closes it.
        const labelEnd = nextClose(stop + 1);
        if (labelEnd > stop + 1 && content[labelEnd + 1] === "]") {
          found.push({
            start,
            end: labelEnd + 2,
            target: content.slice(body, stop),
            label: content.slice(stop + 1, labelEnd),
          });
          from = labelEnd + 2;
          continue;
        }
      }
    }
    // Every later `[[` before `stop` has a target ending at the same `stop` and fails
    // the same way, so the next possible start is `stop` itself.
    from = Math.max(start + 1, stop);
  }
  return found;
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
  for (const match of scanWikiLinks(content)) {
    const target = match.target.trim();
    if (!target) continue;
    const slug = wikiPageSlug(target);
    if (!slug || seen.has(slug)) continue; // one backlink per page, not per mention
    seen.add(slug);
    links.push({ target, slug, label: match.label?.trim() ?? null });
  }
  return links;
}

/** Replaces `[[links]]` with the HTML from the renderer passed in. */
export function renderWikiLinks(content: string, render: (link: WikiLink) => string): string {
  let out = "";
  let last = 0;
  for (const match of scanWikiLinks(content)) {
    const trimmed = match.target.trim();
    if (!trimmed) continue; // left as written
    out += content.slice(last, match.start);
    out += render({
      target: trimmed,
      slug: wikiPageSlug(trimmed),
      label: match.label?.trim() ?? null,
    });
    last = match.end;
  }
  return out + content.slice(last);
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
