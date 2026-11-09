/**
 * KITSUDEN Brain — Types
 *
 * Core data structures for the self-aware knowledge layer.
 */

export type BrainNoteSource = "code" | "user" | "agent" | "system" | "insight";

export type BrainNoteCategory =
  | "schema"
  | "route"
  | "kon"
  | "agent"
  | "function"
  | "dataset"
  | "insight"
  | "connection"
  | "general";

export interface BrainNoteInput {
  title: string;
  content: string;
  source?: BrainNoteSource;
  sourcePath?: string;
  category?: BrainNoteCategory;
  tags?: string[];
  embedding?: number[];
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  relatedNoteIds?: string[];
  /**
   * 0051. Legacy writers (scanner, panel) leave them out: the note has no
   * owner and is `shared` (project knowledge). Owner-aware writes go through
   * `writeMemoryNote` (memory.ts).
   */
  ownerUserId?: string | null;
  visibility?: "private" | "shared";
}

export interface BrainNote {
  id: string;
  title: string;
  content: string;
  source: BrainNoteSource;
  sourcePath: string | null;
  category: BrainNoteCategory;
  tags: string[];
  embedding: number[] | null;
  importance: number;
  confidence: number;
  metadata: Record<string, unknown>;
  relatedNoteIds: string[];
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
  sponsorUserId?: string | null;
  visibility?: string;
  noteKey?: string | null;
  embeddingKind?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BrainConnectionInput {
  sourceNoteId: string;
  targetNoteId: string;
  relationType?: string;
  strength?: number;
  metadata?: Record<string, unknown>;
  /**
   * 0051 provenance. Left out = INFERRED with confidence = strength (what
   * the scanner and the similarity suggestions are). The REST route that
   * creates one by hand passes MANUAL.
   */
  origin?: "EXTRACTED" | "INFERRED" | "MANUAL";
  confidence?: number;
}

export interface BrainConnection extends BrainConnectionInput {
  id: string;
  createdAt: Date;
}

export interface ScannedEntity {
  id: string;
  title: string;
  content: string;
  category: BrainNoteCategory;
  sourcePath?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: BrainNoteCategory | "note";
  group: string;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relation: string;
  strength: number;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  generatedAt: string;
}

export interface BrainScanResult {
  notesCreated: number;
  notesUpdated: number;
  connectionsFound: number;
  errors: string[];
}

export interface BrainConfig {
  /** Watch filesystem changes and auto-regenerate knowledge. */
  watch?: boolean;
  /** Directories to watch/scan. */
  watchPaths?: string[];
  /** Debounce interval in ms for filesystem events. */
  debounceMs?: number;
  /** Dimensions for local embeddings. */
  embeddingDimensions?: number;
  /** Minimum cosine similarity to consider two notes connected. */
  connectionThreshold?: number;
  /** Maximum automatic connections per note. */
  maxConnectionsPerNote?: number;
  /** Where to write the wiki. */
  wikiPath?: string;
  /** Where to write llms.txt and .llms/. */
  llmsPath?: string;
  /** Root of the project. */
  projectRoot?: string;
}

export interface EmbeddingProvider {
  dimensions: number;
  embed(text: string): Promise<number[]> | number[];
}

export interface BrainIndex {
  collections: string[];
  totalNotes: number;
  totalConnections: number;
  lastScanAt?: string;
}
