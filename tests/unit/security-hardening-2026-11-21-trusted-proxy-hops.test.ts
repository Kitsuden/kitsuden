/**
 * Security hardening 2026-11-21: the client IP counts trusted proxies (TRUSTED_PROXY_HOPS)
 * ============================================================================
 *
 * `clientIp` walked `x-forwarded-for` from the right and SKIPPED private entries. Behind a
 * proxy that appends to the header, a client whose own address looks private (IPv6 through
 * docker-proxy, a LAN or VPN visitor) got the walk to go on into the entries it wrote itself:
 * a planted public-looking address became the IP the rate limiter and the audit log saw.
 * Now the operator says how many proxies are in front, and the client is the entry that many
 * hops from the right; with 0 the socket is used and the header ignored.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clientIp, limiterIdentity, trustedProxyHops } from "../../apps/api/src/lib/client-ip";

const ctx = (headers: Record<string, string>, socket?: string) =>
  ({
    env: socket ? { ip: { address: socket, family: "IPv4", port: 1234 } } : undefined,
    req: { header: (n: string) => headers[n.toLowerCase()] },
  }) as never;

const CADDY = "172.18.0.5";
const NGINX = "172.18.0.6";
/** What docker-proxy hands Caddy for every IPv6 visitor. */
const GATEWAY = "172.18.0.1";

const before = process.env.TRUSTED_PROXY_HOPS;
const setHops = (v: string | undefined) => {
  if (v === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = v;
};
beforeEach(() => setHops(undefined));
afterEach(() => setHops(before));

describe("the planted entry (H7)", () => {
  it("one proxy that appends: a client that looks private cannot choose its IP", () => {
    // The client sent `x-forwarded-for: 198.51.100.66`; the proxy appended the address it saw.
    const planted = ctx({ "x-forwarded-for": `198.51.100.66, ${GATEWAY}` }, CADDY);
    for (const hops of [undefined, "1"]) {
      setHops(hops);
      expect(clientIp(planted), `hops=${hops}`).toBe(GATEWAY);
      // The limiter keys a private result on the socket, never on the planted value.
      expect(limiterIdentity(planted), `hops=${hops}`).toBe(`socket:${CADDY}`);
    }
  });

  it("rotating the planted value does not give a new bucket", () => {
    const ids = new Set(
      ["198.51.100.1", "198.51.100.2", "203.0.113.200"].map((fake) =>
        limiterIdentity(ctx({ "x-forwarded-for": `${fake}, 10.8.0.3` }, CADDY))
      )
    );
    expect(ids.size).toBe(1);
  });

  it("two proxies (Caddy → nginx): the second entry from the right, whatever the client adds", () => {
    setHops("2");
    expect(clientIp(ctx({ "x-forwarded-for": `203.0.113.7, ${CADDY}` }, NGINX))).toBe(
      "203.0.113.7"
    );
    expect(
      clientIp(ctx({ "x-forwarded-for": `198.51.100.66, 203.0.113.7, ${CADDY}` }, NGINX))
    ).toBe("203.0.113.7");
    // A private visitor behind both: its own entry, not a planted one further left.
    expect(clientIp(ctx({ "x-forwarded-for": `198.51.100.66, ${GATEWAY}, ${CADDY}` }, NGINX))).toBe(
      GATEWAY
    );
  });

  it("fewer entries than hops (Caddy → API for /media): the leftmost, which Caddy wrote", () => {
    setHops("2");
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7" }, CADDY))).toBe("203.0.113.7");
  });
});

describe("TRUSTED_PROXY_HOPS", () => {
  it("0: the socket, and x-forwarded-for is ignored", () => {
    setHops("0");
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7" }, "198.51.100.9"))).toBe(
      "198.51.100.9"
    );
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7" }, CADDY))).toBe(CADDY);
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7" }))).toBe("unknown");
  });

  it("unset: a public socket means nothing is in front, as before", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, "203.0.113.9"))).toBe("203.0.113.9");
    // Stated: a public socket is a proxy too (a CDN in front of the API).
    setHops("1");
    expect(clientIp(ctx({ "x-forwarded-for": "198.51.100.4" }, "203.0.113.9"))).toBe(
      "198.51.100.4"
    );
  });

  it("no header: the socket; garbage where a proxy's entry should be: the socket", () => {
    setHops("1");
    expect(clientIp(ctx({}, CADDY))).toBe(CADDY);
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7, <script>" }, CADDY))).toBe(CADDY);
    // Empty entries are the client's and do not shift the count.
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7,, " }, CADDY))).toBe("203.0.113.7");
  });

  it("x-real-ip is never read: a client can send it when no proxy sets it", () => {
    expect(clientIp(ctx({ "x-real-ip": "203.0.113.50" }, CADDY))).toBe(CADDY);
  });

  it("parsing: whole numbers 0 to 10; anything else trusts nothing", () => {
    expect(trustedProxyHops({})).toEqual({ hops: 1, stated: false });
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "" })).toEqual({ hops: 1, stated: false });
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: " 2 " })).toEqual({ hops: 2, stated: true });
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" })).toEqual({ hops: 0, stated: true });
    for (const bad of ["-1", "1.5", "two", "11", "true"]) {
      expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), bad).toEqual({
        hops: 0,
        stated: true,
      });
    }
  });
});

describe("deployment files", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

  it("the TLS overlay (Caddy → panel nginx → API) states two hops; the base passes the value", () => {
    expect(read("docker-compose.tls.yml")).toContain("TRUSTED_PROXY_HOPS=${TRUSTED_PROXY_HOPS:-2}");
    expect(read("docker-compose.yml")).toContain("TRUSTED_PROXY_HOPS=${TRUSTED_PROXY_HOPS:-}");
  });

  it("the variable is documented", () => {
    expect(read("docs/install/variables.md")).toContain("TRUSTED_PROXY_HOPS");
    expect(read(".env.example")).toContain("TRUSTED_PROXY_HOPS");
    expect(read(".env.production.example")).toContain("TRUSTED_PROXY_HOPS");
  });
});
