/**
 * Where the user lands after clicking the link in an authentication email
 * ============================================================================
 *
 * better-auth builds the verification link as
 *
 *     <API>/api/auth/verify-email?token=…&callbackURL=<destination>
 *
 * and, if the sign-up carries no `callbackURL`, uses `/`. A relative path is resolved
 * against the API —which is where the link is—, so whoever confirmed their email
 * ended up at the API root (a JSON) and not in the panel. The same goes for the
 * `?callbackURL=` of the password reset link.
 *
 * This function rewrites that parameter BEFORE the link goes out in the
 * email:
 *
 *   · empty or relative  → the same path, but on the panel (`ADMIN_URL`);
 *   · absolute and from an allowed origin → left as is (a public site
 *     that signs up its readers may want to return to itself);
 *   · anything else → the panel root.
 *
 * The last one is what prevents the open redirect: a link of ours never
 * sends to a domain that is not on the list. better-auth already validates the
 * `callbackURL` against `trustedOrigins` on browser requests, but
 * NOT when `auth.api.*` is called from the server (there is no `request`), and in
 * tests it disables the check entirely. Here it is closed for all cases.
 *
 * Only exact ORIGINS are compared (`https://host:port`). A wildcard pattern from
 * `ALLOWED_ORIGINS` (`*.example.com`) authorizes nothing here: when in doubt,
 * the panel.
 */

/** `https://host:port` of an absolute http(s) URL, or `null`. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * A path relative to the root and nothing else: `/`, `/x?y=1`. No `//host` or `/\host`,
 * which the browser interprets as another domain.
 */
function isLocalPath(value: string): boolean {
  return /^\/(?![/\\])/.test(value) && !/[\\\s]/.test(value) && !/^\/%(2f|5c)/i.test(value);
}

/** Panel base without a trailing slash (`ADMIN_URL` may come with one). */
function basePanel(panel: string): string {
  return panel.replace(/\/+$/, "");
}

/**
 * Decides the safe destination for `callbackURL`.
 *
 * @param target    what the link carries (or nothing)
 * @param panel     `ADMIN_URL`
 * @param allowedOnes trusted origins (the same as `trustedOrigins`)
 */
export function safeTarget(
  target: string | null | undefined,
  panel: string,
  allowedOnes: readonly string[]
): string {
  const base = basePanel(panel);
  const value = (target ?? "").trim();

  if (!value) return `${base}/`;
  if (isLocalPath(value)) return `${base}${value}`;

  const origin = originOf(value);
  if (origin) {
    const trusted = new Set(
      [panel, ...allowedOnes].map((p) => originOf(p.trim())).filter((o): o is string => !!o)
    );
    if (trusted.has(origin)) return value;
  }

  return `${base}/`;
}

/**
 * Rewrites the `callbackURL` of a better-auth link (verification or
 * reset). If the link cannot be read as a URL it is returned untouched:
 * better a link that half works than an email with no link.
 *
 * `extra` names other destination parameters to sanitise the same way, but
 * only when the link carries them: a magic link may also have
 * `newUserCallbackURL` and `errorCallbackURL`, and an absent one must stay
 * absent (better-auth falls back to `callbackURL`).
 */
export function setLinkTarget(
  link: string,
  panel: string,
  allowedOnes: readonly string[],
  extra: readonly string[] = []
): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return link;
  }
  u.searchParams.set(
    "callbackURL",
    safeTarget(u.searchParams.get("callbackURL"), panel, allowedOnes)
  );
  for (const name of extra) {
    const value = u.searchParams.get(name);
    if (value !== null) u.searchParams.set(name, safeTarget(value, panel, allowedOnes));
  }
  return u.toString();
}
