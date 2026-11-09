/**
 * Kitsuden — Code Graph
 * ============================================================================
 * Deterministic code graph (no AI): symbol indexer + semantic
 * navigation queries + git history. The advantages of Graphify, Serena and
 * Sourcegraph MCP as system functions.
 */

export {
  indexFiles,
  indexRepo,
  type SourceFileInput,
  type CodeSymbol,
  type CodeSymbolKind,
  type CodeGraph,
  type CodeGraphFile,
  type CodeGraphEdge,
  type CodeEdgeRelation,
  type IndexRepoOptions,
} from "./indexer";

export {
  findSymbol,
  references,
  outline,
  pathBetween,
  communities,
  searchCode,
  type SymbolMatch,
  type SymbolReferences,
  type FileOutline,
  type Community,
  type CodeSearchHit,
  type CodeSearchOptions,
} from "./queries";

export {
  commitSearch,
  fileHistory,
  commitShow,
  type CommitInfo,
  type CommitDetail,
  type CommitSearchOptions,
} from "./git-history";

// ── Interactive visualization (self-contained HTML, no CDN) ──
export { renderGraphHtml, type VisualizeOptions } from "./visualize";

// ── Semantic editing (dry-run by default) ──
export {
  renameSymbol,
  replaceSymbolBody,
  safeDeleteSymbol,
  insertBeforeSymbol,
  loadFiles,
  type FileEdit,
  type EditResult,
  type EditOptions,
} from "./edit";

// ── Semantic search by embeddings (injected provider) ──
export {
  buildSemanticIndex,
  semanticSearch,
  type CodeEmbeddingProvider,
  type SemanticHit,
  type SemanticIndex,
  type BuildIndexOptions,
} from "./semantic";
