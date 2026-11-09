/**
 * KITSUDEN Brain — Knowledge Graph Builder
 *
 * Builds a nodes-and-edges graph from brain notes and connections.
 * Suitable for visualization and for LLM context.
 */

import type {
  BrainConnectionInput,
  BrainNote,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
} from "./types";

export interface BuildGraphOptions {
  /** Group nodes by category. */
  groupByCategory?: boolean;
  /** Include isolated notes as nodes. */
  includeOrphans?: boolean;
}

function noteToNode(note: BrainNote): KnowledgeGraphNode {
  return {
    id: note.id,
    label: note.title,
    type: note.category,
    group: note.category,
    importance: note.importance,
    metadata: {
      source: note.source,
      sourcePath: note.sourcePath,
      tags: note.tags,
      confidence: note.confidence,
    },
  };
}

/**
 * Build a knowledge graph from notes and connections.
 */
export function buildKnowledgeGraph(
  notes: BrainNote[],
  connections: BrainConnectionInput[],
  options: BuildGraphOptions = {}
): KnowledgeGraph {
  const includeOrphans = options.includeOrphans ?? true;

  const nodeIds = new Set<string>();
  const nodes: KnowledgeGraphNode[] = [];

  for (const note of notes) {
    nodeIds.add(note.id);
    nodes.push(noteToNode(note));
  }

  const edges: KnowledgeGraphEdge[] = [];
  for (const c of connections) {
    if (!nodeIds.has(c.sourceNoteId) || !nodeIds.has(c.targetNoteId)) continue;
    edges.push({
      source: c.sourceNoteId,
      target: c.targetNoteId,
      relation: c.relationType ?? "related",
      strength: c.strength ?? 0.5,
    });
  }

  if (!includeOrphans) {
    const connectedIds = new Set<string>();
    for (const e of edges) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
    const filteredNodes = nodes.filter((n) => connectedIds.has(n.id));
    return {
      nodes: filteredNodes,
      edges,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Filter a graph to a neighborhood around a starting note.
 */
export function neighborhoodGraph(
  graph: KnowledgeGraph,
  startId: string,
  depth = 1
): KnowledgeGraph {
  const nodeSet = new Set<string>();
  nodeSet.add(startId);

  let currentIds = new Set<string>([startId]);
  for (let d = 0; d < depth; d++) {
    const nextIds = new Set<string>();
    for (const edge of graph.edges) {
      if (currentIds.has(edge.source)) nextIds.add(edge.target);
      if (currentIds.has(edge.target)) nextIds.add(edge.source);
    }
    for (const id of nextIds) nodeSet.add(id);
    currentIds = nextIds;
  }

  return {
    nodes: graph.nodes.filter((n) => nodeSet.has(n.id)),
    edges: graph.edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target)),
    generatedAt: new Date().toISOString(),
  };
}
