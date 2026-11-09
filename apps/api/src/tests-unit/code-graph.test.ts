/**
 * Code Graph — Unit tests (100% deterministic, no disk or network)
 * ============================================================================
 * Indexes in-memory fixtures and verifies symbols, edges, navigation
 * queries (find/references/outline/path), clusters and search.
 */

import {
  indexFiles,
  findSymbol,
  references,
  outline,
  pathBetween,
  communities,
  searchCode,
  type SourceFileInput,
} from "@kitsuden/engine";
import { describe, expect, test } from "bun:test";

const FIXTURES: SourceFileInput[] = [
  {
    path: "packages/engine/src/mailer.ts",
    content: [
      `export interface MailOptions {`,
      `  to: string;`,
      `}`,
      ``,
      `export function sendMail(opts: MailOptions): void {`,
      `  formatAddress(opts.to);`,
      `}`,
      ``,
      `function formatAddress(raw: string): string {`,
      `  return raw.trim();`,
      `}`,
      ``,
      `export const MAILER_VERSION = "1.0";`,
    ].join("\n"),
  },
  {
    path: "apps/api/src/routes/notify.ts",
    content: [
      `import { sendMail } from "../../../../packages/engine/src/mailer";`,
      `import { Hono } from "hono";`,
      ``,
      `export const notify = (to: string) => {`,
      `  sendMail({ to });`,
      `};`,
      ``,
      `export class Notifier {`,
      `  run(to: string) {`,
      `    sendMail({ to });`,
      `  }`,
      `}`,
    ].join("\n"),
  },
  {
    path: "packages/kons/kon-demo/routes.ts",
    content: [`export type DemoConfig = { enabled: boolean };`].join("\n"),
  },
];

describe("code-graph indexer", () => {
  test("extracts symbols with kind, line and exported", async () => {
    const graph = await indexFiles(FIXTURES);

    const send = graph.symbols.find((s) => s.name === "sendMail");
    expect(send).toBeDefined();
    expect(send!.kind).toBe("function");
    expect(send!.exported).toBe(true);
    expect(send!.line).toBe(5);

    const fmt = graph.symbols.find((s) => s.name === "formatAddress");
    expect(fmt!.exported).toBe(false);

    const version = graph.symbols.find((s) => s.name === "MAILER_VERSION");
    expect(version!.kind).toBe("const");

    const iface = graph.symbols.find((s) => s.name === "MailOptions");
    expect(iface!.kind).toBe("interface");

    const cls = graph.symbols.find((s) => s.name === "Notifier");
    expect(cls!.kind).toBe("class");
  });

  test("resolves relative imports to known files", async () => {
    const graph = await indexFiles(FIXTURES);
    const importEdge = graph.edges.find(
      (e) =>
        e.relation === "imports" &&
        e.from === "apps/api/src/routes/notify.ts" &&
        e.to === "packages/engine/src/mailer.ts"
    );
    expect(importEdge).toBeDefined();
  });

  test("imports of external packages remain as pkg:", async () => {
    const graph = await indexFiles(FIXTURES);
    const pkgEdge = graph.edges.find((e) => e.relation === "imports" && e.to === "pkg:hono");
    expect(pkgEdge).toBeDefined();
  });

  test("detects calls: same file = direct, single cross-file = inferred", async () => {
    const graph = await indexFiles(FIXTURES);

    const local = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.from === "packages/engine/src/mailer.ts#sendMail" &&
        e.to === "packages/engine/src/mailer.ts#formatAddress"
    );
    expect(local).toBeDefined();
    expect(local!.confidence).toBe("direct");

    const cross = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.from === "apps/api/src/routes/notify.ts#notify" &&
        e.to === "packages/engine/src/mailer.ts#sendMail"
    );
    expect(cross).toBeDefined();
    expect(cross!.confidence).toBe("inferred");
  });

  test("is deterministic: same input, same output", async () => {
    const a = await indexFiles(FIXTURES);
    const b = await indexFiles([...FIXTURES].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("code-graph queries", () => {
  test("findSymbol: exact first, then prefix", async () => {
    const graph = await indexFiles(FIXTURES);
    const matches = findSymbol(graph, "sendMail");
    expect(matches[0].exact).toBe(true);
    expect(matches[0].file).toBe("packages/engine/src/mailer.ts");

    const prefix = findSymbol(graph, "MAIL");
    expect(prefix.some((m) => m.name === "MAILER_VERSION")).toBe(true);
  });

  test("references: who calls and who imports", async () => {
    const graph = await indexFiles(FIXTURES);
    const [refs] = references(graph, "sendMail");
    expect(refs.calledBy.map((c) => c.id)).toContain("apps/api/src/routes/notify.ts#notify");
    expect(refs.calledBy.map((c) => c.id)).toContain("apps/api/src/routes/notify.ts#Notifier");
    expect(refs.importedBy).toContain("apps/api/src/routes/notify.ts");
  });

  test("outline: symbols sorted by line", async () => {
    const graph = await indexFiles(FIXTURES);
    const o = outline(graph, "packages/engine/src/mailer.ts");
    expect(o).not.toBeNull();
    expect(o!.symbols.map((s) => s.name)).toEqual([
      "MailOptions",
      "sendMail",
      "formatAddress",
      "MAILER_VERSION",
    ]);
  });

  test("pathBetween: connects symbol to symbol across files", async () => {
    const graph = await indexFiles(FIXTURES);
    const path = pathBetween(graph, "Notifier", "formatAddress");
    expect(path).not.toBeNull();
    expect(path![0]).toBe("apps/api/src/routes/notify.ts#Notifier");
    expect(path![path!.length - 1]).toBe("packages/engine/src/mailer.ts#formatAddress");
  });

  test("pathBetween: null if the node does not exist", async () => {
    const graph = await indexFiles(FIXTURES);
    expect(pathBetween(graph, "doesNotExist", "sendMail")).toBeNull();
  });

  test("communities: groups by package and kon", async () => {
    const graph = await indexFiles(FIXTURES);
    const groups = communities(graph).map((c) => c.group);
    expect(groups).toContain("packages/engine");
    expect(groups).toContain("apps/api");
    expect(groups).toContain("packages/kons/kon-demo");
  });

  test("searchCode: hits with file and line", async () => {
    const hits = searchCode(FIXTURES, "sendMail\\(", { maxResults: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].file).toBe("apps/api/src/routes/notify.ts");
    expect(hits.every((h) => h.line > 0)).toBe(true);
  });

  test("searchCode: invalid regex degrades to literal", async () => {
    const hits = searchCode(FIXTURES, "sendMail(", {});
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test("god nodes: sendMail among the most connected", async () => {
    const graph = await indexFiles(FIXTURES);
    const ids = graph.summary.godNodes.map((g) => g.id);
    expect(ids).toContain("packages/engine/src/mailer.ts#sendMail");
  });
});
