/**
 * Publishing side: pack + sign + add to a LOCAL registry folder, yank, revoke
 * ============================================================================
 *
 * `kon publish` never uploads anything. It writes into a registry folder on
 * disk (index.json, its signature, packages/<id>/…); hosting that folder
 * (GitHub Pages, R2, a git repo) is a separate, deliberate step.
 *
 * Published versions are IMMUTABLE: the same id@version cannot be published
 * twice; a bad release is yanked (hidden from new resolution) or revoked by an
 * advisory (refused everywhere), and a new version is published.
 *
 * Before changing an existing index, its current signature is verified with the
 * registry key being used: nobody re-signs an index someone else tampered with.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dirManifest } from "./client.js";
import { CORE_KONS, type NormalizedManifest } from "./manifest.js";
import { parse, validRange } from "./semver.js";
import {
  signData,
  readSecretKey,
  publicOrSecret,
  verifySignature,
  type SecretKey,
} from "./signature.js";
import { packFiles, filesToPackage, filesFingerprint, readPackage, sha256 } from "./tar.js";

import {
  RecordError,
  addEditor,
  packageComment,
  writeLocalIndex,
  readLocalIndex,
  type Warning,
  type Index,
} from "./index.js";

export function openKey(route: string): SecretKey {
  if (!existsSync(route)) throw new RecordError(`signing key not found: ${route}`);
  return readSecretKey(
    readFileSync(route, "utf8"),
    process.env.KITSUDEN_SIGNING_PASSPHRASE || undefined
  );
}

/** Opens the local index and checks its current signature with the registry key. */
export function openIndexForWriting(dir: string, recordKey: SecretKey, name: string): Index {
  const route = join(dir, "index.json");
  if (existsSync(route)) {
    const sig = join(dir, "index.json.minisig");
    if (!existsSync(sig))
      throw new RecordError(`${route} exists but is not signed: refusing to sign over it`);
    try {
      verifySignature(readFileSync(route), readFileSync(sig, "utf8"), publicOrSecret(recordKey));
    } catch (e) {
      throw new RecordError(
        `the current index does not verify with this registry key: ${(e as Error).message}`
      );
    }
  }
  return readLocalIndex(dir, name);
}

export interface PublishResult {
  id: string;
  version: string;
  sha256: string;
  contentHash: string;
  size: number;
  tarball: string;
  keyId: string;
  warnings: string[];
  manifest: NormalizedManifest;
}

export interface PublishOptions {
  dir: string;
  registryDir: string;
  registryName?: string;
  key: SecretKey;
  recordKey?: SecretKey;
  /** Let the registry key holder add this publisher as a new owner of an existing kon. */
  addOwner?: boolean;
  dryRun?: boolean;
}

/** Pack, sign and add one kon folder to the registry. */
export function publish(o: PublishOptions): PublishResult {
  const r = dirManifest(o.dir, true);
  if (!r.ok || !r.manifest) {
    throw new RecordError(`the manifest is not publishable:\n  ${r.errors.join("\n  ")}`);
  }
  const m = r.manifest;
  const warnings = [...r.warnings];
  if (parse(m.version)?.pre.length)
    warnings.push(`${m.version} is a pre-release: "*" and "^x" ranges will not pick it`);

  const files = filesToPackage(o.dir);
  if (!files.some((f) => f.path === "kon.json"))
    throw new RecordError("kon.json must be at the root of the kon folder");
  const tgz = packFiles(files);
  const contentHash = filesFingerprint(files);
  if (filesFingerprint(readPackage(tgz)) !== contentHash)
    throw new RecordError("internal: package round trip failed");
  const sha = sha256(tgz);

  const recordKey = o.recordKey ?? o.key;
  const index = openIndexForWriting(o.registryDir, recordKey, o.registryName ?? "local");
  const kon = index.kons[m.id];
  if (kon?.versions[m.version]) {
    throw new RecordError(
      `${m.id}@${m.version} is already published; versions are immutable — bump the version`
    );
  }
  const keyId = addEditor(index, publicOrSecret(o.key), m.author?.name ?? "unknown");
  if (kon && !kon.owners.includes(keyId)) {
    if (!(o.addOwner && o.recordKey)) {
      throw new RecordError(
        `${m.id} is owned by ${kon.owners.join(", ")}; key ${keyId} cannot publish it ` +
          `(the registry key holder can add it with --add-owner)`
      );
    }
    kon.owners.push(keyId);
  }
  for (const dep of Object.keys(m.dependencies)) {
    if (!CORE_KONS.has(dep) && !index.kons[dep])
      warnings.push(`dependency ${dep} is not in this registry yet`);
  }

  const rel = `packages/${m.id}/${m.id}-${m.version}.tgz`;
  const result: PublishResult = {
    id: m.id,
    version: m.version,
    sha256: sha,
    contentHash,
    size: tgz.length,
    tarball: rel,
    keyId,
    warnings,
    manifest: m,
  };
  if (o.dryRun) return result;

  const signature = signData(tgz, o.key, packageComment(m.id, m.version, sha, contentHash));
  mkdirSync(join(o.registryDir, "packages", m.id), { recursive: true });
  const tgzPath = join(o.registryDir, rel);
  if (existsSync(tgzPath)) throw new RecordError(`${rel} already exists in the registry folder`);
  writeFileSync(tgzPath, tgz, { flag: "wx" });
  writeFileSync(tgzPath + ".minisig", signature);

  const target = (index.kons[m.id] ??= { owners: [keyId], versions: {} });
  target.description = m.description;
  target.license = m.license;
  target.repository = m.repository?.url ?? null;
  target.versions[m.version] = {
    tarball: rel,
    signature: `${rel}.minisig`,
    sha256: sha,
    size: tgz.length,
    contentHash,
    keyId,
    manifest: m,
    publishedAt: new Date().toISOString(),
    yanked: false,
    yankReason: null,
  };
  writeLocalIndex(o.registryDir, index, recordKey);
  return result;
}

export interface WithdrawalOptions {
  registryDir: string;
  recordKey: SecretKey;
  id: string;
  version: string;
  reason?: string;
  undo?: boolean;
}

/** Yank (or un-yank) one version: hidden from new resolution, kept for lockfiles. */
export function withdraw(o: WithdrawalOptions): void {
  const index = openIndexForWriting(o.registryDir, o.recordKey, "local");
  const v = index.kons[o.id]?.versions[o.version];
  if (!v) throw new RecordError(`${o.id}@${o.version} is not in this registry`);
  v.yanked = !o.undo;
  v.yankReason = o.undo ? null : (o.reason ?? null);
  writeLocalIndex(o.registryDir, index, o.recordKey);
}

export interface NotificationOptions {
  registryDir: string;
  recordKey: SecretKey;
  id: string;
  versions: string;
  summary: string;
  severity: Warning["severity"];
  revoke: boolean;
}

/** Add an advisory; with `revoke`, the versions are refused even when locked. */
export function addNotification(o: NotificationOptions): Warning {
  if (!validRange(o.versions)) throw new RecordError(`not a semver range: ${o.versions}`);
  if (!["low", "moderate", "high", "critical"].includes(o.severity))
    throw new RecordError(`bad severity: ${o.severity}`);
  const index = openIndexForWriting(o.registryDir, o.recordKey, "local");
  if (!index.kons[o.id]) throw new RecordError(`${o.id} is not in this registry`);
  const year = new Date().getUTCFullYear();
  const n = index.advisories.filter((a) => a.id.startsWith(`KKA-${year}-`)).length + 1;
  const warning: Warning = {
    id: `KKA-${year}-${String(n).padStart(4, "0")}`,
    kon: o.id,
    versions: o.versions,
    severity: o.severity,
    summary: o.summary.replace(/[\r\n]+/g, " ").slice(0, 500),
    revoked: o.revoke,
    publishedAt: new Date().toISOString(),
  };
  index.advisories.push(warning);
  writeLocalIndex(o.registryDir, index, o.recordKey);
  return warning;
}

/** Re-sign the index as it is, with a later serial and a fresh expiry. */
export function renewIndex(dir: string, recordKey: SecretKey, validityDays?: number): Index {
  const index = openIndexForWriting(dir, recordKey, "local");
  return writeLocalIndex(dir, index, recordKey, validityDays);
}

/** Revoke a publisher key: every package it signed stops verifying. */
export function revokeKey(dir: string, recordKey: SecretKey, keyId: string): void {
  const index = openIndexForWriting(dir, recordKey, "local");
  index.revokedKeys = [...new Set([...(index.revokedKeys ?? []), keyId])];
  writeLocalIndex(dir, index, recordKey);
}
