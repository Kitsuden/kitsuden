/**
 * KITSUDEN Brain — Project Scanner
 *
 * Deterministic, local scan of the codebase producing structured entities
 * that can be turned into Brain notes. No AST parsing; regex-based heuristics
 * keep the module dependency-free and fast.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { ScannedEntity } from "./types";

export interface ScanOptions {
  root: string;
  include?: string[];
  exclude?: string[];
}

const DEFAULT_INCLUDE = [
  "apps/api/src/db",
  "apps/api/src/routes",
  "apps/api/src/lib",
  "apps/api/src/services",
  "packages/engine/src",
  "packages/kons",
  "packages/grimoires",
];

const DEFAULT_EXCLUDE = [
  "node_modules",
  "dist",
  ".git",
  ".kitsuden",
  ".llms",
  "coverage",
  "playwright-report",
  "test-results",
  "tests",
];

/**
 * Recursively list files under a path.
 */
function* walkFiles(dir: string, exclude: Set<string>): Generator<string> {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (exclude.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, exclude);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

/**
 * Extract JSDoc / top comment block from a TS file.
 */
function extractHeaderComment(source: string): string {
  const match = source.match(/^\s*\/\*\*[\s\S]*?\*\//);
  if (!match) return "";
  return match[0]
    .replace(/\/\*\*|\*\//g, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim();
}

/**
 * Extract exported function/class names from source text.
 */
function extractExports(source: string): string[] {
  const exports: string[] = [];
  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRegex.exec(source)) !== null) {
    exports.push(m[1]);
  }
  return exports;
}

/**
 * Extract pgTable names from a Drizzle schema file.
 */
function extractTableNames(source: string): string[] {
  const names: string[] = [];
  const regex = /export\s+const\s+(\w+)\s*=\s*pgTable\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Extract route path patterns from a Hono routes file.
 */
function extractRoutePaths(source: string): string[] {
  const paths: string[] = [];
  const regex = /\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    paths.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return paths;
}

/**
 * Scan a single code file and produce entities.
 */
function scanCodeFile(filePath: string, root: string): ScannedEntity[] {
  const entities: ScannedEntity[] = [];
  const relPath = relative(root, filePath);
  const source = readFileSync(filePath, "utf-8");
  const header = extractHeaderComment(source);
  const exports = extractExports(source);

  if (filePath.includes("schema") && filePath.endsWith(".ts")) {
    const tables = extractTableNames(source);
    if (tables.length > 0) {
      entities.push({
        id: `schema:${relPath}`,
        title: `Schema: ${tables.join(", ")}`,
        content: [
          `File: ${relPath}`,
          `Tables: ${tables.join(", ")}`,
          header,
          exports.length ? `Exports: ${exports.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        category: "schema",
        sourcePath: relPath,
        tags: ["schema", "database", "drizzle"],
        metadata: { tables, exports },
      });
    }
  }

  if (filePath.includes("route") && filePath.endsWith(".ts")) {
    const routes = extractRoutePaths(source);
    if (routes.length > 0) {
      entities.push({
        id: `route:${relPath}`,
        title: `Routes: ${relPath}`,
        content: [
          `File: ${relPath}`,
          `Endpoints: ${routes.join(", ")}`,
          header,
          exports.length ? `Exports: ${exports.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        category: "route",
        sourcePath: relPath,
        tags: ["routes", "api", "hono"],
        metadata: { routes, exports },
      });
    }
  }

  if (filePath.includes("kon") && filePath.endsWith(".ts")) {
    entities.push({
      id: `kon:${relPath}`,
      title: `Kon: ${relPath}`,
      content: [`File: ${relPath}`, header, exports.length ? `Exports: ${exports.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n"),
      category: "kon",
      sourcePath: relPath,
      tags: ["kon", "module"],
      metadata: { exports },
    });
  }

  // Generic code entity for files with exports not captured above
  if (entities.length === 0 && exports.length > 0) {
    entities.push({
      id: `code:${relPath}`,
      title: `Code: ${relPath}`,
      content: [`File: ${relPath}`, header, `Exports: ${exports.join(", ")}`]
        .filter(Boolean)
        .join("\n"),
      category: "general",
      sourcePath: relPath,
      tags: ["code"],
      metadata: { exports },
    });
  }

  return entities;
}

/**
 * Scan the configured project paths.
 */
export async function scanProject(options: ScanOptions): Promise<ScannedEntity[]> {
  const root = resolve(options.root);
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDE);

  const entities: ScannedEntity[] = [];
  const seen = new Set<string>();

  for (const includePath of include) {
    const fullPath = join(root, includePath);
    if (!existsSync(fullPath)) continue;

    const stat = statSync(fullPath);
    if (stat.isFile()) {
      for (const e of scanCodeFile(fullPath, root)) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          entities.push(e);
        }
      }
      continue;
    }

    for (const file of walkFiles(fullPath, exclude)) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      for (const e of scanCodeFile(file, root)) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          entities.push(e);
        }
      }
    }
  }

  return entities;
}
