/**
 * Text helpers for block content
 * ============================================================================
 *
 * The API sanitizes the HTML and Markdown of every block when it SAVES and
 * again when it SERVES it (`packages/core/blocks/blocks.sanitize.ts`): no
 * scripts, no event handlers, no `javascript:` links. This site trusts that
 * for `set:html`, and adds two cheap guards of its own: plain text is always
 * escaped, and every link it builds itself goes through `safeHref`.
 */
import { marked } from "marked";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The HTML of a text block from its `format`:
 *
 *   html (or missing) → as served by the API (sanitized there)
 *   markdown          → rendered with `marked`
 *   plain             → escaped, one paragraph per blank line
 */
export function textToHtml(text: unknown, format: unknown): string {
  const value = str(text);
  if (!value.trim()) return "";
  if (format === "plain") {
    return value
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }
  if (format === "markdown") return marked.parse(value, { async: false, gfm: true }) as string;
  return value;
}

/** Only links a visitor can follow safely: http(s), mailto, tel, or a site path */
export function safeHref(value: unknown): string | null {
  const v = str(value).trim();
  if (!v) return null;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (v.startsWith("#")) return v;
  try {
    const url = new URL(v);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export const isExternal = (href: string): boolean => /^https?:\/\//i.test(href);

/**
 * A video URL turned into an embeddable player URL. Only YouTube and Vimeo,
 * the two providers the page builder names; anything else is not embedded.
 */
export function videoEmbedUrl(value: unknown): string | null {
  const v = str(value).trim();
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1);
  else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    id =
      url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1] ?? null;
  }
  if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const vimeo = url.pathname.match(/(\d{5,12})/)?.[1];
    if (vimeo) return `https://player.vimeo.com/video/${vimeo}`;
  }
  return null;
}
