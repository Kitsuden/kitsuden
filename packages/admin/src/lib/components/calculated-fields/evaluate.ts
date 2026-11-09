/**
 * Evaluates a calculated-field expression WITHOUT `eval` / `new Function`
 * ============================================================================
 *
 * The panel used `new Function` for the formula preview and the helper below,
 * which forced `script-src 'unsafe-eval'` into the panel's Content-Security-Policy
 * (security review 2026-11-03). This is a small recursive-descent parser for the
 * operators the formula builder offers (`FORMULA_OPERATORS`), with their meaning
 * there, not JavaScript's: `=` compares, `^` is a power, `&` concatenates.
 *
 *   expression := comparison
 *   comparison := concat (("=" | "!=" | ">" | ">=" | "<" | "<=") concat)?
 *   concat     := sum ("&" sum)*
 *   sum        := product (("+" | "-") product)*
 *   product    := power (("*" | "/" | "%") power)*
 *   power      := unary ("^" power)?           right-associative
 *   unary      := "-" unary | "+" unary | atom
 *   atom       := number | 'string' | true | false | identifier | "(" expression ")"
 *
 * An identifier is looked up in `context` (own properties only). Anything else
 * is an error: the caller decides what to show.
 */

export type FormulaValue = number | string | boolean | null;

export class FormulaError extends Error {}

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string };

const OPERATORS = ["!=", ">=", "<=", "=", ">", "<", "+", "-", "*", "/", "%", "^", "&", "(", ")"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${ch}"`);
      tokens.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new FormulaError("Unterminated string");
      tokens.push({ kind: "str", value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: "id", value: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected "${ch}"`);
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  return tokens;
}

const num = (v: FormulaValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new FormulaError(`"${v}" is not a number`);
  return n;
};

export function evaluateFormula(
  expression: string,
  context: Record<string, unknown> = {}
): FormulaValue {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops: string[]) => {
    const t = peek();
    return t?.kind === "op" && ops.includes(t.value);
  };
  const take = () => tokens[pos++]!;

  function atom(): FormulaValue {
    const t = peek();
    if (!t) throw new FormulaError("Unexpected end of formula");
    if (t.kind === "num" || t.kind === "str") {
      pos++;
      return t.value;
    }
    if (t.kind === "id") {
      pos++;
      if (t.value === "true") return true;
      if (t.value === "false") return false;
      if (!Object.prototype.hasOwnProperty.call(context, t.value)) {
        throw new FormulaError(`Unknown field "${t.value}"`);
      }
      const v = context[t.value];
      return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : null;
    }
    if (t.value === "(") {
      pos++;
      const v = comparison();
      if (!isOp(")")) throw new FormulaError('Missing ")"');
      pos++;
      return v;
    }
    throw new FormulaError(`Unexpected "${t.value}"`);
  }

  function unary(): FormulaValue {
    if (isOp("-")) {
      pos++;
      return -num(unary());
    }
    if (isOp("+")) {
      pos++;
      return num(unary());
    }
    return atom();
  }

  function power(): FormulaValue {
    const base = unary();
    if (isOp("^")) {
      pos++;
      return Math.pow(num(base), num(power()));
    }
    return base;
  }

  function product(): FormulaValue {
    let v = power();
    while (isOp("*", "/", "%")) {
      const op = take().value;
      const r = num(power());
      v = op === "*" ? num(v) * r : op === "/" ? num(v) / r : num(v) % r;
    }
    return v;
  }

  function sum(): FormulaValue {
    let v = product();
    while (isOp("+", "-")) {
      const op = take().value;
      const r = num(product());
      v = op === "+" ? num(v) + r : num(v) - r;
    }
    return v;
  }

  function concat(): FormulaValue {
    let v = sum();
    while (isOp("&")) {
      pos++;
      v = `${v ?? ""}${sum() ?? ""}`;
    }
    return v;
  }

  function comparison(): FormulaValue {
    const left = concat();
    if (!isOp("=", "!=", ">", ">=", "<", "<=")) return left;
    const op = take().value;
    const right = concat();
    const bothNumbers = typeof left === "number" && typeof right === "number";
    const [a, b] = bothNumbers ? [left, right] : [String(left ?? ""), String(right ?? "")];
    switch (op) {
      case "=":
        return a === b;
      case "!=":
        return a !== b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      case "<":
        return a < b;
      default:
        return a <= b;
    }
  }

  const result = comparison();
  if (pos < tokens.length) throw new FormulaError(`Unexpected "${String(peek()!.value)}"`);
  return result;
}
