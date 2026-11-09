/**
 * Which addresses the server must not connect to on behalf of someone else
 * ============================================================================
 *
 * Loopback, private ranges, link-local (the cloud metadata service),
 * multicast, and the IPv6 forms that tunnel to any of those. Used by every
 * outbound call that a user, an agent or a third party chooses the target of:
 * the sandbox `fetch`, `webhook_out`, the OAuth client metadata (CIMD) and the
 * agent notifications. Moved here from oauth/cimd.ts so lib/safe-fetch.ts can
 * share it without an import cycle.
 */
import { isIP } from "node:net";

function privateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Is it an address the server must not connect to on behalf of a foreign client? */
export function nonPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return privateIpv4(ip);
  if (v !== 6) return true;
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const ceros = (until: number) => h.slice(0, until).every((x) => x === 0);
  const ipv4Final = () => `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  // `new URL` writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`: only the numbers count.
  if (ceros(5) && h[5] === 0xffff) return privateIpv4(ipv4Final()); // IPv4-mapped
  if (ceros(6)) return true; // ::, ::1 and the deprecated IPv4-compatible ::/96
  return (
    (h[0]! & 0xfe00) === 0xfc00 || // fc00::/7, unique local
    (h[0]! & 0xffc0) === 0xfe80 || // fe80::/10, link-local
    (h[0]! & 0xffc0) === 0xfec0 || // fec0::/10, site-local
    (h[0]! & 0xff00) === 0xff00 || // ff00::/8, multicast
    (h[0] === 0x64 && h[1] === 0xff9b) || // NAT64
    h[0] === 0x2002 || // 6to4: tunnels to an IPv4 address
    (h[0] === 0x2001 && h[1] === 0) || // Teredo: same
    (h[0] === 0x2001 && h[1] === 0xdb8) // documentation
  );
}

/** The eight 16-bit groups of an IPv6 address (with `::` or a dotted tail), or `null`. */
function ipv6Hextets(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0]!;
  const dots = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dots) {
    const [a, b, c, d] = dots.slice(2).map(Number) as [number, number, number, number];
    text = `${dots[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, queue] = text.split("::");
  const chunks = (t: string | undefined) => (t ? t.split(":").map((x) => parseInt(x, 16)) : []);
  const start = chunks(head);
  const fin = chunks(queue);
  const gaps = 8 - start.length - fin.length;
  if (gaps < 0 || (queue === undefined && gaps !== 0)) return null;
  const h = [...start, ...new Array<number>(gaps).fill(0), ...fin];
  return h.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? h : null;
}
