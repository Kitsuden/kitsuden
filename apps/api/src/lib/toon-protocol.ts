/**
 * Kitsuden — Toon Protocol (KITSUDEN Serialization Layer)
 *
 * Type-preserving serialization middleware for Hono (KITSUDEN architecture §3).
 * Unlike the textual TOON (lib/toon.ts — "KitsudenTextFormat", optimized
 * for LLM tokens), this protocol preserves complex JS types that
 * JSON.stringify corrupts or loses:
 *
 *   - Date            → ISO string + meta tag
 *   - BigInt          → string + meta tag
 *   - Map / Set       → arrays + meta tag
 *   - undefined       → null + meta tag
 *   - RegExp / URL    → string + meta tag
 *   - NaN / ±Infinity → string + meta tag
 *   - Circular references → $ref pointers
 *
 * Transport format (SuperJSON-style envelope, 100% valid JSON):
 *   { "json": <flat payload>, "meta": { "<path>": "<tag>" }, "refs": { "<path>": "<targetPath>" } }
 *
 * Content negotiation:
 *   Accept: application/vnd.kitsuden.toon+json  →  Toon Protocol
 *   ?format=toonp                          →  Toon Protocol
 *   (the textual TOON still answers to application/vnd.toon / ?format=toon)
 *
 * The client decodes with `decodeToonProtocol()` (also exported by the SDK)
 * and recovers real instances of Date, Map, Set, BigInt, etc.
 */

import { type MiddlewareHandler } from "hono";

// ── MIME type ──────────────────────────────────────────────────
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
// ENCODER
// ═══════════════════════════════════════════════════════════════

/**
 * Encode any JS value into a Toon Protocol envelope.
 * Safe against circular references (emitted as $ref pointers in `refs`).
 */
export function encodeToonProtocol(input: unknown): ToonEnvelope {
  const meta: Record<string, MetaTag> = {};
  const refs: Record<string, string> = {};
  const seen = new Map<object, string>();

  function walk(value: unknown, path: string): unknown {
    // Primitives with special handling
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
    if (value === null || typeof value !== "object") {
      return value;
    }

    // Circular reference detection
    const existing = seen.get(value as object);
    if (existing !== undefined) {
      refs[path] = existing;
      return null;
    }
    seen.set(value as object, path);

    // Rich types
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

    // Plain object
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = root;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setByPath(root: any, path: string, value: unknown): unknown {
  if (path === "") return value; // replace root
  const segs = path.split(".");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = cur?.[segs[i]!];
    if (cur === null || cur === undefined) return root;
  }
  cur[segs[segs.length - 1]!] = value;
  return root;
}

/**
 * Decode a Toon Protocol envelope back into rich JS values.
 * Restores Date, BigInt, Map, Set, RegExp, URL, undefined and circular refs.
 */
export function decodeToonProtocol(envelope: ToonEnvelope): unknown {
  let root: unknown = envelope.json;
  const meta = envelope.meta ?? {};

  // Apply meta transformations from deepest path to shallowest so nested
  // values (e.g. Dates inside a Map) are revived before their container.
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

  // Restore circular references
  for (const [path, target] of Object.entries(envelope.refs ?? {})) {
    root = setByPath(root, path, getByPath(root, target));
  }

  return root;
}

// ═══════════════════════════════════════════════════════════════
// HONO MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

/**
 * Content-negotiation middleware for the Toon Protocol.
 * Transforms JSON responses into type-preserving envelopes when the client
 * sends `Accept: application/vnd.kitsuden.toon+json` or `?format=toonp`.
 *
 * NOTE: since the handler already serialized to JSON with c.json(), the original
 * rich types (Date, BigInt) were already flattened at that point. This
 * middleware guarantees the *transport contract*: handlers that want
 * full preservation must respond with `toonResponse(c, data)`, which
 * encodes BEFORE serializing.
 */
export function toonProtocolMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const acceptHeader = c.req.header("accept") || "";
    const formatParam = c.req.query("format");
    const wantsProtocol = acceptHeader.includes(TOON_PROTOCOL_MIME) || formatParam === "toonp";

    if (!wantsProtocol) return next();

    await next();

    // Errors are not encoded: they come out as application/problem+json (RFC 9457),
    // the same contract for all clients. See middleware/problems-http.ts.
    if (c.res.status >= 400) return;

    const contentType = c.res.headers.get("content-type") || "";
    // If the handler already responded in Toon Protocol (via toonResponse), do not touch
    if (contentType.includes(TOON_PROTOCOL_MIME)) return;
    if (!contentType.includes("application/json")) return;

    try {
      const original = await c.res.json();
      const envelope = encodeToonProtocol(original);

      c.res = new Response(JSON.stringify(envelope), {
        status: c.res.status,
        headers: {
          "Content-Type": TOON_PROTOCOL_MIME,
          "X-Kitsuden-Format": "toon-protocol",
        },
      });
    } catch {
      // Leave the response unchanged if body isn't valid JSON
    }
  };
}

/**
 * Helper for handlers that want FULL type preservation (encode before
 * serialization so Date/BigInt/Map/Set survive intact).
 *
 * @example
 * return toonResponse(c, { createdAt: new Date(), total: 10n });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toonResponse(c: any, data: unknown, status = 200): Response {
  const envelope = encodeToonProtocol(data);
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      "Content-Type": TOON_PROTOCOL_MIME,
      "X-Kitsuden-Format": "toon-protocol",
    },
  });
}
