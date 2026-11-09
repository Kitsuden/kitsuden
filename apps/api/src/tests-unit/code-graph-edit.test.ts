/**
 * Code Graph — Semantic editing (deterministic tests, no disk or network)
 * ============================================================================
 * These operations MODIFY source code, so the three safety
 * guarantees are tested explicitly:
 *   1. dry-run by default (never writes without `apply: true`)
 *   2. rejection on ambiguity / collision / live references
 *   3. syntax check before writing (all-or-nothing)
 */

import {
  renameSymbol,
  replaceSymbolBody,
  safeDeleteSymbol,
  insertBeforeSymbol,
  buildSemanticIndex,
  semanticSearch,
  indexFiles,
  type SourceFileInput,
  type CodeEmbeddingProvider,
} from "@kitsuden/engine";
import { describe, expect, test } from "bun:test";

const FIXTURES: SourceFileInput[] = [
  {
    path: "src/mailer.ts",
    content: [
      `export function sendMail(to: string): void {`,
      `  formatAddress(to);`,
      `}`,
      ``,
      `function formatAddress(raw: string): string {`,
      `  return raw.trim();`,
      `}`,
      ``,
      `// "sendMail" in a comment must NOT be renamed`,
      `const NOTE = "call sendMail here";`,
      ``,
      `export function unusedHelper(): number {`,
      `  return 42;`,
      `}`,
    ].join("\n"),
  },
  {
    path: "src/notify.ts",
    content: [
      `import { sendMail } from "./mailer";`,
      ``,
      `export function notify(to: string) {`,
      `  sendMail(to);`,
      `}`,
    ].join("\n"),
  },
];

describe("renameSymbol", () => {
  test("renames the declaration and all its references (dry-run)", async () => {
    const r = await renameSymbol(FIXTURES, "sendMail", "dispatchMail");
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false); // dry-run by default
    expect(r.edits.length).toBe(2); // mailer + notify

    const mailer = r.edits.find((e) => e.path === "src/mailer.ts")!;
    expect(mailer.content).toContain("export function dispatchMail");
    const notify = r.edits.find((e) => e.path === "src/notify.ts")!;
    expect(notify.content).toContain("import { dispatchMail }");
    expect(notify.content).toContain("dispatchMail(to)");
  });

  test("does NOT touch strings or comments (uses AST, not text)", async () => {
    const r = await renameSymbol(FIXTURES, "sendMail", "dispatchMail");
    const mailer = r.edits.find((e) => e.path === "src/mailer.ts")!;
    expect(mailer.content).toContain('"call sendMail here"'); // string intact
    expect(mailer.content).toContain('// "sendMail" in a comment'); // comment intact
  });

  test("rejects if the new name already exists (collision)", async () => {
    const r = await renameSymbol(FIXTURES, "sendMail", "formatAddress");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("collision");
    expect(r.edits).toEqual([]);
  });

  test("rejects an invalid identifier", async () => {
    const r = await renameSymbol(FIXTURES, "sendMail", "2bad-name");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is not a valid TypeScript identifier");
  });

  test("rejects if the symbol does not exist", async () => {
    const r = await renameSymbol(FIXTURES, "doesNotExist", "something");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No declaration found");
  });

  test("rejects if the symbol is ambiguous (declared in 2 places)", async () => {
    const dup: SourceFileInput[] = [
      { path: "a.ts", content: "export function dup(): void {}" },
      { path: "b.ts", content: "export function dup(): void {}" },
    ];
    const r = await renameSymbol(dup, "dup", "unique");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ambiguous");
  });
});

describe("safeDeleteSymbol", () => {
  test("deletes a symbol with no references", async () => {
    const r = await safeDeleteSymbol(FIXTURES, "unusedHelper");
    expect(r.ok).toBe(true);
    expect(r.edits[0].content).not.toContain("unusedHelper");
    // The rest of the file survives.
    expect(r.edits[0].content).toContain("sendMail");
  });

  test("REFUSES to delete a symbol with live references", async () => {
    const r = await safeDeleteSymbol(FIXTURES, "sendMail");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("active references");
    expect(r.edits).toEqual([]);
  });
});

describe("replaceSymbolBody", () => {
  test("replaces the whole declaration", async () => {
    const r = await replaceSymbolBody(
      FIXTURES,
      "formatAddress",
      "function formatAddress(raw: string): string {\n  return raw.trim().toLowerCase();\n}"
    );
    expect(r.ok).toBe(true);
    expect(r.edits[0].content).toContain("toLowerCase()");
    expect(r.edits[0].content).toContain("export function sendMail"); // does not touch the rest
  });

  test("ABORTS if the replacement leaves invalid syntax (all-or-nothing)", async () => {
    const r = await replaceSymbolBody(FIXTURES, "formatAddress", "function broken( {{{ ");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid syntax");
    expect(r.applied).toBe(false);
  });
});

describe("insertBeforeSymbol", () => {
  test("inserts code before the declaration", async () => {
    const r = await insertBeforeSymbol(FIXTURES, "sendMail", "/** Sends an email. */");
    expect(r.ok).toBe(true);
    const idxDoc = r.edits[0].content.indexOf("/** Sends an email. */");
    const idxFn = r.edits[0].content.indexOf("export function sendMail");
    expect(idxDoc).toBeGreaterThanOrEqual(0);
    expect(idxDoc).toBeLessThan(idxFn);
  });
});

describe("semantic search", () => {
  test("without a provider it falls back to the deterministic lexical ranking", async () => {
    const graph = await indexFiles(FIXTURES);
    const index = await buildSemanticIndex(graph, FIXTURES);
    expect(index.vectors).toEqual([]);

    const hits = await semanticSearch(index, "send mail");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].mode).toBe("lexical");
    expect(hits[0].symbol.name).toBe("sendMail");
  });

  test("with a provider it uses embeddings and orders by similarity", async () => {
    // Deterministic provider: vector by character frequency.
    const provider: CodeEmbeddingProvider = {
      embed: async (texts) =>
        texts.map((t) => {
          const v = new Array(26).fill(0);
          for (const ch of t.toLowerCase()) {
            const i = ch.charCodeAt(0) - 97;
            if (i >= 0 && i < 26) v[i]++;
          }
          return v;
        }),
    };

    const graph = await indexFiles(FIXTURES);
    const index = await buildSemanticIndex(graph, FIXTURES, provider);
    expect(index.vectors.length).toBe(index.documents.length);

    const hits = await semanticSearch(index, "sendMail dispatch email", provider);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].mode).toBe("semantic");
    // Sorted descending by score.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  test("only indexes exported symbols by default", async () => {
    const graph = await indexFiles(FIXTURES);
    const index = await buildSemanticIndex(graph, FIXTURES);
    const names = index.documents.map((d) => d.symbol.name);
    expect(names).toContain("sendMail"); // exported
    expect(names).not.toContain("formatAddress"); // local
  });
});
