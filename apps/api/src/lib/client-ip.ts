/**
 * The IP of whoever makes the request, without trusting what the client writes.
 *
 * ── THE FLAW ──────────────────────────────────────────────────────────────
 *
 * The limiter used the WHOLE `x-forwarded-for` as the identifier (or, even earlier,
 * the first 32 characters of `Authorization`). Both headers are
 * written by the client: with a different one on every request, each request fell into
 * a new bucket and the limit did not exist. A valid key was not even needed:
 * an `Authorization: Bearer <garbage>` that is not an agent's carries on
 * as an anonymous request.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * The proxies we have in front (Caddy, the panel's nginx, the Docker
 * network) live at PRIVATE addresses; visitors arrive from
 * PUBLIC addresses. So:
 *
 *   1. If whoever opens the socket is a public IP, there is no proxy in front: that is
 *      the IP, and `x-forwarded-for` is client text → it is ignored.
 *   2. If it is private (or unknown), `x-forwarded-for` is walked from RIGHT
 *      to left skipping private ones: the first public one was added by our
 *      first proxy. What the client wrote stays to its left and does not
 *      count.
 *   3. If everything is private (requests from the machine itself or the internal
 *      network), the rightmost entry, or the socket.
 *
 * There is no need to know how many hops there are (Caddy → API, or Caddy → nginx → API):
 * it works for both setups.
 *
 * ── WHEN THE ADDRESS COMES OUT PRIVATE ─────────────────────────────────────
 *
 * Case 3 is not proof of anything. Without ip6tables, Docker's `docker-proxy`
 * hands Caddy every IPv6 visitor with ONE private address (the bridge gateway),
 * and anyone who reaches the API port from inside (the host, a container) can
 * write a different private `x-forwarded-for` on every request. Security review
 * 2026-11-03: the limiter skipped `INPUT_READ` for all of them and keyed the rest
 * on that client-written value. So, for the limiter:
 *
 *   · `limiterIdentity`: a private result is replaced by the SOCKET (`socket:<ip>`),
 *     which nobody can choose. Behind Caddy that is one bucket for every visitor
 *     whose address Docker hid: degraded, never open. Real per-visitor IPv6
 *     limits need IPv6 in Docker (docs/install/server.md).
 *   · `isInternalCall`: only a request with NO forwarding header from a private
 *     socket (the sites' SSR on the Docker network, a process on the host) is
 *     internal. Anything a proxy forwarded is a visitor, whatever address it got.
 */
/** The only thing used from Hono's context (any `Context<…>` works). */
interface MinimalContext {
  env?: unknown;
  req: { header(name: string): string | undefined };
}

/** Ranges treated as "our proxies" (and passed to better-auth). */
export const PROXY_RANGES = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

function clean(ip: string): string {
  let v = ip.trim();
  // [::1]:1234 → ::1 ; 1.2.3.4:5678 → 1.2.3.4
  const brackets = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (brackets) return brackets[1]!.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  v = v.toLowerCase();
  if (v.startsWith("::ffff:") && /^\d{1,3}(\.\d{1,3}){3}$/.test(v.slice(7))) v = v.slice(7);
  return v;
}

function ipv4(v: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

/** Is it an internal network address (or not a valid IP)? */
export function isPrivate(ip: string): boolean {
  const v = clean(ip);
  const a = ipv4(v);
  if (a) {
    const [x, y] = a as [number, number, number, number];
    return (
      x === 127 ||
      x === 10 ||
      x === 0 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127)
    );
  }
  if (v.includes(":") && /^[0-9a-f:]+$/.test(v)) {
    return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true; // what is not an IP identifies nobody from the outside
}

function isIp(v: string): boolean {
  return ipv4(v) !== null || (v.includes(":") && /^[0-9a-f:]+$/.test(v));
}

/** The socket address that `index.ts` provides (`app.fetch(req, { ip })`). */
function socketIp(c: MinimalContext): string | null {
  const env = c.env as { ip?: { address?: string } | string } | undefined;
  const ip = typeof env?.ip === "string" ? env.ip : env?.ip?.address;
  return ip ? clean(ip) : null;
}

export function clientIp(c: MinimalContext): string {
  const socket = socketIp(c);
  if (socket && isIp(socket) && !isPrivate(socket)) return socket;

  const string = (c.req.header("x-forwarded-for") ?? "").split(",").map(clean).filter(isIp);

  for (let i = string.length - 1; i >= 0; i--) {
    if (!isPrivate(string[i]!)) return string[i]!;
  }

  const real = clean(c.req.header("x-real-ip") ?? "");
  if (real && isIp(real) && !isPrivate(real)) return real;

  return string[string.length - 1] ?? socket ?? "unknown";
}

/** The headers a proxy adds when it forwards a request. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded"];

/**
 * A call from inside: no proxy forwarded it (no forwarding header) and the
 * socket is private, or there is no socket at all (an in-process `app.request`).
 */
export function isInternalCall(c: MinimalContext): boolean {
  if (FORWARDING_HEADERS.some((h) => (c.req.header(h) ?? "").trim() !== "")) return false;
  const socket = socketIp(c);
  return socket === null || isPrivate(socket);
}

/**
 * What the limiter counts by: the public client address when there is one; when
 * it comes out private or unknown, the socket, which the client cannot write.
 */
export function limiterIdentity(c: MinimalContext): string {
  const ip = clientIp(c);
  if (isIp(ip) && !isPrivate(ip)) return ip;
  const socket = socketIp(c);
  return socket && isIp(socket) ? `socket:${socket}` : ip;
}
