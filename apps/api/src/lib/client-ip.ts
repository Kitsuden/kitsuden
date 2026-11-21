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
 * ── THE RULE: COUNT THE PROXIES, DO NOT GUESS THEM ─────────────────────────
 *
 * Each proxy APPENDS the address it received the request from to
 * `x-forwarded-for`, so the trustworthy part of the header is its right end:
 * one entry per proxy we run. Everything to the left of that is text the
 * client wrote. `TRUSTED_PROXY_HOPS` says how many proxies stand in front of
 * the API (docs/install/variables.md):
 *
 *   · `0`: no proxy. The socket address is the client; `x-forwarded-for` is
 *     ignored.
 *   · `N` ≥ 1: the client is the N-th entry from the RIGHT. With fewer
 *     entries than N, the leftmost one (a request that crossed fewer of our
 *     proxies, e.g. Caddy → API for `/media/*` when `/api/*` goes Caddy →
 *     nginx → API: Caddy replaces what the client sent, so its entry is the
 *     whole header). No header at all: the socket.
 *   · unset: one proxy, except that a PUBLIC socket means nothing is in
 *     front (the API published straight to the internet) and the header is
 *     ignored, as before.
 *
 * Security audit 2026-11-19 (H7): before, the header was walked from the right
 * SKIPPING private entries, to work with one or two proxies without being
 * told. Whenever the real client looks private (IPv6 behind `docker-proxy`
 * gets the bridge gateway; a visitor on the LAN or a VPN), the walk went on
 * into the client's own entries: a planted public-looking address set the IP
 * the limiter and the audit log saw. A fixed count cannot be walked past.
 *
 * ── WHEN THE ADDRESS COMES OUT PRIVATE ─────────────────────────────────────
 *
 * A private result is not proof of anything. Without ip6tables, Docker's `docker-proxy`
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

/**
 * Private ranges, passed to better-auth as its trusted proxies (lib/auth.ts).
 * `clientIp` no longer uses them to pick the client: it counts hops.
 */
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

/** More than this is a typing mistake, not a deployment. */
const MAX_HOPS = 10;

let warnedInvalid = "";

/**
 * How many proxies stand in front of the API (`TRUSTED_PROXY_HOPS`), and
 * whether it was said. Unset or empty: one, not stated. A value that is not a
 * whole number from 0 to 10 trusts nothing (0) and warns once: a typo must
 * not open the header to the client.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): {
  hops: number;
  stated: boolean;
} {
  const raw = (env.TRUSTED_PROXY_HOPS ?? "").trim();
  if (raw === "") return { hops: 1, stated: false };
  if (/^\d+$/.test(raw) && Number(raw) <= MAX_HOPS) return { hops: Number(raw), stated: true };
  if (warnedInvalid !== raw) {
    warnedInvalid = raw;
    console.warn(
      `[client-ip] TRUSTED_PROXY_HOPS must be a whole number from 0 to ${MAX_HOPS}; ignoring x-forwarded-for until it is fixed`
    );
  }
  return { hops: 0, stated: true };
}

export function clientIp(c: MinimalContext): string {
  const socket = socketIp(c);
  const socketValid = socket !== null && isIp(socket);
  const { hops, stated } = trustedProxyHops();

  if (hops === 0) return socketValid ? socket! : "unknown";
  // Not stated: a public socket means nothing is in front of the API.
  if (!stated && socketValid && !isPrivate(socket!)) return socket!;

  // The entries in the order the proxies appended them. Empty ones are the
  // client's (a proxy always appends an address), so they are dropped.
  const chain = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketValid ? socket! : "unknown";

  const picked = clean(chain[Math.max(0, chain.length - hops)]!);
  if (isIp(picked)) return picked;
  // Garbage where a proxy's entry should be: the socket, never the client's text.
  return socketValid ? socket! : "unknown";
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
