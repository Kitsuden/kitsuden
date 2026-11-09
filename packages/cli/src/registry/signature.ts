/**
 * Signatures: Ed25519 in the minisign format, offline, with node:crypto only
 * ============================================================================
 *
 * WHY THIS AND NOT SIGSTORE (the decision, in short — docs/kons/registry.md has
 * the long version):
 *
 *   · Verification must work OFFLINE and in a Docker build with no network:
 *     a minisign signature is checked with one 32-byte public key. Sigstore
 *     keyless verification needs a trusted root (TUF), a Rekor inclusion proof
 *     and an OIDC identity policy — doable offline with a bundle, but it brings
 *     the sigstore-js dependency tree into the one code path that must trust
 *     nothing.
 *   · Third parties publish from anywhere, not only from a CI with OIDC.
 *   · Zero new dependencies: node:crypto has Ed25519 and BLAKE2b-512.
 *   · The format is minisign's, so users can also check a package with the
 *     `minisign` tool (`minisign -Vm kon-x-1.0.0.tgz -P <key>`; format-level
 *     compatibility, not yet tested against the binary).
 *     Minisign's "trusted comment" is SIGNED: we put the kon id, version and
 *     SHA-256 in it, so a valid signature cannot be replayed onto another kon.
 *
 * Sigstore stays a possible SECOND signature later (provenance from CI) — the
 * index entry has room for it — but it is not the root of trust.
 *
 * Formats (https://jedisct1.github.io/minisign/):
 *   public key:  "untrusted comment: …\n" + base64("Ed" + keyId[8] + pk[32])
 *   signature:   "untrusted comment: …\n" + base64("ED" + keyId[8] + sig[64]) + "\n"
 *                "trusted comment: <text>\n" + base64(globalSig[64]) + "\n"
 *   "ED" = Ed25519 over BLAKE2b-512(file); globalSig = Ed25519(sig ‖ text).
 *   The legacy "Ed" (Ed25519 over the raw file) is accepted when verifying.
 *
 * Secret keys are NOT in minisign's scrypt format: they are a JSON file with a
 * PKCS#8 PEM, encrypted (AES-256-CBC, OpenSSL's PEM encryption) when
 * KITSUDEN_SIGNING_PASSPHRASE is set. They never go in a repository.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export class SignatureError extends Error {}

export interface PublicKey {
  /** 8 bytes, as minisign stores them. */
  keyId: Buffer;
  /** Raw 32-byte Ed25519 key. */
  key: Buffer;
}

export interface SecretKey {
  keyId: Buffer;
  private: KeyObject;
}

/** Key id as minisign prints it: the 8 bytes as a little-endian u64, upper hex. */
export function keyIdOf(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

function rawFromPublic(k: KeyObject): Buffer {
  const jwk = k.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new SignatureError("not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url");
}

function publicObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export function generateKeys(passphrase?: string): {
  publicKey: string;
  secretKey: string;
  keyId: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const pk = rawFromPublic(publicKey);
  const id = keyIdOf(keyId);
  const publicKeyPem = `untrusted comment: minisign public key ${id}\n${Buffer.concat([Buffer.from("Ed"), keyId, pk]).toString("base64")}\n`;
  const pem = privateKey.export(
    passphrase
      ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }
      : { type: "pkcs8", format: "pem" }
  ) as string;
  const secret =
    JSON.stringify(
      {
        format: "kitsuden-signing-key",
        version: 1,
        keyId: keyId.toString("hex"),
        publicKey: Buffer.concat([Buffer.from("Ed"), keyId, pk]).toString("base64"),
        encrypted: Boolean(passphrase),
        pkcs8: pem,
      },
      null,
      2
    ) + "\n";
  return { publicKey: publicKeyPem, secretKey: secret, keyId: id };
}

/** A public key: the minisign file, or just its base64 line. */
export function readPublicKey(text: string): PublicKey {
  const lines = String(text)
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const b64 = lines.find((l) => !l.startsWith("untrusted comment:")) ?? "";
  const b = Buffer.from(b64, "base64");
  if (b.length !== 42 || b.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new SignatureError("not a minisign Ed25519 public key");
  }
  return { keyId: Buffer.from(b.subarray(2, 10)), key: Buffer.from(b.subarray(10)) };
}

export function publicKeyInBase64(k: PublicKey): string {
  return Buffer.concat([Buffer.from("Ed"), k.keyId, k.key]).toString("base64");
}

export function readSecretKey(text: string, passphrase?: string): SecretKey {
  let j: {
    format?: string;
    keyId?: string;
    pkcs8?: string;
    encrypted?: boolean;
    publicKey?: string;
  };
  try {
    j = JSON.parse(text);
  } catch {
    throw new SignatureError("not a kitsuden signing key file");
  }
  if (j.format !== "kitsuden-signing-key" || !j.keyId || !j.pkcs8)
    throw new SignatureError("not a kitsuden signing key file");
  if (j.encrypted && !passphrase)
    throw new SignatureError("the signing key is encrypted: set KITSUDEN_SIGNING_PASSPHRASE");
  let privateKeyPem: KeyObject;
  try {
    privateKeyPem = createPrivateKey(
      j.encrypted ? { key: j.pkcs8, format: "pem", passphrase } : { key: j.pkcs8, format: "pem" }
    );
  } catch {
    throw new SignatureError("could not open the signing key (wrong passphrase?)");
  }
  if (privateKeyPem.asymmetricKeyType !== "ed25519")
    throw new SignatureError("the signing key is not Ed25519");
  const keyId = Buffer.from(j.keyId, "hex");
  if (keyId.length !== 8) throw new SignatureError("bad key id in the signing key file");
  if (j.publicKey) {
    const pub = readPublicKey(j.publicKey);
    if (!pub.key.equals(rawFromPublic(createPublicKey(privateKeyPem))))
      throw new SignatureError("key file is inconsistent");
  }
  return { keyId, private: privateKeyPem };
}

export function publicOrSecret(s: SecretKey): PublicKey {
  return { keyId: s.keyId, key: rawFromPublic(createPublicKey(s.private)) };
}

function blake2b(data: Buffer): Buffer {
  return createHash("blake2b512").update(data).digest();
}

/** A minisign signature file for `data`, with a signed `comment`. */
export function signData(data: Buffer, s: SecretKey, comment: string): string {
  if (/[\r\n]/.test(comment)) throw new SignatureError("trusted comment must be one line");
  const sig = sign(null, blake2b(data), s.private);
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment, "utf8")]), s.private);
  return (
    `untrusted comment: signature from kitsuden kon key ${keyIdOf(s.keyId)}\n` +
    `${Buffer.concat([Buffer.from("ED"), s.keyId, sig]).toString("base64")}\n` +
    `trusted comment: ${comment}\n` +
    `${global.toString("base64")}\n`
  );
}

export interface SignatureRead {
  algorithm: "ED" | "Ed";
  keyId: Buffer;
  signature: Buffer;
  comment: string;
  global: Buffer;
}

export function readSignature(text: string): SignatureRead {
  const l = String(text).split(/\r?\n/);
  if (
    l.length < 4 ||
    !l[0]!.startsWith("untrusted comment:") ||
    !l[2]!.startsWith("trusted comment: ")
  ) {
    throw new SignatureError("not a minisign signature");
  }
  const b = Buffer.from(l[1]!.trim(), "base64");
  const alg = b.subarray(0, 2).toString("latin1");
  if (b.length !== 74 || (alg !== "ED" && alg !== "Ed"))
    throw new SignatureError("unsupported signature algorithm");
  const global = Buffer.from(l[3]!.trim(), "base64");
  if (global.length !== 64) throw new SignatureError("bad global signature");
  return {
    algorithm: alg as "ED" | "Ed",
    keyId: Buffer.from(b.subarray(2, 10)),
    signature: Buffer.from(b.subarray(10)),
    comment: l[2]!.slice("trusted comment: ".length),
    global,
  };
}

/**
 * Verifies a minisign signature against ONE key. Returns the trusted comment
 * (already authenticated) or throws. Never returns on a mismatch.
 */
export function verifySignature(data: Buffer, signatureText: string, key: PublicKey): string {
  const f = readSignature(signatureText);
  if (!f.keyId.equals(key.keyId)) {
    throw new SignatureError(`signed with key ${keyIdOf(f.keyId)}, expected ${keyIdOf(key.keyId)}`);
  }
  const pub = publicObject(key.key);
  const message = f.algorithm === "ED" ? blake2b(data) : data;
  if (!verify(null, message, pub, f.signature))
    throw new SignatureError("signature does not match the data (tampered?)");
  if (!verify(null, Buffer.concat([f.signature, Buffer.from(f.comment, "utf8")]), pub, f.global)) {
    throw new SignatureError("trusted comment signature does not match (tampered?)");
  }
  return f.comment;
}

/** `kitsuden-kon id=kon-x version=1.0.0 sha256=…` → {id, version, sha256}. */
export function commentFields(comment: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const part of comment.split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) output[part.slice(0, i)] = part.slice(i + 1);
    else if (part) output["#"] = part;
  }
  return output;
}
