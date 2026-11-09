/**
 * Security scan of a draft's code — local and deterministic
 * ============================================================================
 *
 * No network, no language models, no dependencies: a JavaScript token reader
 * just good enough not to confuse comments and strings with code, and a few
 * fixed rules. The same input gives the same output (the tests pin it).
 *
 * What it looks at:
 *
 *   high    `eval`, `Function`, `import()`, `constructor` / `__proto__`
 *           (the classic ways out of an interpreter), globals that are not
 *           part of the sandbox (`process`, `require`, `globalThis`, `Bun`…) and
 *           the prologue's internal functions (`__request`, `__api`…), secrets
 *           written in the code, and code over 64 KiB.
 *   medium  obfuscation (`atob`, `fromCharCode`, many `\x` sequences),
 *           extremely long lines (minified code nobody reviews), a
 *           `fetch` to a host that was not declared, and `kitsuden` used in a
 *           way that hides which API path it calls (alias,
 *           `kitsuden["api"]`…): then the call stays "unclassified".
 *           Also: `env` used as a whole, a percent-escape in a literal API
 *           path, a member name built at run time, and a `/` this lexer cannot
 *           settle. It is a lexer, not a parser: when in doubt it reports.
 *   low     loops with no apparent exit (the sandbox cuts them by time).
 *
 * `passed` = no `high` or `medium` finding.
 *
 * It also extracts what the rest of code promotion needs to decide: the calls to
 * `kitsuden.api.*` with their method and literal path (or `null` if
 * dynamic), the literal hosts of `fetch` and the `env` variables it reads.
 *
 * A message NEVER repeats the secret found: it gives the line and the type.
 */

export type FindingSeverity = "high" | "medium" | "low";

export interface ScanFinding {
  rule: string;
  severity: FindingSeverity;
  line: number;
  message: string;
}

export interface ApiCallInfo {
  method: string;
  /** Literal path (`/api/...`) or `null` if computed at run time. */
  path: string | null;
  line: number;
}

export interface ScanReport {
  version: 1;
  passed: boolean;
  bytes: number;
  findings: ScanFinding[];
  apiCalls: ApiCallInfo[];
  fetchHosts: string[];
  /** `true` if there is a `fetch` whose URL is not literal (the allowlist stops it at run time). */
  dynamicFetch: boolean;
  envVars: string[];
}

export const MAX_SCANNABLE_BYTES = 64 * 1024;
const MAX_LINE = 1000;

// ── Tokens ──────────────────────────────────────────────────────────────────

type Token =
  | { t: "id"; v: string; l: number }
  | { t: "p"; v: string; l: number }
  | { t: "s"; v: string; raw: string; template: boolean; interpolated: boolean; l: number }
  | { t: "n"; l: number }
  | { t: "re"; l: number };

interface Read {
  tokens: Token[];
  withoutFinishing: boolean;
  /** Lines where a `/` could be read as a regex or as a division (see below). */
  ambiguousSlashes: number[];
}

const LONG_PUNCTUATION = [
  "===",
  "!==",
  "**=",
  "...",
  "?.",
  "??",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
];

/** Keywords after which a `/` always starts a regex. */
const BEFORE_REGEX = [
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "new",
  "delete",
  "void",
  "throw",
  "await",
];
/** Words that are keywords or plain identifiers depending on context: a `/` after them is a doubt. */
const BEFORE_REGEX_AMBIGUOUS = ["of", "yield"];
const CONTROL_HEADERS = ["if", "while", "for", "with"];
/** A line terminator for a `//` comment, as the interpreter sees it. */
const LINE_END = /[\n\r\u2028\u2029]/;

function readTokens(code: string): Read {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let withoutFinishing = false;
  const ambiguousSlashes: number[] = [];
  const n = code.length;
  /** For each open `(`: does it open the header of if/while/for/with? */
  const parens: boolean[] = [];
  let lastCloseIsControl = false;
  /**
   * Open braces. `template` is the `${` of a template literal: its `}` resumes
   * the string instead of being a token of the code.
   */
  const braces: ("block" | "object" | "template")[] = [];
  let lastBraceIsBlock = false;
  const lastSignificant = () => tokens[tokens.length - 1];

  /** Is the `{` about to be read a block (rather than an object literal or a class body)? */
  const blockBrace = () => {
    const u = lastSignificant();
    if (!u) return true;
    if (u.t === "id") return ["else", "do", "try", "finally"].includes(u.v);
    return u.t === "p" && [")", ";", "{", "}", "=>", "${"].includes(u.v);
  };
  /** Is the `(` about to be read the header of if/while/for/with? */
  const controlParens = () => {
    const u = lastSignificant();
    const a = tokens[tokens.length - 2];
    if (u?.t !== "id") return false;
    if (a?.t === "p" && (a.v === "." || a.v === "?.")) return false;
    return CONTROL_HEADERS.includes(u.v) || (u.v === "await" && a?.t === "id" && a.v === "for");
  };
  const canStartRegex = () => {
    const u = lastSignificant();
    if (!u) return true;
    if (u.t === "id") return BEFORE_REGEX.includes(u.v) || BEFORE_REGEX_AMBIGUOUS.includes(u.v);
    if (u.t === "n" || u.t === "s" || u.t === "re") return false;
    if (u.v === ")") return lastCloseIsControl;
    if (u.v === "}") return lastBraceIsBlock;
    return u.v !== "]";
  };
  /**
   * A slash the lexer cannot settle without a real parser: after `}` (a block
   * or an object?) and after `of`/`yield` (a keyword or a name?). A wrong guess
   * would swallow code as if it were a regex or a string, so it is reported and
   * the draft goes to a human.
   */
  const ambiguousSlash = () => {
    const u = lastSignificant();
    return u?.t === "id" ? BEFORE_REGEX_AMBIGUOUS.includes(u.v) : u?.t === "p" && u.v === "}";
  };

  /**
   * Reads a piece of a template literal, from `i` up to its closing backtick or
   * its next `${`. What is inside `${...}` is CODE, so it goes through the main
   * loop like everything else.
   */
  const readTemplateChunk = (start: number, initialLine: number) => {
    let value = "";
    let closed = false;
    let interpolated = false;
    while (i < n) {
      const d = code[i]!;
      if (d === "\\") {
        const [text, length] = readEscape(code, i);
        value += text;
        if (code[i + 1] === "\n") line++;
        i += length;
        continue;
      }
      if (d === "\n") line++;
      if (d === "$" && code[i + 1] === "{") {
        interpolated = true;
        i += 2;
        break;
      }
      if (d === "`") {
        closed = true;
        i++;
        break;
      }
      value += d;
      i++;
    }
    const continuation = code[start] !== "`";
    tokens.push({
      t: "s",
      v: value,
      raw: code.slice(start, i),
      template: true,
      interpolated: interpolated || continuation,
      l: initialLine,
    });
    if (interpolated) {
      tokens.push({ t: "p", v: "${", l: line });
      braces.push("template");
    } else if (!closed) {
      withoutFinishing = true;
    }
  };

  while (i < n) {
    const c = code[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (
      c === " " ||
      c === "\t" ||
      c === "\r" ||
      c === "\f" ||
      c === "\v" ||
      c === "\u00a0" ||
      c === "\ufeff" ||
      c === "\u2028" ||
      c === "\u2029"
    ) {
      i++;
      continue;
    }
    // Comments
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && !LINE_END.test(code[i]!)) i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const fin = code.indexOf("*/", i + 2);
      const until = fin < 0 ? n : fin + 2;
      if (fin < 0) withoutFinishing = true;
      for (let k = i; k < until; k++) if (code[k] === "\n") line++;
      i = until;
      continue;
    }
    // Templates: the code in `${...}` is read as code, not as text
    if (c === "`") {
      const start = i;
      const initialLine = line;
      i++;
      readTemplateChunk(start, initialLine);
      continue;
    }
    if (c === "}" && braces[braces.length - 1] === "template") {
      braces.pop();
      tokens.push({ t: "p", v: "}$", l: line });
      const start = i;
      const initialLine = line;
      i++;
      readTemplateChunk(start, initialLine);
      continue;
    }
    // Strings
    if (c === "'" || c === '"') {
      const start = i;
      const initialLine = line;
      let value = "";
      i++;
      let closed = false;
      while (i < n) {
        const d = code[i]!;
        if (d === "\\") {
          const [text, length] = readEscape(code, i);
          value += text;
          if (code[i + 1] === "\n") line++;
          i += length;
          continue;
        }
        if (d === "\n") {
          line++;
          break;
        }
        if (d === c) {
          closed = true;
          i++;
          break;
        }
        value += d;
        i++;
      }
      if (!closed) withoutFinishing = true;
      tokens.push({
        t: "s",
        v: value,
        raw: code.slice(start, i),
        template: false,
        interpolated: false,
        l: initialLine,
      });
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      while (i < n && /[0-9a-fA-FxXoObBn_.eE]/.test(code[i]!)) i++;
      tokens.push({ t: "n", l: line });
      continue;
    }
    // Identifiers (including escaped ones eval: they are read as raw text)
    if (/[A-Za-z_$\u0080-\uffff\\]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$\u0080-\uffff\\]/.test(code[i]!)) {
        if (code[i] === "\\" && code[i + 1] === "u") i += 2;
        else i++;
      }
      let v = code.slice(start, i);
      if (v.includes("\\u")) {
        // `eval` is `eval` to the interpreter: it is decoded to look at it.
        v = v.replace(/\\u\{?([0-9a-fA-F]{1,6})\}?/g, (_, h: string) =>
          String.fromCodePoint(parseInt(h, 16))
        );
      }
      tokens.push({ t: "id", v, l: line });
      continue;
    }
    // Regular expression literal
    if (c === "/" && ambiguousSlash()) ambiguousSlashes.push(line);
    if (c === "/" && canStartRegex()) {
      i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        const d = code[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i]!)) i++;
      tokens.push({ t: "re", l: line });
      continue;
    }
    const long = LONG_PUNCTUATION.find((p) => code.startsWith(p, i));
    if (long) {
      tokens.push({ t: "p", v: long, l: line });
      i += long.length;
      continue;
    }
    if (c === "(") parens.push(controlParens());
    if (c === ")") lastCloseIsControl = parens.pop() === true;
    if (c === "{") braces.push(blockBrace() ? "block" : "object");
    if (c === "}") lastBraceIsBlock = braces.pop() === "block";
    tokens.push({ t: "p", v: c, l: line });
    i++;
  }
  if (braces.includes("template")) withoutFinishing = true;
  return { tokens, withoutFinishing, ambiguousSlashes };
}

// ── Rules ───────────────────────────────────────────────────────────────────

/** Globals the sandbox does NOT provide (or that only serve to escape from it). */
const FORBIDDEN_GLOBALS = new Set([
  "process",
  "require",
  "globalThis",
  "Bun",
  "Deno",
  "WebAssembly",
  "SharedArrayBuffer",
  "Atomics",
  "Worker",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
]);

/** The internals of the `child.mjs` prologue: touching them is trying to talk to the host by hand. */
const SANDBOX_INTERNALS = /^__(request|log|call|api|run|event|env|createResponse|text|effect)$/;

const OBFUSCATION = new Set(["atob", "fromCharCode", "fromCodePoint", "unescape"]);

const API_METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};

/** Secrets with a recognizable shape. The message gives the type, never the value. */
const SECRETS: { type: string; re: RegExp }[] = [
  { type: "Kitsuden key", re: /(kitsuden_agent_|kitsuden_sk_|grm_agent_)[A-Za-z0-9_-]{8,}/ },
  { type: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { type: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { type: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { type: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { type: "Stripe key", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { type: "API key (sk-)", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { type: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { type: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    type: "connection string with password",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i,
  },
];

/** `password = "…"`, `apiKey: '…'` (in code, not in a string). */
const SECRET_ASSIGNMENT =
  /^(password|passwd|pwd|secret|client_?secret|token|access_?token|api_?key|apikey|private_?key)$/i;

function urlHost(text: string): string | null {
  const m = /^https?:\/\/([^/?#:@]+)(?::\d+)?(?:[/?#]|$)/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

function allowedHost(host: string, list: readonly string[]): boolean {
  return list.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.")
      ? host.endsWith(q.slice(1)) && host.length > q.length - 1
      : host === q;
  });
}

/**
 * Does the argument end at the literal? Only if `)` or `,` follows it. With
 * `+`, `.concat(`, `?:`, `[…]` or anything else the real path is computed at
 * run time and the literal is only a prefix (security review F73).
 */
function argumentEnds(tok: Token | undefined): boolean {
  return tok?.t === "p" && (tok.v === ")" || tok.v === ",");
}

function literalPath(tok: Token | undefined): { path: string | null; literal: boolean } {
  if (!tok || tok.t !== "s") return { path: null, literal: false };
  if (tok.interpolated) {
    // `/api/datasets/${x}/entries`: the fixed part before the first interpolation.
    return { path: null, literal: false };
  }
  return { path: tok.v, literal: true };
}

/**
 * The path the router will see. Hono decodes percent-escapes, so
 * `/api/%61dmin/x` reaches `/api/admin/x`: classifying the raw text misses it.
 * `null` (unclassifiable) if it cannot be decoded. The query string stays as is.
 */
function decodedPath(path: string): string | null {
  const cut = path.indexOf("?");
  const route = cut < 0 ? path : path.slice(0, cut);
  try {
    return decodeURIComponent(route) + (cut < 0 ? "" : path.slice(cut));
  } catch {
    return null;
  }
}

/** Methods every object inherits: `env.valueOf()` hands out the whole object. */
const OBJECT_INHERITED = new Set([
  "valueOf",
  "toString",
  "toLocaleString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

export interface ScanOptions {
  /** Declared hosts (the draft's `fetchAllow`). */
  fetchAllow?: readonly string[];
}

/** The scan (see the header). Pure and deterministic. */

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
};

/**
 * Decodes the escape at `code[i]` (a backslash) the way JavaScript does, and
 * returns the text and how many characters it took. Keeping only the character
 * after the backslash read `"\u0061dmin"` as `u0061dmin`, while QuickJS runs it
 * as `admin`: a literal API path escaped that way slipped past review
 * (security review 2026-11-03).
 */
function readEscape(code: string, i: number): [string, number] {
  const sig = code[i + 1] ?? "";
  if (sig in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[sig]!, 2];
  if (sig === "\r") return ["", code[i + 2] === "\n" ? 3 : 2];
  if (sig === "\n" || sig === "\u2028" || sig === "\u2029") return ["", 2];
  if (sig === "x") {
    const hex = code.slice(i + 2, i + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), 4];
  }
  if (sig === "u") {
    if (code[i + 2] === "{") {
      const end = code.indexOf("}", i + 3);
      const hex = end > 0 ? code.slice(i + 3, end) : "";
      if (/^[0-9a-fA-F]{1,6}$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
        return [String.fromCodePoint(parseInt(hex, 16)), end - i + 1];
      }
    } else {
      const hex = code.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), 6];
    }
  }
  if (/[0-7]/.test(sig)) {
    // Legacy octal escape (sloppy mode): up to three digits, at most \377.
    const digits = /^[0-7]{1,3}/.exec(code.slice(i + 1, i + 4))![0];
    const value = parseInt(digits, 8);
    const used = value > 0o377 ? digits.slice(0, 2) : digits;
    return [String.fromCharCode(parseInt(used, 8)), 1 + used.length];
  }
  return [sig, 2];
}

export function scanCode(code: string, options: ScanOptions = {}): ScanReport {
  const findings: ScanFinding[] = [];
  const add = (rule: string, severity: FindingSeverity, line: number, message: string) => {
    // One finding per rule and line is enough for a human to take a look.
    if (!findings.some((h) => h.rule === rule && h.line === line))
      findings.push({ rule, severity, line, message });
  };
  const bytes = new TextEncoder().encode(code).byteLength;
  const calls: ApiCallInfo[] = [];
  const hosts = new Set<string>();
  const variables = new Set<string>();
  let dynamicFetch = false;
  const declaredAll = (options.fetchAllow ?? []).map((h) => h.toLowerCase());

  if (bytes > MAX_SCANNABLE_BYTES) {
    add(
      "oversize",
      "high",
      1,
      `Code is ${bytes} bytes; drafts above ${MAX_SCANNABLE_BYTES} bytes are not reviewable`
    );
  }
  code.split("\n").forEach((text, idx) => {
    if (text.length > MAX_LINE) {
      add(
        "long_line",
        "medium",
        idx + 1,
        `Line is ${text.length} characters long (minified or generated code cannot be reviewed)`
      );
    }
  });
  for (const { type: type, re } of SECRETS) {
    const m = re.exec(code);
    if (m) {
      const line = code.slice(0, m.index).split("\n").length;
      add(
        "secret_literal",
        "high",
        line,
        `Looks like a ${type} written in the code (use the action's environment variables or the vault)`
      );
    }
  }

  const { tokens, withoutFinishing: withoutFinishing, ambiguousSlashes } = readTokens(code);
  if (withoutFinishing)
    add(
      "unparsable",
      "medium",
      1,
      "Unterminated string or comment: the code cannot be reviewed reliably"
    );
  for (const line of ambiguousSlashes) {
    add(
      "ambiguous_slash",
      "medium",
      line,
      "A '/' after '}', 'of' or 'yield' can be a regex or a division: the code after it cannot be reviewed reliably"
    );
  }

  /** A literal API path: flags percent-escapes and records what the router will see. */
  const callPath = (path: string | null, line: number): string | null => {
    if (path === null) return null;
    if (path.split("?")[0]!.includes("%")) {
      add(
        "encoded_api_path",
        "medium",
        line,
        "Percent-escape in a literal API path: write the path as the route declares it"
      );
    }
    return decodedPath(path);
  };

  /** Open braces: inside a class body, `this` is the instance and not the global object. */
  const braces: boolean[] = [];
  let openClass = false;

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    const prev = tokens[k - 1];
    const sig = tokens[k + 1];
    const isMember = prev?.t === "p" && (prev.v === "." || prev.v === "?.");

    if (tok.t === "p") {
      if (tok.v === "{" || tok.v === "${") {
        braces.push(tok.v === "{" && openClass);
        if (tok.v === "{") openClass = false;
      } else if (tok.v === "}" || tok.v === "}$") {
        braces.pop();
      }
      continue;
    }
    if (tok.t === "id" && tok.v === "class" && !isMember) openClass = true;

    if (tok.t === "s") {
      // `obj["con" + "structor"]`, `obj[`con${x}`]`: the name of the member is
      // built at run time, so the rules on literal names cannot see it.
      if (
        prev?.t === "p" &&
        prev.v === "[" &&
        (tok.interpolated || (sig?.t === "p" && sig.v === "+"))
      ) {
        add(
          "computed_member",
          "medium",
          tok.l,
          "Member name built at run time: what it reaches cannot be reviewed statically"
        );
      }
      if (tok.v === "constructor" || tok.v === "__proto__" || tok.v === "prototype") {
        add(
          "constructor_escape",
          "high",
          tok.l,
          `String '${tok.v}' used to reach object internals`
        );
      }
      const escapes = (tok.raw.match(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F{])/g) ?? []).length;
      if (escapes >= 8)
        add(
          "obfuscation",
          "medium",
          tok.l,
          `String with ${escapes} escape sequences (obfuscated text)`
        );
      if (/^(GLOBALTHIS|PROCESS)$/i.test(tok.v) || SANDBOX_INTERNALS.test(tok.v)) {
        add("forbidden_global", "high", tok.l, `String naming a host global ('${tok.v}')`);
      }
      continue;
    }
    if (tok.t !== "id") continue;
    const v = tok.v;

    if (v === "eval" && !isMember) {
      add("dynamic_eval", "high", tok.l, "eval() runs code built at runtime");
      continue;
    }
    if (
      v === "Function" &&
      !isMember &&
      ((sig?.t === "p" && sig.v === "(") || (prev?.t === "id" && prev.v === "new"))
    ) {
      add("dynamic_eval", "high", tok.l, "Function() builds code at runtime");
      continue;
    }
    if (v === "import" && !isMember) {
      add(
        "dynamic_import",
        "high",
        tok.l,
        "import is not available in the sandbox (dynamic import / import.meta)"
      );
      continue;
    }
    // `class A { constructor() {} }` declares, it does not escape.
    const declaresMethod =
      !isMember &&
      sig?.t === "p" &&
      sig.v === "(" &&
      prev?.t === "p" &&
      ["{", "}", ";"].includes(prev.v);
    if (v === "constructor" && declaresMethod) continue;
    if (
      v === "constructor" ||
      v === "__proto__" ||
      v === "__defineGetter__" ||
      v === "__lookupGetter__"
    ) {
      add(
        "constructor_escape",
        "high",
        tok.l,
        `'${v}' reaches object internals (classic sandbox escape)`
      );
      continue;
    }
    // Outside a class, `this` is the global object: `this["__pe" + "dir"]` reaches
    // the prologue without naming it.
    if (v === "this" && !isMember && !braces.includes(true)) {
      add(
        "forbidden_global",
        "high",
        tok.l,
        "'this' outside a class is the global object of the sandbox"
      );
      continue;
    }
    if (!isMember && FORBIDDEN_GLOBALS.has(v)) {
      add(
        "forbidden_global",
        "high",
        tok.l,
        `'${v}' is a host global outside kitsuden.api.* (it does not exist in the sandbox)`
      );
      continue;
    }
    if (SANDBOX_INTERNALS.test(v)) {
      add("forbidden_global", "high", tok.l, `'${v}' is internal to the sandbox prologue`);
      continue;
    }
    if (OBFUSCATION.has(v)) {
      add("obfuscation", "medium", tok.l, `'${v}' is typical of obfuscated code`);
      continue;
    }
    if ((v === "Reflect" || v === "Proxy") && !isMember) {
      add("reflection", "medium", tok.l, `'${v}' makes the code hard to review statically`);
      continue;
    }
    if ((v === "setTimeout" || v === "setInterval") && !isMember) {
      const arg = tokens[k + 2];
      if (sig?.t === "p" && sig.v === "(" && arg?.t === "s") {
        add("dynamic_eval", "high", tok.l, `${v}() with a string argument evaluates code`);
      }
      continue;
    }
    if (
      v === "while" &&
      sig?.t === "p" &&
      sig.v === "(" &&
      tokens[k + 2]?.t === "id" &&
      (tokens[k + 2] as { v: string }).v === "true"
    ) {
      add("unbounded_loop", "low", tok.l, "while(true): relies on the sandbox time limit");
      continue;
    }

    // `env.X`, `kitsuden.env.X`
    const fromKitsuden =
      tokens[k - 2]?.t === "id" && (tokens[k - 2] as { v: string }).v === "kitsuden";
    if (v === "env" && (!isMember || fromKitsuden)) {
      const objectKey =
        !fromKitsuden &&
        sig?.t === "p" &&
        sig.v === ":" &&
        prev?.t === "p" &&
        (prev.v === "{" || prev.v === ",");
      if (sig?.t === "p" && (sig.v === "." || sig.v === "?.") && tokens[k + 2]?.t === "id") {
        const name = (tokens[k + 2] as { v: string }).v;
        variables.add(OBJECT_INHERITED.has(name) ? "*" : name);
      } else if (sig?.t === "p" && sig.v === "[") {
        const key = tokens[k + 2];
        if (key?.t === "s" && !key.interpolated) variables.add(key.v);
        else variables.add("*");
      } else if (!objectKey) {
        // `JSON.stringify(env)`, `const { X } = env`, `const e = env`: reads every
        // variable at once, under names this scan cannot list.
        variables.add("*");
        add(
          "env_bulk_read",
          "medium",
          tok.l,
          "env used as a whole: read each variable as env.NAME so that a reviewer can see which ones"
        );
      }
    }

    // `fetch(...)` / `kitsuden.fetch(...)`
    if (v === "fetch" && (!isMember || fromKitsuden)) {
      if (sig?.t === "p" && sig.v === "(") {
        const arg = tokens[k + 2];
        const host = arg?.t === "s" ? urlHost(arg.v.split("${")[0] ?? "") : null;
        if (host) {
          hosts.add(host);
          if (!allowedHost(host, declaredAll)) {
            add(
              "undeclared_host",
              "medium",
              tok.l,
              `fetch to '${host}', which is not declared in fetchAllow (it would be refused at runtime)`
            );
          }
        } else {
          dynamicFetch = true;
        }
      }
      continue;
    }

    // `kitsuden.…`
    if (v === "kitsuden" && !isMember) {
      const p1 = tokens[k + 1];
      const m1 = tokens[k + 2];
      if (!(p1?.t === "p" && (p1.v === "." || p1.v === "?.")) || m1?.t !== "id") {
        add(
          "api_alias",
          "medium",
          tok.l,
          "kitsuden used without a direct member access: calls through it cannot be classified"
        );
        calls.push({ method: "*", path: null, line: tok.l });
        continue;
      }
      // `kitsuden.effect(key, fn)` asks the host for nothing but the ledger: what
      // it wraps is scanned like any other code (its fetch and API calls).
      if (m1.v === "effect") continue;
      if (["fetch", "env", "event", "log"].includes(m1.v)) continue;
      if (m1.v !== "api") {
        add("api_alias", "medium", tok.l, `kitsuden.${m1.v} is not part of the sandbox API`);
        continue;
      }
      const p2 = tokens[k + 3];
      const method = tokens[k + 4];
      const paren = tokens[k + 5];
      if (
        !(p2?.t === "p" && (p2.v === "." || p2.v === "?.")) ||
        method?.t !== "id" ||
        !(paren?.t === "p" && paren.v === "(")
      ) {
        add(
          "api_alias",
          "medium",
          tok.l,
          "kitsuden.api used indirectly (alias or computed member): its calls cannot be classified"
        );
        calls.push({ method: "*", path: null, line: tok.l });
        continue;
      }
      if (method.v === "request") {
        const m = tokens[k + 6];
        const comma = tokens[k + 7];
        const path = literalPath(tokens[k + 8]);
        const literalM = m?.t === "s" && !m.interpolated ? m.v.toUpperCase() : "*";
        const okComma = comma?.t === "p" && comma.v === ",";
        const okEnd = argumentEnds(tokens[k + 9]);
        calls.push({
          method: literalM,
          path: okComma && okEnd ? callPath(path.path, tok.l) : null,
          line: tok.l,
        });
        continue;
      }
      const http = API_METHODS[method.v];
      if (!http) {
        add("api_alias", "medium", tok.l, `kitsuden.api.${method.v} is not a sandbox API method`);
        continue;
      }
      // `"/api/ad" + "min/users/1"`: if the literal is not followed by `)` or
      // `,`, the path is computed and the literal is only a prefix → unclassified.
      const path = argumentEnds(tokens[k + 7]) ? literalPath(tokens[k + 6]).path : null;
      calls.push({
        method: http,
        path: callPath(path, tok.l),
        line: tok.l,
      });
      continue;
    }

    // `password = "…"` / `{ apiKey: "…" }`
    if (SECRET_ASSIGNMENT.test(v) && sig?.t === "p" && (sig.v === "=" || sig.v === ":")) {
      const value = tokens[k + 2];
      if (value?.t === "s" && !value.interpolated && value.v.length >= 8) {
        add(
          "secret_literal",
          "high",
          tok.l,
          `'${v}' is assigned a literal value (secrets belong in environment variables or the vault)`
        );
      }
    }
  }

  // A `for (;;)` loop.
  for (let k = 0; k + 4 < tokens.length; k++) {
    const a = tokens[k]!;
    if (a.t === "id" && a.v === "for") {
      const seq = tokens
        .slice(k + 1, k + 5)
        .map((x) => (x.t === "p" ? x.v : "?"))
        .join("");
      if (seq === "(;;)")
        add("unbounded_loop", "low", a.l, "for(;;): relies on the sandbox time limit");
    }
  }

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return {
    version: 1,
    passed: !findings.some((h) => h.severity === "high" || h.severity === "medium"),
    bytes,
    findings,
    apiCalls: calls,
    fetchHosts: [...hosts].sort(),
    dynamicFetch,
    envVars: [...variables].sort(),
  };
}
