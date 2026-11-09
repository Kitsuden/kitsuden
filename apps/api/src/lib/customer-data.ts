/**
 * Limit on what leaves: customer data does not go to third parties
 * ============================================================================
 *
 * A dataset field or a kon column marked `sensitivity: "customer"` (or
 * `"personal"`) may be READ by whoever scopes and RLS allow. What this module
 * limits is the next step: an execution that read such a value sending it to
 * a host that is not allowed for customer data.
 *
 *   1. MARKS     `SensitivityCatalog`: which keys are marked, per dataset
 *                (by id and slug) and per kon column (by name, everywhere).
 *   2. TRACKING  `MarkedValues`, one per execution: every value under a marked
 *                key in what the execution received (its trigger event, each
 *                `kitsuden.api` answer, each tool result of an agent run) is
 *                remembered, normalized, in memory for that execution only.
 *                Nothing is stored. Each value is also remembered as its
 *                SHA-256, SHA-1 and MD5 digests (hex, base64, base64url; of the
 *                value as read and normalized) and, when it is mostly digits (a
 *                phone number), as its digits only.
 *   3. EGRESS    before something leaves (sandbox `fetch`, `webhook_out`, agent
 *                notification webhooks, the prompt of an engine agent run, the
 *                core email tool), its text is searched for those values: as
 *                sent, percent-decoded, the strings inside JSON, base64/base64url
 *                and hex runs decoded (bounded), and digit groups as whole runs.
 *                Unless the host is allowed for customer data
 *                (`KITSUDEN_CUSTOMER_DATA_HOSTS`, or the action's
 *                `customerDataHosts`, which only a person sets), the request is
 *                refused (sandbox `fetch`, email) or the values are redacted
 *                (`webhook_out`, notifications, model prompts). Each block is
 *                audited.
 *
 * No database or network imports here on purpose: the sandbox host side and the
 * unit tests use it without dragging in the app (`node:crypto` is only for the
 * digests; the sandbox child never imports this module). The catalog is loaded
 * by `customer-data-catalog.ts`.
 *
 * What it does NOT catch (docs/agents/egress.md): values shorter than the
 * minimum length, values encrypted, reversed, split across requests or fields,
 * or sent in part, encodings nested more than once or not on a whole run, data
 * that an outside agent reads over MCP and then sends itself, and email sent by
 * kon code.
 */

import { createHash } from "node:crypto";

import type { Sensitivity } from "@kitsuden/shared";

// ═══════════════════════════════════════════════════════════════
// The catalog of marks
// ═══════════════════════════════════════════════════════════════

export interface SensitivityCatalog {
  /** Dataset id AND slug → field key → label (`dataset:<slug>.<key>`). */
  datasets: Map<string, Map<string, string>>;
  /** Kon columns, matched by name anywhere: column (snake and camel) → label. */
  global: Map<string, string>;
}

export interface MarkedDataset {
  id: string;
  slug: string;
  fields: Record<string, Sensitivity>;
}

export interface MarkedKon {
  id: string;
  tables: Record<string, Record<string, Sensitivity>>;
}

export const EMPTY_CATALOG: SensitivityCatalog = { datasets: new Map(), global: new Map() };

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function buildCatalog(datasets: MarkedDataset[], kons: MarkedKon[]): SensitivityCatalog {
  const catalog: SensitivityCatalog = { datasets: new Map(), global: new Map() };
  for (const ds of datasets) {
    const keys = new Map<string, string>();
    for (const [key, level] of Object.entries(ds.fields)) {
      keys.set(key, `dataset:${ds.slug}.${key} (${level})`);
    }
    if (!keys.size) continue;
    catalog.datasets.set(ds.id, keys);
    if (ds.slug) catalog.datasets.set(ds.slug, keys);
  }
  for (const kon of kons) {
    for (const [table, columns] of Object.entries(kon.tables)) {
      for (const [column, level] of Object.entries(columns)) {
        const label = `kon:${kon.id}/${table}.${column} (${level})`;
        catalog.global.set(column, label);
        catalog.global.set(camel(column), label);
      }
    }
  }
  return catalog;
}

export function catalogIsEmpty(c: SensitivityCatalog): boolean {
  return c.datasets.size === 0 && c.global.size === 0;
}

// ═══════════════════════════════════════════════════════════════
// Normalization and limits
// ═══════════════════════════════════════════════════════════════

/** Values shorter than this (after normalizing) are not tracked: too many false matches. */
export function minimumLength(): number {
  const n = Number(process.env.KITSUDEN_CUSTOMER_DATA_MIN_LENGTH);
  return Number.isInteger(n) && n >= 3 && n <= 64 ? n : 5;
}

/** Most values one execution tracks. Past it, egress to a non-allowed host is refused. */
export const MAX_TRACKED_VALUES = 20_000;

export function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A value with at least this many digits, mostly digits, is also tracked as digits only. */
const MIN_DIGITS = 7;
/** Longer digit strings are not phone or account numbers: not tracked that way. */
const MAX_DIGITS = 24;

/**
 * The digits of a value that is mostly digits (`+34 600 111 222` → `34600111222`),
 * or `null`. "Mostly": at least 60% of its visible characters.
 */
export function digitsOnly(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  const visible = value.replace(/\s/g, "").length;
  return digits.length * 10 >= visible * 6 ? digits : null;
}

const DIGESTS = ["sha256", "sha1", "md5"] as const;

/** The digests code could send instead of a value (normalized, as matching compares). */
function digestsOf(s: string): string[] {
  const out: string[] = [];
  for (const algorithm of DIGESTS) {
    const d = createHash(algorithm).update(s, "utf8").digest();
    out.push(d.toString("hex"), d.toString("base64"), d.toString("base64url"));
  }
  return out.map(normalize);
}

/** Keys whose string value names a dataset, for the object and what it contains. */
const DATASET_ID_KEYS = ["datasetId", "dataSetId", "dataset_id", "data_set_id"];

function datasetOf(o: Record<string, unknown>): string | undefined {
  for (const k of DATASET_ID_KEYS) {
    if (typeof o[k] === "string" && o[k]) return o[k] as string;
  }
  return undefined;
}

/** `/api/datasets/<id or slug>/…` and `/api/datasets/slug/<slug>` → the dataset. */
export function datasetFromPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  const p = path.split("?")[0]!;
  const bySlug = /^\/api\/datasets\/slug\/([^/]+)/.exec(p);
  if (bySlug) return decodeURIComponent(bySlug[1]!);
  const byId = /^\/api\/datasets\/([^/]+)\/(?:entries|search|compare)/.exec(p);
  return byId ? decodeURIComponent(byId[1]!) : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export const REDACTED = "[redacted: customer data]";

// ═══════════════════════════════════════════════════════════════
// Decoding what leaves (bounded)
// ═══════════════════════════════════════════════════════════════

/** Shortest base64/base64url/hex run that is decoded. */
const MIN_ENCODED = 12;
/** Most encoded runs decoded per search, and most bytes they may decode to. */
export const MAX_DECODED_SEGMENTS = 256;
export const MAX_DECODED_BYTES = 256 * 1024;

interface DecodeBudget {
  segments: number;
  bytes: number;
}

const newBudget = (): DecodeBudget => ({
  segments: MAX_DECODED_SEGMENTS,
  bytes: MAX_DECODED_BYTES,
});

/** A run of the base64 / base64url alphabet (hex is a subset of it). */
const ENCODED_RUN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const PERCENT_TOKEN = /[^\s"'<>]*%[0-9A-Fa-f]{2}[^\s"'<>]*/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Bytes as text, only if they are valid UTF-8 text (no control characters). */
function asText(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  try {
    const s = utf8.decode(bytes);
    return CONTROL.test(s) ? null : s;
  } catch {
    return null;
  }
}

/** `%40` → `@`, sequence by sequence: a stray `%` does not stop the rest from decoding. */
function percentDecode(text: string): string {
  return text.replace(/\+/g, " ").replace(PERCENT_RUN, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

/** What one encoded run decodes to as text: hex (even length) and base64/base64url. */
function decodings(run: string, budget: DecodeBudget): string[] {
  const out: string[] = [];
  const maxBytes = Math.max(budget.bytes, 0);
  if (run.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(run)) {
    const hex = asText(Buffer.from(run.slice(0, maxBytes * 2), "hex"));
    if (hex) out.push(hex);
  }
  const b64 = run.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const cut = Math.max(4, Math.floor((maxBytes * 4) / 3 / 4) * 4);
  const text = asText(Buffer.from(b64.slice(0, cut), "base64"));
  if (text) out.push(text);
  // Every run costs its length, decoded or not: a body of junk still runs out.
  budget.bytes -= Math.max(Math.ceil((Math.min(run.length, cut) * 3) / 4), 1);
  return out;
}

/** The encoded runs of `text` (and, for a path, its `/` pieces), decoded, within the budget. */
function* decodedRuns(text: string, budget: DecodeBudget, seen: Set<string>): Generator<string> {
  for (const m of text.matchAll(ENCODED_RUN)) {
    const run = m[0];
    const pieces = run.includes("/")
      ? [run, ...run.split("/").filter((p) => p.length >= MIN_ENCODED)]
      : [run];
    for (const piece of pieces) {
      if (budget.segments <= 0 || budget.bytes <= 0) return;
      if (seen.has(piece)) continue;
      seen.add(piece);
      budget.segments--;
      for (const decoded of decodings(piece, budget)) {
        yield decoded;
        if (decoded.includes("%")) {
          const p = percentDecode(decoded);
          if (p !== decoded) yield p;
        }
      }
    }
  }
}

/** The strings inside a JSON text, one per line, or `null` if it is not JSON. */
function jsonStrings(text: string): string | null {
  const trimmed = text.trimStart();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"'))) return null;
  try {
    const strings: string[] = [];
    const gather = (v: unknown, depth: number) => {
      if (depth > 40) return;
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "number") strings.push(String(v));
      else if (Array.isArray(v)) v.forEach((x) => gather(x, depth + 1));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          strings.push(k);
          gather(x, depth + 1);
        }
      }
    };
    gather(JSON.parse(text), 0);
    // Separated so two strings that meet at the edge do not form a value.
    return strings.join("\n");
  } catch {
    return null;
  }
}

/**
 * The text as sent, percent-decoded, the strings inside it if it is JSON, and
 * the base64/base64url/hex runs of those decoded (one level, within `budget`).
 * A generator: a search that finds something early decodes nothing more.
 */
function* variantsOf(text: string, budget: DecodeBudget = newBudget()): Generator<string> {
  const base = [text];
  yield text;
  const decoded = percentDecode(text);
  if (decoded !== text) {
    base.push(decoded);
    yield decoded;
  }
  const strings = jsonStrings(text);
  if (strings !== null) {
    base.push(strings);
    yield strings;
  }
  const seen = new Set<string>();
  for (const b of base) yield* decodedRuns(b, budget, seen);
}

/** Digits that may sit between two groups of one number: `+34 600-111.222`, `(600) 111`. */
const DIGIT_GAP = /^[ \t\xa0.\-()/+]{1,3}$/;

interface DigitHit {
  start: number;
  end: number;
  label: string;
}

/**
 * Tracked digit strings in `text`, matched only on WHOLE groups of digits: a
 * match starts where a group starts and ends where a group ends, so a value is
 * never found inside a longer number. Groups joined by short separators
 * (`34 600 111 222`) count as one number.
 */
function digitHits(text: string, digits: Map<string, string>, first: boolean): DigitHit[] {
  const out: DigitHit[] = [];
  if (digits.size === 0) return out;
  let run: Array<{ d: string; start: number; end: number }> = [];
  const flush = (): boolean => {
    for (let s = 0; s < run.length; s++) {
      let acc = "";
      let best = -1;
      let bestLabel = "";
      for (let e = s; e < run.length; e++) {
        acc += run[e]!.d;
        if (acc.length > MAX_DIGITS) break;
        const label = acc.length >= MIN_DIGITS ? digits.get(acc) : undefined;
        if (label) {
          best = e;
          bestLabel = label;
        }
      }
      if (best >= 0) {
        out.push({ start: run[s]!.start, end: run[best]!.end, label: bestLabel });
        if (first) return true;
        s = best;
      }
    }
    run = [];
    return false;
  };
  let last = -1;
  for (const m of text.matchAll(/[0-9]+/g)) {
    const start = m.index!;
    if (run.length && !DIGIT_GAP.test(text.slice(last, start)) && flush()) return out;
    run.push({ d: m[0], start, end: start + m[0].length });
    last = start + m[0].length;
  }
  flush();
  return out;
}

/**
 * `normalize` applied one code point at a time, with where each normalized
 * character came from, so a match can be cut out of the ORIGINAL text.
 */
function normalizedWithMap(s: string): { t: string; from: number[]; to: number[] } {
  let t = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const cp of s) {
    const end = i + cp.length;
    let piece = cp.normalize("NFKC").toLowerCase();
    if (/^\s+$/.test(piece)) piece = t.length === 0 || t.endsWith(" ") ? "" : " ";
    for (let k = 0; k < piece.length; k++) {
      from.push(i);
      to.push(end);
    }
    t += piece;
    i = end;
  }
  return { t, from, to };
}

/** `text` with the ranges replaced by `REDACTED` (overlapping ranges merged). */
function cutRanges(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    if (start >= at) {
      out += text.slice(at, start) + REDACTED;
    }
    at = end;
  }
  return out + text.slice(at);
}

// ═══════════════════════════════════════════════════════════════
// What one execution has read
// ═══════════════════════════════════════════════════════════════

export interface MarkedMatch {
  /** Where the value came from (`dataset:clients.email (customer)`), never the value. */
  label: string;
  /** `url`, `header <name>` or `body`. */
  where: string;
}

const PREFIX = 4;
/** Longer texts are redacted whole (if they contain a tracked value), not cut in place. */
const MAX_CUT_TEXT = 1_000_000;

export class MarkedValues {
  /** normalized value or digest → label */
  private readonly values = new Map<string, string>();
  /** The values as read (normalized), without their digests: what `size` counts. */
  private readonly read = new Set<string>();
  /** Digits only → label, for values that are mostly digits (matched on whole groups). */
  private readonly digits = new Map<string, string>();
  /** First `PREFIX` chars → values starting with them (one scan of the text). */
  private readonly byPrefix = new Map<string, string[]>();
  private readonly min: number;
  /** More than `MAX_TRACKED_VALUES` were read: what leaves cannot be checked. */
  overflow = false;

  constructor(
    readonly catalog: SensitivityCatalog = EMPTY_CATALOG,
    options: { minLength?: number } = {}
  ) {
    this.min = Math.max(options.minLength ?? minimumLength(), PREFIX);
  }

  get size(): number {
    return this.read.size;
  }

  /** Nothing tracked: every search is a no-op. */
  get empty(): boolean {
    return this.values.size === 0 && this.digits.size === 0;
  }

  /** The labels of what was read (for the audit), without values. */
  labels(): string[] {
    return [...new Set([...this.values.values(), ...this.digits.values()])];
  }

  /** Was exactly this value read (normalized)? E.g. the recipient of an email. */
  has(value: string): boolean {
    return this.read.has(normalize(value));
  }

  private track(v: string, label: string): void {
    if (v.length < this.min || this.values.has(v)) return;
    this.values.set(v, label);
    const p = v.slice(0, PREFIX);
    const list = this.byPrefix.get(p);
    if (list) list.push(v);
    else this.byPrefix.set(p, [v]);
  }

  /** Remembers a value and everything inside it (a marked `json` or repeater field). */
  add(value: unknown, label: string, depth = 0): void {
    if (depth > 20 || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      const raw = String(value);
      const v = normalize(raw);
      if (v.length < this.min || this.read.has(v)) return;
      if (this.read.size >= MAX_TRACKED_VALUES) {
        this.overflow = true;
        return;
      }
      this.read.add(v);
      const digits = digitsOnly(v);
      if (digits) this.digits.set(digits, label);
      // A value that is only digits is matched on whole digit groups, not inside
      // a longer number (an id, a timestamp).
      if (!(digits && digits === v)) this.track(v, label);
      for (const form of raw === v ? [v] : [raw, v]) {
        for (const d of digestsOf(form)) this.track(d, label);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const x of value) this.add(x, label, depth + 1);
      return;
    }
    if (isObject(value)) {
      for (const x of Object.values(value)) this.add(x, label, depth + 1);
    }
  }

  /**
   * Remembers the marked values in something the execution received.
   * `dataset` is the dataset the whole payload belongs to, when known (the
   * path of the API call); objects that carry a `datasetId` override it.
   */
  collect(node: unknown, dataset?: string, depth = 0): void {
    if (catalogIsEmpty(this.catalog) || depth > 40 || node === null || typeof node !== "object")
      return;
    if (Array.isArray(node)) {
      for (const x of node) this.collect(x, dataset, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const ds = datasetOf(o) ?? dataset;
    for (const [k, v] of Object.entries(o)) {
      if (ds !== undefined && k === "data" && isObject(v)) {
        this.collectScoped(v, this.catalog.datasets.get(ds), depth + 1);
      } else if (this.catalog.global.has(k)) {
        this.add(v, this.catalog.global.get(k)!);
      } else {
        this.collect(v, ds, depth + 1);
      }
    }
  }

  /** Inside the `data` of a known dataset: only its own marked keys (repeaters included). */
  private collectScoped(node: unknown, keys: Map<string, string> | undefined, depth: number): void {
    if (!keys || depth > 40 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) this.collectScoped(x, keys, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (keys.has(k)) this.add(v, keys.get(k)!);
      else this.collectScoped(v, keys, depth + 1);
    }
  }

  /** The text of an API answer (JSON or not), with the path it came from. */
  collectText(body: string, path?: string): void {
    if (catalogIsEmpty(this.catalog) || !body) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    this.collect(parsed, datasetFromPath(path));
  }

  /** A tracked value (plain or digest) in already-normalized text. */
  private findPlain(t: string): string | null {
    for (let i = 0; i + PREFIX <= t.length; i++) {
      const candidates = this.byPrefix.get(t.slice(i, i + PREFIX));
      if (!candidates) continue;
      for (const v of candidates) if (t.startsWith(v, i)) return this.values.get(v)!;
    }
    return null;
  }

  /** The label of the first tracked value inside `text` (in any of its decoded forms). */
  find(text: string | null | undefined, budget?: DecodeBudget): string | null {
    if (!text || this.empty) return null;
    for (const variant of variantsOf(text, budget)) {
      const t = normalize(variant);
      const hit = this.findPlain(t) ?? digitHits(t, this.digits, true)[0]?.label ?? null;
      if (hit) return hit;
    }
    return null;
  }

  /** Searches an outgoing request. `null` = nothing tracked is in it. */
  findInRequest(req: {
    url: string;
    headers?: Record<string, string>;
    body?: string | null;
  }): MarkedMatch | null {
    const inUrl = this.find(req.url);
    if (inUrl) return { label: inUrl, where: "url" };
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      const inHeader = this.find(value);
      if (inHeader) return { label: inHeader, where: `header ${name}` };
    }
    const inBody = this.find(req.body ?? "");
    return inBody ? { label: inBody, where: "body" } : null;
  }

  /**
   * A copy of `node` without customer data: values under marked keys, and any
   * other string that contains a tracked value, become `REDACTED`. Values are
   * collected from `node` first, so a payload is checked against itself too.
   */
  redact(node: unknown, dataset?: string): { value: unknown; redacted: string[] } {
    return this.redactWith(node, dataset, (s, redacted) => {
      const hit = this.find(s);
      if (!hit) return s;
      redacted.add(hit);
      return REDACTED;
    });
  }

  private redactWith(
    node: unknown,
    dataset: string | undefined,
    leaf: (s: string, redacted: Set<string>) => string
  ): { value: unknown; redacted: string[] } {
    this.collect(node, dataset);
    const redacted = new Set<string>();
    const walk = (
      n: unknown,
      ds: string | undefined,
      keys: Map<string, string> | null,
      depth: number
    ): unknown => {
      if (depth > 40) return REDACTED;
      if (typeof n === "string") return leaf(n, redacted);
      if (typeof n === "number") return leaf(String(n), redacted) === String(n) ? n : REDACTED;
      if (Array.isArray(n)) return n.map((x) => walk(x, ds, keys, depth + 1));
      if (!isObject(n)) return n;
      const own = keys ? ds : (datasetOf(n) ?? ds);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n)) {
        const label = keys ? keys.get(k) : this.catalog.global.get(k);
        if (label && v !== null && v !== undefined) {
          redacted.add(label);
          out[k] = REDACTED;
        } else if (!keys && own !== undefined && k === "data" && isObject(v)) {
          out[k] = walk(v, own, this.catalog.datasets.get(own) ?? new Map(), depth + 1);
        } else {
          out[k] = walk(v, own, keys, depth + 1);
        }
      }
      return out;
    };
    const value = walk(node, dataset, null, 0);
    return { value, redacted: [...redacted] };
  }

  /**
   * Free text (a prompt, a tool result) with every tracked value cut out of
   * it, the rest kept: plain copies, digests and digit groups are replaced in
   * place, an encoded run or percent-encoded token that decodes to one is
   * replaced whole. If a tracked value can still be found after that (a form
   * the cuts do not reach), the whole text becomes `REDACTED`. A JSON object
   * or array is redacted field by field (marked keys too) and re-serialized.
   */
  redactText(text: string): { text: string; redacted: string[] } {
    if (!text || this.empty) return { text, redacted: [] };
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      let isJson = false;
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        /* not JSON: free text */
      }
      if (isJson) {
        const r = this.redactWith(parsed, undefined, (s, redacted) =>
          this.redactPlain(s, redacted)
        );
        const out = r.redacted.length ? JSON.stringify(r.value) : text;
        // A key, or a form the walk does not see: the whole text goes.
        const left = this.find(out);
        if (left) return { text: REDACTED, redacted: [...new Set([...r.redacted, left])] };
        return { text: out, redacted: r.redacted };
      }
    }
    const redacted = new Set<string>();
    const out = this.redactPlain(text, redacted);
    return { text: out, redacted: [...redacted] };
  }

  private redactPlain(s: string, redacted: Set<string>): string {
    if (!s || this.empty) return s;
    if (s.length > MAX_CUT_TEXT) {
      // Too long to map character by character: all or nothing.
      const hit = this.find(s);
      if (!hit) return s;
      redacted.add(hit);
      return REDACTED;
    }
    // 1. Plain copies and digests, located in the normalized text.
    const ranges: Array<[number, number]> = [];
    const { t, from, to } = normalizedWithMap(s);
    for (let i = 0; i + PREFIX <= t.length; i++) {
      const candidates = this.byPrefix.get(t.slice(i, i + PREFIX));
      if (!candidates) continue;
      let best = "";
      for (const v of candidates) if (v.length > best.length && t.startsWith(v, i)) best = v;
      if (!best) continue;
      redacted.add(this.values.get(best)!);
      ranges.push([from[i]!, to[i + best.length - 1]!]);
      i += best.length - 1;
    }
    // 2. Digit groups (on the original text: ASCII digits keep their positions).
    for (const hit of digitHits(s, this.digits, false)) {
      redacted.add(hit.label);
      ranges.push([hit.start, hit.end]);
    }
    let out = cutRanges(s, ranges);
    // 3. Encoded runs and percent-encoded tokens that decode to a tracked value.
    const budget = newBudget();
    out = out.replace(ENCODED_RUN, (run) => {
      if (budget.segments <= 0 || budget.bytes <= 0) return run;
      budget.segments--;
      for (const decoded of decodings(run, budget)) {
        const hit = this.find(decoded, budget);
        if (hit) {
          redacted.add(hit);
          return REDACTED;
        }
      }
      return run;
    });
    out = out.replace(PERCENT_TOKEN, (token) => {
      const hit = this.find(percentDecode(token), budget);
      if (!hit) return token;
      redacted.add(hit);
      return REDACTED;
    });
    // 4. Whatever is left that still contains one: the whole text goes.
    const left = this.find(out);
    if (left) {
      redacted.add(left);
      return REDACTED;
    }
    return out;
  }
}

/**
 * The messages of a model request with tracked values cut out of their text
 * and of the tool-call arguments. Copies; `redacted` lists the labels (never
 * values) of what was cut.
 */
export function redactPromptMessages<
  T extends {
    content: string;
    toolCalls?: Array<{ function: { name: string; arguments: string } }>;
  },
>(marked: MarkedValues, messages: T[]): { messages: T[]; redacted: string[] } {
  const redacted = new Set<string>();
  if (marked.empty) return { messages, redacted: [] };
  const out = messages.map((m) => {
    const content = marked.redactText(m.content ?? "");
    content.redacted.forEach((l) => redacted.add(l));
    if (!m.toolCalls?.length) return content.redacted.length ? { ...m, content: content.text } : m;
    const toolCalls = m.toolCalls.map((tc) => {
      const args = marked.redactText(tc.function.arguments ?? "");
      args.redacted.forEach((l) => redacted.add(l));
      return args.redacted.length
        ? { ...tc, function: { ...tc.function, arguments: args.text } }
        : tc;
    });
    return { ...m, content: content.text, toolCalls };
  });
  return { messages: out, redacted: [...redacted] };
}

// ═══════════════════════════════════════════════════════════════
// Where customer data MAY go
// ═══════════════════════════════════════════════════════════════

function hostList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** The server's list (`KITSUDEN_CUSTOMER_DATA_HOSTS`) plus the action's (`customerDataHosts`). */
export function customerDataHosts(ofTheAction?: unknown): string[] {
  return [
    ...new Set([...hostList(process.env.KITSUDEN_CUSTOMER_DATA_HOSTS), ...hostList(ofTheAction)]),
  ];
}

const bareHost = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");

/** `api.crm.com` or `*.crm.com` (subdomains only, like the sandbox allow-list). */
export function hostAllowedForCustomerData(hostname: string, list: string[]): boolean {
  const h = bareHost(hostname);
  return list.some((p) =>
    p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p
  );
}

/** This machine: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`. A model there is not a third party. */
export function isLoopbackHost(hostname: string): boolean {
  const h = bareHost(hostname);
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

// ═══════════════════════════════════════════════════════════════
// Blocks
// ═══════════════════════════════════════════════════════════════

export type EgressChannel =
  | "sandbox_fetch"
  | "webhook_out"
  | "agent_notification"
  | "model_prompt"
  | "email"
  | "external_mcp";

export interface EgressBlock {
  channel: EgressChannel;
  decision: "refused" | "redacted";
  host: string;
  /** Labels of the marked fields involved (never their values). */
  fields: string[];
  where?: string;
  actionId?: string;
  executionId?: string;
  /** A real agent (agent_identities), when one ran it. */
  agentId?: string | null;
}

/** What an execution carries to the sandbox: what it read, where it may go, who to tell. */
export interface CustomerDataGuard {
  marked: MarkedValues;
  allowedHosts: string[];
  /** The catalog could not be loaded: refuse every host not allowed for customer data. */
  strict?: boolean;
  onBlock?: (block: EgressBlock) => void;
}

const HOW =
  `Allow the host for customer data (the action's customerDataHosts, set by a person, or ` +
  `KITSUDEN_CUSTOMER_DATA_HOSTS), or do not send the value. See docs/agents/egress.md.`;

type Problem = { message: string; block: Omit<EgressBlock, "channel" | "decision"> };

/** The guard cannot check anything (marks not loaded, too much read): refuse. */
function uncheckable(guard: CustomerDataGuard, host: string): Problem | null {
  if (guard.strict) {
    return {
      message: `Customer data check unavailable: requests to ${host} are refused. ${HOW}`,
      block: { host, fields: [], where: "unchecked" },
    };
  }
  if (guard.marked.overflow) {
    return {
      message: `This execution read more customer data than can be tracked: requests to ${host} are refused. ${HOW}`,
      block: { host, fields: guard.marked.labels().slice(0, 20), where: "overflow" },
    };
  }
  return null;
}

/**
 * Why a request from this execution cannot go to `hostname`, or `null`.
 * Shared by the sandbox `fetch` (refuses with this text).
 */
export function egressProblem(
  guard: CustomerDataGuard | undefined,
  req: { url: string; hostname: string; headers?: Record<string, string>; body?: string | null }
): Problem | null {
  if (!guard) return null;
  if (hostAllowedForCustomerData(req.hostname, guard.allowedHosts)) return null;
  const cannot = uncheckable(guard, req.hostname);
  if (cannot) return cannot;
  const hit = guard.marked.findInRequest(req);
  if (!hit) return null;
  return {
    message: `Customer data cannot be sent to ${req.hostname}: the ${hit.where} contains a value of ${hit.label}. ${HOW}`,
    block: { host: req.hostname, fields: [hit.label], where: hit.where },
  };
}

/**
 * Why this email cannot be queued, or `null`. The recipient's domain is the
 * host. Writing to the customer whose address was read (the recipient is itself
 * a tracked value) is allowed: that is not a third party.
 */
export function emailProblem(
  guard: CustomerDataGuard | undefined,
  mail: { to: string; subject?: string; html?: string; text?: string }
): Problem | null {
  if (!guard) return null;
  const domain = bareHost(mail.to.slice(mail.to.lastIndexOf("@") + 1));
  if (hostAllowedForCustomerData(domain, guard.allowedHosts)) return null;
  const cannot = uncheckable(guard, domain);
  if (cannot) return cannot;
  if (guard.marked.has(mail.to)) return null;
  for (const [where, value] of [
    ["subject", mail.subject],
    ["html", mail.html],
    ["text", mail.text],
  ] as const) {
    const hit = guard.marked.find(value);
    if (hit) {
      return {
        message: `Customer data cannot be emailed to ${domain}: the ${where} contains a value of ${hit}. ${HOW}`,
        block: { host: domain, fields: [hit], where },
      };
    }
  }
  return null;
}
