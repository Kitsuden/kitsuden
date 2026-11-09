#!/usr/bin/env node
/**
 * Compare benchmark results written by bench.mjs.
 *
 *   node scripts/bench/compare.mjs before.json after.json
 *   node scripts/bench/compare.mjs --a=before-r1.json,before-r2.json --b=after-r1.json,after-r2.json
 *
 * With several files per side, each figure is the MEDIAN over the files
 * (repeat runs interleaved A, B, A, B on the same machine to tell a change from
 * noise). Prints a Markdown table: req/s, p50, p95, p99 and errors per scenario
 * and connection count, with the change in percent.
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.join("=")];
    })
);
const loose = args.filter((a) => !a.startsWith("--"));
const sideA = (opt.a ? opt.a.split(",") : [loose[0]]).filter(Boolean);
const sideB = (opt.b ? opt.b.split(",") : [loose[1]]).filter(Boolean);
if (!sideA.length || !sideB.length) {
  console.error("usage: compare.mjs A.json B.json | --a=a1.json,a2.json --b=b1.json,b2.json");
  process.exit(2);
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function load(files) {
  const byKey = new Map();
  for (const f of files) {
    for (const r of JSON.parse(readFileSync(f, "utf8")).results) {
      if (r.skipped || r.failure) continue;
      const key = `${r.name}@${r.connections}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
  }
  const output = new Map();
  for (const [key, rs] of byKey) {
    output.set(key, {
      rps: median(rs.map((r) => r.rps)),
      p50: median(rs.map((r) => r.p50)),
      p95: median(rs.map((r) => r.p95)),
      p99: median(rs.map((r) => r.p99)),
      errors: median(rs.map((r) => r.errors)),
      cpu: median(rs.map((r) => r.server?.cpuPercent)),
      n: rs.length,
    });
  }
  return output;
}

const A = load(sideA);
const B = load(sideB);
const change = (a, b, moreIsBetter) => {
  if (a == null || b == null || a === 0) return "";
  const p = ((b - a) / a) * 100;
  const sign = p > 0 ? "+" : "";
  const best = moreIsBetter ? p > 0 : p < 0;
  return ` (${sign}${p.toFixed(0)} %${Math.abs(p) >= 10 ? (best ? ", better" : ", worse") : ""})`;
};
const f = (x) => (x == null ? "–" : Number.isInteger(x) ? String(x) : x.toFixed(1));

console.log(
  "| scenario | conn | req/s A → B | p50 ms A → B | p95 ms A → B | p99 ms A → B | errors A → B |"
);
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const key of [...new Set([...A.keys(), ...B.keys()])]) {
  const [name, conn] = key.split("@");
  const a = A.get(key) ?? {};
  const b = B.get(key) ?? {};
  console.log(
    `| ${name} | ${conn} | ${f(a.rps)} → ${f(b.rps)}${change(a.rps, b.rps, true)} | ${f(a.p50)} → ${f(b.p50)}${change(a.p50, b.p50, false)} | ${f(a.p95)} → ${f(b.p95)}${change(a.p95, b.p95, false)} | ${f(a.p99)} → ${f(b.p99)}${change(a.p99, b.p99, false)} | ${f(a.errors)} → ${f(b.errors)} |`
  );
}
console.log(
  `\nA: ${sideA.join(", ")}\nB: ${sideB.join(", ")}  (median of ${Math.max(sideA.length, sideB.length)} run(s) per side)`
);
