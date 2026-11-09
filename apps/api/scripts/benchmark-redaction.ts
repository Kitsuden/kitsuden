#!/usr/bin/env bun
/**
 * Secret redaction with a ~5 MB body
 * ============================================================================
 *
 *   bun --no-env-file scripts/benchmark-redaction.ts
 *
 * Before considering RE2 in WASM (or Rust) for `containsSecret` /
 * `bodyWithSecret` (idempotency.ts, which idempotency and approvals use), we
 * MEASURE: how long they take with 5 MB, including the cases that
 * suit a backtracking regex engine worst:
 *
 *   · a huge string with no secret, with many almost-secret prefixes
 *     («kitsuden_agen…» cut off): the unanchored text search;
 *   · a wide JSON (100,000 keys) and a deep one (nested up to the limit);
 *   · a JSON with the secret at the end (the worst case for exiting early);
 *   · the diff trimming: `JSON.stringify` of 5 MB (what `truncate` does).
 *
 * No database: only pure functions. Prints the median of 5 runs.
 *
 * ── RESULT (2026-10-28, Bun 1.3.14, win32-x64) ──────────────────────────────
 *
 *   text of 5 MB with almost-secret prefixes   8 ms
 *   JSON with a 5 MB string                     3 ms
 *   wide JSON, 100,000 keys (5.4 MB)           55 ms   ← the worst
 *   deep JSON (12 levels)                       2 ms
 *   secret at the end of the wide JSON         51 ms
 *   trim (stringify of 5 MB)                    4 ms
 *
 * Linear and no backtracking: the expressions are anchored (`^…`) or are a fixed
 * prefix followed by a character class. The body is already limited
 * to 10 MB (lib/body-limit.ts), so the realistic worst case is ~0.1 s.
 * DECISION: neither RE2 in WASM nor Rust. Repeat this measurement if an
 * expression with nested quantifiers or unanchored alternations is added.
 */

import { containsSecret, bodyWithSecret } from "../src/lib/idempotency";

const MB = 1024 * 1024;
const encode = (t: string) => new TextEncoder().encode(t);

function median(fn: () => unknown, iterations = 5): number {
  const t: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  return t[Math.floor(t.length / 2)]!;
}

const nearSecrets = "kitsuden_agen ".repeat(Math.ceil((5 * MB) / 14)).slice(0, 5 * MB);
const plainText = encode(nearSecrets);
const nearJson = encode(JSON.stringify({ notes: nearSecrets }));

const width: Record<string, string> = {};
for (let i = 0; i < 100_000; i++) width[`field_${i}`] = "x".repeat(40);
const wideJson = encode(JSON.stringify(width));

let profound: unknown = { value: "x".repeat(5 * MB - 1000) };
for (let i = 0; i < 12; i++) profound = { level: profound };
const deepJson = encode(JSON.stringify(profound));

const withSecretAtEnd = encode(
  JSON.stringify({ ...width, token: "kitsuden_agent_0123456789abcdefABCDEF" })
);

const rows: Array<[string, number, number, boolean]> = [];
const measure = (name: string, bytes: Uint8Array, type = "application/json") => {
  let r = false;
  const ms = median(() => (r = bodyWithSecret(type, bytes)));
  rows.push([name, bytes.length, ms, r]);
};

measure("text, 5 MB of almost-secret prefixes", plainText, "text/plain");
measure("JSON, a 5 MB almost-secret string", nearJson);
measure("Wide JSON (100,000 keys)", wideJson);
measure("deep JSON (12 levels, 5 MB)", deepJson);
measure("wide JSON with the secret at the end", withSecretAtEnd);

const object = JSON.parse(new TextDecoder().decode(wideJson));
const msObject = median(() => containsSecret(object));
const msTrim = median(() => JSON.stringify(object).length);

console.log(`Bun ${Bun.version} · ${process.platform}-${process.arch}\n`);
for (const [n, b, ms, r] of rows) {
  console.log(
    `${n.padEnd(42)} ${(b / MB).toFixed(1)} MB  ${ms.toFixed(1).padStart(7)} ms  secret=${r}`
  );
}
console.log(
  `${"containsSecret on the already-parsed object".padEnd(42)}          ${msObject.toFixed(1).padStart(7)} ms`
);
console.log(
  `${"trim (JSON.stringify of 5 MB)".padEnd(42)}          ${msTrim.toFixed(1).padStart(7)} ms`
);
