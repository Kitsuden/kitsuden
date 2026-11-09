import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

import {
  encodeToonProtocol,
  decodeToonProtocol,
  toonProtocolMiddleware,
  toonResponse,
  TOON_PROTOCOL_MIME,
  type ToonEnvelope,
} from "../lib/toon-protocol";

describe("Toon Protocol — encode/decode roundtrip", () => {
  it("preserves Date instances", () => {
    const date = new Date("2026-07-12T15:30:00.000Z");
    const decoded = decodeToonProtocol(encodeToonProtocol({ createdAt: date })) as {
      createdAt: Date;
    };
    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.createdAt.toISOString()).toBe(date.toISOString());
  });

  it("preserves BigInt", () => {
    const decoded = decodeToonProtocol(encodeToonProtocol({ total: 9007199254740993n })) as {
      total: bigint;
    };
    expect(typeof decoded.total).toBe("bigint");
    expect(decoded.total).toBe(9007199254740993n);
  });

  it("preserves Map with rich values inside", () => {
    const map = new Map<string, Date>([["a", new Date("2020-01-01T00:00:00.000Z")]]);
    const decoded = decodeToonProtocol(encodeToonProtocol({ map })) as { map: Map<string, Date> };
    expect(decoded.map).toBeInstanceOf(Map);
    expect(decoded.map.get("a")).toBeInstanceOf(Date);
  });

  it("preserves Set", () => {
    const decoded = decodeToonProtocol(encodeToonProtocol({ tags: new Set(["a", "b"]) })) as {
      tags: Set<string>;
    };
    expect(decoded.tags).toBeInstanceOf(Set);
    expect(decoded.tags.has("b")).toBe(true);
  });

  it("preserves undefined (JSON would lose it)", () => {
    const decoded = decodeToonProtocol(encodeToonProtocol({ missing: undefined, ok: 1 })) as {
      missing: undefined;
      ok: number;
    };
    expect("missing" in decoded).toBe(true);
    expect(decoded.missing).toBeUndefined();
    expect(decoded.ok).toBe(1);
  });

  it("preserves RegExp with flags", () => {
    const decoded = decodeToonProtocol(encodeToonProtocol({ re: /kitsuden-\d+/gi })) as {
      re: RegExp;
    };
    expect(decoded.re).toBeInstanceOf(RegExp);
    expect(decoded.re.source).toBe("kitsuden-\\d+");
    expect(decoded.re.flags).toBe("gi");
  });

  it("preserves URL", () => {
    const decoded = decodeToonProtocol(
      encodeToonProtocol({ url: new URL("https://kitsuden.gg/api?x=1") })
    ) as { url: URL };
    expect(decoded.url).toBeInstanceOf(URL);
    expect(decoded.url.href).toBe("https://kitsuden.gg/api?x=1");
  });

  it("preserves NaN, Infinity and -Infinity", () => {
    const decoded = decodeToonProtocol(
      encodeToonProtocol({ nan: NaN, inf: Infinity, ninf: -Infinity })
    ) as { nan: number; inf: number; ninf: number };
    expect(Number.isNaN(decoded.nan)).toBe(true);
    expect(decoded.inf).toBe(Infinity);
    expect(decoded.ninf).toBe(-Infinity);
  });

  it("restores circular references", () => {
    type Node = { name: string; self?: Node };
    const node: Node = { name: "root" };
    node.self = node;

    const decoded = decodeToonProtocol(encodeToonProtocol(node)) as Node;
    expect(decoded.name).toBe("root");
    expect(decoded.self).toBe(decoded);
  });

  it("passes plain JSON through untouched (no meta)", () => {
    const input = { a: 1, b: "two", c: [true, null], d: { e: 2.5 } };
    const envelope = encodeToonProtocol(input);
    expect(envelope.meta).toBeUndefined();
    expect(envelope.refs).toBeUndefined();
    expect(decodeToonProtocol(envelope)).toEqual(input);
  });

  it("handles deeply nested rich types in arrays", () => {
    const input = { rows: [{ createdAt: new Date("2025-05-05T05:05:05.000Z"), n: 1n }] };
    const decoded = decodeToonProtocol(encodeToonProtocol(input)) as {
      rows: Array<{ createdAt: Date; n: bigint }>;
    };
    expect(decoded.rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(decoded.rows[0]!.n).toBe(1n);
  });

  it("envelope is valid JSON (serializable)", () => {
    const envelope = encodeToonProtocol({ d: new Date(), big: 5n, m: new Map([[1, 2]]) });
    expect(() => JSON.stringify(envelope)).not.toThrow();
  });
});

describe("Toon Protocol — Hono middleware", () => {
  function buildApp() {
    const app = new Hono();
    app.use("/api/*", toonProtocolMiddleware());
    app.get("/api/data", (c) => c.json({ hello: "world", n: 42 }));
    app.get("/api/rich", (c) => toonResponse(c, { when: new Date("2026-01-01T00:00:00.000Z") }));
    return app;
  }

  it("does not touch normal JSON responses without negotiation", async () => {
    const res = await buildApp().request("/api/data");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ hello: "world", n: 42 });
  });

  it("wraps the response with Accept: vnd.kitsuden.toon+json", async () => {
    const res = await buildApp().request("/api/data", {
      headers: { accept: TOON_PROTOCOL_MIME },
    });
    expect(res.headers.get("content-type")).toContain(TOON_PROTOCOL_MIME);
    const envelope = (await res.json()) as { json: unknown };
    expect(envelope.json).toEqual({ hello: "world", n: 42 });
  });

  it("wraps with ?format=toonp", async () => {
    const res = await buildApp().request("/api/data?format=toonp");
    expect(res.headers.get("content-type")).toContain(TOON_PROTOCOL_MIME);
  });

  it("toonResponse preserves types BEFORE serializing (Date survives)", async () => {
    const res = await buildApp().request("/api/rich", {
      headers: { accept: TOON_PROTOCOL_MIME },
    });
    const decoded = decodeToonProtocol((await res.json()) as ToonEnvelope) as { when: Date };
    expect(decoded.when).toBeInstanceOf(Date);
    expect(decoded.when.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
