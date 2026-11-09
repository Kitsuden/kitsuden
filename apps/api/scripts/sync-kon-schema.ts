/**
 * Kitsuden — Sync Kon Schema (aggregator codegen for drizzle-kit)
 * ============================================================================
 *
 * BEFORE: `apps/api/src/db/schema-all.ts` was edited BY HAND for each kon, and
 * Postgres's global enums forced curating what to export (collisions).
 *
 * NOW: this script scans the manifests (`kon.json` with a `schema`
 * block) and GENERATES `schema-kons.generated.ts`. Each kon declares its
 * strategy:
 *   - "drizzle": tables managed by drizzle-kit → exported to the aggregator.
 *   - "sql":     self-migrates via its own SQL → EXCLUDED (types only), avoiding
 *                enum collisions.
 *
 * Collision safety: the exported symbols of each schema are read
 * (via the deterministic indexer of @kitsuden/engine) and, if two kons export the
 * same name, the second is OMITTED with a warning — a file that
 * does not compile is never generated.
 *
 * Usage:  bun run apps/api/scripts/sync-kon-schema.ts
 *         (or `kitsuden sync-schema`)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Direct import of the code-graph module (NOT from the engine's index, which
// would drag in repo()→apps/api/db and require DATABASE_URL in an offline script).
import { indexFiles } from "../../../packages/engine/src/code-graph/indexer";

// `import.meta.dir` is Bun's and is undefined in Node. The aggregate is watched by
// a vitest test, which runs in Node: with the Bun-ism, the path came out of a
// join(undefined, "..") and the test could not even start. fileURLToPath works in
// both environments.
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const API_DIR = join(dirname(SCRIPT_FILE), "..");
const ROOT = join(API_DIR, "..", "..");
export const GENERATED = join(API_DIR, "src", "db", "schema-kons.generated.ts");

interface SchemaSource {
  konId: string;
  /** Absolute path to the schema file. */
  file: string;
  strategy: "drizzle" | "sql";
  /**
   * If true, this kon's symbols WIN over those of schema-core when they
   * collide (they are emitted anyway; in the aggregator the explicit `export {}`
   * overrides schema-core's `export *` — same mechanics as the manual
   * file). Use it when the canonical table lives in the kon, not in core
   * (e.g. `media`: schema-core has a duplicate legacy definition).
   */
  authoritative: boolean;
}

/**
 * Only `packages/core`. The kons are not part of the core: they are
 * installed (kitsuden-kons) and create their tables with THEIR SQL migrations, so
 * they do not go into the aggregate that drizzle-kit reads. If they did, the
 * versioned file would change depending on which kons each person has installed.
 */
function listManifestDirs(): string[] {
  const dirs: string[] = [];
  for (const tier of ["core"]) {
    const base = join(ROOT, "packages", tier);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, "kon.json");
      if (existsSync(manifest)) dirs.push(join(base, entry.name));
    }
  }
  return dirs.sort();
}

function discover(): SchemaSource[] {
  const out: SchemaSource[] = [];
  for (const dir of listManifestDirs()) {
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "kon.json"), "utf8"));
    } catch {
      continue;
    }
    const schema = manifest.schema;
    if (!schema || !schema.entry) continue;
    if (schema.strategy !== "drizzle") continue; // "sql"/absent → types-only, no drizzle-kit
    const file = join(dir, schema.entry);
    if (!existsSync(file)) {
      console.warn(`⚠️  ${manifest.id}: schema.entry does not exist: ${schema.entry}`);
      continue;
    }
    out.push({
      konId: manifest.id ?? relative(ROOT, dir),
      file,
      strategy: "drizzle",
      authoritative: schema.authoritative === true,
    });
  }
  return out;
}

/** Names of symbols exported by schema-core (reserved). */
async function coreExportNames(): Promise<Set<string>> {
  const coreFile = join(API_DIR, "src", "db", "schema-core.ts");
  const content = readFileSync(coreFile, "utf8");
  const graph = await indexFiles([{ path: "schema-core.ts", content }]);
  return new Set(graph.symbols.filter((s) => s.exported).map((s) => s.name));
}

/** Converts an absolute path to a relative import from src/db/. */
function toImportPath(file: string): string {
  const rel = relative(join(API_DIR, "src", "db"), file).replace(/\\/g, "/");
  return (rel.startsWith(".") ? rel : `./${rel}`).replace(/\.ts$/, "");
}

export interface Aggregated {
  /** The complete file contents, exactly as they should end up on disk. */
  content: string;
  /** Kons with strategy "drizzle" found. */
  sources: number;
  /** Kons that contributed at least one symbol. */
  blocks: number;
  /** Symbols omitted for clashing with core or with another kon. */
  collisions: string[];
}

/**
 * Builds the aggregate WITHOUT writing it.
 *
 * Separated from `main` so it can be tested. The generated file is
 * versioned, and what keeps it honest is a test that regenerates it here and
 * compares — if it wrote to disk, that test would "fix" the drift instead of
 * reporting it.
 */
export async function generateAggregate(): Promise<Aggregated> {
  // Authoritative kons are processed FIRST so their symbol wins the
  // slot before a non-authoritative kon with the same name.
  const sources = discover().sort((a, b) => Number(b.authoritative) - Number(a.authoritative));
  const coreNames = await coreExportNames(); // symbols of schema-core (export *)
  const konClaimed = new Set<string>(); // symbols already emitted by a kon
  const blocks: string[] = [];
  const collisions: string[] = [];

  for (const src of sources) {
    const content = readFileSync(src.file, "utf8");
    const graph = await indexFiles([{ path: src.file, content }]);
    // Separate TYPES from VALUES: with `isolatedModules`, re-exporting a type
    // requires `export type { ... }` — mixing them breaks the typecheck of all
    // the packages that import the aggregate.
    const exported = graph.symbols
      .filter((s) => s.exported)
      .sort((a, b) => a.name.localeCompare(b.name));

    const keepValues: string[] = [];
    const keepTypes: string[] = [];
    for (const sym of exported) {
      const name = sym.name;
      // Another kon already exports it explicitly → two `export {}` = TS error.
      if (konClaimed.has(name)) {
        collisions.push(`${src.konId}: '${name}' already exported by another kon → omitted`);
        continue;
      }
      // Collides with schema-core: only an AUTHORITATIVE kon can beat it
      // (the explicit `export {}` overrides core's `export *`).
      if (coreNames.has(name) && !src.authoritative) {
        collisions.push(`${src.konId}: '${name}' defined in schema-core → core wins`);
        continue;
      }
      konClaimed.add(name);
      if (sym.kind === "interface" || sym.kind === "type") keepTypes.push(name);
      else keepValues.push(name);
    }
    if (keepValues.length === 0 && keepTypes.length === 0) continue;

    const importPath = toImportPath(src.file);
    const parts: string[] = [`// ── ${src.konId} ──`];
    if (keepValues.length) {
      parts.push(`export {\n  ${keepValues.join(",\n  ")},\n} from "${importPath}";`);
    }
    if (keepTypes.length) {
      parts.push(`export type {\n  ${keepTypes.join(",\n  ")},\n} from "${importPath}";`);
    }
    blocks.push(parts.join("\n"));
  }

  const header = `/**
 * Kitsuden — AGGREGATED schema (AUTO-GENERATED)
 * ============================================================================
 * ⚠️ DO NOT EDIT BY HAND. Regenerate with:  kitsuden sync-schema
 *
 * Source: the \`schema\` block of each kon.json with strategy "drizzle".
 * Kons with strategy "sql" (own auto-migration) are excluded on
 * purpose to avoid collisions between global Postgres enums.
 *
 * It re-exports schema-core first; the explicit \`export {}\` of an
 * AUTHORITATIVE kon overrides core's \`export *\` (TS rule
 * explicit-wins-over-star), resolving collisions unambiguously.
 */

// Core first: authoritative kons (e.g. media) override its
// symbols via explicit export further down.
export * from "./schema-core";
`;

  const body = blocks.length
    ? blocks.join("\n\n")
    : "// (no drizzle-managed kons; they all use their own SQL migrations)";

  return {
    content: `${header}\n${body}\n`,
    sources: sources.length,
    blocks: blocks.length,
    collisions,
  };
}

async function main(): Promise<void> {
  const {
    content: content,
    sources: sources,
    blocks: blocks,
    collisions: collisions,
  } = await generateAggregate();

  writeFileSync(GENERATED, content);

  console.log(`✅ ${relative(ROOT, GENERATED)}`);
  console.log(`   ${sources} kons drizzle · ${blocks} with exports`);
  if (collisions.length) {
    console.log(`   ⚠️  ${collisions.length} collisions omitted:`);
    for (const c of collisions) console.log(`      ${c}`);
  }
}

// Only when run as a script. Before, `main()` ran when the module was imported,
// so the test that checks it would have REWRITTEN the file as soon as it
// loaded it — and would always have passed, comparing the file with itself.
const executedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_FILE);

if (executedDirectly) {
  main().catch((err) => {
    console.error("❌ sync-kon-schema failed:", err);
    process.exit(1);
  });
}
