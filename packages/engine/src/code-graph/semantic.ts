/**
 * Kitsuden — Code Graph: Semantic symbol search
 * ============================================================================
 *
 * "Search by meaning, not by regex". Complements `searchCode` (exact) with
 * embedding-similarity search over the already-indexed symbols.
 *
 * DESIGN: the engine is NOT coupled to the embedding provider or to the DB — the
 * host injects an `EmbeddingProvider` (same philosophy as `SystemMapDatabase`
 * or `WikiAuthor`). That way the module is testable in memory and works with
 * OpenAI, Ollama or a local engine without changing a line here.
 *
 * CLEAN DEGRADATION: without a provider, `semanticSearch` falls back to a deterministic
 * lexical ranking (name + context) and never throws. Search keeps working,
 * just without the "by meaning" part.
 */

import type { CodeGraph, CodeSymbol, SourceFileInput } from "./indexer";

// ── Provider contract (injected by the host) ───────────────────────────────────

export interface CodeEmbeddingProvider {
  /** Returns one vector per text, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface SemanticHit {
  symbol: CodeSymbol;
  /** 0..1 — higher is more relevant. */
  score: number;
  /** Fragment of the symbol's code, to show in results. */
  snippet: string;
  /** "semantic" (embeddings) or "lexical" (deterministic fallback). */
  mode: "semantic" | "lexical";
}

export interface SemanticIndex {
  /** Document per symbol: signature + context, ready to embed. */
  documents: { symbol: CodeSymbol; text: string }[];
  /** Vectors aligned with `documents` (empty if there was no provider). */
  vectors: number[][];
}

export interface BuildIndexOptions {
  /** Maximum symbols to index (default 2000). */
  maxSymbols?: number;
  /** Exported symbols only (default true: the public API is what matters). */
  exportedOnly?: boolean;
}

// ── Building the per-symbol document ───────────────────────────────────────────

/**
 * Text representing a symbol for semantic search: its signature plus the
 * following lines. It is what a human would read to know "what does this do".
 */
function symbolDocument(symbol: CodeSymbol, source: string, contextLines = 6): string {
  const lines = source.split("\n");
  const start = symbol.line - 1;
  const body = lines.slice(start, start + contextLines).join("\n");
  // The name goes first and split into words so that it weighs in the embedding:
  // "buildSystemMap" → "build System Map".
  const spaced = symbol.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return `${symbol.kind} ${symbol.name} (${spaced}) in ${symbol.file}\n${body}`;
}

/**
 * Builds the graph's semantic index. If no provider is passed, it leaves
 * `vectors` empty and search will use the lexical ranking.
 */
export async function buildSemanticIndex(
  graph: CodeGraph,
  files: SourceFileInput[],
  provider?: CodeEmbeddingProvider,
  options: BuildIndexOptions = {}
): Promise<SemanticIndex> {
  const maxSymbols = options.maxSymbols ?? 2000;
  const exportedOnly = options.exportedOnly ?? true;

  const sourceByPath = new Map(files.map((f) => [f.path, f.content]));

  const picked = graph.symbols
    .filter((s) => (exportedOnly ? s.exported : true))
    .filter((s) => sourceByPath.has(s.file))
    // Deterministic order before truncating.
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, maxSymbols);

  const documents = picked.map((symbol) => ({
    symbol,
    text: symbolDocument(symbol, sourceByPath.get(symbol.file)!),
  }));

  if (!provider || documents.length === 0) {
    return { documents, vectors: [] };
  }

  const vectors = await provider.embed(documents.map((d) => d.text));
  return { documents, vectors };
}

// ── Similarity ────────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Deterministic lexical ranking: fallback when there are no embeddings.
 * Weights a name match above a match in the body.
 */
function lexicalScore(query: string, doc: { symbol: CodeSymbol; text: string }): number {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  const name = doc.symbol.name.toLowerCase();
  const text = doc.text.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (name === term) score += 1;
    else if (name.includes(term)) score += 0.6;
    if (text.includes(term)) score += 0.15;
  }
  return Math.min(score / terms.length, 1);
}

/**
 * Searches symbols by meaning. With `provider` it uses embeddings; without it, it falls back to
 * the deterministic lexical ranking (never throws).
 */
export async function semanticSearch(
  index: SemanticIndex,
  query: string,
  provider?: CodeEmbeddingProvider,
  limit = 10
): Promise<SemanticHit[]> {
  if (index.documents.length === 0) return [];

  const snippetOf = (text: string) => text.split("\n").slice(1, 4).join("\n").trim().slice(0, 300);

  // Semantic path: requires a provider AND already-computed vectors.
  if (provider && index.vectors.length === index.documents.length) {
    const [queryVector] = await provider.embed([query]);
    if (queryVector && queryVector.some((v) => v !== 0)) {
      return index.documents
        .map((doc, i) => ({
          symbol: doc.symbol,
          score: cosine(queryVector, index.vectors[i]),
          snippet: snippetOf(doc.text),
          mode: "semantic" as const,
        }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id))
        .slice(0, limit);
    }
  }

  // Lexical fallback (also covers the zero vector of a provider without an API key).
  return index.documents
    .map((doc) => ({
      symbol: doc.symbol,
      score: lexicalScore(query, doc),
      snippet: snippetOf(doc.text),
      mode: "lexical" as const,
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id))
    .slice(0, limit);
}
