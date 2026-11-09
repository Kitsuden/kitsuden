/**
 * Kitsuden — Kon ↔ core version compatibility (versioning strategy)
 *
 * The PRODUCT (root, api, admin, sdk, cli, shared, engine) versions in
 * lockstep (0.9.0-beta together). KONS and GRIMOIRES version
 * INDEPENDENTLY (their own semver, like WordPress/VS Code plugins) and
 * declare compatibility with the core in their manifest:
 *
 *   kon.json:
 *     "kitsuden": ">=0.9.0"          ← range (recommended)
 *     "minKitsudenVersion": "0.9.0"  ← minimum (legacy field, also supported)
 *
 * The loader validates on resolve and emits a WARNING if it is not satisfied —
 * it never blocks (beta decision: visibility without breaking existing loads).
 *
 * Supported ranges (no dependency on npm semver — pragmatic subset):
 *   "*"          any version
 *   ">=x.y.z"    / ">x.y.z" / "<=x.y.z" / "<x.y.z"
 *   "^x.y.z"     same major (for 0.y.z: same minor, semver convention)
 *   "~x.y.z"     same major.minor
 *   "x.y.z"      exact
 *   AND combination separated by spaces: ">=0.9.0 <2.0.0"
 *
 * NOTE prerelease: the comparison uses only the x.y.z base ("-beta" is
 * ignored), so "0.9.0-beta" satisfies ">=0.9.0". This is intentional: in beta
 * kons declare compatibility against the 0.9 line, not against the tag.
 */

export type SemverTriple = [number, number, number];

/** Parses "x.y.z(-pre)" → [x,y,z]; null if it cannot be parsed */
export function parseSemverBase(version: string): SemverTriple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: SemverTriple, b: SemverTriple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

function satisfiesClause(current: SemverTriple, clause: string): boolean {
  const c = clause.trim();
  if (c === "" || c === "*" || c === "x") return true;

  const m = /^(>=|<=|>|<|\^|~)?\s*v?(\d+)\.(\d+)\.(\d+)/.exec(c);
  if (!m) return true; // unparseable range → do not block (tolerant)

  const op = m[1] ?? "";
  const target: SemverTriple = [Number(m[2]), Number(m[3]), Number(m[4])];
  const cmp = compare(current, target);

  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "^":
      // Same major; for 0.y.z the semver convention also fixes the minor
      if (target[0] === 0) {
        return current[0] === 0 && current[1] === target[1] && cmp >= 0;
      }
      return current[0] === target[0] && cmp >= 0;
    case "~":
      return current[0] === target[0] && current[1] === target[1] && cmp >= 0;
    default:
      return cmp === 0; // exact
  }
}

/**
 * Does `currentVersion` satisfy `range`? (AND of space-separated clauses)
 * Tolerant: unparseable versions/ranges return true (warning ≠ block).
 */
export function satisfiesKitsudenRange(currentVersion: string, range: string): boolean {
  const current = parseSemverBase(currentVersion);
  if (!current) return true;
  return range
    .split(/\s+/)
    .filter(Boolean)
    .every((clause) => satisfiesClause(current, clause));
}

/**
 * Validates a kon's manifest against the core version.
 * Returns null if compatible (or nothing is declared), or the warning message.
 * Supports `kitsuden` (range) and the legacy `minKitsudenVersion` (equivalent to ">=x.y.z").
 */
export function checkKonCompatibility(
  coreVersion: string,
  manifest: { id?: string; kitsuden?: string; minKitsudenVersion?: string } | null | undefined
): string | null {
  if (!manifest) return null;

  const range =
    manifest.kitsuden ?? (manifest.minKitsudenVersion ? `>=${manifest.minKitsudenVersion}` : null);
  if (!range) return null;

  if (satisfiesKitsudenRange(coreVersion, range)) return null;

  return (
    `Kon '${manifest.id ?? "unknown"}' declares compatibility "${range}" ` +
    `but the core is v${coreVersion}. It is loaded anyway (warning, not a block) — ` +
    `may fail at runtime. Update the kon or the "kitsuden" field in its kon.json.`
  );
}
