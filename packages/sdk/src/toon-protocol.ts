/**
 * @kitsuden/sdk — Toon Protocol (client-side, zero deps)
 *
 * Decoder/encoder of the KITSUDEN serialization protocol with type
 * preservation (KITSUDEN architecture §3). Mirror of the server middleware
 * (apps/api/src/lib/toon-protocol.ts).
 *
 * @example
 * ```typescript
 * import { decodeToonProtocol, TOON_PROTOCOL_MIME } from '@kitsuden/sdk/toon-protocol';
 *
 * const res = await fetch('https://api.example.com/api/graph/games', {
 *   headers: { Accept: TOON_PROTOCOL_MIME },
 * });
 * const data = decodeToonProtocol(await res.json());
 * // data.rows[0].createdAt instanceof Date === true 🎉
 * ```
 */

export const TOON_PROTOCOL_MIME = "application/vnd.kitsuden.toon+json";

type MetaTag =
  | "Date"
  | "BigInt"
  | "Map"
  | "Set"
  | "undefined"
  | "RegExp"
  | "URL"
  | "NaN"
  | "Infinity"
  | "-Infinity";

export interface ToonEnvelope {
  json: unknown;
  meta?: Record<string, MetaTag>;
  refs?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════
// ENCODER (for outgoing requests with rich types)
// ═══════════════════════════════════════════════════════════════

export function encodeToonProtocol(input: unknown): ToonEnvelope {
  const meta: Record<string, MetaTag> = {};
  const refs: Record<string, string> = {};
  const seen = new Map<object, string>();

  function walk(value: unknown, path: string): unknown {
    if (value === undefined) {
      meta[path] = "undefined";
      return null;
    }
    if (typeof value === "bigint") {
      meta[path] = "BigInt";
      return value.toString();
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        meta[path] = "NaN";
        return "NaN";
      }
      if (value === Infinity) {
        meta[path] = "Infinity";
        return "Infinity";
      }
      if (value === -Infinity) {
        meta[path] = "-Infinity";
        return "-Infinity";
      }
      return value;
    }
    if (value === null || typeof value !== "object") return value;

    const existing = seen.get(value as object);
    if (existing !== undefined) {
      refs[path] = existing;
      return null;
    }
    seen.set(value as object, path);

    if (value instanceof Date) {
      meta[path] = "Date";
      return isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (value instanceof RegExp) {
      meta[path] = "RegExp";
      return value.toString();
    }
    if (value instanceof URL) {
      meta[path] = "URL";
      return value.href;
    }
    if (value instanceof Map) {
      meta[path] = "Map";
      const out: unknown[] = [];
      let i = 0;
      for (const [k, v] of value.entries()) {
        out.push([walk(k, `${path}.${i}.0`), walk(v, `${path}.${i}.1`)]);
        i++;
      }
      return out;
    }
    if (value instanceof Set) {
      meta[path] = "Set";
      const out: unknown[] = [];
      let i = 0;
      for (const v of value.values()) {
        out.push(walk(v, `${path}.${i}`));
        i++;
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, `${path}.${i}`));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, path ? `${path}.${k}` : k);
    }
    return out;
  }

  const json = walk(input, "");
  const envelope: ToonEnvelope = { json };
  if (Object.keys(meta).length > 0) envelope.meta = meta;
  if (Object.keys(refs).length > 0) envelope.refs = refs;
  return envelope;
}

// ═══════════════════════════════════════════════════════════════
// DECODER
// ═══════════════════════════════════════════════════════════════

function getByPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cur = root as Record<string, unknown> | null | undefined;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg] as Record<string, unknown>;
  }
  return cur;
}

function setByPath(root: unknown, path: string, value: unknown): unknown {
  if (path === "") return value;
  const segs = path.split(".");
  let cur = root as Record<string, unknown> | null | undefined;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = cur?.[segs[i]!] as Record<string, unknown>;
    if (cur === null || cur === undefined) return root;
  }
  (cur as Record<string, unknown>)[segs[segs.length - 1]!] = value;
  return root;
}

export function decodeToonProtocol(envelope: ToonEnvelope): unknown {
  let root: unknown = envelope.json;
  const meta = envelope.meta ?? {};

  const paths = Object.keys(meta).sort((a, b) => b.split(".").length - a.split(".").length);

  for (const path of paths) {
    const tag = meta[path]!;
    const raw = getByPath(root, path);
    let revived: unknown = raw;

    switch (tag) {
      case "Date":
        revived = raw === null || raw === undefined ? null : new Date(raw as string);
        break;
      case "BigInt":
        revived = BigInt(raw as string);
        break;
      case "undefined":
        revived = undefined;
        break;
      case "NaN":
        revived = NaN;
        break;
      case "Infinity":
        revived = Infinity;
        break;
      case "-Infinity":
        revived = -Infinity;
        break;
      case "RegExp": {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(raw as string);
        revived = m ? new RegExp(m[1]!, m[2]) : raw;
        break;
      }
      case "URL":
        revived = new URL(raw as string);
        break;
      case "Map":
        revived = new Map(raw as [unknown, unknown][]);
        break;
      case "Set":
        revived = new Set(raw as unknown[]);
        break;
    }

    root = setByPath(root, path, revived);
  }

  for (const [path, target] of Object.entries(envelope.refs ?? {})) {
    root = setByPath(root, path, getByPath(root, target));
  }

  return root;
}

/**
 * Fetch + decode in one call.
 *
 * @example
 * const data = await fetchToon('https://api.example.com/api/graph/games');
 */
export async function fetchToon(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Accept: TOON_PROTOCOL_MIME },
  });
  if (!res.ok) throw new Error(`Toon fetch failed: ${res.status} ${res.statusText}`);
  const envelope = (await res.json()) as ToonEnvelope;
  return decodeToonProtocol(envelope);
}
