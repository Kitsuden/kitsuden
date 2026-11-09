/**
 * The registry client — fetch, verify, stage, diff, install, lock
 * ============================================================================
 *
 * No processes here (no pnpm, no migrations): `commands/kon.ts` adds those,
 * exactly as for a source install. The order is the point:
 *
 *   1. load the index and verify its signature with the configured registry key
 *      (and its serial against the lockfile: no rollback);
 *   2. resolve versions (semver, yanked, advisories, core range, SDK);
 *   3. download each package, check size + SHA-256 against the index, verify the
 *      publisher signature and its signed comment, parse the tarball
 *      defensively and extract it into a fresh staging folder;
 *   4. re-validate the manifest INSIDE the package and require it to equal the
 *      one the signed index announced; recompute the content hash;
 *   5. compute the permission diff against what is installed;
 *   — only now does the caller ask the human —
 *   6. hand the staged folder to the normal copy installer (`installKons`) and
 *      write the lockfile.
 *
 * Nothing in packages/kons or kitsuden.kons.json changes before step 6, and a
 * failure anywhere before it leaves the project as it was.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { validateManifest, type NormalizedManifest } from "./manifest.js";
import { permissionsDiff, type PermissionsDiff } from "./permissions.js";
import { readLock, resolver, type Blocking, type Choice, type LockInput } from "./resolver.js";
import { keyIdOf, readPublicKey } from "./signature.js";
import { LIMITS, extract, filesFingerprint, readPackage, sha256 } from "./tar.js";

import {
  RecordError,
  loadIndex,
  editorKey,
  bring,
  relativeUrl,
  verifyPackage,
  type VerifiedIndex,
} from "./index.js";

export const RECORDS_FILE = "kitsuden.registries.json";

export interface ConfiguredRegistry {
  url: string;
  /** Registry public key (minisign base64 line or file contents). */
  key?: string;
  /** Optional: only these publisher key ids are accepted from this registry. */
  trustedPublishers?: string[];
}

export interface RecordsFile {
  default?: string;
  registries: Record<string, ConfiguredRegistry>;
}

export function readRecords(root: string): RecordsFile {
  const route = join(root, RECORDS_FILE);
  if (!existsSync(route)) return { registries: {} };
  const j = JSON.parse(readFileSync(route, "utf8")) as RecordsFile;
  return { default: j.default, registries: j.registries ?? {} };
}

export function hasConfiguredRegistry(root: string): boolean {
  return (
    Boolean(process.env.KITSUDEN_KON_REGISTRY) ||
    Object.keys(readRecords(root).registries).length > 0
  );
}

export interface ChosenRegistry {
  name: string;
  url: string;
  key: string | null;
  trustedEditors?: string[];
}

/** A key given as a file path, or inline (base64 line / minisign file text). */
function keyText(value: string | undefined, root: string): string | null {
  if (!value) return null;
  const route = isAbsolute(value) ? value : resolve(root, value);
  if (!value.includes("\n") && value.length < 300 && existsSync(route))
    return readFileSync(route, "utf8");
  return value;
}

export function chooseRecord(
  root: string,
  o: { registry?: string; registryKey?: string }
): ChosenRegistry {
  const conf = readRecords(root);
  const request =
    o.registry ||
    process.env.KITSUDEN_KON_REGISTRY ||
    conf.default ||
    Object.keys(conf.registries)[0];
  if (!request) {
    throw new RecordError(
      `no kon registry configured: create ${RECORDS_FILE} or pass --registry <name|path|url> (see docs/kons/registry.md)`
    );
  }
  const r = conf.registries[request];
  const url = r
    ? /^[a-z]+:\/\//i.test(r.url) || isAbsolute(r.url)
      ? r.url
      : resolve(root, r.url)
    : request;
  const key = keyText(o.registryKey || process.env.KITSUDEN_KON_REGISTRY_KEY || r?.key, root);
  if (key) readPublicKey(key); // fail early on a malformed key
  return { name: r ? request : "cli", url, key, trustedEditors: r?.trustedPublishers };
}

/** `--allow-unsigned` is for local development: refused when KITSUDEN_PUBLIC=true. */
export function allowUnsigned(request: boolean | undefined): boolean {
  if (!request) return false;
  if (String(process.env.KITSUDEN_PUBLIC ?? "").toLowerCase() === "true") {
    throw new RecordError(
      "--allow-unsigned is refused when KITSUDEN_PUBLIC=true (a public deployment installs signed kons only)"
    );
  }
  return true;
}

export async function openRegistry(
  root: string,
  o: { registry?: string; registryKey?: string; allowUnsigned?: boolean },
  blocking?: Blocking
): Promise<{ registry: ChosenRegistry; verified: VerifiedIndex; withoutSignature: boolean }> {
  const registry = chooseRecord(root, o);
  const withoutSignature = allowUnsigned(o.allowUnsigned);
  const seen = blocking?.registries[registry.name]?.serial;
  const verified = await loadIndex(registry.url, {
    key: registry.key,
    allowUnsigned: withoutSignature,
    seenSerial: seen,
  });
  return { registry, verified, withoutSignature };
}

/** The core version: running API (`/api/version` → version) or the root package.json. */
export function codeCoreVersion(root: string): string | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function migrationsOf(dir: string): string[] {
  const m = join(dir, "migrations");
  if (!existsSync(m)) return [];
  return readdirSync(m, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
}

/** Validate a kon folder as the spec requires (publish, and again after extraction). */
export function dirManifest(dir: string, forPublish: boolean) {
  const konJson = join(dir, "kon.json");
  if (!existsSync(konJson)) throw new RecordError(`${dir}: no kon.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(konJson, "utf8"));
  } catch (e) {
    throw new RecordError(`${konJson}: not valid JSON (${(e as Error).message})`);
  }
  let pkg: Record<string, unknown> | null = null;
  if (existsSync(join(dir, "package.json"))) {
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (e) {
      throw new RecordError(`${dir}/package.json: not valid JSON (${(e as Error).message})`);
    }
  }
  return validateManifest(raw, { forPublish, package: pkg, migrations: migrationsOf(dir) });
}

export interface PreparedKon {
  choice: Choice;
  manifest: NormalizedManifest;
  diff: PermissionsDiff;
  /** Already installed at this exact version and content: nothing to copy. */
  withoutChanges: boolean;
  lockInput: LockInput;
}

export interface Preparation {
  staging: string;
  kons: PreparedKon[];
  warnings: string[];
  verified: VerifiedIndex;
  registry: ChosenRegistry;
}

export interface PrepareOptions {
  root: string;
  requested: Record<string, string>;
  update?: Set<string> | "all";
  registry?: string;
  registryKey?: string;
  allowUnsigned?: boolean;
  coreVersion: string | null;
  coreSdk: number | null;
  /** id → {version, hash, mode, source} from kitsuden.kons.json */
  installed: Record<
    string,
    { version?: string; hash?: string; mode?: string; source?: string; dir?: string | null }
  >;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function prepareInstall(o: PrepareOptions): Promise<Preparation> {
  const blocking = readLock(o.root);
  const {
    registry: registry,
    verified,
    withoutSignature,
  } = await openRegistry(o.root, o, blocking);
  const { index: index } = verified;

  // Kons installed from a source folder satisfy dependencies without the registry.
  const installedOutside: Record<string, string | undefined> = {};
  for (const [id, e] of Object.entries(o.installed)) {
    if (!blocking.kons[id] && !(e.source ?? "").startsWith("registry:"))
      installedOutside[id] = e.version;
  }
  const { plan, warnings: warnings } = resolver({
    index,
    requested: o.requested,
    blocking,
    update: o.update,
    coreVersion: o.coreVersion,
    coreSdk: o.coreSdk,
    installedOutside,
  });

  const staging = join(o.root, ".kitsuden", "registry-staging", randomBytes(6).toString("hex"));
  const cache = join(o.root, ".kitsuden", "kons-cache", "registry");
  mkdirSync(join(staging, "kons"), { recursive: true });
  mkdirSync(cache, { recursive: true });
  const kons: PreparedKon[] = [];
  try {
    for (const choice of plan) {
      const { id, version, input: input } = choice;
      if (registry.trustedEditors && !registry.trustedEditors.includes(input.keyId)) {
        throw new RecordError(
          `${id}@${version} is signed by ${input.keyId}, which is not in trustedPublishers of registry "${registry.name}"`
        );
      }
      const pinned = blocking.kons[id];
      if (pinned && pinned.version === version && pinned.sha256 !== input.sha256) {
        throw new RecordError(
          `${id}@${version}: the registry now serves a different package (SHA-256) than the one in ${"kitsuden.kons.lock"}. ` +
            `Published versions are immutable: refusing.`
        );
      }
      const urlTgz = relativeUrl(verified.url, input.tarball);
      const tgz = await bring(urlTgz, LIMITS.compressed);
      let signature: string | null = null;
      try {
        signature = (await bring(relativeUrl(verified.url, input.signature), 4096)).toString(
          "utf8"
        );
      } catch {
        signature = null;
      }
      const { signed, keyId } = verifyPackage(index, id, version, tgz, signature, {
        allowUnsigned: withoutSignature,
      });

      const files = readPackage(tgz);
      const contentHash = filesFingerprint(files);
      if (contentHash !== input.contentHash) {
        throw new RecordError(`${id}@${version}: content hash does not match the index`);
      }
      const dir = join(staging, "kons", id);
      extract(files, dir);
      const r = dirManifest(dir, true);
      if (!r.ok || !r.manifest) {
        throw new RecordError(
          `${id}@${version}: the manifest inside the package is invalid:\n  ${r.errors.join("\n  ")}`
        );
      }
      if (!equal(r.manifest, input.manifest)) {
        throw new RecordError(
          `${id}@${version}: the manifest inside the package differs from the one in the signed index`
        );
      }
      if (r.manifest.id !== id || r.manifest.version !== version) {
        throw new RecordError(
          `${id}@${version}: the package declares ${r.manifest.id}@${r.manifest.version}`
        );
      }
      writeFileSync(join(cache, `${input.sha256}.tgz`), tgz);
      if (signature) writeFileSync(join(cache, `${input.sha256}.tgz.minisig`), signature);

      // Baseline for the diff: the lockfile, else the installed kon.json.
      const prior = blocking.kons[id];
      let before: { manifest: NormalizedManifest | null; keyId?: string | null } | null = null;
      if (prior) before = { manifest: prior.manifest, keyId: prior.keyId };
      else if (o.installed[id]?.dir) {
        const v = dirManifest(o.installed[id]!.dir!, false);
        before = { manifest: v.manifest ?? null };
      }
      const diff = permissionsDiff(before, { manifest: r.manifest, keyId });
      const inst = o.installed[id];
      const withoutChanges = Boolean(
        prior && prior.version === version && inst?.hash === contentHash
      );
      const publicKey = signed ? (index.publishers[input.keyId]?.publicKey ?? null) : null;
      kons.push({
        choice,
        manifest: r.manifest,
        diff,
        withoutChanges,
        lockInput: {
          version,
          registry: registry.name,
          tarball: urlTgz.href,
          sha256: input.sha256,
          contentHash,
          keyId,
          signed,
          license: r.manifest.license,
          ...(choice.direct
            ? { requested: o.requested[id] }
            : prior?.requested
              ? { requested: prior.requested }
              : {}),
          dependencies: r.manifest.dependencies,
          manifest: r.manifest,
          ...(publicKey ? { publicKey } : {}),
        } as LockInput,
      });
    }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return { staging, kons, warnings, verified, registry };
}

export function cleanStaging(p: Preparation): void {
  rmSync(p.staging, { recursive: true, force: true });
}

/** Writes the lockfile entries for what was installed (and the registry serial). */
export function updateBlocking(
  root: string,
  p: Preparation,
  write: (b: Blocking) => void
): Blocking {
  const b = readLock(root);
  b.registries[p.registry.name] = {
    url: p.registry.url,
    keyId: p.verified.keyId,
    serial: Math.max(p.verified.index.serial, b.registries[p.registry.name]?.serial ?? 0),
  };
  for (const k of p.kons) b.kons[k.choice.id] = k.lockInput;
  write(b);
  return b;
}

/** Re-verify a cached package of the lockfile offline: hash + publisher signature. */
export function verifyFromCache(
  root: string,
  id: string,
  e: LockInput & { publicKey?: string }
): string[] {
  const problems: string[] = [];
  const cache = join(root, ".kitsuden", "kons-cache", "registry", `${e.sha256}.tgz`);
  if (!existsSync(cache))
    return [`${id}: package not in the local cache (run kon sync to fetch it again)`];
  const tgz = readFileSync(cache);
  if (sha256(tgz) !== e.sha256)
    problems.push(`${id}: cached package SHA-256 differs from the lockfile`);
  if (e.signed) {
    const sig = join(cache + ".minisig");
    if (!existsSync(sig) || !e.publicKey)
      problems.push(`${id}: signature or publisher key missing from cache/lockfile`);
    else {
      try {
        const key = readPublicKey(e.publicKey);
        if (keyIdOf(key.keyId) !== e.keyId)
          throw new Error("publisher key id differs from the lockfile");
        const fakeIndex = {
          kons: {
            [id]: {
              owners: [e.keyId!],
              versions: {
                [e.version]: {
                  sha256: e.sha256,
                  size: tgz.length,
                  contentHash: e.contentHash,
                  keyId: e.keyId!,
                  signature: "",
                  tarball: "",
                  manifest: e.manifest,
                  publishedAt: "",
                },
              },
            },
          },
          publishers: { [e.keyId!]: { name: "", publicKey: e.publicKey } },
          revokedKeys: [],
          advisories: [],
        } as unknown as Parameters<typeof verifyPackage>[0];
        verifyPackage(fakeIndex, id, e.version, tgz, readFileSync(sig, "utf8"));
        editorKey(fakeIndex, id, fakeIndex.kons[id]!.versions[e.version]!);
      } catch (err) {
        problems.push(`${id}: ${(err as Error).message}`);
      }
    }
  }
  try {
    if (filesFingerprint(readPackage(tgz)) !== e.contentHash)
      problems.push(`${id}: cached package content differs from the lockfile`);
  } catch (err) {
    problems.push(`${id}: ${(err as Error).message}`);
  }
  return problems;
}
