/**
 * DPoP — proof of possession for agent credentials (RFC 9449)
 * ============================================================================
 *
 * A bearer token works for whoever holds it: a key copied out of a CI log, an
 * OAuth token read from a proxy's memory. A DPoP-bound credential also needs a
 * fresh signature, made with a private key that never leaves the client, on
 * EVERY request: the stolen token alone is useless.
 *
 *   Authorization: DPoP <token>
 *   DPoP: <proof JWT>
 *
 * The proof is a compact JWS whose header carries the PUBLIC key (`jwk`) and
 * whose payload says which request it is for:
 *
 *   header   typ "dpop+jwt", alg ES256 | EdDSA, jwk (public members only)
 *   payload  jti  unique id (replays are refused)
 *            htm  the HTTP method
 *            htu  the URL without query or fragment
 *            iat  issued at (seconds), within ±DPOP_IAT_SKEW_SECONDS (60)
 *            ath  base64url(SHA-256(access token)), on resource requests
 *
 * The credential is bound to the key's RFC 7638 thumbprint (`jkt`, SHA-256,
 * base64url): `agent_api_keys.dpop_jkt`, `oauth_tokens.dpop_jkt`,
 * `agent_short_tokens.dpop_jkt`. Guide: docs/agents/dpop-and-short-tokens.md.
 *
 * Only `node:crypto`: no JOSE dependency. Everything here but the `jti` store
 * is pure and unit-tested (src/tests-unit/dpop.test.ts).
 *
 * ── THE jti STORE ──────────────────────────────────────────────────────────
 *
 * With Valkey configured and answering, a `SET NX PX` there: every instance
 * sees every proof. Without it, a bounded in-memory map: replay protection then
 * holds per instance only (a proof replayed against ANOTHER instance within
 * the iat window is accepted). Run one instance, or configure Valkey.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

/** The algorithms accepted (asymmetric only: never `none`, never HS*). */
export const DPOP_ALGORITHMS = ["ES256", "EdDSA"] as const;
export type DpopAlgorithm = (typeof DPOP_ALGORITHMS)[number];

/** A proof larger than this is refused before parsing (headers are cheap to inflate). */
const MAX_PROOF_LENGTH = 8192;
const MAX_JTI_LENGTH = 256;

/** Members of a JWK that only a PRIVATE (or symmetric) key has. */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** Seconds of clock skew allowed on `iat` (env `DPOP_IAT_SKEW_SECONDS`, 1–600, default 60). */
export function dpopSkewSeconds(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.DPOP_IAT_SKEW_SECONDS);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(Math.max(Math.floor(n), 1), 600);
}

export interface PublicJwk {
  kty: "EC" | "OKP";
  crv: "P-256" | "Ed25519";
  x: string;
  y?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64urlJson(part: string): unknown {
  if (!B64URL.test(part)) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The public JWK of a proof (or of a key an admin binds), checked: EC P-256 or
 * OKP Ed25519 and NO private member. `null` + reason otherwise.
 */
export function publicJwkOf(
  jwk: unknown
): { ok: true; jwk: PublicJwk } | { ok: false; reason: string } {
  if (!isObject(jwk)) return { ok: false, reason: "jwk must be an object" };
  for (const m of PRIVATE_MEMBERS) {
    if (m in jwk) return { ok: false, reason: `jwk carries the private member '${m}'` };
  }
  const { kty, crv, x, y } = jwk;
  if (typeof x !== "string" || !B64URL.test(x)) return { ok: false, reason: "jwk.x is missing" };
  if (kty === "EC" && crv === "P-256") {
    if (typeof y !== "string" || !B64URL.test(y)) return { ok: false, reason: "jwk.y is missing" };
    return { ok: true, jwk: { kty, crv, x, y } };
  }
  if (kty === "OKP" && crv === "Ed25519") return { ok: true, jwk: { kty, crv, x } };
  return { ok: false, reason: "Only EC P-256 (ES256) and OKP Ed25519 (EdDSA) keys are accepted" };
}

/**
 * RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order,
 * no whitespace, base64url. It is what a credential is bound to (`jkt`).
 */
export function jwkThumbprint(jwk: PublicJwk): string {
  const canonical =
    jwk.kty === "EC"
      ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
      : JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical).digest("base64url");
}

/** `ath`: base64url(SHA-256(access token)) (RFC 9449 §4.2). */
export function accessTokenHash(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("base64url");
}

/** Is this a well-formed thumbprint (43 base64url characters)? */
export function isJkt(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * An `htu` as compared (RFC 9449 §4.3: without query and fragment; scheme and
 * host case-insensitive, default port dropped — `URL` does that). `null` if it
 * is not an absolute http(s) URL.
 */
export function normalizeHtu(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Parses an `Authorization` header: `Bearer <t>` or `DPoP <t>` (scheme
 * case-insensitive). `null` for anything else.
 */
export function parseAuthorization(
  header: string | null | undefined
): { scheme: "Bearer" | "DPoP"; token: string } | null {
  if (!header) return null;
  const m = /^(bearer|dpop)\s+(\S+)\s*$/i.exec(header);
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase() === "dpop" ? "DPoP" : "Bearer", token: m[2]! };
}

export interface DpopProofCheck {
  /** The `DPoP` header (one compact JWS). */
  proof: string | null | undefined;
  /** The request method (`GET`, `POST`…). */
  method: string;
  /** The URL the client called, as the client sees it (public origin + path). */
  url: string;
  /** For resource requests: the access token, whose hash must be the proof's `ath`. */
  accessToken?: string;
  /** The thumbprint the credential is bound to (`null`/absent: any key). */
  expectedJkt?: string | null;
  /** Milliseconds since the epoch (tests). */
  now?: number;
  skewSeconds?: number;
}

export type DpopProofResult =
  | { ok: true; jkt: string; jti: string; iat: number; jwk: PublicJwk }
  | { ok: false; reason: string };

/** What a failure answers in `WWW-Authenticate` (RFC 9449 §7.1). */
export const DPOP_CHALLENGE = `DPoP error="invalid_dpop_proof", algs="${DPOP_ALGORITHMS.join(" ")}"`;

const fail = (reason: string): DpopProofResult => ({ ok: false, reason });

/**
 * Verifies a DPoP proof WITHOUT the replay check (pure). The caller then
 * claims the `jti` (`claimJti`). Checks, in order: shape, header (`typ`,
 * `alg`, public `jwk`), signature, then the claims (`htm`, `htu`, `iat`,
 * `ath`) and the thumbprint.
 */
export function verifyDpopProof(check: DpopProofCheck): DpopProofResult {
  const proof = check.proof?.trim();
  if (!proof) return fail("The DPoP header is missing");
  if (proof.length > MAX_PROOF_LENGTH) return fail("DPoP proof too large");
  const parts = proof.split(".");
  if (parts.length !== 3) return fail("DPoP proof is not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (!isObject(header) || !isObject(payload)) return fail("DPoP proof is not valid JSON");
  if (header.typ !== "dpop+jwt") return fail("DPoP proof typ must be dpop+jwt");
  const alg = header.alg;
  if (typeof alg !== "string" || !(DPOP_ALGORITHMS as readonly string[]).includes(alg)) {
    return fail(`DPoP proof alg must be one of ${DPOP_ALGORITHMS.join(", ")}`);
  }
  if ("crit" in header) return fail("DPoP proof crit is not supported");
  const pub = publicJwkOf(header.jwk);
  if (!pub.ok) return fail(`DPoP proof ${pub.reason}`);
  const jwk = pub.jwk;
  if ((alg === "ES256") !== (jwk.kty === "EC"))
    return fail("DPoP proof alg does not match its key");

  let key: KeyObject;
  try {
    key = createPublicKey({ key: { ...jwk }, format: "jwk" });
  } catch {
    return fail("DPoP proof jwk is not a valid public key");
  }
  if (!B64URL.test(s)) return fail("DPoP proof signature is malformed");
  const signature = Buffer.from(s, "base64url");
  const data = Buffer.from(`${h}.${p}`, "ascii");
  let valid = false;
  try {
    valid =
      alg === "ES256"
        ? signature.length === 64 &&
          verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
        : signature.length === 64 && verifySignature(null, data, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail("DPoP proof signature is invalid");

  const { jti, htm, htu, iat, ath } = payload;
  if (typeof jti !== "string" || !jti || jti.length > MAX_JTI_LENGTH)
    return fail("DPoP proof jti is missing");
  if (typeof htm !== "string" || htm !== check.method.toUpperCase())
    return fail("DPoP proof htm does not match the request method");
  const expectedHtu = normalizeHtu(check.url);
  if (typeof htu !== "string" || !expectedHtu || normalizeHtu(htu) !== expectedHtu)
    return fail("DPoP proof htu does not match the request URL");
  if (typeof iat !== "number" || !Number.isFinite(iat)) return fail("DPoP proof iat is missing");
  const now = (check.now ?? Date.now()) / 1000;
  const skew = check.skewSeconds ?? dpopSkewSeconds();
  if (Math.abs(now - iat) > skew) return fail("DPoP proof iat is outside the accepted window");
  if (check.accessToken !== undefined) {
    if (typeof ath !== "string" || ath !== accessTokenHash(check.accessToken))
      return fail("DPoP proof ath does not match the access token");
  }
  const jkt = jwkThumbprint(jwk);
  if (check.expectedJkt && jkt !== check.expectedJkt)
    return fail("DPoP proof key does not match the key this credential is bound to");
  return { ok: true, jkt, jti, iat, jwk };
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLAY CACHE (jti)
// ═══════════════════════════════════════════════════════════════════════════

export interface JtiStore {
  /** `true` the first time `key` is seen within `ttlMs`; `false` for a replay. */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

/** A bounded in-memory store (per process). Oldest entries go first when full. */
export function memoryJtiStore(max = 50_000): JtiStore & { clear(): void; size(): number } {
  const seen = new Map<string, number>();
  return {
    async claim(key, ttlMs) {
      const now = Date.now();
      const until = seen.get(key);
      if (until !== undefined && until > now) return false;
      if (seen.size >= max) {
        for (const [k, v] of seen) {
          if (v <= now) seen.delete(k);
        }
        while (seen.size >= max) seen.delete(seen.keys().next().value as string);
      }
      seen.delete(key);
      seen.set(key, now + ttlMs);
      return true;
    },
    clear() {
      seen.clear();
    },
    size() {
      return seen.size;
    },
  };
}

const memoryStore = memoryJtiStore();

/** For tests: forgets every seen `jti` of the in-memory store. */
export function forgetDpopJtis(): void {
  memoryStore.clear();
}

/**
 * The shared store: Valkey (`SET NX PX`) when configured and answering, the
 * in-memory map otherwise (single-instance protection; see the header).
 */
export const defaultJtiStore: JtiStore = {
  async claim(key, ttlMs) {
    try {
      // Deferred: unit tests of this file must not open a Valkey client.
      const valkey = await import("./valkey");
      if (valkey.valkeyConfigured() && (await valkey.isValkeyAvailable())) {
        const client = await valkey.getValkeyClient();
        const r = await client.set(`kitsuden:dpop:jti:${key}`, "1", {
          condition: "NX",
          expiration: { type: "PX", value: ttlMs },
        });
        return r !== null;
      }
    } catch {
      // Valkey failed: the in-memory store still refuses replays on this instance.
    }
    return memoryStore.claim(key, ttlMs);
  },
};

/**
 * Verifies the proof AND claims its `jti` (scoped to the key's thumbprint), so
 * the same proof is accepted once. The `jti` lives for twice the iat window:
 * after that the `iat` check refuses the proof anyway.
 */
export async function checkDpopProof(
  check: DpopProofCheck,
  store: JtiStore = defaultJtiStore
): Promise<DpopProofResult> {
  const r = verifyDpopProof(check);
  if (!r.ok) return r;
  const skew = check.skewSeconds ?? dpopSkewSeconds();
  const key = createHash("sha256").update(`${r.jkt}:${r.jti}`).digest("base64url");
  if (!(await store.claim(key, skew * 2 * 1000))) return fail("DPoP proof was already used (jti)");
  return r;
}
