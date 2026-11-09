/**
 * Kitsuden — response formats for agents (JSON / TOON / TRON / auto)
 * ============================================================================
 *
 * One and the same response can come out in three formats without losing anything:
 *
 *   json  Compact JSON (no spaces). What anyone can read.
 *   toon  TOON (lib/toon-tabular.ts). Wins on flat, uniform lists.
 *   tron  TRON (`@tron-format/tron`, pinned version). JSON with "classes":
 *         `class A: id,name` and then rows `A(1,"x")`. Wins on
 *         repeated objects even when nested.
 *
 * and `auto` chooses, PER RESPONSE, the shortest of those that truly give back
 * the same data. Measurement in docs/agents/benchmarks.md (24 real
 * endpoints from a copy of production, tokenizers o200k / cl100k / the
 * old Anthropic one).
 *
 * Rules:
 *   1. Nothing goes out without checking the round trip: what was encoded is decoded and
 *      compared with the data. If it does not match, that format is discarded and the
 *      next is tried; compact JSON is always the last resort (it is the
 *      source). TRON 0.1.3 has known bugs that this catches: it writes properties named
 *      `null`/`true`/`false`/`class` without quotes (the
 *      result cannot be read) and loses the `__proto__` key.
 *   2. The cost estimate is the text LENGTH (O(1)). In the measurement it
 *      chose the same format as o200k in 23 of 24 endpoints (12 tokens
 *      lost in total) and was the cheapest; counting pre-tokenizer-style
 *      chunks got fewer right (19/24) and took 18–43 ms on 220 KB.
 *   3. A format that is not JSON is only chosen if it saves at least
 *      `MIN_MARGIN` versus JSON: below that, the difference is within
 *      the estimate's error and JSON is the least surprising.
 *   4. Cost: below `MIN_THRESHOLD` characters of JSON nothing is
 *      attempted (the possible saving is a few tokens). Above
 *      `LARGE_THRESHOLD` the winner is remembered per response SHAPE (caller
 *      key + structure signature) and subsequent responses with that
 *      shape are only encoded in the winner; every `REMEASURE_EVERY` uses
 *      everything is measured again, in case the data changed.
 *
 * TRON reorders keys when two objects have the same keys in a different
 * order (it uses the first's order). The values are the same, and a JSON object
 * has no order (RFC 8259), so TRON's comparison does not look at
 * key order; TOON's does (TOON always preserves it).
 */

import { parse as parseTron, stringify as stringifyTron } from "@tron-format/tron";

import { annotateOutput } from "./format-measure";
import { decodeToon, encodeToon } from "./toon-tabular";

export type Format = "json" | "toon" | "tron";
export type RequestedFormat = Format | "auto";

export const FORMATS: readonly Format[] = ["json", "toon", "tron"];

export const MIME: Record<RequestedFormat, string> = {
  json: "application/json",
  toon: "application/vnd.toon",
  tron: "application/vnd.tron",
  auto: "application/vnd.kitsuden.auto",
};

/** Header (REST) and `_meta` key (MCP) that say which format the body is in. */
export const FORMAT_HEADER = "X-Kitsuden-Format";
export const META_FORMAT = "kitsuden/format";

export const MIN_THRESHOLD = 256;
export const LARGE_THRESHOLD = 16_384;
export const MIN_MARGIN = 0.02;
export const REMEASURE_EVERY = 50;
const CACHE_SIZE = 256;

// ── Codecs ──────────────────────────────────────────────────────────────────

interface Codec {
  encode(data: unknown): string;
  decode(text: string): unknown;
  /** Does the round-trip comparison require the same key order? */
  exactOrder: boolean;
}

const CODECS: Record<Exclude<Format, "json">, Codec> = {
  toon: { encode: encodeToon, decode: decodeToon, exactOrder: true },
  tron: {
    encode: (d) => stringifyTron(d),
    decode: (t) => parseTron(t),
    exactOrder: false,
  },
};

/** Equality of JSON values without looking at key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

/**
 * Does `text` (in `format`) give back the data whose compact JSON is `json`?
 * It never throws: a decoder that blows up is a "no".
 */
export function roundTrip(
  format: Format,
  text: string,
  json: string,
  data?: () => unknown
): boolean {
  if (format === "json") return true;
  const codec = CODECS[format];
  let round: unknown;
  try {
    round = codec.decode(text);
  } catch {
    return false;
  }
  if (JSON.stringify(round) === json) return true;
  if (codec.exactOrder) return false;
  return sameValue(round, data ? data() : JSON.parse(json));
}

/** Encodes in `format` without checking anything. For JSON, compact. */
export function encode(format: Format, data: unknown): string {
  return format === "json" ? (JSON.stringify(data) ?? "null") : CODECS[format].encode(data);
}

// ── Per-shape cache ─────────────────────────────────────────────────────────

interface Memory {
  format: Format;
  usages: number;
}
const cache = new Map<string, Memory>();

/** Empties the per-shape cache (tests). */
export function forgetShapes(): void {
  cache.clear();
}

/**
 * Cheap signature of the STRUCTURE: types and keys down to depth 3, looking
 * only at the first 3 elements of each array and its length in orders of
 * magnitude. Two listings of the same endpoint with different pages give the same one.
 */
export function shapeSignature(v: unknown, prof = 0): string {
  if (v === null) return "n";
  if (Array.isArray(v)) {
    const long = v.length === 0 ? 0 : Math.ceil(Math.log10(v.length + 1));
    if (prof >= 3) return `a${long}`;
    return `a${long}[${v
      .slice(0, 3)
      .map((x) => shapeSignature(x, prof + 1))
      .join(",")}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (prof >= 3) return `o${keys.length}`;
    return `{${keys.map((k) => `${k}:${shapeSignature((v as Record<string, unknown>)[k], prof + 1)}`).join(",")}}`;
  }
  return (typeof v)[0]!;
}

function remember(key: string, format: Format): void {
  if (cache.size >= CACHE_SIZE && !cache.has(key)) {
    const older = cache.keys().next().value;
    if (older !== undefined) cache.delete(older);
  }
  cache.delete(key);
  cache.set(key, { format, usages: 0 });
}

// ── Choice ──────────────────────────────────────────────────────────────────

export interface Output {
  format: Format;
  text: string;
  /** Why that format (for logs, debug headers and tests). */
  reason: "requested" | "small" | "measured" | "remembered" | "no-savings" | "no-reversible";
}

export interface OutputOptions {
  /** The compact JSON of `data`, if the caller already has it (avoids serializing twice). */
  json?: string;
  /** Formats `auto` can choose between (by default, all three). */
  candidates?: readonly Format[];
  /** What produces the response (route or tool): combined with the signature for the cache. */
  key?: string;
}

/**
 * Encodes `data` in the requested format. With `auto`, it chooses; with a specific
 * format, it uses it if the round trip works and otherwise answers in JSON
 * (and says so in `format`). It never returns something that loses data. It records the
 * size in the open measure, if there is one (lib/format-measure.ts: the savings
 * per agent that the panel shows).
 */
export function encodeResponse(
  data: unknown,
  request: RequestedFormat,
  op: OutputOptions = {}
): Output {
  const json = op.json ?? JSON.stringify(data) ?? "null";
  const output = chooseOutput(data, json, request, op);
  annotateOutput(json, output.text, output.format);
  return output;
}

function chooseOutput(
  data: unknown,
  json: string,
  request: RequestedFormat,
  op: OutputOptions
): Output {
  let parsedValue: unknown;
  const canonical = () => (parsedValue ??= JSON.parse(json));

  if (request === "json") return { format: "json", text: json, reason: "requested" };
  if (request !== "auto") {
    const text = encodeSafe(request, request === "tron" ? canonical() : data);
    if (text !== null && roundTrip(request, text, json, canonical))
      return { format: request, text, reason: "requested" };
    return { format: "json", text: json, reason: "no-reversible" };
  }

  if (json.length < MIN_THRESHOLD) return { format: "json", text: json, reason: "small" };
  const candidates = (op.candidates ?? FORMATS).filter((f) => f !== "json");
  if (candidates.length === 0) return { format: "json", text: json, reason: "requested" };

  const large = json.length >= LARGE_THRESHOLD;
  const cacheKey = large ? `${op.key ?? ""}|${candidates.join(",")}|${shapeSignature(data)}` : "";
  const memory = large ? cache.get(cacheKey) : undefined;
  if (memory && ++memory.usages % REMEASURE_EVERY !== 0) {
    if (memory.format === "json") return { format: "json", text: json, reason: "remembered" };
    const text = encodeSafe(memory.format, memory.format === "tron" ? canonical() : data);
    if (text !== null && saves(text, json) && roundTrip(memory.format, text, json, canonical)) {
      return { format: memory.format, text, reason: "remembered" };
    }
    // The shape was the same but this data does not come out well: everything is measured.
  }

  const measuredItems: { format: Format; text: string }[] = [];
  for (const f of candidates) {
    // TRON does not follow JSON.stringify semantics (a Date comes out as {}): it is given the value already as JSON
    const text = encodeSafe(f, f === "tron" ? canonical() : data);
    if (text !== null && saves(text, json)) measuredItems.push({ format: f, text });
  }
  measuredItems.sort((a, b) => a.text.length - b.text.length);
  for (const m of measuredItems) {
    if (roundTrip(m.format, m.text, json, canonical)) {
      if (large) remember(cacheKey, m.format);
      return { format: m.format, text: m.text, reason: "measured" };
    }
  }
  if (large) remember(cacheKey, "json");
  return {
    format: "json",
    text: json,
    reason: measuredItems.length ? "no-reversible" : "no-savings",
  };
}

function saves(text: string, json: string): boolean {
  return text.length <= json.length * (1 - MIN_MARGIN);
}

function encodeSafe(format: Format, data: unknown): string | null {
  try {
    return encode(format, data);
  } catch {
    return null;
  }
}

/**
 * An MCP result that carries data as JSON text (the engine's actions):
 * it passes it to `auto` and records the format in `_meta`. An error, a text that is not
 * JSON or a result with several blocks are returned as is.
 */
export function autoResult<T extends { isError?: boolean; content?: unknown[] }>(
  result: T,
  key: string
): T {
  if (!result || result.isError || result.content?.length !== 1) return result;
  const block = result.content[0] as { type?: string; text?: unknown };
  if (block?.type !== "text" || typeof block.text !== "string" || !/^[[{]/.test(block.text))
    return result;
  let data: unknown;
  try {
    data = JSON.parse(block.text);
  } catch {
    return result;
  }
  const output = encodeResponse(data, "auto", { key });
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  return {
    ...result,
    content: [{ type: "text", text: output.text }],
    _meta: { ...meta, [META_FORMAT]: output.format },
  };
}

// ── Negotiation (REST) ──────────────────────────────────────────────────────

/** Splits by `sep` without cutting inside a quoted value (`formats="json,toon"`). */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let actual = "";
  let inside = false;
  for (const ch of text) {
    if (ch === '"') inside = !inside;
    if (ch === sep && !inside) {
      parts.push(actual);
      actual = "";
    } else actual += ch;
  }
  parts.push(actual);
  return parts;
}

/**
 * Which format a REST request asks for, or `null` to leave the response as
 * is (JSON).
 *
 *   Accept: application/vnd.kitsuden.auto   → auto (also ?format=auto)
 *   Accept: application/vnd.toon            → toon (also ?format=toon)
 *   Accept: application/vnd.tron            → tron (also ?format=tron)
 *
 * An `Accept` that names `application/json` and none of the above always
 * wins, even if the URL carries `?format=`: the panel, Inti and the sites ask for
 * JSON this way and must not receive anything else. With several of our own types in the
 * `Accept`, the one with the highest `q` wins (and, on a tie, the first).
 * `application/vnd.kitsuden.auto; formats="json,toon"` limits the candidates.
 */
export function requestedFormat(
  accept: string | undefined,
  formatInUrl: string | undefined
): { requested: RequestedFormat; candidates?: Format[] } | null {
  const types = splitOutsideQuotes(accept ?? "", ",")
    .map((part, position) => {
      const [type = "", ...params] = splitOutsideQuotes(part, ";").map((s) => s.trim());
      let q = 1;
      let formats: string | undefined;
      for (const p of params) {
        const [k, v = ""] = p.split("=").map((s) => s.trim());
        if (k === "q") q = Number(v) || 0;
        if (k === "formats") formats = v.replace(/^"|"$/g, "");
      }
      return { type: type.toLowerCase(), q, position, formats };
    })
    .filter((t) => t.type && t.q > 0);

  const ownValues = types
    .map((t) => ({
      ...t,
      format: (Object.keys(MIME) as RequestedFormat[]).find(
        (f) => f !== "json" && MIME[f] === t.type
      ),
    }))
    .filter((t): t is typeof t & { format: RequestedFormat } => t.format !== undefined)
    .sort((a, b) => b.q - a.q || a.position - b.position);

  if (ownValues.length > 0) {
    const chosenItem = ownValues[0]!;
    if (chosenItem.format === "auto" && chosenItem.formats) {
      const candidates = chosenItem.formats
        .split(/[\s,]+/)
        .filter((f): f is Format => (FORMATS as readonly string[]).includes(f));
      return { requested: "auto", candidates };
    }
    return { requested: chosenItem.format };
  }
  if (types.some((t) => t.type === MIME.json)) return null;

  const inUrl = (formatInUrl ?? "").toLowerCase();
  if (inUrl === "auto" || inUrl === "toon" || inUrl === "tron") return { requested: inUrl };
  return null;
}
