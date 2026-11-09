/**
 * Validation patterns written by an editor, without ReDoS
 * ============================================================================
 *
 * A dataset field can declare `validation.pattern` / `validationRegex`,
 * and it was compiled with `new RegExp(...)` as is to test every value that
 * comes in (entry creation, CSV import). A catastrophic pattern such as
 * `^(a+)+$` against `"aaaa…!"` hangs the API's event loop: with
 * Bun that is the entire API (earlier audit).
 *
 * The first defence was a regular expression over the pattern's text, and it
 * did not see through nested parentheses (`^((a+))+$`) nor polynomial
 * patterns without groups (`^a*a*a*a*a*b$`) (security review F4). JS has no
 * linear engine (re2) without a native dependency, so here the pattern is
 * really PARSED (escapes, classes, nested groups) and:
 *
 *   · the pattern has a length cap;
 *   · backreferences are rejected;
 *   · every repeated group (`+`, `*`, `{n,}`, `{n,m}` with m > 1) that holds
 *     something of variable length is rejected: another non-fixed quantifier
 *     or an alternation (`(a+)+`, `((a+))+`, `(a|aa)*`, `(\w*)*`, `(a?){20}`);
 *   · the DEGREE of polynomial backtracking is measured: how many quantifiers
 *     can share the same characters in a chain (`a*a*`, `.*x.*`, the implicit
 *     `.*?` of a pattern without `^`). Degree n costs ~length^n steps when the
 *     match fails; with the value cap, up to degree 2 is accepted;
 *   · the value being tested has a length cap (`testPattern`, and the zod
 *     validators apply it with `.max(MAX_LENGTH_TO_TEST)`).
 *
 * The analysis is conservative: when in doubt, it rejects. A rejected pattern
 * is treated as "no pattern": it never takes the request down.
 */

export const MAX_PATTERN_LENGTH = 256;
/**
 * With degree 2 the worst case is ~length² steps: 4096² ≈ 1.7·10⁷, tens of
 * milliseconds. With 10 000 it was 10⁸.
 */
export const MAX_LENGTH_TO_TEST = 4_096;
/** From this polynomial backtracking degree on, the pattern is rejected. */
const MAX_DEGREE = 2;

/** The compiled pattern, or `null` if it is invalid or risky. */
export function safePattern(pattern: unknown, flags?: string): RegExp | null {
  if (typeof pattern !== "string" || pattern === "" || pattern.length > MAX_PATTERN_LENGTH)
    return null;
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return null;
  }
  return riskyPattern(pattern, re.flags) ? null : re;
}

/**
 * Does `value` match the pattern? `true` if the pattern is not usable (it is ignored) and
 * `false` if the value is longer than what is tested.
 */
export function testPattern(pattern: unknown, value: string): boolean {
  const re = safePattern(pattern);
  if (!re) return true;
  if (value.length > MAX_LENGTH_TO_TEST) return false;
  return re.test(value);
}

/** Can this pattern (already compiled without error) backtrack out of control? */
export function riskyPattern(pattern: string, flags = ""): boolean {
  let tree: Node[][];
  try {
    tree = new Reader(pattern, flags).read();
  } catch {
    // What the reader does not understand cannot be judged: rejected.
    return true;
  }
  if (tree.some((alt) => alt.some(hasDangerousRepetition))) return true;
  return backtrackingDegree(tree, flags) > MAX_DEGREE;
}

// ── Character sets (code point ranges) ───────────────────────────────────────

type Range = [number, number];
/** Sorted and without overlaps. */
type CharSet = Range[];

const MAX_CODE_POINT = 0x10ffff;
const ANY: CharSet = [[0, MAX_CODE_POINT]];
const DIGITS: CharSet = [[0x30, 0x39]];
const WORD: CharSet = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const WHITESPACE: CharSet = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const LINE_TERMINATORS: CharSet = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

function normalize(ranges: Range[]): CharSet {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
  const output: CharSet = [];
  for (const [a, b] of sorted) {
    const last = output[output.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else output.push([a, b]);
  }
  return output;
}

function complement(c: CharSet): CharSet {
  const output: Range[] = [];
  let from = 0;
  for (const [a, b] of c) {
    if (a > from) output.push([from, a - 1]);
    from = b + 1;
  }
  if (from <= MAX_CODE_POINT) output.push([from, MAX_CODE_POINT]);
  return output;
}

function union(a: CharSet, b: CharSet): CharSet {
  return normalize([...a, ...b].map(([x, y]) => [x, y] as Range));
}

function intersect(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [a0, a1] = a[i]!;
    const [b0, b1] = b[j]!;
    if (a0 <= b1 && b0 <= a1) return true;
    if (a1 < b1) i++;
    else j++;
  }
  return false;
}

/** With `i`: every ASCII letter also matches in the other case. */
function withCase(c: CharSet): CharSet {
  const extra: Range[] = [];
  for (const [a, b] of c) {
    const upper: Range = [Math.max(a, 0x41), Math.min(b, 0x5a)];
    const lower: Range = [Math.max(a, 0x61), Math.min(b, 0x7a)];
    if (upper[0] <= upper[1]) extra.push([upper[0] + 32, upper[1] + 32]);
    if (lower[0] <= lower[1]) extra.push([lower[0] - 32, lower[1] - 32]);
  }
  // Outside ASCII it is not attempted: treated as "any letter" if there is one.
  if (c.some(([, b]) => b > 0x7f)) extra.push([0x80, MAX_CODE_POINT]);
  return extra.length ? union(c, extra) : c;
}

// ── Pattern tree ─────────────────────────────────────────────────────────────

type Node =
  | { kind: "char"; set: CharSet }
  | { kind: "start" }
  | { kind: "end" }
  /** `\b`, `\B` and lookarounds (`(?=…)`, `(?<!…)`): they do not consume. */
  | { kind: "assertion"; content?: Node[][] }
  | { kind: "group"; alternatives: Node[][] }
  | { kind: "backref" }
  | { kind: "repeat"; node: Node; min: number; max: number };

/**
 * Reader of JS RegExp syntax (with Annex B, the mode without `u`).
 * The pattern already compiled with `new RegExp`, so it does not validate: it only recognizes.
 */
class Reader {
  private i = 0;
  private readonly s: string;
  private readonly unicode: boolean;
  private readonly sets: boolean;
  private readonly ignoreCase: boolean;
  private readonly dotAll: boolean;

  constructor(s: string, flags: string) {
    this.s = s;
    this.unicode = flags.includes("u") || flags.includes("v");
    this.sets = flags.includes("v");
    this.ignoreCase = flags.includes("i");
    this.dotAll = flags.includes("s");
  }

  read(): Node[][] {
    const alternatives = this.alternatives();
    if (this.i < this.s.length) throw new Error("unopened parenthesis");
    return alternatives;
  }

  private alternatives(): Node[][] {
    const output: Node[][] = [this.sequence()];
    while (this.s[this.i] === "|") {
      this.i++;
      output.push(this.sequence());
    }
    return output;
  }

  private sequence(): Node[] {
    const nodes: Node[] = [];
    while (this.i < this.s.length && this.s[this.i] !== "|" && this.s[this.i] !== ")") {
      const atom = this.atom();
      const quantifier = this.quantifier();
      nodes.push(quantifier ? { kind: "repeat", node: atom, ...quantifier } : atom);
    }
    return nodes;
  }

  private char(set: CharSet): Node {
    return { kind: "char", set: this.ignoreCase ? withCase(set) : set };
  }

  private atom(): Node {
    const c = this.s[this.i]!;
    switch (c) {
      case "^":
        this.i++;
        return { kind: "start" };
      case "$":
        this.i++;
        return { kind: "end" };
      case ".":
        this.i++;
        return this.char(this.dotAll ? ANY : complement(LINE_TERMINATORS));
      case "(":
        return this.group();
      case "[":
        return this.char(this.charClass());
      case "\\":
        return this.escape();
      default: {
        const cp = this.s.codePointAt(this.i)!;
        this.i += cp > 0xffff ? 2 : 1;
        return this.char([[cp, cp]]);
      }
    }
  }

  private group(): Node {
    this.i++; // (
    let lookaround = false;
    if (this.s[this.i] === "?") {
      const rest = this.s.slice(this.i + 1);
      if (rest.startsWith(":")) this.i += 2;
      else if (rest.startsWith("=") || rest.startsWith("!")) {
        this.i += 2;
        lookaround = true;
      } else if (rest.startsWith("<=") || rest.startsWith("<!")) {
        this.i += 3;
        lookaround = true;
      } else if (rest.startsWith("<")) {
        const close = this.s.indexOf(">", this.i);
        if (close < 0) throw new Error("unclosed group name");
        this.i = close + 1;
      } else {
        // Modifiers (`(?i:…)`, `(?-i:…)`).
        const m = /^[a-zA-Z-]*:/.exec(rest);
        if (!m) throw new Error("unknown group");
        this.i += 1 + m[0].length;
      }
    }
    const alternatives = this.alternatives();
    if (this.s[this.i] !== ")") throw new Error("unclosed parenthesis");
    this.i++;
    return lookaround
      ? { kind: "assertion", content: alternatives }
      : { kind: "group", alternatives };
  }

  private quantifier(): { min: number; max: number } | null {
    const c = this.s[this.i];
    let q: { min: number; max: number } | null = null;
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    if (q) this.i++;
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.s.slice(this.i));
      if (!m) return null; // literal `{` (Annex B): the next atom reads it
      this.i += m[0].length;
      const min = Number(m[1]);
      q = { min, max: m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]) };
    }
    if (q && this.s[this.i] === "?") this.i++; // lazy: the same backtracking
    return q;
  }

  /** Escape outside a class. */
  private escape(): Node {
    const c = this.s[this.i + 1];
    if (c === undefined) throw new Error("escape at the end");
    if (c === "b" || c === "B") {
      this.i += 2;
      return { kind: "assertion" };
    }
    if (/[1-9]/.test(c)) {
      this.i += 2;
      return { kind: "backref" };
    }
    if (c === "k" && this.s[this.i + 2] === "<") {
      this.i += 2;
      return { kind: "backref" };
    }
    return this.char(this.charEscape());
  }

  /** `\d`, `\w`, `\x41`, `\n`… (inside or outside a class). Leaves `i` after the escape. */
  private charEscape(inClass = false): CharSet {
    const c = this.s[this.i + 1]!;
    this.i += 2;
    const one = (cp: number): CharSet => [[cp, cp]];
    switch (c) {
      case "d":
        return DIGITS;
      case "D":
        return complement(DIGITS);
      case "w":
        return WORD;
      case "W":
        return complement(WORD);
      case "s":
        return WHITESPACE;
      case "S":
        return complement(WHITESPACE);
      case "t":
        return one(9);
      case "n":
        return one(10);
      case "v":
        return one(11);
      case "f":
        return one(12);
      case "r":
        return one(13);
      case "0":
        return one(0);
      case "b":
        return inClass ? one(8) : one(0x62);
      case "c": {
        const l = this.s[this.i];
        if (l && /[a-z]/i.test(l)) {
          this.i++;
          return one(l.charCodeAt(0) % 32);
        }
        return one(0x5c);
      }
      case "x": {
        const m = /^[0-9a-f]{2}/i.exec(this.s.slice(this.i));
        if (!m) return one(0x78);
        this.i += 2;
        return one(parseInt(m[0], 16));
      }
      case "u": {
        const braces = /^\{([0-9a-f]+)\}/i.exec(this.s.slice(this.i));
        if (braces && this.unicode) {
          this.i += braces[0].length;
          return one(Math.min(parseInt(braces[1]!, 16), MAX_CODE_POINT));
        }
        const m = /^[0-9a-f]{4}/i.exec(this.s.slice(this.i));
        if (!m) return one(0x75);
        this.i += 4;
        return one(parseInt(m[0], 16));
      }
      case "p":
      case "P": {
        if (!this.unicode) return one(c.charCodeAt(0));
        const close = this.s.indexOf("}", this.i);
        if (this.s[this.i] !== "{" || close < 0) throw new Error("malformed unicode property");
        this.i = close + 1;
        return ANY; // no Unicode tables: "it can be anything"
      }
      default: {
        if (/[1-9]/.test(c)) return one(c.charCodeAt(0)); // in a class, Annex B treats it as octal or literal
        const cp = this.s.codePointAt(this.i - 1)!;
        if (cp > 0xffff) this.i++;
        return one(cp);
      }
    }
  }

  /** `[…]`: leaves `i` after the `]`. */
  private charClass(): CharSet {
    this.i++; // [
    if (this.sets) {
      // `v` mode (nested classes, `--`, `&&`): skipped whole and treated as
      // "any character", the most conservative choice.
      let level = 1;
      while (this.i < this.s.length && level > 0) {
        const c = this.s[this.i]!;
        if (c === "\\") this.i += 2;
        else {
          if (c === "[") level++;
          else if (c === "]") level--;
          this.i++;
        }
      }
      if (level > 0) throw new Error("unclosed class");
      return ANY;
    }
    const negated = this.s[this.i] === "^";
    if (negated) this.i++;
    const ranges: Range[] = [];
    while (this.i < this.s.length && this.s[this.i] !== "]") {
      const from = this.classElement();
      if (
        this.s[this.i] === "-" &&
        this.s[this.i + 1] !== undefined &&
        this.s[this.i + 1] !== "]" &&
        from.length === 1 &&
        from[0]![0] === from[0]![1]
      ) {
        const back = this.i;
        this.i++; // -
        const to = this.classElement();
        if (to.length === 1 && to[0]![0] === to[0]![1]) {
          ranges.push([from[0]![0], to[0]![0]]);
        } else {
          // `[a-\d]` (Annex B): `a`, `-` and `\d` on their own
          this.i = back;
          ranges.push(...from);
        }
      } else {
        ranges.push(...from);
      }
    }
    if (this.s[this.i] !== "]") throw new Error("unclosed class");
    this.i++;
    const set = normalize(ranges);
    return negated ? complement(set) : set;
  }

  private classElement(): CharSet {
    if (this.s[this.i] === "\\") return this.charEscape(true);
    const cp = this.s.codePointAt(this.i)!;
    this.i += cp > 0xffff ? 2 : 1;
    return [[cp, cp]];
  }
}

// ── Rule 1: repeated groups with something variable inside ───────────────────

/** Is there something inside that can match different lengths? */
function isVariable(n: Node): boolean {
  switch (n.kind) {
    case "repeat":
      return n.min !== n.max || isVariable(n.node);
    case "group":
      return n.alternatives.length > 1 || n.alternatives.some((alt) => alt.some(isVariable));
    case "assertion":
      return (n.content ?? []).some((alt) => alt.some(isVariable));
    default:
      return false;
  }
}

function hasDangerousRepetition(n: Node): boolean {
  switch (n.kind) {
    case "backref":
      return true;
    case "repeat":
      if (n.max > 1 && isVariable(n.node)) return true;
      return hasDangerousRepetition(n.node);
    case "group":
      return n.alternatives.some((alt) => alt.some(hasDangerousRepetition));
    case "assertion":
      return (n.content ?? []).some((alt) => alt.some(hasDangerousRepetition));
    default:
      return false;
  }
}

// ── Rule 2: degree of polynomial backtracking ────────────────────────────────
//
// A "chain" is a series of variable quantifiers that can pass characters to
// each other: `a*a*`, or `.*x.*` (the first `.*` also eats `x`). When the match
// fails, the engine tries every split: ~length^degree steps. The pattern is
// walked carrying the live chains (`last`: what the chain's last quantifier
// eats) and the degree is recorded at every point that can fail and force
// backtracking (a mandatory character, a quantifier with a minimum, `$`, an
// assertion).
//
// An unbounded quantifier (`*`, `+`, `{n,}`) adds 1 to the degree (a "length"
// factor); a bounded one (`?`, `{0,3}`, an optional group) adds ½: it is a
// constant factor, but a run of them (`a?a?a?…aaa`) is exponential in the
// pattern's length and must be cut too. Joining alternatives and keeping the
// larger set overestimates: the error always leans towards rejecting.

interface Chain {
  last: CharSet;
  degree: number;
}

const UNBOUNDED_WEIGHT = 1;
const BOUNDED_WEIGHT = 0.5;

function backtrackingDegree(tree: Node[][], flags: string): number {
  const multiline = flags.includes("m");
  let maximum = 0;
  const record = (state: Chain[]) => {
    for (const c of state) if (c.degree > maximum) maximum = c.degree;
  };

  /** One chain per degree (joining sets): the state does not grow. */
  const merge = (state: Chain[]): Chain[] => {
    const byDegree = new Map<number, CharSet>();
    for (const c of state) {
      const d = Math.min(c.degree, MAX_DEGREE + UNBOUNDED_WEIGHT);
      const previous = byDegree.get(d);
      byDegree.set(d, previous ? union(previous, c.last) : c.last);
    }
    return [...byDegree.entries()].map(([degree, last]) => ({ degree, last }));
  };

  /** Everything a node can consume (without lookarounds, which do not consume). */
  const consumes = (n: Node): CharSet => {
    switch (n.kind) {
      case "char":
        return n.set;
      case "repeat":
        return consumes(n.node);
      case "group":
        return n.alternatives.flat().reduce<CharSet>((acc, m) => union(acc, consumes(m)), []);
      default:
        return [];
    }
  };

  const alternatives = (alts: Node[][], state: Chain[]): Chain[] =>
    merge(alts.flatMap((alt) => sequence(alt, state)));

  const sequence = (nodes: Node[], state: Chain[]): Chain[] => {
    let current = state;
    for (const n of nodes) current = merge(node(n, current));
    return current;
  };

  /** A variable quantifier that eats characters from `set`. */
  const variable = (set: CharSet, min: number, weight: number, state: Chain[]): Chain[] => {
    if (min >= 1) record(state);
    const continuing = state
      .filter((c) => intersect(c.last, set))
      .map((c) => ({ last: set, degree: c.degree + weight }));
    return [...continuing, { last: set, degree: weight }, ...(min === 0 ? state : [])];
  };

  const node = (n: Node, state: Chain[]): Chain[] => {
    switch (n.kind) {
      case "char":
        // Mandatory: the chain continues if its last quantifier can also eat
        // this character (and share it with the next one).
        record(state);
        return state.filter((c) => intersect(c.last, n.set));
      case "start":
        return multiline ? state : [];
      case "end":
        record(state);
        return multiline ? state : [];
      case "assertion":
        record(state);
        if (n.content) alternatives(n.content, state);
        return state;
      case "backref":
        record(state);
        return state;
      case "group":
        return alternatives(n.alternatives, state);
      case "repeat": {
        const { node: inner, min, max } = n;
        if (max === 0) return state;
        if (inner.kind === "start" || inner.kind === "end" || inner.kind === "assertion") {
          return min === 0 ? state : node(inner, state);
        }
        // Fixed (`a{3}`, `(ab){2}`): like the unquantified node.
        if (min === max) return node(inner, state);
        const weight = max === Infinity ? UNBOUNDED_WEIGHT : BOUNDED_WEIGHT;
        const asBlock = variable(consumes(inner), min, weight, state);
        // `(…)?` with something variable inside (rule 1 guarantees it can only
        // have a ceiling of 1): its inner chains as well.
        if (inner.kind === "group" && isVariable(inner)) {
          return [...asBlock, ...alternatives(inner.alternatives, state)];
        }
        return asBlock;
      }
    }
  };

  // Without `^`, the engine tries from every position: a `[^]*?` in front.
  alternatives(tree, [{ last: ANY, degree: UNBOUNDED_WEIGHT }]);
  return maximum;
}
