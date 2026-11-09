/**
 * Page builder: sanitizing block content
 * ============================================================================
 *
 * The first half is a LITERAL COPY of kon-blog's `kons/kon-blog/src/sanitize.ts` in the
 * kitsuden-kons repository (from "Tags that are kept" to `sanitizeUrlsOf`). It is duplicated because a
 * core kon cannot import from a domain kon and `@kitsuden/shared`
 * belongs to another area; its natural home is `shared`. The test
 * `tests/unit/sec-blog-sanitize.test.ts` in kitsuden-kons checks that the two copies are still
 * identical, so they cannot drift apart unnoticed.
 *
 * Why it is needed: pages are written by the team and by the Inti token
 * (`content:edit`), and rendered by a frontend with its own HTML. A `text`
 * block in HTML/markdown, an `embed` or a `javascript:` URL in a button was
 * stored code that ran for every visitor. See the long note in the blog
 * copy.
 */

// ── COPY of kon-blog/src/sanitize.ts: do not edit here without editing there ──
/** Tags that are kept. */
const TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
]);

/** Tags that are removed together with EVERYTHING inside them. */
const WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "textarea",
  "title",
  "xmp",
  "plaintext",
  "svg",
  "math",
  "select",
  "option",
  "head",
]);

/** Attributes that are kept on any allowed tag. */
const ATTRIBUTES = new Set([
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "alt",
  "loading",
  "decoding",
  "width",
  "height",
  "colspan",
  "rowspan",
  "scope",
  "start",
  "reversed",
  "datetime",
  "open",
  "target",
  "rel",
]);

/** Attributes that carry a URL: only allowlisted schemes or relative URLs (`dangerousTarget`). */
const URL_ATTRIBUTES = new Set(["href", "src", "cite"]);

/** Text of a node: what the browser would read as markup, escaped. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]{0,31};|#[0-9]{1,7};|#x[0-9a-fA-F]{1,6};)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const RE_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function cleanAttributes(rawItems: string): string {
  let output = "";
  const seen = new Set<string>();
  for (const m of rawItems.matchAll(RE_ATTRIBUTE)) {
    const name = m[1]!.toLowerCase();
    if (seen.has(name)) continue;
    const value = m[2] ?? m[3] ?? m[4];

    let clean: string | null = null;
    if (URL_ATTRIBUTES.has(name)) {
      // Allowlist of schemes (http, https, mailto, tel) or relative; with
      // entities and whitespace decoded before checking (`&#106;avascript:`).
      const url = (value ?? "").trim();
      if (url && !dangerousTarget(url)) clean = url;
    } else if (
      ATTRIBUTES.has(name) ||
      /^aria-[a-z-]+$/.test(name) ||
      /^data-[a-z0-9-]+$/.test(name)
    ) {
      clean = value ?? "";
    }

    if (clean === null) continue;
    seen.add(name);
    output += value === undefined ? ` ${name}` : ` ${name}="${escapeAttribute(clean)}"`;
  }
  return output;
}

// ── Internal markers ────────────────────────────────────────────────────────
//
// Sanitizing sets aside already-clean pieces with a control marker (NUL) that is
// REMOVED from the input first, so nobody can forge it. The
// expressions that look for it are built from the constant
// instead of writing `\u0000` inside a /…/ literal: `no-control-regex` forbids it
// (rightly so in general: it is almost always a mistake) and here the control
// character is exactly what is being looked for. To remove it, `replaceAll` is enough.
const NULL_VALUE = String.fromCharCode(0);
const RE_SECTION = new RegExp(`${NULL_VALUE}(\\d+)${NULL_VALUE}`, "g");

/**
 * Removes the C0 control characters (U+0000–U+001F), the space and the
 * backslash: browsers ignore them inside a scheme (`java\tscript:`),
 * so the comparison is made without them. Equivalent to the regex class
 * "U+0000 to U+0020 plus the backslash" that used to be here.
 */
function withoutControlsOrBlanks(text: string): string {
  let output = "";
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x20 && ch !== "\\") output += ch;
  }
  return output;
}

/**
 * HTML (or markdown with HTML inside) → the same with only what is allowed.
 *
 * Idempotent: sanitizing twice gives the same as once. What is not
 * a tag (`a < b`, `<3`) is left as it is.
 */
export function sanitizeHtml(input: unknown): string {
  if (typeof input !== "string" || input === "") return typeof input === "string" ? input : "";

  let html = input
    // The null character is used below as a marker; in a text it renders nothing.
    .replaceAll(NULL_VALUE, "")
    // Comments, CDATA and declarations: nothing to show and an easy hiding place.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, "")
    .replace(/<![^>]*>?/g, "")
    .replace(/<\?[^>]*>?/g, "");

  // Removed, along with whatever they contain. Without a closing tag, up to the end: an unclosed `<script>`
  // is just the same to the browser.
  for (const tag of WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, "gi");
    html = html.replace(re, "");
    html = html.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), "");
  }

  // Markdown autolinks (`<https://…>`, `<a@b.c>`). They are NOT kept
  // raw: to the browser `<x@x/onfocus=…>` and `<https://x/onfocus=…>` ARE
  // tags (the `/` ends the name) with an event handler, and setting them aside
  // as they were let them out of the allowlist (XSS, earlier audit). They are
  // rewritten as an `<a>` built here, with the destination escaped: the same
  // link and nothing more. Those with another scheme (`<javascript:…>`) fall through below.
  const sections: string[] = [];
  const setAside = (chunk: string) => {
    sections.push(chunk);
    return `\u0000${sections.length - 1}\u0000`;
  };
  html = html.replace(
    /<((?:https?|mailto):[^\s<>"'`]+|[^\s<>@"'`/=]+@[^\s<>@"'`/=]+)>/gi,
    (_t, inside: string) => {
      const target = /^(?:https?|mailto):/i.test(inside) ? inside : `mailto:${inside}`;
      return setAside(`<a href="${escapeAttribute(target)}">${escapeText(inside)}</a>`);
    }
  );

  // Each tag, rebuilt from the allowlist.
  html = html.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_all, closing: string, rawName: string, rest: string) => {
      const name = rawName.toLowerCase();
      if (!TAGS.has(name)) return "";
      if (closing) return setAside(`</${name}>`);
      const autocierre = /\/\s*$/.test(rest);
      return setAside(
        `<${name}${cleanAttributes(rest.replace(/\/\s*$/, ""))}${autocierre ? " /" : ""}>`
      );
    }
  );

  // A `<` that still opens something (a tag without `>`) is neutralized.
  html = html.replace(/<(?=[a-zA-Z/!?])/g, "&lt;");

  return html.replace(RE_SECTION, (_t, i: string) => sections[Number(i)] ?? "");
}

/**
 * Markdown: the HTML inside it, sanitized, and also the link
 * and image destinations with a scheme that is not on the allowlist, voided.
 *
 * `marked` does not sanitize destinations: `[x](javascript:alert(1))` comes out as `<a>`.
 */
export function sanitizeMarkdown(input: unknown): string {
  if (typeof input !== "string") return "";
  return (
    sanitizeHtml(input)
      // [text](destination …) and ![alt](destination …)
      .replace(/(\]\(\s*<?)([^)\s>]*)/g, (everything, pre: string, target: string) =>
        dangerousTarget(target) ? `${pre}#` : everything
      )
      // Reference definitions: [id]: destination
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*<?)(\S*)/gm, (everything, pre: string, target: string) =>
        dangerousTarget(target) ? `${pre}#` : everything
      )
  );
}

/** Code → character; out of range (which would make `fromCodePoint` throw), a blank. */
function character(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/** Does it carry a scheme that is not one of the allowed ones? (entities and blanks included) */
function dangerousTarget(target: string): boolean {
  const normal = withoutControlsOrBlanks(
    target
      .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => character(parseInt(h, 16)))
      .replace(/&#([0-9]+);?/g, (_, d: string) => character(Number(d)))
      .replace(/&colon;/gi, ":")
      .replace(/&tab;|&newline;/gi, "")
  ).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/.test(normal)) return false; // relative: does not execute
  return !/^(https?|mailto|tel):/.test(normal);
}

/**
 * Walks a block value and voids dangerous URLs in keys that are URLs
 * (`url`, `ctaUrl`, `href`, `linkUrl`, `src`, `image`…). The web renders those
 * fields as `href`/`src` without going through the shared renderer.
 */
const URL_KEY = /(url|href|src|link)$/i;

function sanitizeUrlsOf(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeUrlsOf(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && URL_KEY.test(key) && dangerousTarget(v.trim())) {
      output[key] = "";
    } else {
      output[key] = sanitizeUrlsOf(v, depth + 1);
    }
  }
  return output;
}
// ── END OF THE COPY ──────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// SPECIFIC TO PAGES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hosts whose `<iframe>`s are accepted in an `embed` block. An embed is
 * HTML on purpose, but what really gets embedded are players; a
 * `<script>` or an iframe from just any site is not one.
 */
const HOSTS_INCRUSTABLES = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
  "player.twitch.tv",
  "clips.twitch.tv",
  "open.spotify.com",
  "www.google.com",
  "maps.google.com",
  "docs.google.com",
  "w.soundcloud.com",
]);

const IFRAME_ATTRIBUTES = new Set([
  "width",
  "height",
  "title",
  "allow",
  "allowfullscreen",
  "loading",
  "referrerpolicy",
  "frameborder",
]);

/** `embed.code`: only iframes from the hosts above; the rest, as sanitized HTML. */
const IFRAME_MARK = String.fromCharCode(1);
const RE_IFRAME = new RegExp(`${IFRAME_MARK}(\\d+)${IFRAME_MARK}`, "g");

export function sanitizeEmbed(code: unknown): string {
  if (typeof code !== "string") return "";
  const iframes: string[] = [];
  // `\u0001` is the marker below: kept out of the input so it cannot be forged.
  const withoutIframes = code
    .replaceAll(IFRAME_MARK, "")
    .replace(
      /<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*)>(?:[\s\S]*?<\/iframe\s*>)?/gi,
      (_t, attrs: string) => {
        let src = "";
        let rest = "";
        for (const m of attrs.matchAll(RE_ATTRIBUTE)) {
          const name = m[1]!.toLowerCase();
          const value = m[2] ?? m[3] ?? m[4];
          if (name === "src") src = value ?? "";
          else if (IFRAME_ATTRIBUTES.has(name)) {
            rest += value === undefined ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`;
          }
        }
        let host = "";
        try {
          const u = new URL(src);
          if (u.protocol === "https:") host = u.hostname.toLowerCase();
        } catch {
          host = "";
        }
        if (!HOSTS_INCRUSTABLES.has(host)) return "";
        iframes.push(`<iframe src="${escapeAttribute(src)}"${rest}></iframe>`);
        return `\u0001${iframes.length - 1}\u0001`;
      }
    );
  return sanitizeHtml(withoutIframes).replace(
    RE_IFRAME,
    (_t, i: string) => iframes[Number(i)] ?? ""
  );
}

/**
 * The `content` of a page block, ready to save or serve.
 *
 *   · `text`/`richtext`: `text`/`content` according to its `format` (html, markdown;
 *     `plain` is left alone, the frontend escapes it).
 *   · `embed`: `code` with `sanitizeEmbed`.
 *   · Any block: URLs in URL keys (`url`, `buttonUrl`,
 *     `linkUrl`, `embedUrl`…) with a dangerous scheme, emptied.
 */
export function sanitizeBlockContent(type: unknown, content: unknown): unknown {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return sanitizeUrlsOf(content);
  }
  const c = sanitizeUrlsOf(content) as Record<string, unknown>;
  const format = c.format;
  for (const key of ["text", "content", "html", "body"]) {
    const v = c[key];
    if (typeof v !== "string") continue;
    if (type === "embed") continue;
    if (format === "plain") continue;
    c[key] = format === "html" || key === "html" ? sanitizeHtml(v) : sanitizeMarkdown(v);
  }
  if (type === "embed" && typeof c.code === "string") c.code = sanitizeEmbed(c.code);
  return c;
}

/**
 * Classes and colors of a block or page: they go into `class="…"` and `style="…"` on
 * the frontend. What Tailwind writes (`md:p-4`, `bg-[#111]`,
 * `w-1/2`) and CSS colors are accepted; no quotes, `<`, `;` or `{`.
 */
const RE_CLASSES = /^[\w\s:/.\-[\]#%()!,]*$/;
const RE_COLOR = /^[#\w\s(),.%-]*$/;

export function invalidStyle(fields: Record<string, unknown>): string | null {
  for (const key of ["cssClass"]) {
    const v = fields[key];
    if (
      v !== undefined &&
      v !== null &&
      (typeof v !== "string" || !RE_CLASSES.test(v) || v.length > 200)
    ) {
      return `\`${key}\` only accepts classes`;
    }
  }
  for (const key of ["backgroundColor", "textColor", "padding"]) {
    const v = fields[key];
    if (
      v !== undefined &&
      v !== null &&
      (typeof v !== "string" || !RE_COLOR.test(v) || v.length > 50)
    ) {
      return `\`${key}\` is not a valid value`;
    }
  }
  return null;
}

/**
 * `customCss` of a page: CSS, not a way to close the `<style>` and open
 * a `<script>` (`</style><script>…`), nor to load outside stylesheets
 * or behaviors.
 */
export function invalidCss(css: unknown): string | null {
  if (css === undefined || css === null) return null;
  if (typeof css !== "string") return "`customCss` must be text";
  if (css.length > 50_000) return "`customCss` is too long";
  if (/<|@import|javascript:|expression\s*\(|behavior\s*:|-moz-binding/i.test(css)) {
    return "`customCss` contains something that is not presentation CSS (`<`, `@import`, `javascript:`…)";
  }
  return null;
}
