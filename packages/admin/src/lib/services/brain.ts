/**
 * Brain Service
 * Service to interact with the Brain API (apps/api/src/routes/brain.ts)
 *
 * The answers are read as the API sends them, not as this file once assumed:
 *
 *   GET /notes                    → `{ notes }`               (was read as a bare array: the
 *                                                              list always came out empty)
 *   GET /notes/:id                → `{ note, connections }`   (was read as the note itself:
 *                                                              every field was undefined)
 *   GET /graph/:id/neighborhood   → a graph, with no `centerId` or `depth`
 *   GET /wiki                     → `{ path, index }`
 *   importance, confidence        → integers 0–100 (columns of `brain_notes`); the panel
 *                                   draws them as a 0–1 fraction, so "80" became "8000%"
 */

import type {
  BrainNote,
  BrainStatus,
  BrainWiki,
  KnowledgeGraph,
  KnowledgeGraphNode,
  BrainNeighborhood,
} from "$lib/types/brain";

const API = import.meta.env.VITE_API_URL ?? "";
const BASE = `${API}/api/brain`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── What the API sends → what the panel draws ───────────────────────────────

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);

/** A 0–100 score as the 0–1 fraction the panel draws. Missing or not a number: `fallback`. */
export function fraction(score: unknown, fallback = 0): number {
  const n = typeof score === "string" && score.trim() !== "" ? Number(score) : score;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n / 100));
}

export function toBrainNote(raw: unknown): BrainNote {
  const row = isRow(raw) ? raw : {};
  return {
    ...(row as Partial<BrainNote>),
    id: String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    content: typeof row.content === "string" ? row.content : "",
    source: typeof row.source === "string" ? row.source : "",
    sourcePath: typeof row.sourcePath === "string" ? row.sourcePath : null,
    category: typeof row.category === "string" ? row.category : "general",
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    importance: fraction(row.importance),
    confidence: fraction(row.confidence),
    relatedNoteIds: Array.isArray(row.relatedNoteIds) ? (row.relatedNoteIds as string[]) : [],
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? row.createdAt ?? ""),
  };
}

/** `{ notes }` from the API; a bare array and `{ docs }` are accepted too. */
export function toBrainNotes(data: unknown): BrainNote[] {
  const list = Array.isArray(data)
    ? data
    : isRow(data) && Array.isArray(data.notes)
      ? data.notes
      : isRow(data) && Array.isArray(data.docs)
        ? data.docs
        : [];
  return list.map(toBrainNote);
}

/** `{ note, connections }` → the note; a note sent bare is accepted too. */
export function toBrainNoteDetail(data: unknown): BrainNote {
  return toBrainNote(isRow(data) && isRow(data.note) ? data.note : data);
}

function toGraphNode(raw: unknown): KnowledgeGraphNode {
  const row = isRow(raw) ? raw : {};
  const meta = isRow(row.metadata) ? row.metadata : undefined;
  const type = typeof row.type === "string" ? row.type : "general";
  return {
    ...(row as Partial<KnowledgeGraphNode>),
    id: String(row.id ?? ""),
    label: typeof row.label === "string" && row.label ? row.label : String(row.id ?? ""),
    type,
    group: typeof row.group === "string" ? row.group : type,
    importance: row.importance === undefined ? undefined : fraction(row.importance, 0.5),
    metadata: meta && {
      ...(meta as NonNullable<KnowledgeGraphNode["metadata"]>),
      source: typeof meta.source === "string" ? meta.source : "",
      sourcePath: typeof meta.sourcePath === "string" ? meta.sourcePath : null,
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
      confidence: fraction(meta.confidence),
    },
  };
}

export function toKnowledgeGraph(data: unknown): KnowledgeGraph {
  const row = isRow(data) ? data : {};
  const nodes = (Array.isArray(row.nodes) ? row.nodes : []).map(toGraphNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(row.edges) ? row.edges : [])
    .filter(isRow)
    .map((e) => ({
      source: String(e.source ?? ""),
      target: String(e.target ?? ""),
      relation: typeof e.relation === "string" ? e.relation : "related",
      strength: typeof e.strength === "number" && Number.isFinite(e.strength) ? e.strength : 0.5,
    }))
    // An edge to a node that is not in the answer makes cytoscape throw on the whole graph.
    .filter((e) => ids.has(e.source) && ids.has(e.target));
  return {
    nodes,
    edges,
    generatedAt: typeof row.generatedAt === "string" ? row.generatedAt : "",
  };
}

/** The neighbourhood is a plain graph: the centre and the depth are what was asked for. */
export function toNeighborhood(data: unknown, centerId: string, depth: number): BrainNeighborhood {
  const graph = toKnowledgeGraph(data);
  return { nodes: graph.nodes, edges: graph.edges, centerId, depth };
}

// ── Calls ───────────────────────────────────────────────────────────────────

export async function getBrainStatus(): Promise<BrainStatus> {
  const row = await fetchJson<Partial<BrainStatus> | null>(`${BASE}/status`);
  return {
    ...row,
    totalNotes: Number(row?.totalNotes ?? 0) || 0,
    totalConnections: Number(row?.totalConnections ?? 0) || 0,
  };
}

export async function getBrainGraph(): Promise<KnowledgeGraph> {
  return toKnowledgeGraph(await fetchJson<unknown>(`${BASE}/graph`));
}

export async function getBrainNotes(params: Record<string, string> = {}): Promise<BrainNote[]> {
  const query = new URLSearchParams(params);
  const url = `${BASE}/notes${query.toString() ? `?${query}` : ""}`;
  return toBrainNotes(await fetchJson<unknown>(url));
}

export async function getBrainNote(id: string): Promise<BrainNote> {
  return toBrainNoteDetail(await fetchJson<unknown>(`${BASE}/notes/${encodeURIComponent(id)}`));
}

export async function getBrainNeighborhood(id: string, depth = 1): Promise<BrainNeighborhood> {
  return toNeighborhood(
    await fetchJson<unknown>(
      `${BASE}/graph/${encodeURIComponent(id)}/neighborhood?depth=${encodeURIComponent(depth)}`
    ),
    id,
    depth
  );
}

export async function triggerBrainScan(): Promise<{ message?: string; startedAt?: string }> {
  return fetchJson<{ message?: string; startedAt?: string }>(`${BASE}/scan`, {
    method: "POST",
  });
}

export async function getBrainLlmsTxt(): Promise<string> {
  const res = await fetch(`${BASE}/llms.txt`, { credentials: "include" });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || `HTTP ${res.status}`);
  }
  return res.text();
}

export async function getBrainWiki(): Promise<BrainWiki> {
  return fetchJson<BrainWiki>(`${BASE}/wiki`);
}
