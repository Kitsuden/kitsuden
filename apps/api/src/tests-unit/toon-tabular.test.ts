import { decode as decodeRef, encode as encodeRef } from "@toon-format/toon";
import { describe, it, expect } from "bun:test";

import { encodeToon, decodeToon, ToonDecodeError } from "../lib/toon-tabular";

/**
 * The in-house codec against the reference implementation
 * (`@toon-format/toon@4.4.0`, pinned devDependency). The four failures that
 * the G1 measurement found (docs/agents/benchmarks.md) each have their own test:
 * with the previous codec, all four failed.
 */

/** Full round trip: same text as the reference and both decoders return the value. */
function roundTrip(value: unknown): void {
  const text = encodeToon(value);
  expect(text).toBe(encodeRef(value as never));
  expect(decodeToon(text)).toEqual(value as never);
  expect(decodeRef(text)).toEqual(value as never);
}

describe("TOON — the four G1 failures", () => {
  it("1. list-form arrays with nested objects: the decoder no longer returns []", () => {
    // Before: decodeToon(encodeToon(v)) gave { a: [] } with no error at all.
    const v = {
      a: [
        { x: 1, m: { z: 2 }, t: ["p", "q"] },
        { x: 2, m: { z: 3 } },
      ],
    };
    const text = encodeToon(v);
    expect(text).toContain("a[2]:\n  - x: 1");
    expect(decodeToon(text)).toEqual(v);
    roundTrip(v);
    // And the real shape of a dataset entries listing
    roundTrip({
      docs: [
        {
          id: "e1",
          title: "One",
          data: { skills: ["a", "b"], tier: "S" },
          _meta: { datasetId: "d", createdAt: "2026-10-25" },
        },
        {
          id: "e2",
          title: "Two",
          data: { skills: [], tier: null },
          _meta: { datasetId: "d", createdAt: "2026-10-24" },
        },
      ],
      totalDocs: 2,
      page: 1,
    });
  });

  it("2. the siblings of `data` in the envelope are not lost (nothing gets unwrapped)", () => {
    // Before: encodeTOON({ data, view }) dropped `view` (the entire tier list).
    const v = {
      data: { slug: "x", tiers: [{ id: "S", items: 3 }] },
      view: { rows: [{ tier: "S", ids: ["a", "b"] }] },
      profile: null,
    };
    const text = encodeToon(v);
    expect(text).toContain("view:");
    expect(text).toContain("profile: null");
    expect(decodeToon(text)).toEqual(v);
    roundTrip(v);
  });

  it("3. the empty object is written as TOON (`key:` with nothing) and read as {}", () => {
    // Before: `content: {}`, which the reference reads as the text "{}".
    const v = { content: {}, externalIds: {}, name: "x" };
    const text = encodeToon(v);
    expect(text).toBe("content:\nexternalIds:\nname: x");
    expect(decodeRef(text)).toEqual(v);
    roundTrip(v);
    roundTrip({});
    roundTrip([{}, {}]);
    roundTrip({ list: [{ a: {} }, { a: {}, b: 1 }] });
  });

  it("4. a root array is a root array for both decoders (no invented `data` key)", () => {
    // Before: `data[2]{id}:`, which the reference read as { data: [...] }.
    const v = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];
    const text = encodeToon(v);
    expect(text).toBe("[2]{id,name}:\n  1,a\n  2,b");
    expect(decodeToon(text)).toEqual(v);
    expect(decodeRef(text)).toEqual(v);
    roundTrip([]);
    roundTrip([1, "two", null]);
    roundTrip([[1, 2], [3]]);
  });
});

describe("TOON — specification forms", () => {
  it("table: keys once and CSV rows", () => {
    expect(
      encodeToon({
        users: [
          { id: 1, name: "Alice", role: "admin" },
          { id: 2, name: "Bob", role: "user" },
        ],
      })
    ).toBe("users[2]{id,name,role}:\n  1,Alice,admin\n  2,Bob,user");
  });

  it("folds into the header a column that is a uniform object", () => {
    const v = {
      items: [
        { id: 1, _meta: { ds: "d", at: "t1" } },
        { id: 2, _meta: { ds: "d", at: "t2" } },
      ],
    };
    expect(encodeToon(v)).toBe("items[2]{id,_meta{ds,at}}:\n  1,d,t1\n  2,d,t2");
    roundTrip(v);
  });

  it("keyed table for an object of uniform objects", () => {
    const v = { byId: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } };
    expect(encodeToon(v)).toBe("byId[2:]{x,y}:\n  a: 1,2\n  b: 3,4");
    roundTrip(v);
  });

  it("quotes whatever would otherwise change type or break the line", () => {
    const v = {
      a: "1",
      b: "true",
      c: "x,y",
      d: "plain",
      e: "",
      f: " sp",
      g: "-x",
      h: "#h",
      i: "a:b",
      j: "05",
      k: "l\nn",
    };
    const text = encodeToon(v);
    for (const l of [
      'a: "1"',
      'b: "true"',
      'c: "x,y"',
      "d: plain",
      'e: ""',
      'f: " sp"',
      'g: "-x"',
      'h: "#h"',
      'i: "a:b"',
      'j: "05"',
      'k: "l\\nn"',
    ]) {
      expect(text).toContain(l);
    }
    roundTrip(v);
  });

  it("keys that need quotes, including __proto__", () => {
    roundTrip(JSON.parse('{"x-y":1,"1a":2,"with space":3,"":4,"__proto__":{"k":5}}'));
  });

  it("empty arrays and scalars at the root", () => {
    expect(encodeToon({ items: [] })).toBe("items: []");
    expect(encodeToon(42)).toBe("42");
    expect(encodeToon("hello")).toBe("hello");
    expect(encodeToon(null)).toBe("null");
    for (const v of [{ items: [] }, 42, "hello", null, true, ""]) roundTrip(v);
  });

  it("JSON.stringify semantics: Date, undefined, NaN", () => {
    const date = new Date("2026-10-25T10:00:00.000Z");
    const v = { f: date, u: undefined, n: Number.NaN, l: [undefined, 1] };
    expect(decodeToon(encodeToon(v))).toEqual(JSON.parse(JSON.stringify(v)));
  });

  it("reads tab and pipe delimiters (the reference writes them with options)", () => {
    const v = {
      t: [
        { a: 1, b: "x y" },
        { a: 2, b: "z" },
      ],
    };
    expect(decodeToon(encodeRef(v, { delimiter: "\t" }))).toEqual(v);
    expect(decodeToon(encodeRef(v, { delimiter: "|" }))).toEqual(v);
  });

  it("malformed TOON throws instead of returning partial data", () => {
    expect(() => decodeToon("a[3]{x}:\n  1\n  2")).toThrow(ToonDecodeError);
    expect(() => decodeToon("a[2]:\n  - 1")).toThrow(ToonDecodeError);
    expect(() => decodeToon('a: "unclosed')).toThrow(ToonDecodeError);
  });
});

describe("TOON — random data against the reference", () => {
  it("20 000 values: same text as the reference and both decoders return them", () => {
    let seed = 20261025;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const TEXTS = [
      "",
      "a",
      "Hello world",
      "1",
      "05",
      "-3",
      "true",
      "null",
      "x,y",
      "a:b",
      "#h",
      "-x",
      " sp",
      'q"t',
      "l\nn",
      "t\tb",
      "[x]",
      "{y}",
      "\\",
      "\u0001",
      "é ñ",
      "1e5",
      "+1",
      "a|b",
    ];
    const KEYS = [
      "id",
      "name",
      "_meta",
      "a.b",
      "x-y",
      "1a",
      "",
      "with space",
      "k",
      "__proto__",
      "tags",
    ];
    const put = (o: Record<string, unknown>, k: string, v: unknown) =>
      Object.defineProperty(o, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    const scalar = (): unknown =>
      pick<unknown>([null, true, false, 0, -1, 3.25, 1e21, 42, pick(TEXTS), pick(TEXTS)]);
    const value = (p: number): unknown => {
      const r = rnd();
      if (p > 3 || r < 0.35) return scalar();
      if (r < 0.55) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(p + 1));
      if (r < 0.75) {
        const ks = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(KEYS));
        const nested = rnd() < 0.5;
        return Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
          const o: Record<string, unknown> = {};
          for (const k of ks)
            put(
              o,
              k,
              nested && rnd() < 0.5
                ? { p: scalar(), q: scalar() }
                : rnd() < 0.85
                  ? scalar()
                  : value(p + 1)
            );
          return o;
        });
      }
      const o: Record<string, unknown> = {};
      const n = Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) put(o, pick(KEYS), value(p + 1));
      return o;
    };
    let failures = 0;
    for (let i = 0; i < 20_000; i++) {
      const v = value(0);
      const text = encodeToon(v);
      const json = JSON.stringify(v);
      if (
        text !== encodeRef(v as never) ||
        JSON.stringify(decodeToon(text)) !== json ||
        JSON.stringify(decodeRef(text)) !== json
      ) {
        failures++;
      }
    }
    expect(failures).toBe(0);
  });
});
