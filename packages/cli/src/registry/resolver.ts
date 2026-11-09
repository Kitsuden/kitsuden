/**
 * Dependency resolution and the lockfile (`kitsuden.kons.lock`)
 * ============================================================================
 *
 * RESOLUTION. Requests are `{id: range}`; every chosen version adds its own
 * `dependencies.kons` ranges. Each kon gets the highest version that
 *   · satisfies EVERY range that applies to it,
 *   · is not yanked (a yanked version stays installable only when the lockfile
 *     already pins it — Cargo's rule — and that prints a warning),
 *   · is not revoked by an advisory (never, lockfile or not),
 *   · declares a `kitsuden` range this core satisfies and an `sdk` it provides.
 * A locked version that still fits is kept (`update` lifts the lock). The loop
 * re-derives the ranges from the current choice until nothing changes; a
 * conflict is reported with who asked for what. Core kons (kon-media…) and
 * kons installed from a source folder (`kon add --from`) satisfy dependencies
 * without coming from the registry, if their version fits.
 *
 * LOCKFILE. Exact version, tarball URL, SHA-256, content hash, signing key and
 * the normalized manifest (the baseline for the next permission diff) of every
 * registry kon. Commit it: `kon sync` installs exactly what it says, verifying
 * each package again.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CORE_KONS, compatibleWithTheCore, type NormalizedManifest } from "./manifest.js";
import { satisfies } from "./semver.js";

import { warningsOf, isRevoked, versionsOf, type Index, type PublishedVersion } from "./index.js";

export const LOCK_FILE = "kitsuden.kons.lock";

export interface LockInput {
  version: string;
  registry: string;
  tarball: string;
  sha256: string;
  contentHash: string;
  keyId: string | null;
  /** The publisher's public key (minisign base64), for offline `kon verify`. */
  publicKey?: string;
  signed: boolean;
  license: string | null;
  /** The range asked for on the command line (only for kons asked directly). */
  requested?: string;
  dependencies: Record<string, string>;
  manifest: NormalizedManifest;
}

export interface Blocking {
  $comment?: string;
  lockfileVersion: 1;
  registries: Record<string, { url: string; keyId: string | null; serial: number }>;
  kons: Record<string, LockInput>;
}

const COMMENT =
  "Exact kons installed from a registry, with their hashes and signing keys. Written by " +
  "`kitsuden kon add|update|remove`; `kitsuden kon sync` installs exactly this. Commit it.";

export function readLock(root: string): Blocking {
  const route = join(root, LOCK_FILE);
  if (!existsSync(route)) return { lockfileVersion: 1, registries: {}, kons: {} };
  const j = JSON.parse(readFileSync(route, "utf8")) as Blocking;
  if (j.lockfileVersion !== 1)
    throw new Error(`${LOCK_FILE}: lockfileVersion ${j.lockfileVersion} is not supported`);
  return { lockfileVersion: 1, registries: j.registries ?? {}, kons: j.kons ?? {} };
}

export function writeLock(root: string, b: Blocking): void {
  const kons = Object.fromEntries(Object.entries(b.kons).sort(([x], [y]) => x.localeCompare(y)));
  writeFileSync(
    join(root, LOCK_FILE),
    JSON.stringify(
      { $comment: COMMENT, lockfileVersion: 1, registries: b.registries, kons },
      null,
      2
    ) + "\n"
  );
}

export class ResolutionError extends Error {}

export interface Choice {
  id: string;
  version: string;
  input: PublishedVersion;
  direct: boolean;
  blocked: boolean;
}

export interface ResolutionOptions {
  index: Index;
  requested: Record<string, string>;
  blocking?: Blocking;
  /** Kons whose lock is lifted (`update`); "all" lifts every lock. */
  update?: Set<string> | "all";
  coreVersion: string | null;
  coreSdk: number | null;
  /** Kons installed outside the registry (source copies, links): id → version. */
  installedOutside?: Record<string, string | undefined>;
}

export interface Resolution {
  plan: Choice[];
  warnings: string[];
}

export function resolver(o: ResolutionOptions): Resolution {
  const { index: index } = o;
  const warnings = new Set<string>();
  const chosenItems = new Map<string, string>();
  const released = (id: string) => o.update === "all" || (o.update?.has(id) ?? false);

  const choose = (id: string, ranges: { range: string; by: string }[]): string => {
    const blocked = o.blocking?.kons[id]?.version;
    const reasons: string[] = [];
    const candidates = versionsOf(index, id).filter((v) => {
      const e = index.kons[id]!.versions[v]!;
      const revoked = isRevoked(index, id, v);
      if (revoked) {
        reasons.push(`${v}: revoked (${revoked.id}: ${revoked.summary})`);
        return false;
      }
      if (e.yanked && !(v === blocked && !released(id))) {
        reasons.push(`${v}: yanked${e.yankReason ? ` (${e.yankReason})` : ""}`);
        return false;
      }
      if (!compatibleWithTheCore(e.manifest.kitsuden, o.coreVersion)) {
        reasons.push(`${v}: needs kitsuden ${e.manifest.kitsuden}, this core is ${o.coreVersion}`);
        return false;
      }
      if (o.coreSdk !== null && e.manifest.sdk !== null && e.manifest.sdk > o.coreSdk) {
        reasons.push(`${v}: needs kon SDK v${e.manifest.sdk}, this core provides v${o.coreSdk}`);
        return false;
      }
      const fails = ranges.find((r) => !satisfies(v, r.range));
      if (fails) {
        reasons.push(`${v}: does not satisfy ${fails.range} (from ${fails.by})`);
        return false;
      }
      return true;
    });
    if (!candidates.length) {
      throw new ResolutionError(
        `no version of ${id} fits: ` +
          ranges.map((r) => `${r.range} (from ${r.by})`).join(", ") +
          (reasons.length ? `\n  ${reasons.join("\n  ")}` : "\n  (it has no published versions)")
      );
    }
    const chosen =
      blocked && !released(id) && candidates.includes(blocked) ? blocked : candidates[0]!;
    const e = index.kons[id]!.versions[chosen]!;
    if (e.yanked)
      warnings.add(
        `${id}@${chosen} is yanked; kept because the lockfile pins it. Run \`kon update ${id}\`.`
      );
    for (const a of warningsOf(index, id, chosen)) {
      if (!a.revoked)
        warnings.add(`${id}@${chosen}: advisory ${a.id} (${a.severity}): ${a.summary}`);
    }
    return chosen;
  };

  for (let round = 0; round < 100; round++) {
    const ranges = new Map<string, { range: string; by: string }[]>();
    const add = (id: string, range: string, by: string) => {
      if (!ranges.has(id)) ranges.set(id, []);
      ranges.get(id)!.push({ range, by });
    };
    for (const [id, range] of Object.entries(o.requested)) add(id, range, "your request");
    for (const [id, v] of chosenItems) {
      for (const [dep, range] of Object.entries(
        index.kons[id]!.versions[v]!.manifest.dependencies
      )) {
        add(dep, range, `${id}@${v}`);
      }
    }
    let change = false;
    for (const [id, list] of ranges) {
      if (CORE_KONS.has(id)) continue;
      const outside = o.installedOutside?.[id];
      if (o.installedOutside && id in o.installedOutside && !(id in o.requested)) {
        const fails = list.find((r) => !outside || !satisfies(outside, r.range));
        if (fails) {
          throw new ResolutionError(
            `${id} is installed from a source folder (version ${outside ?? "unknown"}) and ${fails.by} needs ${fails.range}. ` +
              `Remove it, or install it from the registry: kon add ${id}@"${fails.range}"`
          );
        }
        continue;
      }
      if (!index.kons[id]) {
        const by = list.map((r) => r.by).join(", ");
        throw new ResolutionError(`${id} (needed by ${by}) is not in the registry`);
      }
      const v = choose(id, list);
      if (chosenItems.get(id) !== v) {
        chosenItems.set(id, v);
        change = true;
      }
    }
    for (const id of [...chosenItems.keys()]) {
      if (!ranges.has(id)) {
        chosenItems.delete(id);
        change = true;
      }
    }
    if (!change) {
      const plan: Choice[] = [...chosenItems].map(([id, version]) => ({
        id,
        version,
        input: index.kons[id]!.versions[version]!,
        direct: id in o.requested,
        blocked: o.blocking?.kons[id]?.version === version,
      }));
      // Dependencies first: install order.
      const order: Choice[] = [];
      const visit = (e: Choice, stack: Set<string>) => {
        if (order.includes(e)) return;
        if (stack.has(e.id))
          throw new ResolutionError(`dependency cycle: ${[...stack, e.id].join(" → ")}`);
        stack.add(e.id);
        for (const dep of Object.keys(e.input.manifest.dependencies)) {
          const d = plan.find((p) => p.id === dep);
          if (d) visit(d, stack);
        }
        stack.delete(e.id);
        order.push(e);
      };
      for (const e of plan.sort((a, b) => a.id.localeCompare(b.id))) visit(e, new Set());
      return { plan: order, warnings: [...warnings] };
    }
  }
  throw new ResolutionError("dependency resolution did not converge (conflicting ranges)");
}

/** `blog@^1.2`, `kon-blog@1.0.0`, `blog` → {id, range}. */
export function readRequest(
  text: string,
  konIdOf: (n: string) => string
): { id: string; range: string } {
  const t = text.trim();
  const at = t.lastIndexOf("@");
  if (at > 0) return { id: konIdOf(t.slice(0, at)), range: t.slice(at + 1).trim() || "*" };
  return { id: konIdOf(t), range: "*" };
}
