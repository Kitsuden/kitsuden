/**
 * Kitsuden — TOON (Token-Oriented Object Notation), canonical codec
 * ============================================================================
 *
 * Own implementation, dependency-free, of https://toonformat.dev/ . The
 * encoder's OUTPUT is byte-for-byte the same as that of the reference
 * implementation `@toon-format/toon@4.4.0` for any JSON value, and the decoder
 * reads everything that version writes. It is guarded by
 * `src/tests-unit/toon-tabular.test.ts`, which compares the two in both
 * directions (also with random data).
 *
 * This file is the CANONICAL copy. There are two identical copies, byte for byte,
 * for the packages that cannot depend on the API: `packages/sdk/src/toon.ts`
 * (the SDK has no dependencies) and `packages/mcp-server/src/toon.ts`. It is guarded by
 * `src/tests-unit/toon-mirrors.test.ts`: edit here and copy.
 *
 *   users[2]{id,name,role}:        ← table: the keys ONCE, CSV rows
 *     1,Alice,admin
 *     2,Bob,user
 *   docs[2]{id,_meta{datasetId,createdAt},name}:   ← object column folded
 *     1,d1,2026-01-01,a                               into the header
 *     2,d1,2026-01-02,b
 *   tags[3]: admin,ops,dev         ← inline scalar array
 *   items[2]:                      ← list form (non-uniform objects)
 *     - id: 1
 *       extra: true
 *     - id: 2
 *   profile:                       ← empty object: the key with nothing after it
 *   empty: []                      ← empty array
 *
 * Root: an array is written without a key (`[2]{id}:`), an empty object is the
 * empty document, and a scalar is its literal. 2-space indentation.
 *
 * Input semantics = those of `JSON.stringify`: `toJSON` is called (Date →
 * ISO), `undefined`/function/symbol properties disappear, in an array
 * they become `null`, NaN/±Infinity become `null` and -0 becomes 0. That way
 * `decodeToon(encodeToon(x))` is the same as `JSON.parse(JSON.stringify(x))`,
 * which is what `auto` mode (lib/formats.ts) needs to verify that
 * a TOON response loses nothing compared with the same one in JSON.
 *
 * History (2026-10-25, measurement G1 in docs/agents/benchmarks.md): the previous
 * codec could not read the list form (it returned `[]` without error in 15 of
 * 24 real endpoints), wrote `{}` where TOON expects the bare key, and
 * put root arrays under an invented `data` key.
 */

// ── Literals and patterns (those of the reference) ──────────────────────────

const INDENTATION = 2;
const DELIMITER = ",";
const DELIMITERS = [",", "\t", "|"] as const;
/** Number that a decoder reads as a number (no leading zeros). */
const NUMERIC_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i;
/** Text that LOOKS like a number (with leading zeros or a + sign): it goes in quotes. */
const LOOKS_LIKE_NUMBER = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const UNQUOTED_KEY = /^[A-Z_][\w.]*$/i;
const ARRAY_LENGTH = /^(?:0|[1-9]\d*)$/;
// Control characters: they are escaped (\uXXXX) and force quoting. This is on purpose.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_GLOBAL = /[\u0000-\u001F]/g;

export class ToonDecodeError extends SyntaxError {
  line?: number;
  constructor(message: string, line?: number) {
    super(line !== undefined ? `Line ${line}: ${message}` : message);
    this.name = "ToonDecodeError";
    this.line = line;
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isScalar(v: unknown): v is null | boolean | number | string {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}
function isEmptyObject(v: JsonObject): boolean {
  for (const _ in v) return false;
  return true;
}
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Assigns without going through the inherited `__proto__` setter. */
function assign(target: JsonObject, key: string, value: Json): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

// ── Normalization with JSON.stringify semantics ─────────────────────────────

/**
 * Returns the value as `JSON.parse(JSON.stringify(v))` would see it.
 * Copies only what changes: a value that is already pure JSON is returned as is
 * (the middleware case, which starts from an already parsed body).
 */
function normalize(v: unknown, withinArray: boolean): Json | undefined {
  if (v === null) return null;
  if (typeof v === "object" || typeof v === "bigint") {
    const withToJson = v as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") return normalize(withToJson.toJSON(), withinArray);
  }
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      if (!Number.isFinite(v)) return null;
      return Object.is(v, -0) ? 0 : v;
    case "bigint":
      // Same as JSON.stringify: a BigInt without toJSON cannot be serialized.
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      return withinArray ? null : undefined;
  }
  if (Array.isArray(v)) {
    let copy: Json[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const n = normalize(v[i], true) as Json;
      if (copy) copy.push(n);
      else if (n !== v[i]) {
        copy = v.slice(0, i) as Json[];
        copy.push(n);
      }
    }
    return copy ?? (v as Json[]);
  }
  const obj = v as Record<string, unknown>;
  let copy: JsonObject | null = null;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const n = normalize(obj[k], false);
    if (copy) {
      if (n !== undefined) assign(copy, k, n);
    } else if (n !== obj[k]) {
      copy = {};
      for (let j = 0; j < i; j++) assign(copy, keys[j]!, obj[keys[j]!] as Json);
      if (n !== undefined) assign(copy, k, n);
    }
  }
  return copy ?? (obj as JsonObject);
}

// ── Scalars ─────────────────────────────────────────────────────────────────

function escape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(CONTROL_GLOBAL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function goesWithoutQuotes(s: string): boolean {
  if (!s) return false;
  if (/^[ \t]|[ \t]$/.test(s)) return false;
  if (s === "true" || s === "false" || s === "null") return false;
  if (LOOKS_LIKE_NUMBER.test(s)) return false;
  if (s.includes(":") || s.includes('"') || s.includes("\\")) return false;
  if (/[[\]{}]/.test(s)) return false;
  if (CONTROL.test(s)) return false;
  if (s.includes(DELIMITER)) return false;
  if (s.startsWith("-") || s.startsWith("#")) return false;
  return true;
}

function scalar(v: null | boolean | number | string): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return goesWithoutQuotes(v) ? v : `"${escape(v)}"`;
}

function key(k: string): string {
  return UNQUOTED_KEY.test(k) ? k : `"${escape(k)}"`;
}

// ── Table detection ─────────────────────────────────────────────────────────

/** Column of a table: a leaf, or a uniform object folded into the header. */
interface Field {
  name: string;
  children?: Field[];
}

/** Rows are a table if they have the same keys and each column is a leaf or table-object. */
function tableFields(rows: JsonObject[]): Field[] | undefined {
  if (rows.length === 0) return undefined;
  const firstOnes = Object.keys(rows[0]!);
  if (firstOnes.length === 0) return undefined;
  for (const row of rows) {
    if (Object.keys(row).length !== firstOnes.length) return undefined;
    for (const k of firstOnes) if (!has(row, k)) return undefined;
  }
  const fields: Field[] = [];
  for (const k of firstOnes) {
    const column = rows.map((f) => f[k]);
    if (column.every(isScalar)) {
      fields.push({ name: k });
      continue;
    }
    if (!column.every((v) => isObject(v) && !isEmptyObject(v))) return undefined;
    const children = tableFields(column as JsonObject[]);
    if (!children) return undefined;
    fields.push({ name: k, children });
  }
  return fields;
}

/** Object whose values (2 or more) are uniform objects: table with a key per row. */
function tableFieldsWithKey(v: JsonObject): Field[] | undefined {
  const values = Object.values(v);
  if (values.length < 2) return undefined;
  if (!values.every((x) => isObject(x) && !isEmptyObject(x))) return undefined;
  return tableFields(values as JsonObject[]);
}

function leaves(row: JsonObject, fields: Field[], out: Json[]): Json[] {
  for (const c of fields) {
    const v = row[c.name] as Json;
    if (c.children) leaves(v as JsonObject, c.children, out);
    else out.push(v);
  }
  return out;
}

function fieldSegment(fields: Field[]): string {
  return fields
    .map((c) => key(c.name) + (c.children ? `{${fieldSegment(c.children)}}` : ""))
    .join(DELIMITER);
}

function header(length: number, k?: string, fields?: Field[], withKey = false): string {
  let h = k !== undefined ? key(k) : "";
  h += `[${length}${withKey ? ":" : ""}]`;
  if (fields) h += `{${fieldSegment(fields)}}`;
  return h + ":";
}

function csvRow(values: Json[]): string {
  return values.map((v) => scalar(v as null | boolean | number | string)).join(DELIMITER);
}

// ── Encoder ─────────────────────────────────────────────────────────────────

class Output {
  readonly lines: string[] = [];
  line(level: number, text: string): void {
    this.lines.push(" ".repeat(INDENTATION * level) + text);
  }
  item(level: number, text: string): void {
    this.line(level, "- " + text);
  }
}

function inlineLine(values: Json[], k?: string): string {
  const h = header(values.length, k);
  return values.length === 0 ? h : `${h} ${csvRow(values)}`;
}

function encodeObject(o: JsonObject, level: number, s: Output): void {
  for (const k of Object.keys(o)) encodePair(k, o[k] as Json, level, s);
}

function encodePair(k: string, v: Json, level: number, s: Output): void {
  if (isScalar(v)) {
    s.line(level, `${key(k)}: ${scalar(v)}`);
  } else if (Array.isArray(v)) {
    encodeArray(k, v, level, s);
  } else {
    const withKey = tableFieldsWithKey(v);
    if (withKey) {
      encodeTableWithKey(k, v, withKey, level, s);
      return;
    }
    s.line(level, `${key(k)}:`);
    if (!isEmptyObject(v)) encodeObject(v, level + 1, s);
  }
}

function encodeTableWithKey(
  k: string | undefined,
  v: JsonObject,
  fields: Field[],
  level: number,
  s: Output
): void {
  const inputs = Object.keys(v);
  s.line(level, header(inputs.length, k, fields, true));
  rowsWithKey(v, inputs, fields, level + 1, s);
}

function rowsWithKey(
  v: JsonObject,
  inputs: string[],
  fields: Field[],
  level: number,
  s: Output
): void {
  for (const e of inputs)
    s.line(level, `${key(e)}: ${csvRow(leaves(v[e] as JsonObject, fields, []))}`);
}

function tableRows(rows: JsonObject[], fields: Field[], level: number, s: Output): void {
  for (const f of rows) s.line(level, csvRow(leaves(f, fields, [])));
}

function encodeArray(k: string | undefined, v: Json[], level: number, s: Output): void {
  if (v.length === 0) {
    s.line(level, k !== undefined ? `${key(k)}: []` : "[]");
    return;
  }
  if (v.every(isScalar)) {
    s.line(level, inlineLine(v, k));
    return;
  }
  if (v.every((a) => Array.isArray(a) && a.every(isScalar))) {
    s.line(level, header(v.length, k));
    for (const a of v) s.item(level + 1, inlineLine(a as Json[]));
    return;
  }
  if (v.every(isObject)) {
    const fields = tableFields(v as JsonObject[]);
    if (fields) {
      s.line(level, header(v.length, k, fields));
      tableRows(v as JsonObject[], fields, level + 1, s);
      return;
    }
  }
  s.line(level, header(v.length, k));
  for (const x of v) encodeItem(x, level + 1, s);
}

function encodeItem(v: Json, level: number, s: Output): void {
  if (isScalar(v)) {
    s.item(level, scalar(v));
  } else if (Array.isArray(v)) {
    if (v.every(isScalar)) s.item(level, inlineLine(v));
    else {
      s.item(level, header(v.length));
      for (const x of v) encodeItem(x, level + 1, s);
    }
  } else {
    encodeObjectAsItem(v, level, s);
  }
}

function encodeObjectAsItem(o: JsonObject, level: number, s: Output): void {
  const keys = Object.keys(o);
  if (keys.length === 0) {
    s.line(level, "-");
    return;
  }
  const k0 = keys[0]!;
  const v0 = o[k0] as Json;
  const rest = (): void => {
    for (let i = 1; i < keys.length; i++) encodePair(keys[i]!, o[keys[i]!] as Json, level + 1, s);
  };

  if (Array.isArray(v0) && v0.length > 0 && v0.every(isObject)) {
    const fields = tableFields(v0 as JsonObject[]);
    if (fields) {
      s.item(level, header(v0.length, k0, fields));
      tableRows(v0 as JsonObject[], fields, level + 2, s);
      rest();
      return;
    }
  }
  if (isObject(v0)) {
    const withKey = tableFieldsWithKey(v0);
    if (withKey) {
      const inputs = Object.keys(v0);
      s.item(level, header(inputs.length, k0, withKey, true));
      rowsWithKey(v0, inputs, withKey, level + 2, s);
      rest();
      return;
    }
  }
  const ck = key(k0);
  if (isScalar(v0)) {
    s.item(level, `${ck}: ${scalar(v0)}`);
  } else if (Array.isArray(v0)) {
    if (v0.length === 0) s.item(level, `${ck}: []`);
    else if (v0.every(isScalar)) s.item(level, `${ck}${inlineLine(v0)}`);
    else {
      s.item(level, `${ck}${header(v0.length)}`);
      for (const x of v0) encodeItem(x, level + 2, s);
    }
  } else {
    s.item(level, `${ck}:`);
    if (!isEmptyObject(v0)) encodeObject(v0, level + 2, s);
  }
  rest();
}

/**
 * Encodes a value to TOON. Same output as `encode()` from
 * `@toon-format/toon@4.4.0` (without a trailing newline). `undefined` at the root
 * gives `null`, like the JSON body of an empty response.
 */
export function encodeToon(input: unknown): string {
  const v = normalize(input, true) ?? null;
  if (isScalar(v)) {
    // A text that starts with a BOM is always quoted (otherwise it would disappear).
    return typeof v === "string" && v.startsWith("\uFEFF") ? `"${escape(v)}"` : scalar(v);
  }
  const s = new Output();
  if (Array.isArray(v)) encodeArray(undefined, v, 0, s);
  else {
    const withKey = tableFieldsWithKey(v);
    if (withKey) encodeTableWithKey(undefined, v, withKey, 0, s);
    else encodeObject(v, 0, s);
  }
  return s.lines.join("\n");
}

// ── Decoder ─────────────────────────────────────────────────────────────────

interface Line {
  level: number;
  text: string;
  num: number;
}

class Reader {
  private i = 0;
  constructor(private readonly lines: Line[]) {}
  look(): Line | undefined {
    return this.lines[this.i];
  }
  read(): Line | undefined {
    return this.lines[this.i++];
  }
}

function scan(text: string): Line[] {
  const rawOnes = text.split("\n");
  const out: Line[] = [];
  for (let n = 0; n < rawOnes.length; n++) {
    let raw = rawOnes[n]!;
    if (n === 0 && raw.startsWith("\uFEFF")) raw = raw.slice(1);
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    let indent = 0;
    let withTab = false;
    while (indent < raw.length && (raw[indent] === " " || raw[indent] === "\t")) {
      if (raw[indent] === "\t") withTab = true;
      indent++;
    }
    let end = raw.length;
    while (end > indent && raw[end - 1] === " ") end--;
    if (end === indent) continue; // blank line
    if (!withTab && raw[indent] === "#") continue; // comment
    if (withTab) throw new ToonDecodeError("Tabs are not allowed in indentation", n + 1);
    const content = indent === 0 && end === raw.length ? raw : raw.slice(indent, end);
    out.push({ level: Math.floor(indent / INDENTATION), text: content, num: n + 1 });
  }
  return out;
}

function trim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === " ") a++;
  while (b > a && s[b - 1] === " ") b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"' };

function unescapeText(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\(u[0-9a-fA-F]{4}|.?)/g, (_, seq: string) => {
    if (seq.length === 5) return String.fromCharCode(parseInt(seq.slice(1), 16));
    const c = ESCAPES[seq];
    if (c === undefined) throw new SyntaxError(`Invalid escape sequence: \\${seq}`);
    return c;
  });
}

function closingQuote(s: string, from: number): number {
  for (let i = from + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

/** Position of `ch` outside quotes, or -1. */
function outsideQuotes(s: string, ch: string, from = 0): number {
  // Shortcut: if `ch` appears before the first quote, it is outside quotes.
  const quote = s.indexOf('"', from);
  const direct = s.indexOf(ch, from);
  if (quote === -1 || (direct !== -1 && direct < quote)) return direct;
  let inside = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inside && c === "\\") {
      i++;
      continue;
    }
    if (c === '"') inside = !inside;
    else if (!inside && c === ch) return i;
  }
  return -1;
}

function literalText(token: string): string {
  const t = trim(token);
  if (!t.startsWith('"')) return t;
  const end = closingQuote(t, 0);
  if (end === -1) throw new SyntaxError("Unterminated string: missing closing quote");
  if (end !== t.length - 1) throw new SyntaxError("Unexpected characters after closing quote");
  return unescapeText(t.slice(1, end));
}

function primitive(token: string): Json {
  const t = trim(token);
  if (!t) return "";
  if (t.startsWith('"')) return literalText(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (NUMERIC_LITERAL.test(t)) {
    const n = Number.parseFloat(t);
    if (Number.isFinite(n)) return Object.is(n, -0) ? 0 : n;
  }
  return t;
}

function separate(input: string, delim: string): string[] {
  if (!input.includes('"')) return input === "" ? [] : input.split(delim).map(trim);
  const values: string[] = [];
  let start = 0;
  let inside = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inside && c === "\\" && i + 1 < input.length) {
      i++;
      continue;
    }
    if (c === '"') inside = !inside;
    else if (!inside && c === delim) {
      values.push(trim(input.slice(start, i)));
      start = i + 1;
    }
  }
  if (start < input.length || values.length > 0) values.push(trim(input.slice(start)));
  return values;
}

function closingBrace(s: string, from: number): number {
  let inside = false;
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inside && c === "\\") {
      i++;
      continue;
    }
    if (c === '"') inside = !inside;
    else if (!inside && c === "{") depth++;
    else if (!inside && c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readFields(segment: string, delim: string): Field[] {
  const parts: string[] = [];
  let actual = "";
  let inside = false;
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (inside && c === "\\" && i + 1 < segment.length) {
      actual += c + segment[i + 1];
      i++;
      continue;
    }
    if (c === '"') inside = !inside;
    else if (!inside && c === "{") depth++;
    else if (!inside && c === "}") depth--;
    else if (!inside && depth === 0 && c === delim) {
      parts.push(actual);
      actual = "";
      continue;
    }
    actual += c;
  }
  parts.push(actual);
  return parts.map((p) => {
    const t = trim(p);
    if (!t) throw new SyntaxError("Empty field name in field list");
    const opens = outsideQuotes(t, "{");
    if (opens === -1) return { name: literalText(t) };
    const closes = closingBrace(t, opens);
    if (closes !== t.length - 1)
      throw new SyntaxError("Unexpected content after nested field group");
    return {
      name: literalText(t.slice(0, opens)),
      children: readFields(t.slice(opens + 1, closes), delim),
    };
  });
}

function countLeaves(cs: Field[]): number {
  let n = 0;
  for (const c of cs) n += c.children ? countLeaves(c.children) : 1;
  return n;
}

interface Header {
  key?: string;
  length: number;
  delim: string;
  fields?: Field[];
  withKey: boolean;
  online?: string;
}

/** Reads an array header (`key[N]{fields}: ...`) or returns undefined if the line is not one. */
function readHeader(text: string): Header | undefined {
  let opens: number;
  if (text.startsWith('"')) {
    const end = closingQuote(text, 0);
    if (end === -1 || text[end + 1] !== "[") return undefined;
    opens = end + 1;
  } else opens = outsideQuotes(text, "[");
  if (opens === -1) return undefined;
  const firstColon = outsideQuotes(text, ":");
  if (firstColon === -1 || firstColon < opens) return undefined;
  const closes = outsideQuotes(text, "]", opens);
  if (closes === -1) throw new SyntaxError("Unterminated bracket segment");

  let endBraces = closes + 1;
  const brace = outsideQuotes(text, "{", closes);
  if (brace !== -1 && brace < outsideQuotes(text, ":", closes)) {
    if (brace !== closes + 1)
      throw new SyntaxError("Unexpected content between bracket segment and field list");
    const end = closingBrace(text, brace);
    if (end !== -1) endBraces = end + 1;
  }
  const colon = outsideQuotes(text, ":", Math.max(closes, endBraces));
  if (colon === -1) throw new SyntaxError("Missing colon after array header");
  if (colon !== Math.max(closes + 1, endBraces)) {
    throw new SyntaxError("Unexpected content between bracket segment and colon");
  }

  let k: string | undefined;
  if (opens > 0) {
    const raw = text.slice(0, opens);
    if (/[ \t]$/.test(raw))
      throw new SyntaxError("Unexpected whitespace between key and bracket segment");
    k = raw.startsWith('"') ? literalText(raw) : raw;
  }

  let seg = text.slice(opens + 1, closes);
  let delim: string = DELIMITER;
  if (seg.endsWith("\t")) {
    delim = "\t";
    seg = seg.slice(0, -1);
  } else if (seg.endsWith("|")) {
    delim = "|";
    seg = seg.slice(0, -1);
  }
  let withKey = false;
  if (seg.endsWith(":")) {
    withKey = true;
    seg = seg.slice(0, -1);
  }
  if (!ARRAY_LENGTH.test(seg)) throw new SyntaxError(`Invalid array length: "${seg}"`);

  let cs: Field[] | undefined;
  if (brace !== -1 && brace < colon) {
    const end = closingBrace(text, brace);
    if (end !== -1 && end < colon) {
      const content = text.slice(brace + 1, end);
      for (const other of DELIMITERS) {
        if (other !== delim && outsideQuotes(content, other) !== -1) {
          throw new SyntaxError("Header delimiter mismatch");
        }
      }
      cs = readFields(content, delim);
    }
  }
  const after = trim(text.slice(colon + 1));
  if (withKey && !cs) throw new SyntaxError("Keyed header requires a field list");
  if (cs && after) throw new SyntaxError("Unexpected content after fields-bearing header colon");
  return {
    key: k,
    length: Number.parseInt(seg, 10),
    delim,
    fields: cs,
    withKey,
    online: after || undefined,
  };
}

function readKey(text: string): { key: string; end: number } {
  if (text.startsWith('"')) {
    const closes = closingQuote(text, 0);
    if (closes === -1) throw new SyntaxError("Unterminated quoted key");
    let p = closes + 1;
    while (text[p] === " ") p++;
    if (text[p] !== ":") throw new SyntaxError("Missing colon after key");
    return { key: unescapeText(text.slice(1, closes)), end: p + 1 };
  }
  const colon = outsideQuotes(text, ":");
  if (colon === -1) throw new SyntaxError("Missing colon after key");
  return { key: trim(text.slice(0, colon)), end: colon + 1 };
}

const isHeaderWithoutKey = (t: string) => trim(t).startsWith("[") && outsideQuotes(t, ":") !== -1;
const isKeyValuePair = (t: string) => outsideQuotes(t, ":") !== -1;

/** In a table, is the line a row (and not a following `key: value`)? */
function isRow(text: string, delim: string): boolean {
  const colon = outsideQuotes(text, ":");
  if (colon === -1) return true;
  const d = outsideQuotes(text, delim);
  return d !== -1 && d < colon;
}

function fieldsObject(cs: Field[], values: Json[]): JsonObject {
  let i = 0;
  const build = (nodes: Field[]): JsonObject => {
    const o: JsonObject = {};
    for (const n of nodes)
      assign(o, n.name, n.children ? build(n.children) : (values[i++] as Json));
    return o;
  };
  return build(cs);
}

class Decoder {
  constructor(private readonly r: Reader) {}

  private error(m: string, l?: Line): ToonDecodeError {
    return new ToonDecodeError(m, l?.num);
  }

  private withLine<T>(l: Line, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ToonDecodeError) throw e;
      throw this.error((e as Error).message, l);
    }
  }

  document(): Json {
    const first = this.r.look();
    if (!first) return {};
    if (first.level !== 0) throw this.error("Over-indented line", first);
    if (first.text === "[]") {
      this.r.read();
      this.consumed();
      return [];
    }
    if (isHeaderWithoutKey(first.text)) {
      const h = this.withLine(first, () => readHeader(first.text));
      if (h) {
        this.r.read();
        const v = this.fromHeader(h, 0, first);
        this.consumed();
        return v;
      }
    }
    this.r.read();
    if (!this.r.look() && !isKeyValuePair(first.text)) {
      return this.withLine(first, () => primitive(first.text));
    }
    if (!isKeyValuePair(first.text)) {
      throw this.error(
        "Top-level document must start with a key-value or array-header line",
        first
      );
    }
    const o: JsonObject = {};
    this.par(first, 0, o);
    for (let l = this.r.look(); l; l = this.r.look()) {
      if (l.level !== 0) throw this.error("Over-indented line", l);
      this.r.read();
      this.par(l, 0, o);
    }
    return o;
  }

  private consumed(): void {
    const l = this.r.look();
    if (l) throw this.error("Unexpected content after the document root", l);
  }

  private par(l: Line, base: number, o: JsonObject): void {
    const h = this.withLine(l, () => readHeader(l.text));
    if (h) {
      if (h.key === undefined)
        throw this.error("Keyless array header is only valid at the root or as a list item", l);
      if (has(o, h.key)) throw this.error(`Duplicate sibling key "${h.key}"`, l);
      assign(o, h.key, this.fromHeader(h, base, l));
      return;
    }
    const { key: k, end } = this.withLine(l, () => readKey(l.text));
    if (has(o, k)) throw this.error(`Duplicate sibling key "${k}"`, l);
    const rest = trim(l.text.slice(end));
    if (!rest) {
      const sig = this.r.look();
      assign(o, k, sig && sig.level > base ? this.fields(base + 1) : {});
      return;
    }
    assign(o, k, rest === "[]" ? [] : this.withLine(l, () => primitive(rest)));
  }

  private fields(base: number): JsonObject {
    const o: JsonObject = {};
    let level: number | undefined;
    for (let l = this.r.look(); l && l.level >= base; l = this.r.look()) {
      level ??= l.level;
      if (l.level !== level) throw this.error(`Over-indented line: expected depth ${level}`, l);
      this.r.read();
      this.par(l, level, o);
    }
    return o;
  }

  private contentLevel(base: number): number {
    const l = this.r.look();
    return !l || l.level <= base + 1 ? base + 1 : l.level;
  }

  private fromHeader(h: Header, base: number, l: Line): Json {
    if (h.withKey) return this.tableWithKey(h, base, l);
    if (h.online !== undefined) {
      const values = this.withLine(l, () => separate(h.online!, h.delim).map(primitive));
      if (values.length !== h.length)
        throw this.error(`Expected ${h.length} inline values, got ${values.length}`, l);
      return values;
    }
    if (h.fields && h.fields.length > 0) return this.table(h, base, l);
    return this.list(h, base, l);
  }

  private table(h: Header, base: number, cab: Line): Json[] {
    const level = this.contentLevel(base);
    const leavesPerRow = countLeaves(h.fields!);
    const rows: Json[] = [];
    while (rows.length < h.length) {
      const l = this.r.look();
      if (!l || l.level <= base) break;
      if (l.level !== level) throw this.error(`Over-indented line: expected depth ${level}`, l);
      if (!isRow(l.text, h.delim)) break;
      this.r.read();
      const values = this.withLine(l, () => separate(l.text, h.delim).map(primitive));
      if (values.length !== leavesPerRow)
        throw this.error(`Expected ${leavesPerRow} row values, got ${values.length}`, l);
      rows.push(fieldsObject(h.fields!, values));
    }
    if (rows.length !== h.length)
      throw this.error(`Expected ${h.length} tabular rows, got ${rows.length}`, cab);
    return rows;
  }

  private tableWithKey(h: Header, base: number, cab: Line): JsonObject {
    const level = this.contentLevel(base);
    const leavesPerRow = countLeaves(h.fields!);
    const o: JsonObject = {};
    let n = 0;
    for (let l = this.r.look(); l && l.level > base; l = this.r.look()) {
      if (l.level !== level) throw this.error(`Over-indented line: expected depth ${level}`, l);
      this.r.read();
      const { key: k, end } = this.withLine(l, () => readKey(l.text));
      if (has(o, k)) throw this.error(`Duplicate key "${k}"`, l);
      const cells = trim(l.text.slice(end));
      const values =
        cells === "" ? [] : this.withLine(l, () => separate(cells, h.delim).map(primitive));
      if (values.length !== leavesPerRow)
        throw this.error(`Expected ${leavesPerRow} entry cells, got ${values.length}`, l);
      assign(o, k, fieldsObject(h.fields!, values));
      n++;
    }
    if (n !== h.length) throw this.error(`Expected ${h.length} keyed entries, got ${n}`, cab);
    return o;
  }

  private list(h: Header, base: number, cab: Line): Json[] {
    const level = this.contentLevel(base);
    const items: Json[] = [];
    while (items.length < h.length) {
      const l = this.r.look();
      if (!l || l.level <= base) break;
      if (l.level !== level) throw this.error(`Over-indented line: expected depth ${level}`, l);
      if (!(l.text.startsWith("- ") || l.text === "-")) break;
      items.push(this.item(level));
    }
    if (items.length !== h.length)
      throw this.error(`Expected ${h.length} list items, got ${items.length}`, cab);
    const sig = this.r.look();
    if (sig && sig.level === level && (sig.text.startsWith("- ") || sig.text === "-")) {
      throw this.error(`Expected ${h.length} list items, but found more`, sig);
    }
    return items;
  }

  private item(base: number): Json {
    const l = this.r.read()!;
    if (l.text === "-") return {};
    const after = l.text.slice(2).replace(/^ +/, "");
    if (!trim(after)) return {};
    if (trim(after) === "[]") return [];
    const li: Line = { ...l, text: after };
    if (isHeaderWithoutKey(after)) {
      const h = this.withLine(li, () => readHeader(after));
      if (h) {
        if (h.withKey || h.fields)
          throw this.error("Keyless header with a field list is only valid at the root", li);
        return this.fromHeader(h, base, li);
      }
    }
    const h = this.withLine(li, () => readHeader(after));
    if (h && h.key !== undefined && h.fields !== undefined) {
      const o: JsonObject = {};
      assign(o, h.key, this.fromHeader(h, base + 1, li));
      this.siblings(base + 1, o);
      return o;
    }
    if (isKeyValuePair(after)) {
      const o: JsonObject = {};
      this.par(li, base + 1, o);
      this.siblings(base + 1, o);
      return o;
    }
    return this.withLine(li, () => primitive(after));
  }

  private siblings(level: number, o: JsonObject): void {
    for (let l = this.r.look(); l && l.level >= level; l = this.r.look()) {
      if (l.level !== level) throw this.error(`Over-indented line: expected depth ${level}`, l);
      this.r.read();
      this.par(l, level, o);
    }
  }
}

/**
 * Decodes TOON. Reads everything `encodeToon` writes and what the
 * reference implementation writes (tables with folded columns, keyed
 * tables, list form at any depth, delimiters `,` `\t` `|`).
 * The empty document is `{}`. On malformed TOON it throws `ToonDecodeError`:
 * it never returns partial data.
 */
export function decodeToon(text: string): unknown {
  return new Decoder(new Reader(scan(text))).document();
}
