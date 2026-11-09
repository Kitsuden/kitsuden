/**
 * TRON decoder (Token Reduced Object Notation, https://tron-format.github.io/)
 * ============================================================================
 *
 * Decode only: the API encodes (with `@tron-format/tron`, pinned) and sends
 * TRON only after checking that it decodes back to the same data. This is an
 * independent implementation, written so the SDK keeps zero dependencies; its
 * parity with the reference parser is tested on shared fixtures
 * (`packages/sdk/tests/fixtures/tron-cases.json`, also read by the Python SDK).
 *
 * Grammar (what the API emits):
 *
 *   document  := header* value
 *   header    := "class" Name ("(" Parent ")")? ":" prop ("," | newline prop)*
 *   value     := null | true | false | number | string | array | object | Name "(" args ")"
 *   object    := "{" (string ":" value ("," …)*)? "}"     keys are always quoted
 *   args      := positional values, then optional `prop=value` named ones
 *
 * `#` starts a comment until the end of the line; `;` and newlines separate.
 */

export class TronDecodeError extends SyntaxError {
  constructor(message: string) {
    super(`TRON: ${message}`);
    this.name = "TronDecodeError";
  }
}

const enum T {
  Class,
  Ident,
  Str,
  Num,
  True,
  False,
  Null,
  LParen,
  RParen,
  LBracket,
  RBracket,
  LBrace,
  RBrace,
  Comma,
  Colon,
  Semi,
  Equals,
  Newline,
  Eof,
}

interface Tok {
  t: T;
  v: string;
  at: number;
}

const SYMBOLS: Record<string, T> = {
  "(": T.LParen,
  ")": T.RParen,
  "[": T.LBracket,
  "]": T.RBracket,
  "{": T.LBrace,
  "}": T.RBrace,
  ",": T.Comma,
  ":": T.Colon,
  ";": T.Semi,
  "=": T.Equals,
};
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "\n") {
      out.push({ t: T.Newline, v: c, at: i++ });
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c in SYMBOLS) {
      out.push({ t: SYMBOLS[c]!, v: c, at: i++ });
    } else if (c === '"') {
      const at = i++;
      let v = "";
      for (;;) {
        if (i >= src.length) throw new TronDecodeError(`unterminated string at ${at}`);
        const d = src[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\") {
          const e = src[i + 1];
          if (e === undefined) throw new TronDecodeError(`unterminated string at ${at}`);
          if (e === "u") {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new TronDecodeError(`bad \\u escape at ${i}`);
            v += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            v += ESCAPES[e] ?? e;
            i += 2;
          }
        } else {
          v += d;
          i++;
        }
      }
      out.push({ t: T.Str, v, at });
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const at = i++;
      while (i < src.length && /[0-9.eE+-]/.test(src[i]!)) i++;
      out.push({ t: T.Num, v: src.slice(at, i), at });
    } else if (/[A-Za-z_]/.test(c)) {
      const at = i++;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      const v = src.slice(at, i);
      const t =
        v === "class"
          ? T.Class
          : v === "true"
            ? T.True
            : v === "false"
              ? T.False
              : v === "null"
                ? T.Null
                : T.Ident;
      out.push({ t, v, at });
    } else {
      throw new TronDecodeError(`unexpected character '${c}' at ${i}`);
    }
  }
  out.push({ t: T.Eof, v: "", at: src.length });
  return out;
}

/** Decode a TRON document into plain JSON values. */
export function decodeTron(src: string): unknown {
  const tk = tokens(src);
  let p = 0;
  const classes = new Map<string, string[]>();
  const view = (t: T) => tk[p]!.t === t;
  const take = (t: T) => {
    if (view(t)) {
      p++;
      return true;
    }
    return false;
  };
  const require = (t: T, that: string) => {
    const k = tk[p]!;
    if (k.t !== t) throw new TronDecodeError(`expected ${that} at ${k.at}, found '${k.v}'`);
    p++;
    return k;
  };
  const separators = () => {
    while (take(T.Semi) || take(T.Newline));
  };
  const breaks = () => {
    while (take(T.Newline));
  };

  const kind = () => {
    const name = require(T.Ident, "class name").v;
    let props: string[] = [];
    if (take(T.LParen)) {
      const parent = require(T.Ident, "parent class name");
      const inherited = classes.get(parent.v);
      if (!inherited) throw new TronDecodeError(`undefined parent class ${parent.v}`);
      props = [...inherited];
      require(T.RParen, "')'");
    }
    require(T.Colon, "':'");
    while (!view(T.Semi) && !view(T.Class) && !view(T.Eof)) {
      if (take(T.Newline)) {
        if (view(T.Class) || view(T.Eof)) break;
        if (view(T.Ident) && tk[p + 1]?.t === T.LParen) break;
        if (!view(T.Ident) && !view(T.Str)) break;
        continue;
      }
      if (take(T.Comma)) continue;
      if (view(T.Ident) || view(T.Str)) props.push(tk[p++]!.v);
      else break;
    }
    classes.set(name, props);
  };

  const value = (): unknown => {
    const k = tk[p]!;
    switch (k.t) {
      case T.Null:
        p++;
        return null;
      case T.True:
        p++;
        return true;
      case T.False:
        p++;
        return false;
      case T.Num: {
        p++;
        const n = Number(k.v);
        if (Number.isNaN(n)) throw new TronDecodeError(`bad number '${k.v}' at ${k.at}`);
        return n;
      }
      case T.Str:
        p++;
        return k.v;
      case T.LBracket: {
        p++;
        const arr: unknown[] = [];
        for (;;) {
          breaks();
          if (view(T.RBracket)) break;
          arr.push(value());
          breaks();
          if (!take(T.Comma)) break;
        }
        require(T.RBracket, "']'");
        return arr;
      }
      case T.LBrace: {
        p++;
        const obj: Record<string, unknown> = {};
        for (;;) {
          breaks();
          if (view(T.RBrace)) break;
          const key = require(T.Str, "quoted key").v;
          require(T.Colon, "':'");
          defineNow(obj, key, value());
          breaks();
          if (!take(T.Comma)) break;
        }
        require(T.RBrace, "'}'");
        return obj;
      }
      case T.Ident:
        return instance();
      default:
        throw new TronDecodeError(`unexpected '${k.v}' at ${k.at}`);
    }
  };

  const instance = (): Record<string, unknown> => {
    const name = tk[p++]!;
    const props = classes.get(name.v);
    if (!props) throw new TronDecodeError(`undefined class ${name.v} at ${name.at}`);
    require(T.LParen, "'('");
    const obj: Record<string, unknown> = {};
    const placed = new Set<string>();
    let position = 0;
    let named = false;
    for (;;) {
      breaks();
      if (view(T.RParen)) break;
      if ((view(T.Ident) || view(T.Str)) && tk[p + 1]?.t === T.Equals) {
        named = true;
        const prop = tk[p]!;
        if (!props.includes(prop.v))
          throw new TronDecodeError(`unknown property ${prop.v} of ${name.v}`);
        if (placed.has(prop.v)) throw new TronDecodeError(`property ${prop.v} repeated`);
        p += 2;
        defineNow(obj, prop.v, value());
        placed.add(prop.v);
      } else {
        if (named)
          throw new TronDecodeError(`positional argument after a named one at ${tk[p]!.at}`);
        if (position >= props.length) throw new TronDecodeError(`too many arguments for ${name.v}`);
        const prop = props[position++]!;
        defineNow(obj, prop, value());
        placed.add(prop);
      }
      breaks();
      if (!take(T.Comma)) break;
    }
    if (placed.size < props.length) {
      throw new TronDecodeError(
        `missing arguments for ${name.v}: ${props.filter((x) => !placed.has(x)).join(", ")}`
      );
    }
    require(T.RParen, "')'");
    return obj;
  };

  separators();
  while (take(T.Class)) {
    kind();
    separators();
  }
  if (view(T.Eof)) throw new TronDecodeError("no data section");
  const data = value();
  separators();
  if (!view(T.Eof))
    throw new TronDecodeError(`unexpected '${tk[p]!.v}' after the data at ${tk[p]!.at}`);
  return data;
}

/** `obj[k] = v` that also works for `__proto__` (an own property, like JSON.parse). */
function defineNow(obj: Record<string, unknown>, k: string, v: unknown): void {
  if (k === "__proto__")
    Object.defineProperty(obj, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else obj[k] = v;
}
