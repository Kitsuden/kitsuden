/**
 * Kitsuden — Code Graph: Semantic editing (Serena style, deterministic)
 * ============================================================================
 *
 * Turns the read-only code-graph into a SYMBOL-level editor: the
 * agent stops "reading your code" and starts "refactoring your code".
 *
 *   renameSymbol       → renames a symbol and ALL its references
 *   replaceSymbolBody  → replaces the body of a function/class by name
 *   safeDeleteSymbol   → deletes a symbol only if nobody references it
 *   insertBeforeSymbol → inserts code right before a symbol
 *
 * SAFE BY DEFAULT — three guarantees, in this order:
 *
 *   1. DRY-RUN: no operation writes to disk unless `apply: true`. It always
 *      returns the `edits` to review before applying.
 *   2. NO AMBIGUITY: if the name resolves to more than one symbol (or to none),
 *      the operation is REJECTED instead of guessing which to touch.
 *   3. SYNTAX VERIFICATION: each modified file is re-parsed; if the
 *      result does not compile syntactically, the whole operation is aborted and
 *      NOTHING is written (all-or-nothing).
 *
 * Renaming uses the AST (real identifiers), not text search: it does not
 * touch strings, comments or substrings of other names.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SourceFileInput } from "./indexer";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileEdit {
  /** Relative path of the file. */
  path: string;
  /** Number of occurrences modified in this file. */
  occurrences: number;
  /** Resulting content (to review in dry-run). */
  content: string;
}

export interface EditResult {
  ok: boolean;
  /** Reason for rejection when `ok` is false. */
  error?: string;
  /** Files that would change (dry-run) or changed (`apply: true`). */
  edits: FileEdit[];
  /** true if the changes were written to disk. */
  applied: boolean;
  /** Readable summary of the operation. */
  summary: string;
}

export interface EditOptions {
  /** Write to disk. Default false (dry-run). */
  apply?: boolean;
  /** Repo root to resolve paths when writing. */
  root?: string;
}

// ── Lazy loading of typescript (same as the indexer) ──────────────────────────

let tsModule: any = null;
async function loadTs(): Promise<any> {
  if (!tsModule) {
    const mod: any = await import("typescript");
    tsModule = mod.default ?? mod;
  }
  return tsModule;
}

function fail(error: string): EditResult {
  return { ok: false, error, edits: [], applied: false, summary: error };
}

/**
 * Verifies that the text is still syntactically valid TypeScript.
 * It is the last safety net before writing.
 */
async function isParseable(path: string, content: string): Promise<boolean> {
  const ts = await loadTs();
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  // `parseDiagnostics` is not public but it is the standard way to detect
  // syntax errors without building a full Program.
  const diags = (sf as any).parseDiagnostics ?? [];
  return diags.length === 0;
}

/** Writes the edits to disk, or returns them as they are in dry-run. */
async function commit(
  edits: FileEdit[],
  options: EditOptions,
  summary: string
): Promise<EditResult> {
  // Syntax verification of ALL the files before touching any.
  for (const edit of edits) {
    if (!(await isParseable(edit.path, edit.content))) {
      return fail(
        `The edit would leave "${edit.path}" with invalid syntax — aborted, nothing written.`
      );
    }
  }

  if (options.apply) {
    const root = options.root ?? process.cwd();
    for (const edit of edits) writeFileSync(join(root, edit.path), edit.content);
  }

  return {
    ok: true,
    edits,
    applied: Boolean(options.apply),
    summary: options.apply ? summary : `${summary} (dry-run: nothing written)`,
  };
}

// ── Symbol location ─────────────────────────────────────────────────────────

interface DeclSite {
  path: string;
  /** Start and end offset of the complete declaration. */
  start: number;
  end: number;
  kind: string;
}

/** Finds the top-level declarations of `name` in the given files. */
async function findDeclarations(files: SourceFileInput[], name: string): Promise<DeclSite[]> {
  const ts = await loadTs();
  const out: DeclSite[] = [];

  for (const file of files) {
    const sf = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
      const push = (kind: string, node: any) =>
        out.push({ path: file.path, start: node.getStart(sf), end: node.getEnd(), kind });

      if (
        (ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt)) &&
        stmt.name?.text === name
      ) {
        push(ts.SyntaxKind[stmt.kind], stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) {
            // The declaration includes the whole `export const`.
            push("VariableStatement", stmt);
          }
        }
      }
    }
  }
  return out;
}

/** All identifiers with that name, per file (for renaming). */
async function findIdentifiers(
  files: SourceFileInput[],
  name: string
): Promise<Map<string, number[]>> {
  const ts = await loadTs();
  const byFile = new Map<string, number[]>();

  for (const file of files) {
    const sf = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const offsets: number[] = [];

    const visit = (node: any) => {
      // Only REAL AST identifiers: never strings or comments.
      if (ts.isIdentifier(node) && node.text === name) {
        // Do not rename the key of `{ foo: bar }` when foo is not the symbol.
        const parent = node.parent;
        const isPropertyKey =
          parent &&
          ts.isPropertyAssignment(parent) &&
          parent.name === node &&
          parent.initializer !== node;
        if (!isPropertyKey) offsets.push(node.getStart(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    if (offsets.length > 0) byFile.set(file.path, offsets);
  }
  return byFile;
}

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Renames a symbol and all its references, via AST.
 * Rejects if the symbol does not exist, is ambiguous, or the new name is already used.
 */
export async function renameSymbol(
  files: SourceFileInput[],
  oldName: string,
  newName: string,
  options: EditOptions = {}
): Promise<EditResult> {
  if (!VALID_IDENT.test(newName)) {
    return fail(`"${newName}" is not a valid TypeScript identifier.`);
  }
  if (oldName === newName) return fail("The new name is the same as the current one.");

  const decls = await findDeclarations(files, oldName);
  if (decls.length === 0) return fail(`No declaration found for "${oldName}".`);
  if (decls.length > 1) {
    const where = decls.map((d) => d.path).join(", ");
    return fail(
      `"${oldName}" is declared in ${decls.length} places (${where}) — ambiguous, not renamed.`
    );
  }

  // Collision: the new name already exists as a declaration.
  const clash = await findDeclarations(files, newName);
  if (clash.length > 0) {
    return fail(`"${newName}" is already declared in ${clash[0].path} — collision.`);
  }

  const hits = await findIdentifiers(files, oldName);
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const edits: FileEdit[] = [];

  for (const [path, offsets] of hits) {
    const content = byPath.get(path)!;
    // From back to front: the earlier offsets do not shift.
    let next = content;
    for (const off of [...offsets].sort((a, b) => b - a)) {
      next = next.slice(0, off) + newName + next.slice(off + oldName.length);
    }
    edits.push({ path, occurrences: offsets.length, content: next });
  }

  const total = edits.reduce((n, e) => n + e.occurrences, 0);
  return commit(
    edits.sort((a, b) => a.path.localeCompare(b.path)),
    options,
    `Renamed "${oldName}" → "${newName}": ${total} references in ${edits.length} files`
  );
}

/**
 * Replaces the complete declaration of a symbol with new code.
 * The replacement must be the entire declaration (`export function x() {...}`).
 */
export async function replaceSymbolBody(
  files: SourceFileInput[],
  name: string,
  replacement: string,
  options: EditOptions = {}
): Promise<EditResult> {
  const decls = await findDeclarations(files, name);
  if (decls.length === 0) return fail(`Declaration not found for "${name}".`);
  if (decls.length > 1) {
    return fail(`"${name}" is declared in ${decls.length} places — ambiguous, not replaced.`);
  }

  const decl = decls[0];
  const content = files.find((f) => f.path === decl.path)!.content;
  const next = content.slice(0, decl.start) + replacement.trimEnd() + content.slice(decl.end);

  return commit(
    [{ path: decl.path, occurrences: 1, content: next }],
    options,
    `Replaced the body of "${name}" in ${decl.path}`
  );
}

/**
 * Deletes a symbol — ONLY if nobody references it outside its declaration.
 * It is the guarantee that makes automatic dead-code cleanup safe.
 */
export async function safeDeleteSymbol(
  files: SourceFileInput[],
  name: string,
  options: EditOptions = {}
): Promise<EditResult> {
  const decls = await findDeclarations(files, name);
  if (decls.length === 0) return fail(`Declaration not found for "${name}".`);
  if (decls.length > 1) {
    return fail(`"${name}" is declared in ${decls.length} places — ambiguous, not deleted.`);
  }

  const decl = decls[0];
  const hits = await findIdentifiers(files, name);

  // References outside the declaration's range = it is in use.
  const external: string[] = [];
  for (const [path, offsets] of hits) {
    for (const off of offsets) {
      const insideDecl = path === decl.path && off >= decl.start && off < decl.end;
      if (!insideDecl) external.push(`${path}:${off}`);
    }
  }
  if (external.length > 0) {
    return fail(
      `"${name}" has ${external.length} active references (e.g. ${external[0]}) — not deleted.`
    );
  }

  const content = files.find((f) => f.path === decl.path)!.content;
  // Consume the whole line and the line break that follows it.
  let start = decl.start;
  while (start > 0 && content[start - 1] !== "\n") start--;
  let end = decl.end;
  while (end < content.length && content[end] !== "\n") end++;
  if (end < content.length) end++;

  const next = content.slice(0, start) + content.slice(end);
  return commit(
    [{ path: decl.path, occurrences: 1, content: next }],
    options,
    `Deleted "${name}" from ${decl.path} (no active references)`
  );
}

/** Inserts code right before a symbol's declaration. */
export async function insertBeforeSymbol(
  files: SourceFileInput[],
  name: string,
  code: string,
  options: EditOptions = {}
): Promise<EditResult> {
  const decls = await findDeclarations(files, name);
  if (decls.length === 0) return fail(`Declaration not found for "${name}".`);
  if (decls.length > 1) {
    return fail(`"${name}" is declared in ${decls.length} places — ambiguous.`);
  }

  const decl = decls[0];
  const content = files.find((f) => f.path === decl.path)!.content;
  let start = decl.start;
  while (start > 0 && content[start - 1] !== "\n") start--;

  const next = content.slice(0, start) + `${code.trimEnd()}\n\n` + content.slice(start);
  return commit(
    [{ path: decl.path, occurrences: 1, content: next }],
    options,
    `Inserted code before "${name}" in ${decl.path}`
  );
}

// ── Helper to load the repo files ─────────────────────────────────────────────

/** Reads the given files (relative paths) from the root. */
export function loadFiles(root: string, paths: string[]): SourceFileInput[] {
  const out: SourceFileInput[] = [];
  for (const path of paths) {
    try {
      out.push({ path, content: readFileSync(join(root, path), "utf8") });
    } catch {
      // skipped: unreadable file
    }
  }
  return out;
}
