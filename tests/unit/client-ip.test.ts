/**
 * The limiter identifies the client by an IP the client CANNOT
 * choose. Before it used `Authorization` (first 32 characters) or the whole
 * `x-forwarded-for`: by changing either on every request,
 * each one went to a new bucket and there was no limit.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isPrivate,
  clientIp,
  isInternalCall,
  limiterIdentity,
  PROXY_RANGES,
} from "../../apps/api/src/lib/client-ip";

const ctx = (headers: Record<string, string>, socket?: string) =>
  ({
    env: socket ? { ip: { address: socket, family: "IPv4", port: 1234 } } : undefined,
    req: { header: (n: string) => headers[n.toLowerCase()] },
  }) as never;

describe("clientIp", () => {
  it("with no proxy in front (public socket), it ignores what the client writes in x-forwarded-for", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, "203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(ctx({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" }, "203.0.113.9"))).toBe(
      "203.0.113.9"
    );
  });

  it("behind Caddy (one hop): the IP the proxy added", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7" }, "172.18.0.5"))).toBe("203.0.113.7");
  });

  it("behind Caddy → nginx (two hops): the first public one starting from the right", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7, 172.18.0.4" }, "172.18.0.6"))).toBe(
      "203.0.113.7"
    );
  });

  it("what the client puts in front does not change its bucket", () => {
    const a = clientIp(
      ctx({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.18.0.4" }, "172.18.0.6")
    );
    const b = clientIp(
      ctx({ "x-forwarded-for": "5.6.7.8, 203.0.113.7, 172.18.0.4" }, "172.18.0.6")
    );
    expect(a).toBe("203.0.113.7");
    expect(b).toBe(a);
  });

  it("garbage in the header does not count as an IP", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "<script>, 203.0.113.7" }, "10.0.0.2"))).toBe(
      "203.0.113.7"
    );
  });

  it("everything internal (the machine itself): the rightmost entry or the socket", () => {
    expect(clientIp(ctx({}, "172.17.0.1"))).toBe("172.17.0.1");
    expect(clientIp(ctx({}))).toBe("unknown");
  });

  it("normalizes IPv4 mapped in IPv6 and ports", () => {
    expect(clientIp(ctx({}, "::ffff:203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7:5555" }, "10.0.0.3"))).toBe(
      "203.0.113.7"
    );
  });

  it("classifies private ranges correctly", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPrivate(ip), ip).toBe(true);
    }
    for (const ip of ["172.32.0.1", "8.8.8.8", "203.0.113.7", "2001:4860:4860::8888"]) {
      expect(isPrivate(ip), ip).toBe(false);
    }
    expect(PROXY_RANGES).toContain("172.16.0.0/12");
  });
});

// Security review 2026-11-03: without ip6tables every IPv6 visitor reaches Caddy
// from the Docker gateway, and an internal caller can write any private XFF.
describe("private addresses are not proof (IPv6 behind docker-proxy)", () => {
  const GATEWAY = "172.18.0.1";
  const CADDY = "172.18.0.5";

  it("a forwarded private client is keyed on the socket, not on what the header says", () => {
    expect(limiterIdentity(ctx({ "x-forwarded-for": GATEWAY }, CADDY))).toBe(`socket:${CADDY}`);
    // An internal caller rotating private XFF values keeps ONE bucket
    const a = limiterIdentity(ctx({ "x-forwarded-for": "10.0.0.1" }, "172.18.0.9"));
    const b = limiterIdentity(ctx({ "x-forwarded-for": "10.0.0.2" }, "172.18.0.9"));
    expect(a).toBe(b);
  });

  it("a public client keeps its own address", () => {
    expect(limiterIdentity(ctx({ "x-forwarded-for": "203.0.113.7" }, CADDY))).toBe("203.0.113.7");
    expect(limiterIdentity(ctx({}, "203.0.113.9"))).toBe("203.0.113.9");
    // A LAN install without proxy: each visitor's own socket
    expect(limiterIdentity(ctx({}, "192.168.1.20"))).toBe("socket:192.168.1.20");
  });

  it("only a call with no forwarding header from a private socket is internal", () => {
    expect(isInternalCall(ctx({}, "172.18.0.7"))).toBe(true); // the site's SSR
    expect(isInternalCall(ctx({}))).toBe(true); // in-process
    expect(isInternalCall(ctx({ "x-forwarded-for": GATEWAY }, CADDY))).toBe(false);
    expect(isInternalCall(ctx({ "x-real-ip": "10.0.0.3" }, CADDY))).toBe(false);
    expect(isInternalCall(ctx({}, "203.0.113.9"))).toBe(false);
  });
});

describe("rate-limiter.ts", () => {
  const source = readFileSync(resolve(__dirname, "../../apps/api/src/lib/rate-limiter.ts"), "utf8");

  it("does not take the identifier from Authorization or from the raw x-forwarded-for", () => {
    const generateKey = source.slice(
      source.indexOf("function generateKey"),
      source.indexOf("export async function checkRateLimit")
    );
    expect(generateKey).not.toMatch(/header\("authorization"\)/i);
    expect(generateKey).not.toMatch(/header\("x-forwarded-for"\)/);
    expect(generateKey).toContain("limiterIdentity(c)");
  });

  it("dataset reads are skipped only for internal calls, never for a forwarded private address", () => {
    const input = source.slice(source.indexOf("export const INPUT_READ"));
    expect(input.slice(0, input.indexOf("};"))).toContain(
      "skip: (c) => !siteVisitor(c) && isInternalCall(c)"
    );
    expect(source).not.toMatch(/isPrivate\(clientIp\(c\)\)/);
  });

  it("login limits point to better-auth's real paths", () => {
    expect(source).toContain('"/api/auth/sign-in/email"');
    expect(source).toContain('"/api/auth/sign-up/email"');
    expect(source).toContain('"/api/auth/request-password-reset"');
    expect(source).not.toContain('"/api/auth/login"');
  });

  it("better-auth receives the trusted proxies (otherwise it does not limit with two hops)", () => {
    const auth = readFileSync(resolve(__dirname, "../../apps/api/src/lib/auth.ts"), "utf8");
    expect(auth).toMatch(/trustedProxies:\s*PROXY_RANGES/);
  });

  it("there is no second rateLimit() per route counting each request twice", () => {
    const cf = readFileSync(
      resolve(__dirname, "../../apps/api/src/lib/critical-features.ts"),
      "utf8"
    );
    expect(cf).not.toMatch(/app\.use\([^)]*rateLimit\(\{/);
  });
});

describe("limits on anonymous routes that send mail", () => {
  it("the members' magic link has its own limit", async () => {
    const { RATE_LIMIT_CONFIGS } = await import("../../apps/api/src/lib/rate-limiter");
    expect(RATE_LIMIT_CONFIGS["/api/members/signin"]?.limit).toBeLessThanOrEqual(5);
    expect(RATE_LIMIT_CONFIGS["/api/auth/sign-in/email"]?.limit).toBeLessThanOrEqual(10);
  });
});
