/**
 * Kitsuden — Code Graph: Deterministic symbol indexer
 * ============================================================================
 *
 * Turns TypeScript code into a queryable graph of symbols and relations
 * (Graphify/Serena/Sourcegraph style, but as a system function, WITHOUT AI):
 *
 *   - Symbols: functions, classes, interfaces, types, enums, top-level consts
 *     with file + line (symbol-level navigation, not loose lines).
 *   - Relations: `imports` (file→file/package), `declares`
 *     (file→symbol) and `calls` (symbol→symbol, best effort).
 *   - Confidence per edge: "direct" (read from the AST) or "inferred" (resolved
 *     by name), like Graphify's EXTRACTED/INFERRED tags.
 *
 * Deterministic: same input → same output. Pure syntactic parsing with the
 * TypeScript compiler API (no type-checker, no LSP, no network).
 *
 * The `typescript` module is loaded lazily (dynamic import) so as not to pay its cost
 * at server startup when the code-graph is not used.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SourceFileInput {
  /** Path relative to the repo root, with forward slashes. */
  path: string;
  content: string;
}

export type CodeSymbolKind = "function" | "class" | "interface" | "type" | "enum" | "const";

export interface CodeSymbol {
  /** `${file}#${name}` — unique within the graph. */
  id: string;
  name: string;
  kind: CodeSymbolKind;
  file: string;
  line: number;
  exported: boolean;
}

export type CodeEdgeRelation = "imports" | "declares" | "calls";

export interface CodeGraphEdge {
  from: string;
  to: string;
  relation: CodeEdgeRelation;
  /** "direct" = read from the AST; "inferred" = resolved by name. */
  confidence: "direct" | "inferred";
}

export interface CodeGraphFile {
  path: string;
  /** Import specifiers as they appear (already resolved if relative). */
  imports: string[];
  /** IDs of symbols declared in the file. */
  symbols: string[];
}

export interface CodeGraph {
  files: CodeGraphFile[];
  symbols: CodeSymbol[];
  edges: CodeGraphEdge[];
  summary: {
    totalFiles: number;
    totalSymbols: number;
    totalEdges: number;
    /** Most connected nodes (total degree), Graphify "god nodes" style. */
    godNodes: { id: string; degree: number }[];
  };
}

export interface IndexRepoOptions {
  /** Subdirectories to index, relative to the root. Default: apps and packages. */
  dirs?: string[];
  /** Maximum files (protection; default 5000). */
  maxFiles?: number;
}

// ── Lazy loading of typescript ─────────────────────────────────────────────────

let tsModule: any = null;

async function loadTs(): Promise<any> {
  if (!tsModule) {
    const mod: any = await import("typescript");
    tsModule = mod.default ?? mod;
  }
  return tsModule;
}

// ── Core: index a list of files (pure, testable) ──────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".bun", "coverage"]);

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Resolves a relative import against the set of known files. */
function resolveRelativeImport(fromFile: string, spec: string, known: Set<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    base.replace(/\.js$/, ".ts"),
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

export async function indexFiles(files: SourceFileInput[]): Promise<CodeGraph> {
  const ts = await loadTs();

  const sorted = [...files]
    .map((f) => ({ ...f, path: normalizePath(f.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const knownPaths = new Set(sorted.map((f) => f.path));

  const outFiles: CodeGraphFile[] = [];
  const symbols: CodeSymbol[] = [];
  const edges: CodeGraphEdge[] = [];
  /** name → ids of symbols with that name (to resolve calls). */
  const byName = new Map<string, string[]>();
  /** Pending calls to resolve: {fromId, calleeName, sameFile}. */
  const pendingCalls: { fromId: string; callee: string; file: string }[] = [];

  for (const file of sorted) {
    const sf = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);

    const fileSymbols: string[] = [];
    const fileImports: string[] = [];

    const lineOf = (node: any): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const isExported = (node: any): boolean =>
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;

    const addSymbol = (name: string, kind: CodeSymbolKind, node: any) => {
      const id = `${file.path}#${name}`;
      symbols.push({
        id,
        name,
        kind,
        file: file.path,
        line: lineOf(node),
        exported: isExported(node),
      });
      fileSymbols.push(id);
      edges.push({ from: file.path, to: id, relation: "declares", confidence: "direct" });
      const list = byName.get(name) ?? [];
      list.push(id);
      byName.set(name, list);
      return id;
    };

    /** Collects names of functions called inside a node. */
    const collectCalls = (node: any, ownerId: string) => {
      const visit = (n: any) => {
        if (ts.isCallExpression(n)) {
          const callee = n.expression;
          let name: string | null = null;
          if (ts.isIdentifier(callee)) name = callee.text;
          else if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
          if (name) pendingCalls.push({ fromId: ownerId, callee: name, file: file.path });
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(node, visit);
    };

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        const resolved = spec.startsWith(".")
          ? resolveRelativeImport(file.path, spec, knownPaths)
          : null;
        const target = resolved ?? spec;
        fileImports.push(target);
        edges.push({
          from: file.path,
          to: resolved ?? `pkg:${spec}`,
          relation: "imports",
          confidence: resolved ? "direct" : "direct",
        });
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const id = addSymbol(stmt.name.text, "function", stmt);
        if (stmt.body) collectCalls(stmt.body, id);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        const id = addSymbol(stmt.name.text, "class", stmt);
        collectCalls(stmt, id);
      } else if (ts.isInterfaceDeclaration(stmt)) {
        addSymbol(stmt.name.text, "interface", stmt);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        addSymbol(stmt.name.text, "type", stmt);
      } else if (ts.isEnumDeclaration(stmt)) {
        addSymbol(stmt.name.text, "enum", stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
          const id = addSymbol(decl.name.text, isFn ? "function" : "const", stmt);
          if (init) collectCalls(init, id);
        }
      }
    }

    outFiles.push({ path: file.path, imports: fileImports.sort(), symbols: fileSymbols });
  }

  // Resolve calls by name (best effort, deterministic):
  //   - match in the same file → direct
  //   - unique cross-file match whose file is IMPORTED by the caller →
  //     inferred (without the import relation we do not invent edges; this prevents
  //     common names like drizzle's `.references()` from creating false god nodes)
  const importsOf = new Map<string, Set<string>>();
  for (const f of outFiles) importsOf.set(f.path, new Set(f.imports));

  const seenCallEdge = new Set<string>();
  for (const call of pendingCalls) {
    const candidates = byName.get(call.callee) ?? [];
    if (candidates.length === 0) continue;
    const sameFile = candidates.filter((id) => id.startsWith(`${call.file}#`));
    let target: string | null = null;
    let confidence: "direct" | "inferred" = "inferred";
    if (sameFile.length === 1) {
      target = sameFile[0];
      confidence = "direct";
    } else {
      const callerImports = importsOf.get(call.file);
      const imported = candidates.filter((id) => callerImports?.has(id.slice(0, id.indexOf("#"))));
      if (imported.length === 1) target = imported[0];
    }
    if (!target || target === call.fromId) continue;
    const key = `${call.fromId}→${target}`;
    if (seenCallEdge.has(key)) continue;
    seenCallEdge.add(key);
    edges.push({ from: call.fromId, to: target, relation: "calls", confidence });
  }

  // God nodes: total degree (in + out) over all edges.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const godNodes = Array.from(degree.entries())
    .map(([id, d]) => ({ id, degree: d }))
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, 10);

  return {
    files: outFiles,
    symbols,
    edges,
    summary: {
      totalFiles: outFiles.length,
      totalSymbols: symbols.length,
      totalEdges: edges.length,
      godNodes,
    },
  };
}

// ── Index the repo from disk ──────────────────────────────────────────────────

function walkTsFiles(root: string, dir: string, out: string[], max: number): void {
  if (out.length >= max) return;
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (out.length >= max) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walkTsFiles(root, join(dir, entry.name), out, max);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(normalizePath(join(dir, entry.name)));
    }
  }
}

export async function indexRepo(root: string, options: IndexRepoOptions = {}): Promise<CodeGraph> {
  const dirs = options.dirs ?? ["apps", "packages"];
  const maxFiles = options.maxFiles ?? 5000;
  const paths: string[] = [];
  for (const dir of dirs) walkTsFiles(root, dir, paths, maxFiles);

  const files: SourceFileInput[] = [];
  for (const p of paths.sort()) {
    try {
      files.push({ path: p, content: readFileSync(join(root, p), "utf8") });
    } catch {
      // Unreadable file → skipped (deterministic for the rest).
    }
  }
  return indexFiles(files);
}
