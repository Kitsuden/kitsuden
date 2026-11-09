/**
 * `kitsuden kon search|info|add <id>@<range>|update|outdated|sync|publish|verify|yank|keygen`
 * ============================================================================
 *
 * The registry side of `kitsuden kon`. The logic lives in `../registro/*` (no
 * processes, tested apart); here are the prompts, the output and the call to
 * the same pnpm-install + migration-runner step as a source install.
 *
 * Confirmation rules (like the code promotion pipeline, docs/agents/promotion.md):
 *   · a NEW kon shows its declared permissions and needs a yes: an interactive
 *     answer, or --yes;
 *   · an UPDATE that widens scopes, outbound hosts or sensitive operations (or
 *     changes the signing key) needs an interactive yes, or BOTH --yes and
 *     --accept-wider: --yes alone never accepts wider permissions on update;
 *   · without a terminal and without the flags, nothing is installed (exit 3).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import chalk from "chalk";

import {
  KonError,
  konIdOf,
  installKons,
  readKonsFile,
  inputPath,
  type InstalledKonNow,
} from "../kons/installation.js";
import {
  openRegistry,
  updateBlocking,
  cleanStaging,
  dirManifest,
  prepareInstall,
  verifyFromCache,
  codeCoreVersion,
  type Preparation,
} from "../registry/client.js";
import { warningsOf, localDir, isRevoked, versionsOf } from "../registry/index.js";
import { compatibleWithTheCore } from "../registry/manifest.js";
import { wide, diffText } from "../registry/permissions.js";
import {
  openKey,
  addNotification,
  publish,
  renewIndex,
  withdraw,
  revokeKey,
} from "../registry/publish.js";
import { writeLock, readLock, readRequest, LOCK_FILE } from "../registry/resolver.js";
import { maxSatisfying, satisfies } from "../registry/semver.js";
import {
  generateKeys,
  keyIdOf,
  readPublicKey,
  verifySignature,
  commentFields,
} from "../registry/signature.js";
import { filesFingerprint, readPackage, sha256 } from "../registry/tar.js";

import { fail, postInstallSteps, rootOf, coreSdk, type KonCommandOptions } from "./kon.js";

export interface RegistryOptions extends KonCommandOptions {
  registry?: string;
  registryKey?: string;
  allowUnsigned?: boolean;
  yes?: boolean;
  acceptWider?: boolean;
  dryRun?: boolean;
  // publish / yank
  key?: string;
  indexKey?: string;
  registryName?: string;
  addOwner?: boolean;
  reason?: string;
  undo?: boolean;
  revoke?: boolean;
  advisory?: string;
  severity?: string;
  range?: string;
  revokeKey?: string;
  expiresDays?: string;
  // verify / keygen
  file?: string;
  sig?: string;
  out?: string;
}

export async function askQuestion(text: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const r = (await rl.question(`${text} [y/N] `)).trim().toLowerCase();
    return r === "y" || r === "yes";
  } finally {
    rl.close();
  }
}

async function core(
  root: string,
  o: RegistryOptions
): Promise<{ version: string | null; sdk: number | null }> {
  try {
    const s = await coreSdk(root, o.apiUrl);
    return { version: s.version ?? codeCoreVersion(root), sdk: s.sdk };
  } catch {
    return { version: codeCoreVersion(root), sdk: null };
  }
}

function installedFrom(root: string) {
  const output: Record<
    string,
    { version?: string; hash?: string; mode?: string; source?: string; dir?: string | null }
  > = {};
  for (const [id, e] of Object.entries(readKonsFile(root).kons)) {
    output[id] = {
      version: e.version,
      hash: e.hash,
      mode: e.mode,
      source: e.source,
      dir: inputPath(root, id, e),
    };
  }
  return output;
}

/** Shows the plan and the permission diff; returns whether to go ahead. */
async function confirmPlan(
  p: Preparation,
  o: RegistryOptions,
  isUpdate: boolean
): Promise<boolean> {
  const withChanges = p.kons.filter((k) => !k.withoutChanges);
  console.log(
    chalk.gray(
      `  registry ${p.registry.name} (${p.verified.url.href}) — index serial ${p.verified.index.serial}, ` +
        (p.verified.signed
          ? `signed by ${p.verified.keyId}`
          : chalk.yellow("UNSIGNED (--allow-unsigned)"))
    )
  );
  for (const a of p.warnings) console.log(chalk.yellow(`  ! ${a}`));
  if (!withChanges.length) {
    console.log(chalk.green("✔ Everything is already installed at the resolved versions."));
    return false;
  }
  console.log(chalk.bold("\nPermissions declared by what will be installed:"));
  for (const k of withChanges) {
    const lines = diffText(k.diff, k.manifest);
    const signature = k.lockInput.signed
      ? `signed by ${k.lockInput.keyId}`
      : chalk.yellow("UNSIGNED");
    console.log(
      `  ${chalk.bold(lines[0])}${k.choice.direct ? "" : chalk.gray(" (dependency)")} ${chalk.gray(signature)}`
    );
    for (const l of lines.slice(1))
      console.log(
        l.startsWith("    ! ") ? chalk.red(l) : l.includes("+ ") ? chalk.yellow(l) : chalk.gray(l)
      );
  }
  console.log(chalk.gray("  (+ = new compared with what is installed)"));
  if (o.dryRun) {
    console.log(chalk.cyan("\n--dry-run: nothing installed."));
    return false;
  }
  const widen = withChanges.filter((k) => !k.diff.next && wide(k.diff));
  const newOnes = withChanges.filter((k) => k.diff.next);
  if (widen.length) {
    const list = widen.map((k) => k.choice.id).join(", ");
    console.log(chalk.red(`\n! ${list}: the update WIDENS the declared permissions.`));
    if (o.yes && o.acceptWider) return true;
    if (await askQuestion("Accept the wider permissions?")) return true;
    console.error(
      chalk.red(
        "✖ Not installed. Review the diff above; to accept it non-interactively pass --yes --accept-wider."
      )
    );
    process.exitCode = 3;
    return false;
  }
  if (o.yes) return true;
  if (
    await askQuestion(newOnes.length || !isUpdate ? "Install with these permissions?" : "Update?")
  )
    return true;
  console.error(
    chalk.red("✖ Not installed: confirmation required (answer y, or pass --yes after reviewing).")
  );
  process.exitCode = 3;
  return false;
}

async function installPrepared(
  root: string,
  p: Preparation,
  o: RegistryOptions
): Promise<InstalledKonNow[]> {
  const ids = p.kons.filter((k) => !k.withoutChanges).map((k) => k.choice.id);
  let facts: InstalledKonNow[] = [];
  try {
    facts = installKons(ids, {
      root,
      source: p.staging,
      declaredOrigin: `registry:${p.registry.name}`,
      allowedPlan: new Set(p.kons.map((k) => k.choice.id)),
      enable: o.enable,
      force: o.force,
      coreSdk: (await core(root, o)).sdk ?? 1,
    });
    updateBlocking(root, p, (b) => writeLock(root, b));
  } finally {
    cleanStaging(p);
  }
  for (const k of facts) {
    const dep = k.asDependency ? chalk.gray(" (dependency)") : "";
    console.log(
      chalk.green(`✔ ${k.id}@${k.version}`) + dep + chalk.gray(` → packages/kons/${k.id}`)
    );
  }
  console.log(chalk.gray(`  ${LOCK_FILE} updated`));
  return facts;
}

// ── add / update / sync ─────────────────────────────────────────────────────

export async function konAddFromRegistry(names: string[], o: RegistryOptions): Promise<void> {
  try {
    const root = rootOf(o);
    const requests: Record<string, string> = {};
    for (const n of names) {
      const { id, range } = readRequest(n, konIdOf);
      requests[id] = range;
    }
    const blocking = readLock(root);
    // Keep the ranges of what was asked before, so a new add does not drop them.
    for (const [id, e] of Object.entries(blocking.kons))
      if (e.requested && !(id in requests)) requests[id] = e.requested;
    const n = await core(root, o);
    const p = await prepareInstall({
      root,
      requested: requests,
      update: new Set(names.map((x) => readRequest(x, konIdOf).id)),
      registry: o.registry,
      registryKey: o.registryKey,
      allowUnsigned: o.allowUnsigned,
      coreVersion: n.version,
      coreSdk: n.sdk,
      installed: installedFrom(root),
    });
    if (!(await confirmPlan(p, o, false))) {
      cleanStaging(p);
      return;
    }
    const facts = await installPrepared(root, p, o);
    postInstallSteps(root, facts, o);
  } catch (e) {
    fail(e);
  }
}

export async function konUpdateCommand(names: string[], o: RegistryOptions): Promise<void> {
  try {
    const root = rootOf(o);
    const blocking = readLock(root);
    const requests: Record<string, string> = {};
    for (const [id, e] of Object.entries(blocking.kons))
      if (e.requested) requests[id] = e.requested;
    const ids = names.map(konIdOf);
    for (const id of ids) {
      if (!blocking.kons[id])
        throw new KonError(`${id} was not installed from a registry (not in ${LOCK_FILE})`);
    }
    if (!Object.keys(requests).length)
      throw new KonError(`nothing to update: no registry kons in ${LOCK_FILE}`);
    const n = await core(root, o);
    const p = await prepareInstall({
      root,
      requested: requests,
      update: ids.length ? new Set(ids) : "all",
      registry: o.registry,
      registryKey: o.registryKey,
      allowUnsigned: o.allowUnsigned,
      coreVersion: n.version,
      coreSdk: n.sdk,
      installed: installedFrom(root),
    });
    if (!(await confirmPlan(p, o, true))) {
      cleanStaging(p);
      return;
    }
    const facts = await installPrepared(root, p, o);
    postInstallSteps(root, facts, o);
  } catch (e) {
    fail(e);
  }
}

/** Install exactly what the lockfile says (CI, a fresh checkout, a container build). */
export async function konSyncCommand(o: RegistryOptions): Promise<void> {
  try {
    const root = rootOf(o);
    const blocking = readLock(root);
    const requests: Record<string, string> = {};
    for (const [id, e] of Object.entries(blocking.kons)) requests[id] = `=${e.version}`;
    if (!Object.keys(requests).length) {
      console.log(chalk.gray(`Nothing in ${LOCK_FILE}.`));
      return;
    }
    const n = await core(root, o);
    const p = await prepareInstall({
      root,
      requested: requests,
      registry: o.registry,
      registryKey: o.registryKey,
      allowUnsigned: o.allowUnsigned,
      coreVersion: n.version,
      coreSdk: n.sdk,
      installed: installedFrom(root),
    });
    for (const k of p.kons) {
      const b = blocking.kons[k.choice.id];
      if (b && (b.sha256 !== k.lockInput.sha256 || b.contentHash !== k.lockInput.contentHash)) {
        cleanStaging(p);
        throw new KonError(
          `${k.choice.id}@${k.choice.version}: the registry package differs from the lockfile`
        );
      }
    }
    // The lockfile was already accepted: no permission prompt, unless the
    // signing key changed.
    const changedKey = p.kons.filter((k) => k.diff.keyChanged);
    if (changedKey.length && !(o.yes && o.acceptWider)) {
      cleanStaging(p);
      throw new KonError(
        `${changedKey.map((k) => k.choice.id).join(", ")}: signing key changed since the lockfile`
      );
    }
    if (!p.kons.some((k) => !k.withoutChanges)) {
      cleanStaging(p);
      console.log(chalk.green("✔ Installed kons match the lockfile."));
      return;
    }
    const facts = await installPrepared(root, p, o);
    postInstallSteps(root, facts, o);
  } catch (e) {
    fail(e);
  }
}

export function removeFromLock(root: string, ids: string[]): void {
  if (!existsSync(join(root, LOCK_FILE))) return;
  const b = readLock(root);
  let change = false;
  for (const id of ids) {
    if (b.kons[id]) {
      delete b.kons[id];
      change = true;
    }
  }
  if (change) writeLock(root, b);
}

// ── search / info / outdated ────────────────────────────────────────────────

export async function konSearchCommand(
  text: string | undefined,
  o: RegistryOptions
): Promise<void> {
  try {
    const root = rootOf(o);
    const { verified } = await openRegistry(root, o, readLock(root));
    const q = (text ?? "").toLowerCase();
    const rows = Object.entries(verified.index.kons)
      .filter(([id, k]) => !q || id.includes(q) || (k.description ?? "").toLowerCase().includes(q))
      .map(([id, k]) => {
        const versions = versionsOf(verified.index, id).filter((v) => !k.versions[v]!.yanked);
        return {
          id,
          latest: versions[0] ?? null,
          license: k.license ?? null,
          description: k.description ?? "",
        };
      });
    if (o.json) return void console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) console.log(chalk.gray("No kons match."));
    for (const f of rows) {
      console.log(
        `${chalk.bold(f.id.padEnd(26))} ${String(f.latest ?? "-").padEnd(10)} ${String(f.license ?? "").padEnd(10)} ${chalk.gray(f.description.slice(0, 60))}`
      );
    }
  } catch (e) {
    fail(e);
  }
}

export async function konInfoCommand(name: string, o: RegistryOptions): Promise<void> {
  try {
    const root = rootOf(o);
    const { verified } = await openRegistry(root, o, readLock(root));
    const { index: index } = verified;
    const { id, range } = readRequest(name, konIdOf);
    const k = index.kons[id];
    if (!k) throw new KonError(`${id} is not in the registry`);
    const versions = versionsOf(index, id);
    const chosen =
      maxSatisfying(
        versions.filter((v) => !k.versions[v]!.yanked && !isRevoked(index, id, v)),
        range
      ) ?? versions[0]!;
    const v = k.versions[chosen]!;
    if (o.json)
      return void console.log(
        JSON.stringify(
          {
            id,
            owners: k.owners,
            versions: k.versions,
            advisories: index.advisories.filter((a) => a.kon === id),
          },
          null,
          2
        )
      );
    const m = v.manifest;
    console.log(`${chalk.bold(`${id}@${chosen}`)}  ${m.name}`);
    console.log(chalk.gray(`  ${m.description}`));
    console.log(
      `  license     ${m.license}\n  author      ${m.author?.name ?? "-"}\n  repository  ${m.repository?.url ?? "-"}`
    );
    console.log(`  kitsuden    ${m.kitsuden ?? "*"}   sdk ${m.sdk ?? "-"}`);
    console.log(
      `  depends on  ${
        Object.entries(m.dependencies)
          .map(([d, r]) => `${d}@${r}`)
          .join(", ") || "-"
      }`
    );
    console.log(`  scopes      ${m.permissions?.scopes.join(", ") || "(none)"}`);
    console.log(`  hosts       ${m.permissions?.hosts.join(", ") || "(none)"}`);
    console.log(`  sensitive   ${m.permissions?.sensitive.join(", ") || "(none)"}`);
    console.log(`  tables      ${m.tables.join(", ") || "-"}`);
    console.log(`  migrations  ${m.migrations.join(", ") || "-"}`);
    console.log(
      `  signed by   ${v.keyId} (${index.publishers[v.keyId]?.name ?? "?"})   sha256 ${v.sha256.slice(0, 16)}…  ${v.size} B`
    );
    console.log(chalk.bold("  versions"));
    for (const x of versions) {
      const e = k.versions[x]!;
      const rev = isRevoked(index, id, x);
      const mark = rev
        ? chalk.red(`revoked ${rev.id}`)
        : e.yanked
          ? chalk.yellow(`yanked${e.yankReason ? `: ${e.yankReason}` : ""}`)
          : "";
      console.log(`    ${x.padEnd(12)} ${e.publishedAt.slice(0, 10)} ${mark}`);
    }
    for (const a of index.advisories.filter((a) => a.kon === id)) {
      console.log(
        chalk.yellow(
          `  advisory ${a.id} [${a.severity}] ${a.versions}: ${a.summary}${a.revoked ? " (revoked)" : ""}`
        )
      );
    }
  } catch (e) {
    fail(e);
  }
}

export async function konOutdatedCommand(o: RegistryOptions): Promise<void> {
  try {
    const root = rootOf(o);
    const blocking = readLock(root);
    const { verified } = await openRegistry(root, o, blocking);
    const { index: index } = verified;
    const n = await core(root, o);
    const rows = Object.entries(blocking.kons).map(([id, e]) => {
      const usables = versionsOf(index, id).filter((v) => {
        const x = index.kons[id]!.versions[v]!;
        return (
          !x.yanked &&
          !isRevoked(index, id, v) &&
          compatibleWithTheCore(x.manifest.kitsuden, n.version)
        );
      });
      const wanted = maxSatisfying(usables, e.requested ?? "*");
      const latest = usables[0] ?? null;
      const actual = index.kons[id]?.versions[e.version];
      const flags = [
        actual?.yanked ? "yanked" : "",
        isRevoked(index, id, e.version) ? "REVOKED" : "",
        ...warningsOf(index, id, e.version)
          .filter((a) => !a.revoked)
          .map((a) => `advisory ${a.id}`),
      ].filter(Boolean);
      return { id, current: e.version, wanted, latest, requested: e.requested ?? null, flags };
    });
    if (o.json) return void console.log(JSON.stringify(rows, null, 2));
    console.log(
      chalk.gray(
        `${"kon".padEnd(26)} ${"current".padEnd(10)} ${"wanted".padEnd(10)} ${"latest".padEnd(10)}`
      )
    );
    for (const f of rows) {
      const color = f.flags.length
        ? chalk.red
        : f.current !== f.latest
          ? chalk.yellow
          : chalk.green;
      console.log(
        color(
          `${f.id.padEnd(26)} ${f.current.padEnd(10)} ${String(f.wanted ?? "-").padEnd(10)} ${String(f.latest ?? "-").padEnd(10)} ${f.flags.join(", ")}`
        )
      );
    }
  } catch (e) {
    fail(e);
  }
}

// ── publish / yank / keygen ─────────────────────────────────────────────────

export async function konPublishCommand(dir: string, o: RegistryOptions): Promise<void> {
  try {
    if (!o.registry)
      throw new KonError(
        "--registry <folder> is required: publish writes to a local registry folder"
      );
    if (!o.key)
      throw new KonError(
        "--key <publisher secret key file> is required (create one with `kitsuden kon keygen`)"
      );
    const targetDir = localDir(o.registry);
    const r = publish({
      dir: resolve(dir),
      registryDir: targetDir,
      registryName: o.registryName,
      key: openKey(resolve(o.key)),
      recordKey: o.indexKey ? openKey(resolve(o.indexKey)) : undefined,
      addOwner: o.addOwner,
      dryRun: o.dryRun,
    });
    for (const a of r.warnings) console.log(chalk.yellow(`  ! ${a}`));
    const p = r.manifest.permissions!;
    console.log(
      chalk.green(
        `${o.dryRun ? "✔ (dry run) would publish" : "✔ published"} ${r.id}@${r.version}`
      ) + chalk.gray(` → ${targetDir}/${r.tarball}`)
    );
    console.log(
      chalk.gray(
        `  sha256 ${r.sha256}\n  content ${r.contentHash}\n  ${r.size} bytes, signed by ${r.keyId}, license ${r.manifest.license}`
      )
    );
    console.log(
      chalk.gray(
        `  scopes [${p.scopes.join(", ")}]  hosts [${p.hosts.join(", ")}]  sensitive [${p.sensitive.join(", ")}]`
      )
    );
  } catch (e) {
    fail(e);
  }
}

export async function konYankCommand(spec: string, o: RegistryOptions): Promise<void> {
  try {
    if (!o.registry) throw new KonError("--registry <folder> is required");
    if (!o.indexKey) throw new KonError("--index-key <registry secret key file> is required");
    const dir = localDir(o.registry);
    const recordKey = openKey(resolve(o.indexKey));
    if (o.revokeKey) {
      revokeKey(dir, recordKey, o.revokeKey.toUpperCase());
      console.log(
        chalk.green(
          `✔ publisher key ${o.revokeKey} revoked: every package it signed is now refused`
        )
      );
      return;
    }
    const at = spec.lastIndexOf("@");
    if (at <= 0) throw new KonError("give <kon>@<version>");
    const id = konIdOf(spec.slice(0, at));
    const version = spec.slice(at + 1);
    if (o.revoke) {
      if (!o.advisory) throw new KonError('--revoke needs --advisory "<summary>"');
      const a = addNotification({
        registryDir: dir,
        recordKey,
        id,
        versions: o.range ?? `=${version}`,
        summary: o.advisory,
        severity: (o.severity ?? "high") as "high",
        revoke: true,
      });
      console.log(chalk.green(`✔ ${a.id}: ${id}@${a.versions} revoked (refused even when locked)`));
      return;
    }
    if (o.advisory) {
      const a = addNotification({
        registryDir: dir,
        recordKey,
        id,
        versions: o.range ?? `=${version}`,
        summary: o.advisory,
        severity: (o.severity ?? "moderate") as "moderate",
        revoke: false,
      });
      console.log(chalk.green(`✔ advisory ${a.id} for ${id}@${a.versions}`));
    }
    withdraw({ registryDir: dir, recordKey, id, version, reason: o.reason, undo: o.undo });
    console.log(chalk.green(`✔ ${id}@${version} ${o.undo ? "un-yanked" : "yanked"}`));
  } catch (e) {
    fail(e);
  }
}

/** Re-signs an unchanged index with a later serial and expiry, so a quiet registry stays usable. */
export async function konResignCommand(o: RegistryOptions): Promise<void> {
  try {
    if (!o.registry) throw new KonError("--registry <folder> is required");
    if (!o.indexKey) throw new KonError("--index-key <registry secret key file> is required");
    const days = o.expiresDays === undefined ? undefined : Number(o.expiresDays);
    if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
      throw new KonError("--expires-days must be a whole number of days, 1 or more");
    }
    const i = renewIndex(localDir(o.registry), openKey(resolve(o.indexKey)), days);
    console.log(chalk.green(`✔ index re-signed: serial ${i.serial}, expires ${i.expires}`));
  } catch (e) {
    fail(e);
  }
}

function insideARepo(route: string): string | null {
  let dir = resolve(route);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function konKeygenCommand(o: RegistryOptions): Promise<void> {
  try {
    if (!o.out) throw new KonError("--out <path> is required (writes <path>.pub and <path>.key)");
    const base = resolve(o.out);
    const repo = insideARepo(dirname(base));
    if (repo && !o.force) {
      throw new KonError(
        `${dirname(base)} is inside a git repository (${repo}): a secret key must not live there. ` +
          `Choose a folder outside it (or --force if you really mean it).`
      );
    }
    for (const f of [`${base}.pub`, `${base}.key`])
      if (existsSync(f)) throw new KonError(`${f} already exists`);
    const pass = process.env.KITSUDEN_SIGNING_PASSPHRASE || undefined;
    const { publicKey: publicKeyPem, secretKey: secret, keyId } = generateKeys(pass);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.pub`, publicKeyPem);
    writeFileSync(`${base}.key`, secret, { mode: 0o600 });
    console.log(chalk.green(`✔ key ${keyId}`));
    console.log(
      chalk.gray(
        `  public  ${base}.pub   (share it; registry operators put it in kitsuden.registries.json)`
      )
    );
    console.log(
      chalk.gray(
        `  secret  ${base}.key   (${pass ? "encrypted with KITSUDEN_SIGNING_PASSPHRASE" : chalk.yellow("NOT encrypted: set KITSUDEN_SIGNING_PASSPHRASE to encrypt")})`
      )
    );
  } catch (e) {
    fail(e);
  }
}

// ── verify ──────────────────────────────────────────────────────────────────

export async function konVerifyCommand(names: string[], o: RegistryOptions): Promise<void> {
  try {
    if (o.file) {
      // Offline check of one package file: signature, signed comment, safe parse, manifest.
      if (!o.key) throw new KonError("--key <publisher public key> is required with --file");
      const tgz = readFileSync(resolve(o.file));
      const signature = readFileSync(resolve(o.sig ?? `${o.file}.minisig`), "utf8");
      const key = readPublicKey(readFileSync(resolve(o.key), "utf8"));
      const comment = verifySignature(tgz, signature, key);
      const c = commentFields(comment);
      const files = readPackage(tgz);
      const content = filesFingerprint(files);
      if (c.sha256 !== sha256(tgz) || c.content !== content)
        throw new KonError("the signed comment does not describe this file");
      const kj = files.find((f) => f.path === "kon.json");
      const pj = files.find((f) => f.path === "package.json");
      if (!kj) throw new KonError("no kon.json in the package");
      const { validateManifest } = await import("../registry/manifest.js");
      const migrations = files
        .filter((f) => /^migrations\/[^/]+\.sql$/.test(f.path))
        .map((f) => f.path.slice(11));
      const r = validateManifest(JSON.parse(kj.data.toString("utf8")), {
        forPublish: true,
        package: pj ? JSON.parse(pj.data.toString("utf8")) : null,
        migrations,
      });
      if (!r.ok) throw new KonError(`manifest invalid:\n  ${r.errors.join("\n  ")}`);
      if (r.manifest!.id !== c.id || r.manifest!.version !== c.version)
        throw new KonError("signed id/version differ from the manifest");
      console.log(
        chalk.green(
          `✔ ${c.id}@${c.version} verified — key ${keyIdOf(key.keyId)}, ${files.length} files, sha256 ${c.sha256}`
        )
      );
      return;
    }
    const root = rootOf(o);
    const blocking = readLock(root);
    const file = readKonsFile(root);
    const ids = names.length ? names.map(konIdOf) : Object.keys(blocking.kons);
    if (!ids.length) {
      console.log(chalk.gray(`No registry kons in ${LOCK_FILE}.`));
      return;
    }
    let badOnes = 0;
    for (const id of ids) {
      const e = blocking.kons[id];
      if (!e) {
        console.log(chalk.red(`✖ ${id}: not in ${LOCK_FILE}`));
        badOnes++;
        continue;
      }
      const problems = verifyFromCache(root, id, e);
      const inst = file.kons[id];
      const dir = inst ? inputPath(root, id, inst) : null;
      if (!dir) problems.push(`${id}: not installed (run kon sync)`);
      else {
        const { fingerprintOf } = await import("../kons/installation.js");
        if (fingerprintOf(dir) !== e.contentHash)
          problems.push(
            `${id}: installed copy differs from the signed package (local changes or tampering)`
          );
        const m = dirManifest(dir, true);
        if (!m.ok) problems.push(`${id}: installed manifest invalid: ${m.errors.join("; ")}`);
      }
      if (inst && inst.version !== e.version)
        problems.push(`${id}: kitsuden.kons.json says ${inst.version}, lockfile ${e.version}`);
      if (problems.length) {
        badOnes++;
        for (const p of problems) console.log(chalk.red(`✖ ${p}`));
      } else {
        console.log(
          chalk.green(`✔ ${id}@${e.version}`) +
            chalk.gray(
              ` ${e.signed ? `signed by ${e.keyId}` : "UNSIGNED"}, content ${e.contentHash.slice(0, 16)}…`
            )
        );
      }
    }
    // Online part, when a registry is reachable: revocations since install.
    try {
      const { verified } = await openRegistry(root, o, blocking);
      for (const id of ids) {
        const e = blocking.kons[id];
        if (!e) continue;
        const rev = isRevoked(verified.index, id, e.version);
        if (rev) {
          badOnes++;
          console.log(chalk.red(`✖ ${id}@${e.version}: REVOKED by ${rev.id}: ${rev.summary}`));
        }
        if (verified.index.revokedKeys?.includes(e.keyId ?? "")) {
          badOnes++;
          console.log(chalk.red(`✖ ${id}: its signing key ${e.keyId} has been revoked`));
        }
        if (verified.index.kons[id]?.versions[e.version]?.yanked)
          console.log(chalk.yellow(`! ${id}@${e.version} is yanked`));
        if (!satisfies(e.version, e.requested ?? "*"))
          console.log(chalk.yellow(`! ${id}@${e.version} no longer satisfies ${e.requested}`));
      }
    } catch (err) {
      console.log(
        chalk.gray(`  (registry not checked for revocations: ${(err as Error).message})`)
      );
    }
    if (badOnes) {
      process.exitCode = 1;
      console.error(chalk.red(`✖ ${badOnes} problem(s)`));
    }
  } catch (e) {
    fail(e);
  }
}
