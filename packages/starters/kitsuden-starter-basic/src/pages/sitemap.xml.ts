/**
 * sitemap.xml, built on request from the API
 * ============================================================================
 *
 * `@astrojs/sitemap` is not used: with `output: "server"` it only sees the
 * static routes, so it would list `/` and `/blog` and none of the content.
 * Here the URLs come from the published pages and posts, with their real
 * `lastmod`, against `SITE_URL` (Astro's `site`).
 */
import type { APIRoute } from "astro";

import type { Post } from "../lib/kitsuden";
import { site as settings } from "../lib/site";

const MAX_POSTS = 1000;

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isoDate = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const GET: APIRoute = async ({ locals, site, url }) => {
  const base = site ?? new URL(url.origin);
  const { kitsuden } = locals;

  const pages = await kitsuden.pages.list(100);
  const posts: Post[] = [];
  let hasBlog = false;
  for (let page = 1; posts.length < MAX_POSTS; page++) {
    const list = await kitsuden.posts.list({ page, limit: 100, locale: settings.locale });
    if (!list) break;
    hasBlog = true;
    posts.push(...list.docs);
    if (!list.hasNextPage) break;
  }

  const entries: { loc: string; lastmod?: string | null }[] = [
    { loc: "/", lastmod: isoDate(pages.find((p) => p.isHomepage || p.slug === "home")?.updatedAt) },
    ...pages
      .filter((p) => !p.isHomepage && p.slug !== "home")
      .map((p) => ({ loc: `/${p.slug}`, lastmod: isoDate(p.updatedAt) })),
    ...(hasBlog ? [{ loc: "/blog", lastmod: isoDate(posts[0]?.publishedAt) }] : []),
    ...posts.map((p) => ({
      loc: `/blog/${p.slug}`,
      lastmod: isoDate(p.updatedAt ?? p.publishedAt),
    })),
  ];

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries
      .map(
        (e) =>
          `  <url><loc>${escapeXml(new URL(e.loc, base).href)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
};
