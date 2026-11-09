/**
 * TOON Benchmark — measures the real savings of tabular TOON vs JSON.
 *
 * Usage:
 *   bun run apps/api/scripts/toon-benchmark.ts
 *
 * Metric: TOON reduces tokens mostly on arrays of uniform objects
 * (the typical shape of an API/list response). We report:
 *   - bytes (exact measure, no dependencies)
 *   - approximate "tokens" with a stable heuristic (~4 chars/token, GPT-style)
 *
 * HONESTY NOTE: the heuristic is NOT a real tokenizer. For an exact
 * per-model number, plug in a tokenizer (e.g. gpt-tokenizer / tiktoken) in
 * `countTokens()`. The savings in BYTES are exact and do not depend on the tokenizer.
 */

import { encodeToon } from "../src/lib/toon-tabular";

/** Stable, deterministic token heuristic (~4 chars/token). */
function countTokens(s: string): number {
  // GPT-style approximation: words + punctuation, with a floor by length.
  const wordish = (s.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []).length;
  const byLength = Math.ceil(s.length / 4);
  return Math.max(wordish, byLength);
}

function pct(from: number, to: number): string {
  if (from === 0) return "0%";
  return `${(((from - to) / from) * 100).toFixed(1)}%`;
}

interface Sample {
  name: string;
  value: unknown;
}

const samples: Sample[] = [
  {
    name: "List of 50 uniform records (typical API case)",
    value: Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      title: `Item ${i + 1}`,
      status: i % 2 ? "published" : "draft",
      views: i * 137,
      author: `user_${i % 7}`,
    })),
  },
  {
    name: "Game catalog (10 records, gaming fields)",
    value: Array.from({ length: 10 }, (_, i) => ({
      slug: `game-${i}`,
      name: `Game Title ${i}`,
      platform: ["pc", "ps5", "xbox"][i % 3],
      rating: (7 + (i % 3)).toFixed(1),
      released: `2024-0${(i % 9) + 1}-15`,
    })),
  },
  {
    name: "Single nested object (config)",
    value: {
      site: { name: "Kitsuden", locale: "es", theme: "dark" },
      features: { rls: true, mcp: true, toon: true },
      tags: ["baas", "cms", "ai"],
    },
  },
];

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║  TOON Benchmark — JSON vs TOON tabular                            ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

let totalJsonTok = 0;
let totalToonTok = 0;
let totalJsonBytes = 0;
let totalToonBytes = 0;

for (const sample of samples) {
  const json = JSON.stringify(sample.value);
  const jsonPretty = JSON.stringify(sample.value, null, 2);
  const toon = encodeToon(sample.value);

  const jBytes = Buffer.byteLength(json);
  const tBytes = Buffer.byteLength(toon);
  const jTok = countTokens(json);
  const jpTok = countTokens(jsonPretty);
  const tTok = countTokens(toon);

  totalJsonTok += jTok;
  totalToonTok += tTok;
  totalJsonBytes += jBytes;
  totalToonBytes += tBytes;

  console.log(`▸ ${sample.name}`);
  console.log(`    bytes:  JSON ${jBytes}  →  TOON ${tBytes}   (−${pct(jBytes, tBytes)})`);
  console.log(
    `    tokens: JSON(min) ${jTok} / JSON(pretty) ${jpTok}  →  TOON ${tTok}   (−${pct(jTok, tTok)} vs min, −${pct(jpTok, tTok)} vs pretty)`
  );
  console.log("");
}

console.log("──────────────────────────────────────────────────────────────────");
console.log(
  `TOTAL bytes:  JSON ${totalJsonBytes}  →  TOON ${totalToonBytes}   (−${pct(totalJsonBytes, totalToonBytes)})`
);
console.log(
  `TOTAL tokens: JSON ${totalJsonTok}  →  TOON ${totalToonTok}   (−${pct(totalJsonTok, totalToonTok)})`
);
console.log("──────────────────────────────────────────────────────────────────");
console.log(
  "\nNote: token heuristic (~4 chars/token). Byte savings are exact.\n" +
    "For per-model numbers, plug in a real tokenizer in countTokens()."
);
