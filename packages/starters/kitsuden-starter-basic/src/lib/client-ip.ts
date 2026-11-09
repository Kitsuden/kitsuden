/**
 * The visitor's IP, as this server sees it
 * ============================================================================
 *
 * Sent to the API as `x-kitsuden-client` (only with `KITSUDEN_SITE_KEY`), so
 * the API's rate limit counts each visitor separately.
 *
 * Behind a reverse proxy (Caddy in docker-compose.tls.yml) the socket address
 * is the PROXY's, and every visitor would share one counter. With
 * `KITSUDEN_TRUST_PROXY=true` the address is taken from `X-Forwarded-For`
 * instead: its LAST entry, which is the one the proxy added (the entries
 * before it are written by the client and can be anything). Only enable it
 * when a proxy you control is the only way to reach this server.
 */
export function visitorIp(
  socketAddress: string | undefined,
  forwardedFor: string | null | undefined,
  trustProxy: boolean
): string | undefined {
  if (trustProxy && forwardedFor) {
    const last = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return socketAddress;
}
