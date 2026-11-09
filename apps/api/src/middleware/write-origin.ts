/**
 * CSRF: a write carrying the session cookie has to come from one of our
 * origins.
 * ============================================================================
 *
 * ── THE GAP ─────────────────────────────────────────────
 *
 * The API routes authenticate with the better-auth cookie. CORS does not
 * protect a write: any page can send a `<form
 * method=post>` or a `fetch(..., {mode: "no-cors", credentials: "include"})`
 * with `Content-Type: text/plain`, and the browser sends it WITHOUT a preflight. It
 * will not be able to read the response, but the effect has already happened. What stops it today is
 * the cookie's `SameSite=Lax`, which does not cover:
 *
 *   - a SIBLING site on the same registrable domain (wikis, sites on
 *     subdomains, any subdomain with an XSS): to the browser it is
 *     "same-site" and it sends the cookie;
 *   - browsers or configurations that do not apply Lax by default.
 *
 * better-auth already checks the `Origin` on ITS routes (`trustedOrigins`); the
 * rest of the API did not.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Only on methods that write and only if the request carries better-auth's
 * session cookie (it runs before the session middleware, so it reads the cookie
 * itself; an agent with `Bearer` carries no cookie and is not CSRF-able):
 *
 *   - `Origin` (or, if missing, the `Referer`'s origin) has to be in the
 *     list (ALLOWED_ORIGINS + better-auth's trustedOrigins) or be the SAME
 *     host the request is going to (the panel served behind its nginx);
 *   - `Origin: null` (sandboxed iframes, odd redirects) is rejected;
 *   - with neither `Origin` nor `Referer` it is let through: browsers send
 *     `Origin` on every request that is not GET/HEAD, so its absence is
 *     a non-browser client (SSR, scripts), which is not CSRF.
 */
import { createMiddleware } from "hono/factory";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value === "null") return "null";
  try {
    return new URL(value).origin;
  } catch {
    return "null";
  }
}

/** Decides without a Hono context (tested by `tests/unit/write-origin.test.ts`). */
export function allowedWriteOrigin(params: {
  method: string;
  withCookie: boolean;
  origin?: string | null;
  referer?: string | null;
  host?: string | null;
  allowedOnes: readonly string[];
}): boolean {
  if (SAFE.has(params.method.toUpperCase())) return true;
  if (!params.withCookie) return true;

  const origin = originOf(params.origin) ?? originOf(params.referer);
  if (origin === null) return true; // neither Origin nor Referer: not a browser
  if (origin === "null") return false;
  if (params.allowedOnes.includes(origin)) return true;

  // Same host as the request: the panel behind its proxy (nginx forwards
  // `Host`), where the browser's origin IS the API's.
  if (params.host) {
    try {
      if (new URL(origin).host === params.host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

const SESSION_COOKIE = /(^|;\s*)(__Secure-)?better-auth\.session_token=/;

/** Does this `Cookie` header carry a better-auth session? */
export function hasSessionCookie(cookie: string | undefined | null): boolean {
  return !!cookie && SESSION_COOKIE.test(cookie);
}

export function requireOriginOnWrites(allowedOnes: () => readonly string[]) {
  return createMiddleware(async (c, next) => {
    const withCookie =
      Boolean((c.get as (k: string) => unknown)("session")) ||
      hasSessionCookie(c.req.header("cookie"));
    const ok = allowedWriteOrigin({
      method: c.req.method,
      withCookie,
      origin: c.req.header("origin"),
      referer: c.req.header("referer"),
      host: c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host"),
      allowedOnes: allowedOnes(),
    });
    if (!ok) {
      return c.json(
        { error: "Forbidden", message: "Origin not allowed for a cookie-authenticated write" },
        403
      );
    }
    await next();
  });
}
