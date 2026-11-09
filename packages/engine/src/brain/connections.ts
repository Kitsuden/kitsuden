/**
 * KITSUDEN Brain — Connection Engine
 *
 * Discovers relationships between notes using embeddings, shared tokens and
 * explicit metadata links. This is the core of the Karpathy-style "organize
 * and connect" approach.
 */

import { cosineSimilarity } from "./embeddings";
import type { BrainConnectionInput, BrainNote } from "./types";

export interface ConnectionDiscoveryOptions {
  /** Minimum cosine similarity to create a connection. */
  threshold?: number;
  /** Max connections to store per note. */
  maxPerNote?: number;
  /** Relation type for embedding-based matches. */
  relationType?: string;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "boy",
  "did",
  "she",
  "use",
  "her",
  "too",
  "any",
  "say",
  "man",
  "try",
  "ask",
  "end",
  "why",
  "let",
  "put",
  "say",
  "she",
  "try",
  "way",
  "own",
  "say",
]);

function tokenizeForOverlap(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / Math.max(a.size, b.size);
}

/**
 * Score how strongly two notes should be connected.
 * Combines embedding cosine similarity with lexical overlap.
 */
export function scoreConnection(a: BrainNote, b: BrainNote): number {
  const vecA = Array.isArray(a.embedding) ? a.embedding : [];
  const vecB = Array.isArray(b.embedding) ? b.embedding : [];
  let embeddingScore = 0;
  if (vecA.length === vecB.length && vecA.length > 0) {
    embeddingScore = cosineSimilarity(vecA, vecB);
  }

  const tokensA = tokenizeForOverlap(`${a.title} ${a.content} ${(a.tags ?? []).join(" ")}`);
  const tokensB = tokenizeForOverlap(`${b.title} ${b.content} ${(b.tags ?? []).join(" ")}`);
  const overlapScore = jaccardOverlap(tokensA, tokensB);

  // Combine: the (lexical, term-hash) embedding captures overlapping vocabulary
  // including word fragments; the overlap captures exact long terms
  return Math.min(1, embeddingScore * 0.7 + overlapScore * 0.3);
}

/**
 * Discover candidate connections between a set of notes.
 * Returns undirected unique pairs.
 */
export function discoverConnections(
  notes: BrainNote[],
  options: ConnectionDiscoveryOptions = {}
): BrainConnectionInput[] {
  const threshold = options.threshold ?? 0.25;
  const maxPerNote = options.maxPerNote ?? 5;
  const relationType = options.relationType ?? "related";

  const pairs: Array<{ source: string; target: string; strength: number }> = [];

  for (let i = 0; i < notes.length; i++) {
    const a = notes[i];
    const scored: Array<{ targetId: string; strength: number }> = [];
    for (let j = 0; j < notes.length; j++) {
      if (i === j) continue;
      const b = notes[j];
      const strength = scoreConnection(a, b);
      if (strength >= threshold) {
        scored.push({ targetId: b.id, strength });
      }
    }
    scored.sort((x, y) => y.strength - x.strength);
    const top = scored.slice(0, maxPerNote);
    for (const t of top) {
      // Keep pair ordered for uniqueness
      const [source, target] = a.id < t.targetId ? [a.id, t.targetId] : [t.targetId, a.id];
      pairs.push({ source, target, strength: t.strength });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique: BrainConnectionInput[] = [];
  for (const p of pairs) {
    const key = `${p.source}|${p.target}|${relationType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      sourceNoteId: p.source,
      targetNoteId: p.target,
      relationType,
      strength: p.strength,
    });
  }

  return unique;
}

/**
 * Suggest the most relevant existing notes for a new text fragment.
 */
export function suggestConnections(
  note: BrainNote,
  candidates: BrainNote[],
  options: { limit?: number; threshold?: number } = {}
): Array<{ noteId: string; strength: number }> {
  const limit = options.limit ?? 5;
  const threshold = options.threshold ?? 0.2;

  return candidates
    .filter((c) => c.id !== note.id)
    .map((c) => ({ noteId: c.id, strength: scoreConnection(note, c) }))
    .filter((c) => c.strength >= threshold)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}
