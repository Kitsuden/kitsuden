import { describe, it, expect, beforeEach } from "bun:test";

import {
  encodeResponse,
  shapeSignature,
  requestedFormat,
  roundTrip,
  forgetShapes,
  REMEASURE_EVERY,
  LARGE_THRESHOLD,
} from "../lib/formats";

const rows = (n: number, extra = "") =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    slug: `row-${i}${extra}`,
    name: `Row number ${i}`,
    active: i % 2 === 0,
  }));

beforeEach(() => forgetShapes());

describe("requestedFormat (REST negotiation)", () => {
  it("own types in Accept", () => {
    expect(requestedFormat("application/vnd.toon", undefined)).toEqual({ requested: "toon" });
    expect(requestedFormat("application/vnd.tron", undefined)).toEqual({ requested: "tron" });
    expect(requestedFormat("application/vnd.kitsuden.auto", undefined)).toEqual({
      requested: "auto",
    });
  });

  it("?format= when Accept does not ask for JSON", () => {
    expect(requestedFormat(undefined, "auto")).toEqual({ requested: "auto" });
    expect(requestedFormat("*/*", "toon")).toEqual({ requested: "toon" });
    expect(requestedFormat("*/*", "toonp")).toBeNull(); // it belongs to the Toon Protocol, another middleware
    expect(requestedFormat(undefined, "json")).toBeNull();
  });

  it("Accept: application/json always beats ?format=", () => {
    expect(requestedFormat("application/json", "auto")).toBeNull();
    expect(requestedFormat("application/json, text/plain, */*", "toon")).toBeNull();
  });

  it("several types: the highest q wins, and on a tie the first", () => {
    expect(requestedFormat("application/vnd.toon;q=0.5, application/vnd.tron", undefined)).toEqual({
      requested: "tron",
    });
    expect(requestedFormat("application/vnd.toon, application/json", undefined)).toEqual({
      requested: "toon",
    });
    expect(requestedFormat("application/vnd.toon;q=0, application/json", undefined)).toBeNull();
  });

  it('formats="…" limits the candidates for auto', () => {
    expect(
      requestedFormat('application/vnd.kitsuden.auto; formats="json,toon"', undefined)
    ).toEqual({
      requested: "auto",
      candidates: ["json", "toon"],
    });
  });
});

describe("encodeResponse", () => {
  it("json is compact JSON", () => {
    const r = encodeResponse({ a: [1, 2], b: { c: "x" } }, "json");
    expect(r).toEqual({ format: "json", text: '{"a":[1,2],"b":{"c":"x"}}', reason: "requested" });
  });

  it("never returns something that does not give the data back", () => {
    // TRON 0.1.3 cannot read back what it writes with a property called `class`.
    const data = [
      { class: 1, b: 2 },
      { class: 3, b: 4 },
    ];
    const r = encodeResponse(data, "tron");
    expect(r.format).toBe("json");
    expect(r.reason).toBe("no-reversible");
    // And the __proto__ key, which TRON loses when reading.
    const withProto = JSON.parse(
      `[${Array.from({ length: 20 }, (_, i) => `{"__proto__":${i},"b":"${"x".repeat(20)}"}`).join(",")}]`
    );
    const r2 = encodeResponse(withProto, "auto", { candidates: ["json", "tron"] });
    expect(r2.format).toBe("json");
  });

  it("roundTrip rejects a text the decoder does not understand", () => {
    expect(roundTrip("toon", 'a: "unclosed', '{"a":"x"}')).toBe(false);
    expect(roundTrip("tron", "class A: null,b\n\n[A(1,2)]", '[{"null":1,"b":2}]')).toBe(false);
  });

  it("auto remembers the winner per shape in large responses and measures again from time to time", () => {
    const large = rows(400);
    expect(JSON.stringify(large).length).toBeGreaterThan(LARGE_THRESHOLD);
    const first = encodeResponse(large, "auto", { key: "GET /x" });
    expect(first.reason).toBe("measured");
    expect(first.format).toBe("toon");
    // Another page with the same shape: it no longer measures
    const second = encodeResponse(rows(400, "-b"), "auto", { key: "GET /x" });
    expect(second.reason).toBe("remembered");
    expect(second.format).toBe("toon");
    const reasons = new Set<string>();
    for (let i = 0; i < REMEASURE_EVERY; i++)
      reasons.add(encodeResponse(large, "auto", { key: "GET /x" }).reason);
    expect(reasons.has("measured")).toBe(true);
    // Another route with the same shape does not share the memory
    expect(encodeResponse(large, "auto", { key: "GET /y" }).reason).toBe("measured");
  });

  it("if the remembered format does not work for this data, it measures again", () => {
    const large = rows(400);
    encodeResponse(large, "auto", { key: "GET /z", candidates: ["json", "tron"] });
    // Same signature (the first elements equal) but with a row TRON cannot read:
    // (two rows: TRON only declares a class for keys that repeat)
    const trap = rows(400).map((f, i) => (i >= 398 ? { ...f, class: i } : f));
    const r = encodeResponse(trap, "auto", { key: "GET /z", candidates: ["json", "tron"] });
    expect(r.reason).not.toBe("remembered");
    expect(r.format).toBe("json");
    expect(JSON.parse(r.text)).toEqual(trap);
  });

  it("the shape signature does not depend on the values or the exact size", () => {
    expect(shapeSignature(rows(120))).toBe(shapeSignature(rows(150, "-z")));
    expect(shapeSignature(rows(5))).not.toBe(shapeSignature(rows(500)));
    expect(shapeSignature({ a: 1 })).not.toBe(shapeSignature({ b: 1 }));
  });
});

describe("data that is not pure JSON (Drizzle rows in MCP)", () => {
  it("a Date comes out as in JSON in all three formats", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      title: `Entry ${i}`,
      created: new Date(Date.UTC(2026, 9, 25, 10, i)),
      data: { tags: ["a", "b"], level: i },
    }));
    const json = JSON.stringify(rows);
    for (const request of ["tron", "toon", "auto"] as const) {
      const r = encodeResponse(rows, request);
      expect(r.format).not.toBe("json");
      expect(roundTrip(r.format, r.text, json)).toBe(true);
    }
  });
});
