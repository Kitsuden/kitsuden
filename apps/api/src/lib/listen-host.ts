/**
 * The address the API listens on (`HOST`).
 *
 * Without `hostname`, bun chose on its own and on Windows ended up listening
 * only on `localhost` (IPv6, `::1`): `http://127.0.0.1:3001` gave connection
 * refused, and tools that do not try IPv6 first (or that are
 * configured with the IP) did not reach the API.
 *
 * Default: `0.0.0.0` (all IPv4 interfaces) in production, which is what the
 * container needs —Docker forwards to the container's IP, not its loopback— and
 * the image sets `HOST=0.0.0.0` anyway. What is exposed OUTSIDE is decided by
 * the `ports:` of docker-compose (`127.0.0.1:3000:3000` by default).
 *
 * Outside production the default is `127.0.0.1` (since 2026-11-04, security
 * review 2026-11-03): a development API on `0.0.0.0` was reachable from the
 * whole network with setup and sign-up open. `HOST=0.0.0.0` (or `::` for dual
 * stack) still listens everywhere, and then the setup token is required and
 * sign-up is closed unless `KITSUDEN_SIGNUP=open` (`listensBeyondLoopback`).
 */
type Env = Record<string, string | undefined>;

export function listenHost(env: Env = process.env): string {
  const host = (env["HOST"] ?? "").trim();
  if (host) return host;
  return env["NODE_ENV"] === "production" ? "0.0.0.0" : "127.0.0.1";
}

/** `127.0.0.0/8`, `::1` or `localhost`: reachable only from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Does the API listen on an address other machines can reach? */
export function listensBeyondLoopback(env: Env = process.env): boolean {
  return !isLoopbackHost(listenHost(env));
}
