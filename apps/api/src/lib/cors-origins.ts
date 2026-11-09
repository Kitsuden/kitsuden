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

  return (
    `ALLOWED_ORIGINS does not include the public site (${site.origin}): login and comments ` +
    `will fail there due to CORS even though the site loads fine. Sister sites go too, one per origin.`
  );
}
