/**
 * Which origins can call the API with credentials
 * ============================================================================
 *
 * Those on the fixed list (`ALLOWED_ORIGINS`: panel and public sites), and nothing else.
 *
 * Until 2026-09-21 the public site's SUBDOMAINS were also accepted,
 * because each wiki (`aniimo.<domain>`) and esports (`esports.<domain>`) lived
 * on its own. There are no subdomains now: the wiki is `/<game>/wiki/` and esports
 * `/esports/`, so they share origin with their site and the wildcard only widened
 * who is allowed to call with the session cookie.
 */

export function allowedOrigin(fixedItems: readonly string[]): (origin: string) => string | null {
  const list = new Set(fixedItems);
  return (origin: string) => (origin && list.has(origin) ? origin : null);
}

/**
 * Can the public site call itself?
 * ============================================================================
 *
 * The public site has to be on the fixed list: `example.com`.
 * It is the piece most often forgotten, and its symptom is among the worst: the site
 * loads perfectly and only login and comments fail, which is exactly what
 * nobody tests when deploying.
 *
 * Returns the warning to show at startup, or `null` if it is fine.
 */
export function incompleteCorsWarning(
  fixedItems: readonly string[],
  publicUrl: string
): string | null {
  let site: URL;
  try {
    site = new URL(publicUrl);
  } catch {
    return null; // Without the site URL there is nothing to check
  }

  if (fixedItems.includes(site.origin)) return null;

  // The origin stays out of the text: the site URL can come from the environment, which
  // stays out of logs. The site URL in Settings says which origin is meant.
  return (
    `ALLOWED_ORIGINS does not include the public site's origin (the site URL in Settings): ` +
    `login and comments will fail there due to CORS even though the site loads fine. ` +
    `Sister sites go too, one per origin.`
  );
}

/**
 * Is `origin` the API's own origin? The browser sends `Origin` on a WebSocket handshake, and a page the
 * API serves itself (kon-koe's inbox) has the API's host there. Compared with the request's `Host`
 * (which a reverse proxy keeps), never with a list, so it cannot open the door to another site.
 */
export function sameOrigin(origin: string, host: string | null | undefined): boolean {
  if (!host) return false;
  try {
    const u = new URL(origin);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}
