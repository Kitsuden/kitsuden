/**
 * Calculated field expression interpreter
 * ============================================================================
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * `evaluateExpression` did `new Function("return " + expression)()` after
 * substituting each `{field}` with its value as TEXT. There were two ways to run
 * code on the server (with `process.env`, `Bun.spawn`…):
 *
 *   · The formula was saved by anyone who could create a calculated field,
 *     and `GET /api/datasets/:id/entries?includeCalculated=true` ran it.
 *   · Even if the formula was harmless, the VALUE of a text field was put
 *     between quotes escaping only `"`: a value ending in `\` closed the
 *     string and whatever came after it was executed.
 *
 * No code is generated here. It is tokenized and interpreted: numbers, strings,
 * `true/false/null`, `{field}`, `+ - * / % **`, comparisons, `&& || !`,
 * `? :`, parentheses and an allowlist of functions (`min`, `max`, `round`,
 * `floor`, `ceil`, `abs`, `sqrt`, `pow`, also written `Math.x`). There are no
 * free identifiers, no property access, no brackets: no object can be
 * reached. Field values enter as VALUES.
 *
 * JS operators are only applied to primitives (number, string, boolean,
 * null), which have no `valueOf`/`toString` of their own to invoke.
 *
 * Limits on length, tokens and nesting: a huge or deeply nested formula does not
 * eat the CPU or blow the stack.
 */

export const EXPRESSION_LIMITS = { length: 2000, pieces: 1000, depth: 64 } as const;

export type Primitive = number | string | boolean | null;

type Piece =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "field"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const ALLOWED_FUNCTIONS: Record<string, (...a: number[]) => number> = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  round: (a) => Math.round(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  abs: (a) => Math.abs(a),
  sqrt: (a) => Math.sqrt(a),
  pow: (a, b) => Math.pow(a, b),
};

/** The longer ones first: `===` before `==`, `**` before `*`. */
const OPERATORS = [
  "===",
  "!==",
  "**",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "?",
  ":",
  "(",
  ")",
  ",",
];

function chunk(source: string): Piece[] {
  const pieces: Piece[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i, i + 64));
      if (!m) throw new Error(`Invalid number at position ${i}`);
      pieces.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (ch === "{") {
      const m = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}/.exec(source.slice(i, i + 200));
      if (!m) throw new Error(`Invalid field reference at position ${i}`);
      pieces.push({ t: "field", v: m[1] });
      i += m[0].length;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\" && j + 1 < source.length) j++;
        text += source[j];
        j++;
      }
      if (j >= source.length) throw new Error("Unclosed string");
      pieces.push({ t: "str", v: text });
      i = j + 1;
    } else if (/[a-zA-Z_]/.test(ch)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?/.exec(
        source.slice(i, i + 200)
      )!;
      pieces.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => source.startsWith(o, i));
      if (!op) throw new Error(`Character not allowed "${ch}"`);
      pieces.push({ t: "op", v: op });
      i += op.length;
    }
    if (pieces.length > EXPRESSION_LIMITS.pieces) throw new Error("Expression too long");
  }
  return pieces;
}

function fieldValue(row: Record<string, unknown>, name: string): Primitive {
  // `hasOwn`: a `{constructor}` or `{__proto__}` cannot reach the prototype.
  if (!Object.prototype.hasOwnProperty.call(row, name)) return 0;
  const v = row[name];
  if (v === null || v === undefined) return 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.getTime();
  // Objects and lists are not operands. Before they ended up as "[object Object]"
  // and the expression failed; NaN gives the same result without going through text.
  return Number.NaN;
}

/** Evaluates the expression against a row. Throws if it is not valid. */
export function evaluateSafeExpression(
  expression: string,
  row: Record<string, unknown>
): Primitive {
  if (typeof expression !== "string") throw new Error("Invalid expression");
  if (expression.length > EXPRESSION_LIMITS.length) {
    throw new Error(`The expression exceeds ${EXPRESSION_LIMITS.length} characters`);
  }

  const pieces = chunk(expression);
  if (pieces.length === 0) throw new Error("Empty expression");
  let pos = 0;
  let depth = 0;

  const looks = (): Piece | undefined => pieces[pos];
  const isOp = (v: string): boolean => {
    const p = pieces[pos];
    return p !== undefined && p.t === "op" && p.v === v;
  };
  const takes = (v: string): void => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };
  const enters = (): void => {
    if (++depth > EXPRESSION_LIMITS.depth) {
      throw new Error("Expression nested too deeply");
    }
  };
  const exits = (): void => {
    depth--;
  };
  const num = (v: Primitive): number => Number(v);

  function ternary(): Primitive {
    enters();
    const cond = logicalOr();
    let r = cond;
    if (isOp("?")) {
      pos++;
      const a = ternary();
      takes(":");
      const b = ternary();
      r = cond ? a : b;
    }
    exits();
    return r;
  }

  function logicalOr(): Primitive {
    let a = logicalAnd();
    while (isOp("||")) {
      pos++;
      const b = logicalAnd();
      a = a || b;
    }
    return a;
  }

  function logicalAnd(): Primitive {
    let a = equality();
    while (isOp("&&")) {
      pos++;
      const b = equality();
      a = a && b;
    }
    return a;
  }

  function equality(): Primitive {
    let a = comparison();
    for (;;) {
      const p = looks();
      if (!p || p.t !== "op" || !["==", "!=", "===", "!=="].includes(p.v)) return a;
      pos++;
      const b = comparison();
      // Loose equality on purpose for `==`/`!=`: it is what whoever wrote
      // formulas with the previous version used. Only between primitives.
      // eslint-disable-next-line eqeqeq
      a = p.v === "==" ? a == b : p.v === "!=" ? a != b : p.v === "===" ? a === b : a !== b;
    }
  }

  function comparison(): Primitive {
    let a = sum();
    for (;;) {
      const p = looks();
      if (!p || p.t !== "op" || !["<", ">", "<=", ">="].includes(p.v)) return a;
      pos++;
      const b = sum();
      const x = a as number;
      const z = b as number;
      a = p.v === "<" ? x < z : p.v === ">" ? x > z : p.v === "<=" ? x <= z : x >= z;
    }
  }

  function sum(): Primitive {
    let a = product();
    for (;;) {
      const p = looks();
      if (!p || p.t !== "op" || (p.v !== "+" && p.v !== "-")) return a;
      pos++;
      const b = product();
      // `+` concatenates if there is a string, as in JS: `{name} + " (" + {level} + ")"`.
      a = p.v === "+" ? (a as number) + (b as number) : num(a) - num(b);
    }
  }

  function product(): Primitive {
    let a = unary();
    for (;;) {
      const p = looks();
      if (!p || p.t !== "op" || !["*", "/", "%"].includes(p.v)) return a;
      pos++;
      const b = unary();
      a = p.v === "*" ? num(a) * num(b) : p.v === "/" ? num(a) / num(b) : num(a) % num(b);
    }
  }

  function unary(): Primitive {
    if (isOp("-") || isOp("+") || isOp("!")) {
      const op = (looks() as { v: string }).v;
      pos++;
      enters();
      const v = unary();
      exits();
      return op === "-" ? -num(v) : op === "+" ? num(v) : !v;
    }
    return strength();
  }

  function strength(): Primitive {
    const base = primary();
    if (isOp("**")) {
      pos++;
      enters();
      const exp = unary();
      exits();
      return Math.pow(num(base), num(exp));
    }
    return base;
  }

  function primary(): Primitive {
    const p = looks();
    if (!p) throw new Error("Incomplete expression");
    pos++;
    if (p.t === "num" || p.t === "str") return p.v;
    if (p.t === "field") return fieldValue(row, p.v);
    if (p.t === "op" && p.v === "(") {
      const v = ternary();
      takes(")");
      return v;
    }
    if (p.t === "id") {
      if (p.v === "true") return true;
      if (p.v === "false") return false;
      if (p.v === "null") return null;
      // `Math.round` or `round`; any other identifier (or `something.other`)
      // does not exist for this grammar.
      const name = p.v.startsWith("Math.") ? p.v.slice(5) : p.v;
      const fn = Object.prototype.hasOwnProperty.call(ALLOWED_FUNCTIONS, name)
        ? ALLOWED_FUNCTIONS[name]
        : undefined;
      if (!fn || name.includes(".")) throw new Error(`Identifier not allowed "${p.v}"`);
      takes("(");
      const args: number[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(num(ternary()));
          if (args.length > 50) throw new Error("Too many arguments");
          if (!isOp(",")) break;
          pos++;
        }
      }
      takes(")");
      return fn(...args);
    }
    throw new Error(`Unexpected token "${String(p.v)}"`);
  }

  const result = ternary();
  if (pos !== pieces.length) throw new Error("Extra text at the end of the expression");
  return result;
}
