/**
 * DPoP proofs (RFC 9449): lib/dpop.ts, pure functions and the jti store.
 * Run: cd apps/api && bun --no-env-file test src/tests-unit/dpop.test.ts
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "bun:test";

import {
  accessTokenHash,
  checkDpopProof,
  jwkThumbprint,
  memoryJtiStore,
  normalizeHtu,
  parseAuthorization,
  publicJwkOf,
  verifyDpopProof,
  type PublicJwk,
} from "../lib/dpop";

const URL_ = "https://api.example.com/api/agent/decisions";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

interface Pair {
  alg: "ES256" | "EdDSA";
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function pair(alg: "ES256" | "EdDSA"): Pair {
  const { privateKey, publicKey } =
    alg === "ES256"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : generateKeyPairSync("ed25519");
  return { alg, privateKey, jwk: publicKey.export({ format: "jwk" }) as Record<string, unknown> };
}

function proof(
  p: Pair,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
): string {
  const h = b64({ typ: "dpop+jwt", alg: p.alg, jwk: p.jwk, ...header });
  const body = b64({
    jti: crypto.randomUUID(),
    htm: "GET",
    htu: URL_,
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  });
  const data = Buffer.from(`${h}.${body}`);
  const sig =
    p.alg === "ES256"
      ? sign("sha256", data, { key: p.privateKey, dsaEncoding: "ieee-p1363" })
      : sign(null, data, p.privateKey);
  return `${h}.${body}.${sig.toString("base64url")}`;
}

const es = pair("ES256");
const ed = pair("EdDSA");

describe("verifyDpopProof", () => {
  it("accepts a valid ES256 proof and returns the RFC 7638 thumbprint", () => {
    const r = verifyDpopProof({ proof: proof(es), method: "GET", url: URL_ });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jkt).toBe(jwkThumbprint(es.jwk as unknown as PublicJwk));
  });

  it("accepts a valid EdDSA proof", () => {
    const r = verifyDpopProof({ proof: proof(ed), method: "GET", url: URL_ });
    expect(r.ok).toBe(true);
  });

  it("ignores the query and fragment of the request URL", () => {
    const r = verifyDpopProof({ proof: proof(es), method: "GET", url: `${URL_}?a=1#x` });
    expect(r.ok).toBe(true);
  });

  it("refuses a wrong htm", () => {
    const r = verifyDpopProof({ proof: proof(es), method: "POST", url: URL_ });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("htm") });
  });

  it("refuses a proof made for another URL", () => {
    const r = verifyDpopProof({
      proof: proof(es),
      method: "GET",
      url: "https://api.example.com/api/other",
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("htu") });
    const host = verifyDpopProof({
      proof: proof(es),
      method: "GET",
      url: "https://evil.example.com/api/agent/decisions",
    });
    expect(host.ok).toBe(false);
  });

  it("checks ath against the access token", () => {
    const token = "kitsuden_agent_x_0123456789abcdef_secret";
    const good = proof(es, { ath: accessTokenHash(token) });
    expect(verifyDpopProof({ proof: good, method: "GET", url: URL_, accessToken: token }).ok).toBe(
      true
    );
    const wrong = verifyDpopProof({
      proof: good,
      method: "GET",
      url: URL_,
      accessToken: "another-token",
    });
    expect(wrong).toEqual({ ok: false, reason: expect.stringContaining("ath") });
    const missing = verifyDpopProof({
      proof: proof(es),
      method: "GET",
      url: URL_,
      accessToken: token,
    });
    expect(missing.ok).toBe(false);
  });

  it("refuses a stale or future iat", () => {
    const old = proof(es, { iat: Math.floor(Date.now() / 1000) - 120 });
    expect(verifyDpopProof({ proof: old, method: "GET", url: URL_ })).toEqual({
      ok: false,
      reason: expect.stringContaining("iat"),
    });
    const future = proof(es, { iat: Math.floor(Date.now() / 1000) + 120 });
    expect(verifyDpopProof({ proof: future, method: "GET", url: URL_ }).ok).toBe(false);
    // Inside a wider configured window it passes.
    expect(verifyDpopProof({ proof: old, method: "GET", url: URL_, skewSeconds: 300 }).ok).toBe(
      true
    );
  });

  it("refuses alg none", () => {
    const h = b64({ typ: "dpop+jwt", alg: "none", jwk: es.jwk });
    const body = b64({ jti: "1", htm: "GET", htu: URL_, iat: Math.floor(Date.now() / 1000) });
    const r = verifyDpopProof({ proof: `${h}.${body}.`, method: "GET", url: URL_ });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("alg") });
  });

  it("refuses HS256 (a symmetric key would let the server's secret sign)", () => {
    const h = b64({ typ: "dpop+jwt", alg: "HS256", jwk: { kty: "oct", k: "c2VjcmV0" } });
    const body = b64({ jti: "1", htm: "GET", htu: URL_, iat: Math.floor(Date.now() / 1000) });
    const r = verifyDpopProof({ proof: `${h}.${body}.c2ln`, method: "GET", url: URL_ });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("alg") });
  });

  it("refuses a jwk with private members", () => {
    const priv = es.privateKey.export({ format: "jwk" }) as Record<string, unknown>;
    const r = verifyDpopProof({ proof: proof(es, {}, { jwk: priv }), method: "GET", url: URL_ });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("private") });
  });

  it("refuses a thumbprint that is not the bound one", () => {
    const boundTo = jwkThumbprint(ed.jwk as unknown as PublicJwk);
    expect(publicJwkOf(ed.jwk).ok).toBe(true);
    const r = verifyDpopProof({ proof: proof(es), method: "GET", url: URL_, expectedJkt: boundTo });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("bound") });
    const own = verifyDpopProof({
      proof: proof(ed),
      method: "GET",
      url: URL_,
      expectedJkt: boundTo,
    });
    expect(own.ok).toBe(true);
  });

  it("refuses a forged signature, a wrong typ and a key of another type", () => {
    const good = proof(es);
    const [h, p] = good.split(".");
    const other = proof(pair("ES256")).split(".")[2];
    expect(verifyDpopProof({ proof: `${h}.${p}.${other}`, method: "GET", url: URL_ }).ok).toBe(
      false
    );
    expect(
      verifyDpopProof({ proof: proof(es, {}, { typ: "JWT" }), method: "GET", url: URL_ }).ok
    ).toBe(false);
    expect(
      verifyDpopProof({ proof: proof(es, {}, { alg: "EdDSA" }), method: "GET", url: URL_ }).ok
    ).toBe(false);
    expect(verifyDpopProof({ proof: undefined, method: "GET", url: URL_ }).ok).toBe(false);
    expect(verifyDpopProof({ proof: "a.b", method: "GET", url: URL_ }).ok).toBe(false);
  });
});

describe("checkDpopProof (replay)", () => {
  it("accepts a jti once and refuses the replay", async () => {
    const store = memoryJtiStore();
    const p = proof(es);
    expect((await checkDpopProof({ proof: p, method: "GET", url: URL_ }, store)).ok).toBe(true);
    const again = await checkDpopProof({ proof: p, method: "GET", url: URL_ }, store);
    expect(again).toEqual({ ok: false, reason: expect.stringContaining("already used") });
  });

  it("the store stays bounded", async () => {
    const store = memoryJtiStore(3);
    for (let i = 0; i < 10; i++) expect(await store.claim(`k${i}`, 60_000)).toBe(true);
    expect(store.size()).toBeLessThanOrEqual(3);
  });
});

describe("helpers", () => {
  it("RFC 7638 thumbprint of the RFC's own example key", () => {
    // RFC 7638 §3.1 uses an RSA key; this checks the canonical EC form instead.
    const jwk: PublicJwk = {
      kty: "EC",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    };
    expect(jwkThumbprint(jwk)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwkThumbprint({ ...jwk })).toBe(jwkThumbprint(jwk));
  });

  it("parses Bearer and DPoP authorization headers", () => {
    expect(parseAuthorization("Bearer abc")).toEqual({ scheme: "Bearer", token: "abc" });
    expect(parseAuthorization("dpop abc")).toEqual({ scheme: "DPoP", token: "abc" });
    expect(parseAuthorization("Basic abc")).toBeNull();
    expect(parseAuthorization(undefined)).toBeNull();
  });

  it("normalizes htu", () => {
    expect(normalizeHtu("HTTPS://API.example.com:443/a?b#c")).toBe("https://api.example.com/a");
    expect(normalizeHtu("ftp://x/y")).toBeNull();
  });
});
