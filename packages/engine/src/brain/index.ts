/**
 * KITSUDEN Brain — Self-Aware Knowledge Engine
 *
 * Organizes notes and ideas, discovers connections, and keeps the project's
 * knowledge base updated automatically. Inspired by the Karpathy method:
 * instead of asking a bot questions, the system watches, connects and writes.
 *
 * Public API:
 *   - initKitsudenBrain(config)      Start scanner + optional file watcher
 *   - shutdownKitsudenBrain()        Stop watchers
 *   - scanProjectKnowledge()    One-shot deterministic scan
 *   - getBrainIndex()           Stats and status
 */

import { eq, and } from "drizzle-orm";

import { brainNotes } from "../../../../apps/api/src/db/schema-core";
import { messageOf } from "../errors";

import { discoverConnections } from "./connections";
import { buildKnowledgeGraph, neighborhoodGraph } from "./knowledge-graph";
import { generateLlms } from "./llms";
import {
  upsertBrainNote,
  listBrainNotes,
  createBrainConnection,
  listBrainConnections,
  deleteBrainNote,
  searchSimilarBrainNotes,
  getBrainNote,
  type BrainDb,
} from "./notes";
import { scanProject } from "./scanner";
import type {
  BrainConfig,
  BrainNote,
  BrainNoteInput,
  BrainScanResult,
  KnowledgeGraph,
  BrainIndex,
} from "./types";
import { watchPaths } from "./watcher";
import { generateWiki } from "./wiki";

export * from "./types";
export * from "./embeddings";
export * from "./scanner";
export * from "./connections";
export * from "./knowledge-graph";
export { generateWiki } from "./wiki";
export * from "./memory";
export * from "./graphify";
export { generateLlms } from "./llms";

// ── Second Brain (Karpathy method): sources / author / operations / schema ──
export {
  captureSource,
  listSources,
  getSource,
  deleteSource,
  hashContent,
  type BrainSource,
  type BrainSourceInput,
  type BrainSourceType,
} from "./sources";

// ── Tree index: retrieval by reasoning (2nd layer, alongside the vector) ──
export {
  buildContentTree,
  retrieveFromTree,
  renderIndex,
  readNode,
  findNode,
  pathOf,
  type ContentTree,
  type TreeNode,
  type TreePath,
  type BranchSelector,
  type RetrieveOptions,
  type RetrievedSection,
} from "./content-tree";
import { eqEnum } from "../db-conditions";
export {
  extractSignals,
  summarize,
  keywords,
  headings,
  links,
  suggestBacklinks,
  type ExtractionResult,
} from "./extraction";
export {
  resolveAuthor,
  createInstructionAuthor,
  createApiAuthor,
  createCliAuthor,
  buildAuthorPrompt,
  type WikiAuthor,
  type AuthorTask,
  type AuthorResult,
  type AuthorMode,
} from "./author";
export {
  capture,
  sync as syncBrain,
  lint,
  digest,
  type CaptureResult,
  type SyncResult,
  type LintReport,
  type DigestResult,
} from "./operations";
export { generateBrainSchemaDoc, type BrainSchemaOptions } from "./schema-doc";
export {
  upsertBrainNote,
  listBrainNotes,
  createBrainConnection,
  listBrainConnections,
  deleteBrainNote,
  searchSimilarBrainNotes,
  getBrainNote,
};

interface BrainRuntime {
  db: BrainDb;
  config: Required<BrainConfig>;
  stopWatcher?: () => void;
  lastScanAt?: string;
}

let runtime: BrainRuntime | null = null;

function resolveConfig(config: BrainConfig = {}): Required<BrainConfig> {
  const root = config.projectRoot ?? process.cwd();
  return {
    watch: config.watch ?? false,
    watchPaths: config.watchPaths ?? [
      `${root}/apps/api/src`,
      `${root}/packages/engine/src`,
      `${root}/packages/kons`,
    ],
    debounceMs: config.debounceMs ?? 3000,
    embeddingDimensions: config.embeddingDimensions ?? 384,
    connectionThreshold: config.connectionThreshold ?? 0.25,
    maxConnectionsPerNote: config.maxConnectionsPerNote ?? 5,
    wikiPath: config.wikiPath ?? `${root}/.kitsuden/brain`,
    llmsPath: config.llmsPath ?? root,
    projectRoot: root,
  };
}

async function countExistingByPath(
  db: BrainDb,
  sourcePath: string,
  category: string
): Promise<number> {
  const rows = await db
    .select({ id: brainNotes.id })
    .from(brainNotes)
    .where(and(eq(brainNotes.sourcePath, sourcePath), eqEnum(brainNotes.category, category)))
    .limit(1);
  return rows.length;
}

/**
 * Scan the project, convert entities into notes, discover connections,
 * and regenerate wiki + llms.txt.
 */
export async function scanProjectKnowledge(
  db: BrainDb,
  config?: BrainConfig
): Promise<BrainScanResult> {
  const cfg = resolveConfig(config);
  const result: BrainScanResult = {
    notesCreated: 0,
    notesUpdated: 0,
    connectionsFound: 0,
    errors: [],
  };

  try {
    const entities = await scanProject({ root: cfg.projectRoot });

    // Upsert notes
    for (const entity of entities) {
      try {
        const existed = entity.sourcePath
          ? (await countExistingByPath(db, entity.sourcePath, entity.category)) > 0
          : false;

        await upsertBrainNote(db, {
          title: entity.title,
          content: entity.content,
          source: "code",
          sourcePath: entity.sourcePath,
          category: entity.category,
          tags: entity.tags,
          importance: 50,
          confidence: 90,
          metadata: entity.metadata,
        });

        if (existed) result.notesUpdated++;
        else result.notesCreated++;
      } catch (err: unknown) {
        result.errors.push(`entity ${entity.id}: ${messageOf(err)}`);
      }
    }

    // Discover and persist connections
    const allNotes = await listBrainNotes(db, { limit: 10000 });
    const connections = discoverConnections(allNotes, {
      threshold: cfg.connectionThreshold,
      maxPerNote: cfg.maxConnectionsPerNote,
    });

    for (const conn of connections) {
      try {
        await createBrainConnection(db, conn);
        result.connectionsFound++;
      } catch (err: unknown) {
        result.errors.push(
          `connection ${conn.sourceNoteId}->${conn.targetNoteId}: ${messageOf(err)}`
        );
      }
    }

    // Generate artifacts
    const dbConnections = await listBrainConnections(db);
    const graph = buildKnowledgeGraph(allNotes, dbConnections, { includeOrphans: true });
    generateWiki({ wikiPath: cfg.wikiPath, notes: allNotes, graph });
    generateLlms({ projectRoot: cfg.llmsPath, notes: allNotes, graph });

    if (runtime) {
      runtime.lastScanAt = new Date().toISOString();
    }
  } catch (err: unknown) {
    result.errors.push(`scan failed: ${messageOf(err)}`);
  }

  return result;
}

/**
 * Initialize the Brain engine.
 */
export function initKitsudenBrain(db: BrainDb, config: BrainConfig = {}): BrainRuntime {
  if (runtime) return runtime;

  const cfg = resolveConfig(config);
  runtime = { db, config: cfg };

  if (cfg.watch) {
    runtime.stopWatcher = watchPaths({
      paths: cfg.watchPaths,
      debounceMs: cfg.debounceMs,
      recursive: true,
      onEvent: async () => {
        if (!runtime) return;
        await scanProjectKnowledge(runtime.db, runtime.config);
      },
    });
  }

  // Initial scan in background (non-blocking)
  scanProjectKnowledge(db, cfg).catch((err) => {
    console.warn("[KITSUDEN Brain] Initial scan failed:", messageOf(err));
  });

  return runtime;
}

/**
 * Stop filesystem watchers.
 */
export function shutdownKitsudenBrain(): void {
  if (runtime?.stopWatcher) {
    runtime.stopWatcher();
  }
  runtime = null;
}

/**
 * Get current status and index stats.
 */
export async function getBrainIndex(db: BrainDb): Promise<BrainIndex> {
  const notes = await listBrainNotes(db, { limit: 10000 });
  const connections = await listBrainConnections(db);
  const categories = new Set(notes.map((n) => n.category));
  return {
    collections: Array.from(categories),
    totalNotes: notes.length,
    totalConnections: connections.length,
    lastScanAt: runtime?.lastScanAt,
  };
}

/**
 * Build the full knowledge graph from the database.
 */
export async function getKnowledgeGraph(db: BrainDb): Promise<KnowledgeGraph> {
  const notes = await listBrainNotes(db, { limit: 10000 });
  const connections = await listBrainConnections(db);
  return buildKnowledgeGraph(notes, connections, { includeOrphans: true });
}

/**
 * Get the neighborhood graph around a note.
 */
export async function getBrainNeighborhood(
  db: BrainDb,
  noteId: string,
  depth = 1
): Promise<KnowledgeGraph> {
  const graph = await getKnowledgeGraph(db);
  return neighborhoodGraph(graph, noteId, depth);
}

/**
 * Add a user or agent note and immediately discover connections.
 */
export async function addBrainNoteWithConnections(
  db: BrainDb,
  input: BrainNoteInput,
  config?: BrainConfig
): Promise<{ note: BrainNote; suggestions: Array<{ noteId: string; strength: number }> }> {
  const cfg = resolveConfig(config);
  const note = await upsertBrainNote(db, input);
  const candidates = await listBrainNotes(db, { limit: 10000 });
  const { suggestConnections } = await import("./connections");
  const suggestions = suggestConnections(note, candidates, {
    limit: cfg.maxConnectionsPerNote,
    threshold: cfg.connectionThreshold,
  });

  for (const s of suggestions) {
    await createBrainConnection(db, {
      sourceNoteId: note.id,
      targetNoteId: s.noteId,
      relationType: "related",
      strength: s.strength,
    });
  }

  return { note, suggestions };
}
