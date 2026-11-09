/**
 * Semver for the kon registry — versions, ranges and "the highest that fits"
 * ============================================================================
 *
 * A small, dependency-free subset of npm's semver: enough for kon versions,
 * kon-to-kon dependency ranges and the core compatibility range. It is here and
 * not the `semver` package because the CLI must verify packages before it
 * trusts anything, and every dependency of the verifier is attack surface (and
 * a lockfile change other work would collide with).
 *
 * Supported ranges: `1.2.3`, `=1.2.3`, `>1`, `>=1.2`, `<2`, `<=1.2.3`, `^1.2.3`,
 * `~1.2.3`, `1.x`, `1.2.*`, `*`, `""`, hyphen ranges `1.0.0 - 2.0.0`, AND by
 * spaces and OR by `||`. Pre-releases follow npm's rule: `1.0.0-beta` only
 * satisfies a comparator that names a pre-release of the same `1.0.0`.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
  raw: string;
}

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parse(v: string): Version | null {
  const m = VERSION.exec(String(v).trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre, raw: String(v).trim() };
}

export function valid(v: string): boolean {
  return parse(v) !== null;
}

export function compare(a: Version | string, b: Version | string): number {
  const x = typeof a === "string" ? parse(a) : a;
  const y = typeof b === "string" ? parse(b) : b;
  if (!x || !y) throw new Error(`invalid version: ${!x ? String(a) : String(b)}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

type Op = ">" | ">=" | "<" | "<=" | "=";
interface Comparator {
  op: Op;
  v: Version;
}

/** `1`, `1.2`, `1.x`, `1.2.*` → the parts that are fixed (null = wildcard). */
function partial(s: string): { parts: (number | null)[]; pre: string | null } | null {
  const m =
    /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      s
    );
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map((p) =>
    p === undefined || /^[xX*]$/.test(p) ? null : Number(p)
  );
  // A wildcard makes everything after it a wildcard too (`1.x.3` → `1.x.x`).
  const first = parts.indexOf(null);
  if (first >= 0) for (let i = first; i < 3; i++) parts[i] = null;
  return { parts, pre: m[4] ?? null };
}

function view(major: number, minor: number, patch: number, pre: string | null = null): Version {
  const raw = `${major}.${minor}.${patch}${pre ? `-${pre}` : ""}`;
  return parse(raw)!;
}

/** The lowest pre-release of a version: `<2.0.0` must not let `2.0.0-beta` in. */
function lowest(major: number, minor: number, patch: number): Version {
  return view(major, minor, patch, "0");
}

function expand(token: string): Comparator[] {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(token)!;
  const op = m[1] ?? "";
  const p = partial(m[2]!);
  if (!p) throw new Error(`invalid range comparator: "${token}"`);
  const [M, mi, pa] = p.parts;
  if (M === null) {
    return op === "<" || op === ">" ? [{ op: "<", v: view(0, 0, 0, "0") }] : [];
  }
  const full = mi !== null && pa !== null;
  const base = view(M, mi ?? 0, pa ?? 0, p.pre);
  switch (op) {
    case "^": {
      const upper =
        M > 0
          ? lowest(M + 1, 0, 0)
          : mi === null
            ? lowest(1, 0, 0)
            : mi > 0 || pa === null
              ? lowest(0, mi + 1, 0)
              : lowest(0, 0, pa! + 1);
      return [
        { op: ">=", v: base },
        { op: "<", v: upper },
      ];
    }
    case "~": {
      const upper = mi === null ? lowest(M + 1, 0, 0) : lowest(M, mi + 1, 0);
      return [
        { op: ">=", v: base },
        { op: "<", v: upper },
      ];
    }
    case ">":
      if (full) return [{ op: ">", v: base }];
      return [{ op: ">=", v: mi === null ? lowest(M + 1, 0, 0) : lowest(M, mi + 1, 0) }];
    case ">=":
      return [{ op: ">=", v: base }];
    case "<":
      return [{ op: "<", v: full ? base : lowest(M, mi ?? 0, 0) }];
    case "<=":
      if (full) return [{ op: "<=", v: base }];
      return [{ op: "<", v: mi === null ? lowest(M + 1, 0, 0) : lowest(M, mi + 1, 0) }];
    default:
      if (full) return [{ op: "=", v: base }];
      return [
        { op: ">=", v: base },
        { op: "<", v: mi === null ? lowest(M + 1, 0, 0) : lowest(M, mi + 1, 0) },
      ];
  }
}

function parseSet(set: string): Comparator[] {
  const s = set.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hyphen) {
    const hi = partial(hyphen[2]!);
    if (!hi) throw new Error(`invalid range: "${set}"`);
    const upper = hi.parts.includes(null)
      ? expand(`<=${hyphen[2]}`)
      : [{ op: "<=" as Op, v: parse(hyphen[2]!)! }];
    return [...expand(`>=${hyphen[1]}`), ...upper];
  }
  // `>= 1.2.3` → `>=1.2.3`
  const tokens = s
    .replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
  return tokens.flatMap(expand);
}

export function parseRange(range: string): Comparator[][] {
  const r = String(range ?? "").trim();
  if (r.length > 256) throw new Error("range too long");
  return r.split("||").map(parseSet);
}

export function validRange(range: string): boolean {
  try {
    parseRange(range);
    return true;
  } catch {
    return false;
  }
}

function test(c: Comparator, v: Version): boolean {
  const d = compare(v, c.v);
  switch (c.op) {
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case "=":
      return d === 0;
  }
}

export function satisfies(version: string | Version, range: string): boolean {
  const v = typeof version === "string" ? parse(version) : version;
  if (!v) return false;
  let sets: Comparator[][];
  try {
    sets = parseRange(range);
  } catch {
    return false;
  }
  return sets.some((set) => {
    if (!set.every((c) => test(c, v))) return false;
    if (!v.pre.length) return true;
    // npm: a pre-release only matches if a comparator names a pre-release of
    // the same major.minor.patch (the synthetic `-0` bounds do not count).
    return set.some(
      (c) =>
        c.v.pre.length > 0 &&
        !(c.v.pre.length === 1 && c.v.pre[0] === 0 && c.op === "<") &&
        c.v.major === v.major &&
        c.v.minor === v.minor &&
        c.v.patch === v.patch
    );
  });
}

/** The highest version of the list that satisfies the range. */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!satisfies(v, range)) continue;
    if (best === null || compare(v, best) > 0) best = v;
  }
  return best;
}

/** `0.9.0-beta` → `0.9.0`: the core's pre-release tag does not change its contract. */
export function coerceRelease(v: string): string | null {
  const p = parse(v);
  return p ? `${p.major}.${p.minor}.${p.patch}` : null;
}

export function sortDesc(versions: string[]): string[] {
  return [...versions].filter(valid).sort((a, b) => compare(b, a));
}
