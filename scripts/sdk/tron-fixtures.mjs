#!/usr/bin/env node
/**
 * TRON fixtures for the SDK decoders (TypeScript and Python)
 * ============================================================================
 *
 * Encodes a set of values with the SAME library and version the API uses
 * (`@tron-format/tron`, pinned in apps/api) and keeps the cases whose round
 * trip with the reference parser gives the value back (the API only sends
 * TRON in that case). Writes `{ tron, json }` pairs to
 *
 *   packages/sdk/tests/fixtures/tron-cases.json
 *   packages/sdk-python/tests/fixtures/tron-cases.json
 *
 * Both SDK test suites decode every case with their own decoder and compare.
 *
 *   node scripts/sdk/tron-fixtures.mjs           # write
 *   node scripts/sdk/tron-fixtures.mjs --check   # exit 1 if the files differ
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(ROOT, "apps/api/package.json"));
const route = require.resolve("@tron-format/tron");
const { stringify, parse } = await import(pathToFileURL(route).href);
const version = JSON.parse(
  readFileSync(join(dirname(route), "..", "package.json"), "utf8")
).version;

const row = (i) => ({
  id: `0c6e1c2e-0000-4000-8000-00000000000${i}`,
  name: `Item ${i}`,
  price: i * 1.5,
  active: i % 2 === 0,
  tags: ["a", `t${i}`],
  meta: { rank: i, note: null },
});

const VALUES = [
  null,
  true,
  false,
  0,
  -12,
  3.25,
  1e21,
  "plain",
  'with "quotes", commas, colons: and\nnewlines\ttabs \\ backslash',
  "unicode: ñandú, 日本語, emoji 😀",
  "",
  [],
  {},
  [1, 2, 3],
  ["x", null, true, 1.5, { a: 1 }],
  { a: 1, b: "two", c: [true, false], d: { e: null } },
  { docs: [row(1), row(2), row(3)], totalDocs: 3, page: 1, limit: 10, hasNextPage: false },
  [row(1), row(2), row(3), row(4)],
  {
    data: [
      { x: 1, y: 2 },
      { y: 3, x: 4 },
      { x: 5, y: 6, z: 7 },
    ],
    meta: { total: 3 },
  },
  { nested: { level: { deeper: [{ k: "v", n: [1, [2, [3]]] }] } } },
  { "key with spaces": 1, "kebab-key": 2, 123: 3, ünïcode: 4 },
  [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5 }, { b: 6 }],
  { empty: { obj: {}, arr: [], str: "" } },
  { big: Array.from({ length: 25 }, (_, i) => ({ id: i, label: `row ${i}`, ok: i % 3 === 0 })) },
];

const cases = [];
for (const v of VALUES) {
  let text;
  try {
    text = stringify(v);
  } catch {
    continue;
  }
  let round;
  try {
    round = parse(text);
  } catch {
    continue;
  }
  if (JSON.stringify(sort(round)) !== JSON.stringify(sort(JSON.parse(JSON.stringify(v))))) continue;
  cases.push({ tron: text, json: JSON.parse(JSON.stringify(v)) });
}

function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sort(v[k])])
    );
  return v;
}

const output = `${JSON.stringify({ library: `@tron-format/tron@${version}`, cases: cases }, null, 2)}\n`;
const targets = [
  join(ROOT, "packages/sdk/tests/fixtures/tron-cases.json"),
  join(ROOT, "packages/sdk-python/tests/fixtures/tron-cases.json"),
];
if (process.argv.includes("--check")) {
  const badOnes = targets.filter(
    (d) => !existsSync(d) || readFileSync(d, "utf8").replaceAll("\r\n", "\n") !== output
  );
  if (badOnes.length) {
    console.error(`[tron-fixtures] stale: ${badOnes.join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}
for (const d of targets) {
  mkdirSync(dirname(d), { recursive: true });
  writeFileSync(d, output);
}
console.error(
  `[tron-fixtures] ${cases.length}/${VALUES.length} cases (${version}) → ${targets.length} files`
);
