/**
 * Brain Types
 * Types for the Brain knowledge system
 */

export interface BrainNote {
  id: string;
  title: string;
  content: string;
  source: string;
  sourcePath: string | null;
  category: string;
  tags: string[];
  importance: number;
  confidence: number;
  metadata?: Record<string, any>;
  relatedNoteIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: string;
  group: string;
  importance?: number;
  metadata?: {
    source: string;
    sourcePath: string | null;
    tags: string[];
    confidence: number;
  };
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

export interface BrainStatus {
  totalNotes: number;
  totalConnections: number;
  collections?: string[];
  lastScanAt?: string;
}

export interface BrainNeighborhood {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  centerId: string;
  depth: number;
}

/** `GET /api/brain/wiki`: where the generated wiki is on the server's disk. */
export interface BrainWiki {
  path: string;
  index: string;
}
