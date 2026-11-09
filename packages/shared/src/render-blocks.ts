/**
 * Blocks → HTML. ONE renderer, two consumers.
 * ============================================================================
 *
 * ── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
 *
 * `blog_posts.blocks` was edited, saved and served by the API… and NOBODY
 * rendered it. Searching for `PageBlock` across the whole tree only turned up
 * panel components: the block builder produced data that no page could
 * show. From the editor it looked like this:
 *
 *   · you add a gallery in the "Blocks" tab
 *   · you look at the preview
 *   · it comes out exactly like a post without blocks
 *
 * Which does not read as "the preview does not support them" but as "it was not
 * saved".
 *
 * ── WHY IT LIVES IN `shared` ───────────────────────────────────────────────
 *
 * Because there has to be ONLY ONE. If the panel draws the preview with its
 * renderer and the public site with another, the preview stops being a
 * preview: it shows something nobody is going to publish. `@kitsuden/shared` is the
 * only package that both the panel and `kon-blog` depend on.
 *
 * ── WHAT CANNOT BE RENDERED STATICALLY ─────────────────────────────────────
 *
 * Six of the thirteen blocks are interactive or query live data: a
 * map with thousands of markers, a grid over a dataset, a carousel that
 * asks for the most recent games. That is NOT solved with static HTML,
 * and pretending it is is worse than not doing it: layout would be built on a
 * false result.
 *
 * For those a container is emitted with `data-kitsuden-block` and its configuration
 * in JSON, for the site to hydrate, plus a readable fallback content.
 * Each one is listed in the result's `interactive` so that whoever renders knows that what they
 * see is a gap and not the result.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 *
 * All user data is escaped. The only point where HTML can get in is
 * a `richtext` block with `format: "html"`, and there an INJECTED sanitizer
 * is needed: without it the HTML is escaped and shows as text. It fails on the
 * safe side on purpose — whoever forgets to pass the sanitizer gets ugly content,
 * not a stored XSS on every blog page.
 */

import { Marked } from "marked";

import { readBlockData } from "./block-keys";

/** A block exactly as the editor stores it in the `blocks` column. */
export interface ContentBlock {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  order?: number;
}

export interface RenderOptions {
  /**
   * Markdown → HTML. **It does not need to be passed**: there is a default.
   *
   * ── WHY THERE IS A DEFAULT AND IT IS NOT REQUIRED OF THE CALLER ──────────
   *
   * Because when each caller brought its own, each one left out a different
   * half and the result diverged SILENTLY. Measured:
   *
   *     API   : <div class="ks-richtext"><pre># Hello</pre></div>
   *     Panel : <div class="ks-richtext"><h1>Hello</h1></div>
   *
   * The preview showed a heading and the site published the raw markdown. Nothing
   * fails, nothing warns, and the editor makes decisions about something that
   * will not be published — which is exactly what this module existed to
   * prevent.
   *
   * A shared default turns "remember to pass the same thing in both
   * places" into "there is nothing to pass".
   */
  markdownToHtml?: (md: string) => string;

  /**
   * Sanitizes foreign HTML. Without it, the HTML is ESCAPED.
   *
   * It is not a convenience: `richtext` with `format: "html"` is text that someone
   * wrote and that will end up on a public page. Emitting it raw is a stored
   * XSS.
   *
   * NO caller passes one today, and that is deliberate: the blog's sanitizer
   * (`sanitizeHTML`) needs `DOMParser`, which in the API runtime DOES NOT
   * EXIST —verified in the container: `typeof DOMParser === "undefined"`—,
   * so there it fell back to stripping all tags while the panel
   * escaped them. Two behaviors for the same data.
   *
   * Until there is a sanitizer that works the same on server and browser, the
   * HTML is escaped in both places. It looks ugly and looks the SAME.
   */
  sanitizeHtml?: (html: string) => string;

  /**
   * Prefix of the CSS classes. The site and the panel lay things out differently and this way they do not
   * step on each other.
   */
  prefix?: string;
}

export interface RenderResult {
  html: string;
  /** Types that were emitted as a gap to hydrate, without repeats. */
  interactive: string[];
  /** Types this renderer does not know. */
  unknownAll: string[];
}

/** Escapes for text and for attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A URL that can be put in `href`/`src` without opening a hole.
 *
 * `javascript:`, `data:` and `vbscript:` in an `href` execute code on click.
 * Relative ones and those with a known scheme pass; the rest are discarded and leave the
 * attribute empty.
 */
export function safeUrl(value: unknown): string {
  const url = String(value ?? "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  // Relative and anchors: they cannot carry a scheme, so they execute nothing.
  if (/^[/#?]/.test(url)) return url;
  return "";
}

/**
 * Default Markdown → HTML. The API and the panel use it, so it is the same one.
 *
 * ── WHY `<` IS ESCAPED BEFORE CONVERTING ───────────────────────────────────
 *
 * `marked` does NOT sanitize: since version 5 it has no `sanitize` option, and markdown
 * allows inline HTML, so a `<script>` written in the body would come out as is
 * on every page where the block appears.
 *
 * ONLY the `<` is escaped. It is just enough so that no tag ever gets
 * formed, and it leaves the rest of the syntax intact — in particular the `>` of
 * quotes, which would stop working if it were escaped too.
 */
function defaultMarkdown(md: string): string {
  return safeMarkdown(md);
}

/**
 * ── AND LINKS TOO ──────────────────────────────────────────────────────────
 *
 * Escaping the `<` prevents a tag from being formed, but it does not touch markdown
 * syntax: `[click](javascript:alert(1))` came out as an `<a>` with that href
 * and executed on click. Here `href`/`src` go through `safeUrl`: anything
 * that is not http(s), mailto, tel or relative stays as text, with no link.
 *
 * It matters more in the wiki than in blocks: a block is written by an editor,
 * a wiki page by any session.
 */
const markdownWithSafeLinks = new Marked({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const secure = safeUrl(href);
      if (!secure) return text;
      const titleValue = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(secure)}"${titleValue}>${text}</a>`;
    },
    image({ href, title, text }) {
      const secure = safeUrl(href);
      if (!secure) return escapeHtml(text);
      const titleValue = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(secure)}" alt="${escapeHtml(text)}"${titleValue}>`;
    },
  },
});

/** Markdown → HTML with no injectable tags and no links that execute code. */
export function safeMarkdown(md: string): string {
  return markdownWithSafeLinks.parse(md.replace(/</g, "&lt;"), { async: false }) as string;
}

const ASPECT_RATIO: Record<string, string> = {
  "16:9": "56.25%",
  "4:3": "75%",
  "1:1": "100%",
};

/**
 * Blocks that CANNOT be drawn statically.
 * ============================================================================
 *
 * Each one declares TWO texts, and the distinction is the fix for a real bug:
 *
 *   · `label` — what a PERSON sees. It appears on the public page when the
 *     site has not yet hydrated the block, and search engines and screen
 *     readers read it too.
 *   · `because` — what whoever PROGRAMS the frontend reads. It explains why this
 *     cannot be served as static HTML.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 *
 * Before there was a single text and the programmer's one was drawn, where
 * the visitor reads it:
 *
 *     tier-list — References a kon-tierlist template; its rows live in that
 *     table.
 *
 * That came out in the middle of a published article, with the block identifier
 * in bold and a sentence about database tables. Whoever does not hydrate —or whose
 * script fails— publishes internal jargon to their readers.
 *
 * The note is not lost: it travels as an HTML comment, which is where
 * whoever is looking at the source code to implement hydration will look for it.
 */
interface InteractiveBlock {
  /** For the reader. Short, human, no identifiers. */
  label: string;
  /** For whoever programs the frontend. It is not drawn. */
  because: string;
}

const INTERACTIVE: Record<string, InteractiveBlock> = {
  "tier-list": {
    label: "Tier list",
    because: "References a kon-tierlist template; its rows live in that table.",
  },
  "character-builder": {
    label: "Character builder",
    because:
      "kon-builder application: the reader configures, the engine calculates and returns a code.",
  },
  comments: {
    label: "Comments",
    because: "kon-comments thread: it is read with the reader's session and changes when replying.",
  },
  "game-map": {
    label: "Map",
    because: "Map with markers: needs zoom, layers and clustering on the client.",
  },
  "dynamic-carousel": {
    label: "Carousel",
    because: "Queries live games or streamers every time it is drawn.",
  },
  "smart-filter": {
    label: "Filters",
    because: "Filters the reader operates; without JavaScript they filter nothing.",
  },
  "smart-grid": {
    label: "Grid",
    because: "Grid over a dataset, with sorting and grouping on the client.",
  },
  "comparison-slider": {
    label: "Image comparison",
    because: "The slider is interaction; without it they are two loose images.",
  },
  "habitat-map": {
    label: "Habitat map",
    because:
      "Reads a dataset and groups its rows by region; the reader filters and switches region.",
  },
  "stat-compare": {
    label: "Comparator",
    because: "The reader chooses which dataset rows to compare; the stats are read live.",
  },
  "event-search": {
    label: "Event finder",
    because:
      "The reader types and the list is filtered on the client over the rows the page already carries.",
  },
  "race-planner": {
    label: "Race calendar",
    because:
      "The reader chooses a shift and filters; the calendar is assembled on the client from the dataset's rows.",
  },
  affinity: {
    label: "Affinity calculator",
    because:
      "The reader chooses the trained one, parents and grandparents; kinship points are added up on the client.",
  },
  dex: {
    label: "Index with cards",
    because:
      "Filters and sorts a dataset's rows on the client; each card composes several datasets.",
  },
  "card-browser": {
    label: "Card catalog",
    because:
      "The reader searches and filters; a catalog of thousands of cards is paginated against the API, it does not fit on the page.",
  },
  "deck-builder": {
    label: "Deck builder",
    because:
      "Each change to the deck is validated against the game's rules, and the test hand is dealt on click.",
  },
  "deck-showcase": {
    label: "Deck showcase",
    because: 'The gallery is sorted and filtered live, and the "like" writes.',
  },
  deck: {
    label: "Meta deck",
    because:
      "It only references an archetype or a list by its id: its cards and its share are read when drawn, so the article does not go stale with a copy inside.",
  },
};

/**
 * Safe text inside an HTML comment.
 *
 * A `--` closes the comment early and the rest of the note would
 * become markup. The notes are our own literals and today carry none,
 * but that is a property of this file today, not a guarantee.
 */
function secureNote(text: string): string {
  return text.replace(/-{2,}/g, "-").replace(/>/g, "");
}

/** Container for the site to hydrate what cannot be resolved here. */
function gap(
  type: string,
  data: Record<string, unknown>,
  prefix: string,
  interior: string
): string {
  const config = escapeHtml(JSON.stringify(data ?? {}));
  return (
    `<div class="${prefix}block ${prefix}block--${escapeHtml(type)}" ` +
    `data-kitsuden-block="${escapeHtml(type)}" data-kitsuden-config="${config}">` +
    interior +
    `</div>`
  );
}

/**
 * Seconds from a YouTube `t=`: `90`, `1m30s`, `1h2m3s`.
 *
 * All three forms are accepted because all three come from YouTube itself depending on
 * where you click "share", and whoever pastes a link with a timestamp expects
 * the video to start there.
 */
function secondsOf(t: string | null): number | null {
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);

  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;

  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * The URL that CAN be put in an `<iframe>`.
 *
 * ── WHY IT IS NEEDED ───────────────────────────────────────────────────────
 *
 * A normal YouTube link CANNOT be embedded. Verified with `curl`:
 *
 *     GET https://www.youtube.com/watch?v=…    X-Frame-Options: SAMEORIGIN
 *     GET https://www.youtube.com/embed/…      (no X-Frame-Options)
 *
 * That is: the "Embed" block accepted the URL anyone copies from the browser
 * bar —its own placeholder said `youtube.com/watch?v=…`—
 * and the result was a BLANK FRAME. No error, no warning: the block
 * saved fine and there was no video on the page.
 *
 * Fixing it here and not in the editor has a reason: that way blocks ALREADY SAVED
 * with the bad URL work too, without touching them one by one.
 *
 * What it does not recognize is returned as is: some services do accept their
 * normal URL, and over-guessing would break the ones that work today.
 */
export function embedUrl(value: unknown): string {
  const url = safeUrl(value);
  if (!url) return "";

  let u: URL;
  try {
    u = new URL(url, "https://example.invalid");
  } catch {
    return url;
  }

  const host = u.hostname.replace(/^www\./, "");

  // ── YouTube ───────────────────────────────────────────────────────────────
  const isYouTube = host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  const isNoCookie = host === "youtube-nocookie.com";

  if (isYouTube || isNoCookie) {
    let id: string | null = null;

    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0] || null;
    } else if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else {
      // `/embed/ID`, `/shorts/ID`, `/live/ID`, `/v/ID`
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      id = m ? m[1] : null;
    }

    if (!id || !/^[\w-]{6,20}$/.test(id)) return url;

    // The domain is kept: whoever put `-nocookie` there on purpose does not want us
    // to change it to the normal one.
    const domain = isNoCookie ? "www.youtube-nocookie.com" : "www.youtube.com";
    const target = new URL(`https://${domain}/embed/${id}`);

    const start = secondsOf(u.searchParams.get("t") ?? u.searchParams.get("start"));
    if (start) target.searchParams.set("start", String(start));

    // A playlist is still valid in the embed.
    const list = u.searchParams.get("list");
    if (list) target.searchParams.set("list", list);

    return target.toString();
  }

  // ── Vimeo ─────────────────────────────────────────────────────────────────
  if (host === "vimeo.com") {
    const m = u.pathname.match(/^\/(\d+)/);
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
  }

  /**
   * Twitch is left out ON PURPOSE: its player requires a `parent`
   * parameter with the domain it is served from, and that is not known here —the
   * same content can be published on several domains—. Getting it wrong gives a
   * blank frame, which is exactly what this exists to avoid. The
   * site resolves it when hydrating, like the other interactive blocks.
   */

  return url;
}

/** The live embed of each platform. `null` if not recognized. */
function streamerUrl(platform: string, channel: string): string | null {
  const c = encodeURIComponent(channel);
  switch (platform) {
    case "twitch":
      // Twitch requires `parent`; the site sets it when hydrating, here the
      // channel is left identified and the container ready.
      return `https://player.twitch.tv/?channel=${c}`;
    case "youtube":
      return `https://www.youtube.com/embed/live_stream?channel=${c}`;
    case "kick":
      return `https://player.kick.com/${c}`;
    default:
      return null;
  }
}

/**
 * Draws a list of blocks.
 *
 * Sorts by `order` because the array can arrive in any order: it is jsonb,
 * and whoever writes it through the API need not respect the position.
 */
export function renderBlocks(
  blocks: ContentBlock[] | null | undefined,
  options: RenderOptions = {}
): RenderResult {
  const prefix = options.prefix ?? "ks-";
  const interactive = new Set<string>();
  const unknownAll = new Set<string>();

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { html: "", interactive: [], unknownAll: [] };
  }

  const sortedItems = [...blocks].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));

  const parts = sortedItems.map((block) => {
    const type = String(block?.type ?? "");
    // Data a 0.8 writer left with Spanish keys (`titulo`…) still renders: see block-keys.ts.
    // Remove in 0.10 (back to `block?.data ?? {}`).
    const d = readBlockData(type, block?.data ?? {}) as Record<string, any>;

    switch (type) {
      // ── Truly static ───────────────────────────────────────────────────────
      case "hero": {
        const background = safeUrl(d.imageUrl);
        const overlay =
          d.overlay === "none" ? "" : ` ${prefix}hero--${escapeHtml(d.overlay ?? "dark")}`;
        const buttons = [
          d.ctaLabel && safeUrl(d.ctaUrl)
            ? `<a class="${prefix}cta" href="${escapeHtml(safeUrl(d.ctaUrl))}">${escapeHtml(d.ctaLabel)}</a>`
            : "",
          d.ctaSecondaryLabel && safeUrl(d.ctaSecondaryUrl)
            ? `<a class="${prefix}cta ${prefix}cta--sec" href="${escapeHtml(safeUrl(d.ctaSecondaryUrl))}">${escapeHtml(d.ctaSecondaryLabel)}</a>`
            : "",
        ].join("");

        return (
          `<section class="${prefix}hero${overlay}"` +
          (background ? ` style="background-image:url('${escapeHtml(background)}')"` : "") +
          `>` +
          `<h2>${escapeHtml(d.title)}</h2>` +
          (d.subtitle ? `<p>${escapeHtml(d.subtitle)}</p>` : "") +
          (buttons ? `<div class="${prefix}hero-ctas">${buttons}</div>` : "") +
          `</section>`
        );
      }

      case "richtext": {
        const text = String(d.content ?? "");
        if (!text) return "";

        if (d.format === "html") {
          // Without a sanitizer NO HTML is emitted. See the security note above.
          const secure = options.sanitizeHtml
            ? options.sanitizeHtml(text)
            : `<pre>${escapeHtml(text)}</pre>`;
          return `<div class="${prefix}richtext">${secure}</div>`;
        }

        const html = (options.markdownToHtml ?? defaultMarkdown)(text);
        return `<div class="${prefix}richtext">${html}</div>`;
      }

      case "image-gallery": {
        const images = Array.isArray(d.images) ? d.images : [];
        if (images.length === 0) {
          return `<div class="${prefix}gallery ${prefix}vacio">Gallery with no images</div>`;
        }
        const columns = Number(d.columns) > 0 ? Number(d.columns) : 3;
        const cells = images
          .map((img: any) => {
            const src = safeUrl(img?.url);
            if (!src) return "";
            return (
              `<figure>` +
              `<img src="${escapeHtml(src)}" alt="${escapeHtml(img?.alt ?? "")}" loading="lazy">` +
              (img?.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : "") +
              `</figure>`
            );
          })
          .join("");

        return (
          `<div class="${prefix}gallery ${prefix}gallery--${escapeHtml(d.layout ?? "grid")}" ` +
          `style="--ks-cols:${columns}">${cells}</div>`
        );
      }

      case "embed": {
        // `embedUrl` and not plain `safeUrl`: a normal
        // YouTube link cannot be put in an iframe and comes out blank.
        const src = embedUrl(d.url);
        if (!src) return "";
        const paddingBottom = ASPECT_RATIO[String(d.aspectRatio ?? "16:9")] ?? "56.25%";
        return (
          `<figure class="${prefix}embed">` +
          `<div style="position:relative;padding-bottom:${paddingBottom};height:0;overflow:hidden">` +
          `<iframe src="${escapeHtml(src)}" loading="lazy" allowfullscreen ` +
          `style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>` +
          `</div>` +
          (d.caption ? `<figcaption>${escapeHtml(d.caption)}</figcaption>` : "") +
          `</figure>`
        );
      }

      case "callout": {
        const variant = escapeHtml(d.variant ?? "info");
        return (
          `<aside class="${prefix}callout ${prefix}callout--${variant}">` +
          (d.title ? `<p class="${prefix}callout-title">${escapeHtml(d.title)}</p>` : "") +
          `<p>${escapeHtml(d.content)}</p>` +
          `</aside>`
        );
      }

      case "facebook-group": {
        // A card with a link, not an iframe: Facebook no longer allows embedding groups and its
        // script would load cookies and tracking without anyone clicking. Only facebook.com links.
        const href = safeUrl(d.url);
        if (!/^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[^\s"'<>]+$/i.test(href)) return "";
        const title = String(d.title ?? "").trim() || "Join our Facebook group";
        const text =
          String(d.description ?? "").trim() ||
          "Share your builds, get your questions answered and chat with the community.";
        const button = String(d.ctaLabel ?? "").trim() || "Join the group";
        return (
          `<aside class="${prefix}facebook-group" style="display:flex;flex-wrap:wrap;align-items:center;gap:16px;` +
          `margin:24px 0;padding:18px 20px;border-radius:16px;border:1px solid rgba(24,119,242,.35);background:rgba(24,119,242,.08)">` +
          `<span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;` +
          `border-radius:999px;background:#1877f2;color:#fff;flex:none">` +
          `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z"/></svg></span>` +
          `<div style="flex:1 1 240px;min-width:0">` +
          `<p style="margin:0;font-weight:700;font-size:1.05rem">${escapeHtml(title)}</p>` +
          `<p style="margin:4px 0 0;opacity:.75;font-size:.9rem;line-height:1.5">${escapeHtml(text)}</p></div>` +
          `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 20px;` +
          `border-radius:6px;background:#1877f2;color:#fff;font-weight:600;font-size:.9rem;text-decoration:none">${escapeHtml(button)}</a>` +
          `</aside>`
        );
      }

      case "divider": {
        const style = escapeHtml(d.style ?? "line");
        return style === "space"
          ? `<div class="${prefix}espacio"></div>`
          : `<hr class="${prefix}divider ${prefix}divider--${style}">`;
      }

      case "streamer-widget": {
        // This one CAN be drawn: it is a platform iframe.
        const src = streamerUrl(String(d.platform ?? ""), String(d.channelName ?? ""));
        if (!src) {
          unknownAll.add(`streamer-widget:${d.platform}`);
          return "";
        }
        return (
          `<div class="${prefix}streamer" data-kitsuden-block="streamer-widget" ` +
          `data-kitsuden-config="${escapeHtml(JSON.stringify(d))}">` +
          `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden">` +
          `<iframe src="${escapeHtml(src)}" allowfullscreen ` +
          `style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>` +
          `</div></div>`
        );
      }

      // ── Those that need hydrating ─────────────────────────────────────────
      default: {
        if (type in INTERACTIVE) {
          interactive.add(type);

          /**
           * What whoever does not hydrate sees: search engines, screen readers, a
           * `curl` — and the reader, if the script fails. The block is named in
           * human terms; an empty div reads as a layout failure, and the
           * identifier with a sentence about tables reads as a leak of internal
           * jargon, which is what it was.
           */
          const reservation =
            `<p class="${prefix}reserva">${escapeHtml(INTERACTIVE[type].label)}</p>` +
            // The technical explanation remains available where whoever is going to
            // implement hydration looks for it: the source code.
            `<!-- kitsuden: ${secureNote(INTERACTIVE[type].because)} -->`;

          // The comparison one can at least show its two images.
          if (type === "comparison-slider") {
            const before = safeUrl(d.beforeImageUrl);
            const after = safeUrl(d.afterImageUrl);
            const figures =
              before && after
                ? `<figure><img src="${escapeHtml(before)}" alt="${escapeHtml(d.beforeLabel ?? "before")}" loading="lazy"><figcaption>${escapeHtml(d.beforeLabel ?? "Before")}</figcaption></figure>` +
                  `<figure><img src="${escapeHtml(after)}" alt="${escapeHtml(d.afterLabel ?? "after")}" loading="lazy"><figcaption>${escapeHtml(d.afterLabel ?? "After")}</figcaption></figure>`
                : reservation;
            return gap(type, d, prefix, figures);
          }

          return gap(type, d, prefix, reservation);
        }

        unknownAll.add(type);
        return "";
      }
    }
  });

  return {
    html: parts.filter(Boolean).join("\n"),
    interactive: [...interactive],
    unknownAll: [...unknownAll],
  };
}

/** The types this renderer knows how to draw fully. */
export const STATIC_TYPES = [
  "hero",
  "richtext",
  "image-gallery",
  "embed",
  "callout",
  "facebook-group",
  "divider",
  "streamer-widget",
] as const;

/** Those emitted as a gap to hydrate. */
export const INTERACTIVE_TYPES = Object.keys(INTERACTIVE);
