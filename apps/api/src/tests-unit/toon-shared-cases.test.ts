import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, it, expect } from "bun:test";

import { decodeToon, encodeToon } from "../lib/toon-tabular";

/**
 * TOON → JSON pairs shared with clients in other languages (today, the Python
 * SDK: packages/sdk-python/tests/fixtures/toon-cases.json). This test
 * requires the file to be what the API's encoder writes TODAY, so a
 * codec change does not leave the other decoder testing a TOON that no longer exists.
 *
 * Regenerate: UPDATE_TOON_CASES=1 bun test src/tests-unit/toon-shared-cases.test.ts
 */
const FILE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "sdk-python",
  "tests",
  "fixtures",
  "toon-cases.json"
);

const row = (i: number) => ({
  id: i,
  slug: `row-${i}`,
  name: `Row ${i}`,
  active: i % 2 === 0,
  note: i * 1.5,
});

const CASES: Record<string, unknown> = {
  "flat table": Array.from({ length: 4 }, (_, i) => row(i)),
  "listing with envelope": { docs: [row(1), row(2)], totalDocs: 2, page: 1, hasNextPage: false },
  "column folded into the header": {
    docs: [
      { id: "e1", _meta: { datasetId: "d1", createdAt: "2026-10-25T10:00:00.000Z" }, name: "One" },
      { id: "e2", _meta: { datasetId: "d1", createdAt: "2026-10-24T09:00:00.000Z" }, name: "Two" },
    ],
  },
  "keyed table": { byId: { a: { x: 1, y: "one" }, b: { x: 2, y: "two" } } },
  "list form with nested items": {
    docs: [
      { id: 1, data: { skills: ["fire", "ice"], stats: { atk: 10 } }, tags: [] },
      { id: 2, data: { skills: [], stats: { atk: 0 } }, extra: { note: null } },
    ],
  },
  "empty objects": { content: {}, externalIds: {}, list: [{}, { a: {} }] },
  "siblings of data": { data: { slug: "x" }, view: { rows: [["a", "b"], ["c"]] }, profile: null },
  "root array of objects": [row(1), row(2)],
  "root array of scalars": [1, "two", null, true, 2.5],
  "empty root array": [],
  "empty root object": {},
  "arrays of arrays": {
    matrix: [
      [1, 2],
      [3, 4],
    ],
    mixed: [1, [2, 3], { a: 1 }],
  },
  "texts that need quotes": {
    number: "42",
    zeros: "05",
    truth: "true",
    nullText: "null",
    comma: "a,b",
    colon: "a:b",
    dash: "-x",
    hash: "#topic",
    empty: "",
    spaces: " a ",
    newline: "line\nbreak",
    tab: "a\tb",
    quotes: 'says "hello"',
    backslash: "a\\b",
    control: "\u0001",
    unicode: "ñandú 😀",
    brackets: "[x]",
    braces: "{y}",
    pipe: "a|b",
  },
  "keys with quotes": JSON.parse(
    '{"x-y":1,"1a":2,"with space":3,"":4,"a.b":5,"__proto__":{"k":6}}'
  ),
  numbers: { integer: 42, negative: -7, decimal: 3.25, large: 1e21, small: 1e-7, zero: 0 },
  scalar: "hello",
};

describe("TOON cases shared with other clients", () => {
  const current = Object.entries(CASES).map(([name, json]) => ({
    name,
    json,
    toon: encodeToon(json),
  }));

  if (process.env.UPDATE_TOON_CASES === "1" || !existsSync(FILE)) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(current, null, 2) + "\n");
  }

  it("the file is what the encoder writes today", () => {
    const saved = JSON.parse(readFileSync(FILE, "utf8"));
    expect(saved).toEqual(JSON.parse(JSON.stringify(current)));
  });

  it("each case gives back its JSON with the API's decoder", () => {
    for (const c of current)
      expect(JSON.stringify(decodeToon(c.toon))).toBe(JSON.stringify(c.json));
  });
});
