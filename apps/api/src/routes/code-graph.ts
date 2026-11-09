/**
 * Code Graph — Routes (system function, no AI)
 * ============================================================================
 *
 * Semantic code navigation for agents and humans:
 *
 *   GET /api/code-graph                     → summary (god nodes, clusters)
 *   GET /api/code-graph?full=true           → full graph
 *   GET /api/code-graph/symbol/:name        → find_symbol + references
 *   GET /api/code-graph/outline?file=...    → skeleton of a file
 *   GET /api/code-graph/path?from=&to=      → path between two nodes
 *   GET /api/code-graph/search?q=...        → structured regex search
 *   GET /api/code-graph/history?path=&grep= → commits (search/history)
 *   GET /api/code-graph/commit/:sha         → detail of a commit
 *   GET /api/code-graph/visualize           → interactive graph (HTML)
 *   GET /api/code-graph/semantic?q=...      → search by meaning
 *   POST /api/code-graph/edit/:op           → refactor (rename/replace/delete)
 *
 * The index is built lazily and cached in memory; `?refresh=true` rebuilds
 * it. Like every /api/* route, it respects TOON negotiation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  indexRepo,
  findSymbol,
  references,
  outline,
  pathBetween,
  communities,
  commitSearch,
  fileHistory,
  commitShow,
  searchCode,
  renderGraphHtml,
  renameSymbol,
  replaceSymbolBody,
  safeDeleteSymbol,
  insertBeforeSymbol,
  buildSemanticIndex,
  semanticSearch,
  type CodeGraph,
  type SourceFileInput,
  type CodeEmbeddingProvider,
  type SemanticIndex,
} from "@kitsuden/engine";
import { Hono } from "hono";

import { protectRoute, requireAdmin } from "../middleware/auth-guard";

const app = new Hono();

const ROOT = process.cwd();

let cached: { graph: CodeGraph; builtAt: string } | null = null;
let building: Promise<CodeGraph> | null = null;

async function getGraph(refresh = false): Promise<CodeGraph> {
  if (cached && !refresh) return cached.graph;
  if (!building) {
    building = indexRepo(ROOT).then((graph) => {
      cached = { graph, builtAt: new Date().toISOString() };
      building = null;
      return graph;
    });
  }
  return building;
}

/** Loads the content of the graph's files (for search). */
function loadFiles(graph: CodeGraph): SourceFileInput[] {
  const out: SourceFileInput[] = [];
  for (const f of graph.files) {
    try {
      out.push({ path: f.path, content: readFileSync(join(ROOT, f.path), "utf8") });
    } catch {
      // omitted
    }
  }
  return out;
}

app.get("/", protectRoute, async (c) => {
  const refresh = c.req.query("refresh") === "true";
  const graph = await getGraph(refresh);
  if (c.req.query("full") === "true") return c.json(graph);
  return c.json({
    builtAt: cached?.builtAt,
    summary: graph.summary,
    communities: communities(graph),
  });
});

app.get("/symbol/:name", protectRoute, async (c) => {
  const graph = await getGraph();
  const name = c.req.param("name");
  const matches = findSymbol(graph, name);
  if (matches.length === 0) {
    return c.json({ error: { code: "NOT_FOUND", message: `Symbol "${name}" not found` } }, 404);
  }
  return c.json({ matches, references: references(graph, name) });
});

app.get("/outline", protectRoute, async (c) => {
  const file = c.req.query("file");
  if (!file) return c.json({ error: { code: "VALIDATION", message: "Missing ?file=" } }, 400);
  const graph = await getGraph();
  const result = outline(graph, file);
  if (!result) {
    return c.json({ error: { code: "NOT_FOUND", message: `File "${file}" not indexed` } }, 404);
  }
  return c.json(result);
});

app.get("/path", protectRoute, async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ error: { code: "VALIDATION", message: "Missing ?from= and ?to=" } }, 400);
  }
  const graph = await getGraph();
  const path = pathBetween(graph, from, to);
  if (!path) {
    return c.json({ error: { code: "NOT_FOUND", message: "No path between those nodes" } }, 404);
  }
  return c.json({ from, to, hops: path.length - 1, path });
});

app.get("/search", protectRoute, async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: { code: "VALIDATION", message: "Missing ?q=" } }, 400);
  const graph = await getGraph();
  const hits = searchCode(loadFiles(graph), q, {
    regex: c.req.query("regex") !== "false",
    caseSensitive: c.req.query("case") === "true",
    maxResults: Math.min(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 200),
  });
  return c.json({ query: q, total: hits.length, hits });
});

app.get("/history", protectRoute, (c) => {
  const path = c.req.query("path");
  const grep = c.req.query("grep");
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const commits =
    path && !grep
      ? fileHistory(ROOT, path, limit)
      : commitSearch(ROOT, { grep, path, limit, author: c.req.query("author") });
  return c.json({ total: commits.length, commits });
});

app.get("/commit/:sha", protectRoute, (c) => {
  const detail = commitShow(ROOT, c.req.param("sha"));
  if (!detail) {
    return c.json({ error: { code: "NOT_FOUND", message: "Commit not found" } }, 404);
  }
  return c.json(detail);
});

// ═══════════════════════════════════════════════════════════════════════════
// VISUALIZATION — force-directed graph, self-contained HTML (no CDN)
// ═══════════════════════════════════════════════════════════════════════════

app.get("/visualize", protectRoute, async (c) => {
  const graph = await getGraph(c.req.query("refresh") === "true");
  const html = renderGraphHtml(graph, {
    title: c.req.query("title") ?? "Kitsuden Code Graph",
    maxNodes: Math.min(Number.parseInt(c.req.query("nodes") ?? "150", 10) || 150, 400),
    includeSymbols: c.req.query("symbols") === "true",
  });
  return c.html(html);
});

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC SEARCH — "by meaning", not by regex
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Embeddings provider injected from @kitsuden/core (vector-search).
 * Without OPENAI_API_KEY, `generateEmbeddings` returns zero vectors and
 * `semanticSearch` automatically falls back to the deterministic lexical ranking.
 */
async function embeddingProvider(): Promise<CodeEmbeddingProvider | undefined> {
  try {
    const mod: any = await import("../../../../packages/core/vector-search/embeddings");
    if (!mod.isEmbeddingAvailable?.()) return undefined;
    return { embed: (texts: string[]) => mod.generateEmbeddings(texts) };
  } catch {
    return undefined; // vector-search not available → lexical fallback
  }
}

let semanticIndex: SemanticIndex | null = null;

app.get("/semantic", protectRoute, async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: { code: "VALIDATION", message: "Missing ?q=" } }, 400);

  const graph = await getGraph();
  const provider = await embeddingProvider();

  // The index is built once (embedding ~2k symbols is expensive).
  if (!semanticIndex || c.req.query("refresh") === "true") {
    semanticIndex = await buildSemanticIndex(graph, loadFiles(graph), provider, {
      exportedOnly: c.req.query("all") !== "true",
    });
  }

  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "10", 10) || 10, 50);
  const hits = await semanticSearch(semanticIndex, q, provider, limit);

  return c.json({
    query: q,
    mode: hits[0]?.mode ?? (provider ? "semantic" : "lexical"),
    indexed: semanticIndex.documents.length,
    total: hits.length,
    hits,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC EDITING — symbol-level refactor
//
// SECURITY: requires ADMIN (it modifies the server's source code) and it is
// a dry run unless `apply: true` is explicit in the body. The engine also verifies
// that the result is still syntactically valid before writing.
// ═══════════════════════════════════════════════════════════════════════════

app.post("/edit/:op", protectRoute, requireAdmin, async (c) => {
  const op = c.req.param("op");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const { name, newName, code, apply } = body as Record<string, string | boolean>;

  if (typeof name !== "string" || !name) {
    return c.json({ error: { code: "VALIDATION", message: "Missing 'name'" } }, 400);
  }

  const graph = await getGraph();
  const files = loadFiles(graph);
  const opts = { apply: apply === true, root: ROOT };

  let result;
  switch (op) {
    case "rename":
      if (typeof newName !== "string" || !newName) {
        return c.json({ error: { code: "VALIDATION", message: "Missing 'newName'" } }, 400);
      }
      result = await renameSymbol(files, name, newName, opts);
      break;
    case "replace":
      if (typeof code !== "string" || !code) {
        return c.json({ error: { code: "VALIDATION", message: "Missing 'code'" } }, 400);
      }
      result = await replaceSymbolBody(files, name, code, opts);
      break;
    case "delete":
      result = await safeDeleteSymbol(files, name, opts);
      break;
    case "insert-before":
      if (typeof code !== "string" || !code) {
        return c.json({ error: { code: "VALIDATION", message: "Missing 'code'" } }, 400);
      }
      result = await insertBeforeSymbol(files, name, code, opts);
      break;
    default:
      return c.json(
        {
          error: {
            code: "VALIDATION",
            message: `Operation "${op}" unknown. Use: rename|replace|delete|insert-before`,
          },
        },
        400
      );
  }

  // An applied edit invalidates the in-memory indexes.
  if (result.applied) {
    cached = null;
    semanticIndex = null;
  }

  return c.json(result, result.ok ? 200 : 409);
});

export const codeGraphRoutes = app;
