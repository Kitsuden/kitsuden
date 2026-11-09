import type { APIRoute } from "astro";

/** Everything is public but the Inti write endpoints; the sitemap is announced against SITE_URL */
export const GET: APIRoute = ({ site, url }) => {
  const sitemap = new URL("/sitemap.xml", site ?? url.origin).href;
  return new Response(`User-agent: *\nAllow: /\nDisallow: /_actions/\n\nSitemap: ${sitemap}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
