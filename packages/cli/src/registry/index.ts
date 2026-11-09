/**
 * The registry index — one signed JSON document, hostable anywhere static
 * ============================================================================
 *
 *   <registry>/index.json            the index (format below)
 *   <registry>/index.json.minisig    its signature, by the REGISTRY key
 *   <registry>/packages/<id>/<id>-<version>.tgz          the package
 *   <registry>/packages/<id>/<id>-<version>.tgz.minisig  by the PUBLISHER key
 *
 * The folder can be served as is by GitHub Pages, R2/S3, any static host, or a
 * git repository (`file://` or a checkout path). "API mode" is a server that
 * answers the same three paths (it may generate them): the client only ever
 * GETs `index.json`, `index.json.minisig` and the tarball URLs the index names.
 *
 * Trust: the user configures the REGISTRY public key (kitsuden.registries.json).
 * The signed index says which PUBLISHER keys may publish each kon (`owners`),
 * lists yanked versions, advisories (revocations) and revoked keys. A package is
 * accepted only if its own signature verifies with an owner key of the signed
 * index AND its signed comment names the same id, version and SHA-256 as the
 * index. Compromising the static host alone is not enough to ship code: it
 * needs the registry key (to change owners) or a publisher key (to sign).
 *
 * Rollback: the index carries a `serial` that only grows. The client keeps the
 * highest one it saw per registry in `kitsuden.kons.lock` and refuses an older
 * index. A fresh checkout with no lockfile has no floor yet, so the signed
 * `expires` is what limits how long a host can keep serving an old index: every
 * write sets it (INDEX_VALIDITY_DAYS by default) and the client enforces
 * it. A registry with nothing new to publish runs `kitsuden kon resign`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { NormalizedManifest } from "./manifest.js";
import { satisfies, sortDesc } from "./semver.js";
import {
  SignatureError,
  commentFields,
  publicKeyInBase64,
  signData,
  keyIdOf,
  readPublicKey,
  verifySignature,
  type PublicKey,
  type SecretKey,
} from "./signature.js";
import { LIMITS, sha256 } from "./tar.js";

export const INDEX_FORMAT = "kitsuden-kon-index";
export const INDEX_VERSION = 1;
/** How long a newly signed index stays valid. */
export const INDEX_VALIDITY_DAYS = 30;

export interface PublishedVersion {
  tarball: string;
  signature: string;
  sha256: string;
  size: number;
  contentHash: string;
  keyId: string;
  manifest: NormalizedManifest;
  publishedAt: string;
  yanked?: boolean;
  yankReason?: string | null;
}

export interface IndexKon {
  owners: string[];
  description?: string;
  license?: string | null;
  repository?: string | null;
  versions: Record<string, PublishedVersion>;
}

export interface Warning {
  id: string;
  kon: string;
  /** Semver range of affected versions. */
  versions: string;
  severity: "low" | "moderate" | "high" | "critical";
  summary: string;
  /** Revoked: refused even when the lockfile pins it. */
  revoked: boolean;
  publishedAt: string;
}

export interface Index {
  format: typeof INDEX_FORMAT;
  version: number;
  registry: string;
  serial: number;
  generatedAt: string;
  expires?: string | null;
  publishers: Record<string, { name: string; publicKey: string }>;
  revokedKeys?: string[];
  kons: Record<string, IndexKon>;
  advisories: Warning[];
}

export class RecordError extends Error {}

export function emptyIndex(name: string): Index {
  return {
    format: INDEX_FORMAT,
    version: INDEX_VERSION,
    registry: name,
    serial: 0,
    generatedAt: new Date(0).toISOString(),
    expires: null,
    publishers: {},
    revokedKeys: [],
    kons: {},
    advisories: [],
  };
}

// ── Locations ───────────────────────────────────────────────────────────────

/** `./reg`, `/abs/reg/index.json`, `file:///…`, `https://…/index.json` → URL of index.json. */
export function indexUrl(location: string, cwd = process.cwd()): URL {
  if (/^https?:\/\//i.test(location) || /^file:\/\//i.test(location)) {
    const u = new URL(location);
    if (!u.pathname.endsWith(".json")) u.pathname = u.pathname.replace(/\/?$/, "/index.json");
    if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
      throw new RecordError(`refusing plain http for a registry (${u.host}); use https`);
    }
    return u;
  }
  const route = isAbsolute(location) ? location : resolve(cwd, location);
  return pathToFileURL(route.endsWith(".json") ? route : join(route, "index.json"));
}

/** The local folder of a file-based registry (for publish/yank). */
export function localDir(location: string, cwd = process.cwd()): string {
  const u = indexUrl(location, cwd);
  if (u.protocol !== "file:") {
    throw new RecordError(
      "publish and yank write to a LOCAL registry folder; upload that folder to your host afterwards"
    );
  }
  return dirname(fileURLToPath(u));
}

export async function bring(url: URL, limit: number): Promise<Buffer> {
  if (url.protocol === "file:") {
    const route = fileURLToPath(url);
    if (!existsSync(route)) throw new RecordError(`not found: ${route}`);
    const data = readFileSync(route);
    if (data.length > limit) throw new RecordError(`${route}: larger than ${limit} bytes`);
    return data;
  }
  const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new RecordError(`GET ${url.href} → ${r.status}`);
  const long = Number(r.headers.get("content-length") ?? 0);
  if (long > limit) throw new RecordError(`${url.href}: larger than ${limit} bytes`);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > limit) throw new RecordError(`${url.href}: larger than ${limit} bytes`);
  return data;
}

/** Resolves a tarball/signature path of the index against the index URL; never leaves its origin. */
export function relativeUrl(base: URL, route: string): URL {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(route) ||
    route.startsWith("/") ||
    route.includes("..") ||
    route.includes("\\")
  ) {
    throw new RecordError(
      `index path must be relative and inside the registry: ${JSON.stringify(route)}`
    );
  }
  return new URL(route, base);
}

// ── Load and verify ─────────────────────────────────────────────────────────

export interface VerifiedIndex {
  index: Index;
  url: URL;
  signed: boolean;
  keyId: string | null;
}

export interface LoadOptions {
  /** Registry public key (minisign). Without it, only --allow-unsigned loads the index. */
  key?: string | null;
  allowUnsigned?: boolean;
  /** Highest serial seen before (rollback protection). */
  seenSerial?: number;
  now?: Date;
}

export function validateIndexShape(j: unknown): Index {
  const i = j as Index;
  if (!i || i.format !== INDEX_FORMAT) throw new RecordError("not a kitsuden kon index");
  if (i.version !== INDEX_VERSION)
    throw new RecordError(`index version ${i.version} is not supported by this CLI`);
  if (!Number.isInteger(i.serial) || i.serial < 0) throw new RecordError("index: bad serial");
  if (!i.kons || typeof i.kons !== "object") throw new RecordError("index: no kons");
  i.advisories ??= [];
  i.publishers ??= {};
  i.revokedKeys ??= [];
  return i;
}

export async function loadIndex(location: string, o: LoadOptions = {}): Promise<VerifiedIndex> {
  const url = indexUrl(location);
  const data = await bring(url, 8 * 1024 * 1024);
  let signed = false;
  let keyId: string | null = null;
  let signedSerial: string | undefined;
  if (o.key) {
    const key = readPublicKey(o.key);
    let signature: Buffer;
    try {
      signature = await bring(new URL(url.href + ".minisig"), 4096);
    } catch {
      throw new RecordError(`the registry index is not signed (${url.href}.minisig missing)`);
    }
    let comment: string;
    try {
      comment = verifySignature(data, signature.toString("utf8"), key);
    } catch (e) {
      throw new RecordError(`registry index signature: ${(e as SignatureError).message}`);
    }
    const c = commentFields(comment);
    if (c["#"] !== "kitsuden-index" || c.sha256 !== sha256(data)) {
      throw new RecordError("registry index: the signed comment does not describe this index");
    }
    signed = true;
    keyId = keyIdOf(key.keyId);
    signedSerial = c.serial;
  } else if (!o.allowUnsigned) {
    throw new RecordError(
      "no public key is configured for this registry: add its key to kitsuden.registries.json " +
        "(or --registry-key). --allow-unsigned exists for local development only."
    );
  }
  let index: Index;
  try {
    index = validateIndexShape(JSON.parse(data.toString("utf8")));
  } catch (e) {
    throw e instanceof RecordError
      ? e
      : new RecordError(`index is not valid JSON: ${(e as Error).message}`);
  }
  if (signed && signedSerial !== String(index.serial)) {
    throw new RecordError("registry index: the signed serial does not match the index");
  }
  if (o.seenSerial !== undefined && index.serial < o.seenSerial) {
    throw new RecordError(
      `registry index serial ${index.serial} is older than one already seen (${o.seenSerial}): possible rollback, refusing`
    );
  }
  if (index.expires && new Date(index.expires).getTime() < (o.now ?? new Date()).getTime()) {
    throw new RecordError(
      `registry index expired at ${index.expires}: the registry must re-sign it`
    );
  }
  return { index, url, signed, keyId };
}

// ── Questions about the index ───────────────────────────────────────────────

/** Advisories that revoke (or just warn about) this version. */
export function warningsOf(index: Index, id: string, version: string): Warning[] {
  return index.advisories.filter((a) => a.kon === id && satisfies(version, a.versions));
}

export function isRevoked(index: Index, id: string, version: string): Warning | null {
  return warningsOf(index, id, version).find((a) => a.revoked) ?? null;
}

export function versionsOf(index: Index, id: string): string[] {
  return sortDesc(Object.keys(index.kons[id]?.versions ?? {}));
}

/** The publisher key of a version, checked against the index (owner, not revoked). */
export function editorKey(index: Index, id: string, v: PublishedVersion): PublicKey {
  const kon = index.kons[id];
  if (!kon) throw new RecordError(`${id} is not in the index`);
  if (!kon.owners.includes(v.keyId))
    throw new RecordError(`${id}: key ${v.keyId} is not an owner of this kon`);
  if (index.revokedKeys?.includes(v.keyId))
    throw new RecordError(`${id}: publisher key ${v.keyId} has been revoked`);
  const p = index.publishers[v.keyId];
  if (!p) throw new RecordError(`${id}: publisher key ${v.keyId} is not listed in the index`);
  const key = readPublicKey(p.publicKey);
  if (keyIdOf(key.keyId) !== v.keyId) throw new RecordError(`${id}: publisher key id mismatch`);
  return key;
}

export function packageComment(
  id: string,
  version: string,
  sha: string,
  contentHash: string
): string {
  return `kitsuden-kon id=${id} version=${version} sha256=${sha} content=${contentHash} timestamp=${Math.floor(Date.now() / 1000)}`;
}

/**
 * Checks a downloaded package against the signed index: size, SHA-256, the
 * publisher's signature and its signed comment. Throws on any mismatch.
 */
export function verifyPackage(
  index: Index,
  id: string,
  version: string,
  tgz: Buffer,
  signature: string | null,
  o: { allowUnsigned?: boolean } = {}
): { signed: boolean; keyId: string | null } {
  const v = index.kons[id]?.versions[version];
  if (!v) throw new RecordError(`${id}@${version} is not in the index`);
  if (tgz.length !== v.size)
    throw new RecordError(`${id}@${version}: size ${tgz.length} ≠ index ${v.size} (tampered?)`);
  if (tgz.length > LIMITS.compressed) throw new RecordError(`${id}@${version}: package too large`);
  const sha = sha256(tgz);
  if (sha !== v.sha256)
    throw new RecordError(`${id}@${version}: SHA-256 does not match the index (tampered?)`);
  if (!signature) {
    if (o.allowUnsigned) return { signed: false, keyId: null };
    throw new RecordError(
      `${id}@${version} is not signed. Unsigned packages are refused (--allow-unsigned is for local development only).`
    );
  }
  const key = editorKey(index, id, v);
  let comment: string;
  try {
    comment = verifySignature(tgz, signature, key);
  } catch (e) {
    throw new RecordError(`${id}@${version}: ${(e as Error).message}`);
  }
  const c = commentFields(comment);
  if (
    c["#"] !== "kitsuden-kon" ||
    c.id !== id ||
    c.version !== version ||
    c.sha256 !== sha ||
    c.content !== v.contentHash
  ) {
    throw new RecordError(
      `${id}@${version}: the signature was made for a different package (${comment})`
    );
  }
  return { signed: true, keyId: v.keyId };
}

// ── Writing (local registry folder) ─────────────────────────────────────────

export function readLocalIndex(dir: string, name = "local"): Index {
  const route = join(dir, "index.json");
  if (!existsSync(route)) return emptyIndex(name);
  return validateIndexShape(JSON.parse(readFileSync(route, "utf8")));
}

/** Writes index.json (serial + 1, fresh `expires`) and signs it with the registry key. */
export function writeLocalIndex(
  dir: string,
  index: Index,
  recordKey: SecretKey,
  validityDays: number = INDEX_VALIDITY_DAYS
): Index {
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const next: Index = {
    ...index,
    serial: index.serial + 1,
    generatedAt: new Date(now).toISOString(),
    expires: new Date(now + validityDays * 86_400_000).toISOString(),
  };
  const sorted: Index = {
    ...next,
    kons: Object.fromEntries(Object.entries(next.kons).sort(([a], [b]) => a.localeCompare(b))),
  };
  const data = Buffer.from(JSON.stringify(sorted, null, 2) + "\n", "utf8");
  writeFileSync(join(dir, "index.json"), data);
  const comment = `kitsuden-index registry=${index.registry} serial=${next.serial} sha256=${sha256(data)}`;
  writeFileSync(join(dir, "index.json.minisig"), signData(data, recordKey, comment));
  return sorted;
}

export function addEditor(index: Index, key: PublicKey, name: string): string {
  const id = keyIdOf(key.keyId);
  if (index.revokedKeys?.includes(id))
    throw new RecordError(`key ${id} is revoked in this registry`);
  index.publishers[id] ??= { name, publicKey: publicKeyInBase64(key) };
  return id;
}
