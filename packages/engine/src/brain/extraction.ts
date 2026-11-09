/**
 * KITSUDEN Brain — Deterministic Extraction
 * ============================================================================
 *
 * DETERMINISTIC core that turns a raw source into structured signals
 * (summary, keywords, headings, links, suggested backlinks). It uses no AI: the
 * same input always produces the same output.
 *
 * This layer is what allows "a local AI to understand how to do it": the
 * analysis work comes already solved and reproducible; the model (if used)
 * only writes the prose from these signals.
 */

import { embedTextLocal, cosineSimilarity } from "./embeddings";
import type { BrainNote } from "./types";

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
  "her",
  "was",
  "one",
  "our",
  "out",
  "his",
  "has",
  "had",
  "how",
  "man",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "did",
  "get",
  "may",
  "que",
  "los",
  "las",
  "una",
  "con",
  "por",
  "para",
  "del",
  "que",
  "como",
  "más",
  "este",
  "esta",
  "esto",
  "with",
  "from",
  "this",
  "that",
  "have",
  "will",
  "your",
  "they",
  "when",
  "para",
  "sobre",
  "entre",
  "cada",
  "pero",
  "sino",
  "también",
  "porque",
]);

export interface ExtractionResult {
  summary: string;
  keywords: string[];
  headings: string[];
  links: string[];
  /** ids of related existing notes (suggested backlinks), by similarity. */
  relatedNoteIds: string[];
}

/** Splits text into sentences in a simple, stable way. */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Tokenizes into lowercase terms, without stopwords or short tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ_\s]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOP_WORDS.has(t));
}

/** Deterministic extractive summary: the first N meaningful sentences. */
export function summarize(text: string, maxSentences = 3): string {
  const sentences = splitSentences(text).filter((s) => s.length > 20);
  return sentences.slice(0, maxSentences).join(" ");
}

/** Top-K keywords by frequency (stable order: freq desc, then alphabetical). */
export function keywords(text: string, topK = 8): string[] {
  const freq = new Map<string, number>();
  for (const term of tokenize(text)) {
    freq.set(term, (freq.get(term) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([term]) => term);
}

/** Extracts Markdown headings (`#`, `##`, ... lines). */
export function headings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Extracts URLs present in the text. */
export function links(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
  return Array.from(new Set(matches));
}

/**
 * Suggests related existing notes by local embedding similarity
 * (deterministic: same text + same notes → same ids).
 */
export function suggestBacklinks(
  text: string,
  existingNotes: BrainNote[],
  opts: { threshold?: number; limit?: number } = {}
): string[] {
  const threshold = opts.threshold ?? 0.25;
  const limit = opts.limit ?? 5;
  const vec = embedTextLocal(text);

  return existingNotes
    .map((n) => ({
      id: n.id,
      score:
        Array.isArray(n.embedding) && n.embedding.length === vec.length
          ? cosineSimilarity(vec, n.embedding)
          : 0,
    }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

/** Complete, deterministic extraction of a source. */
export function extractSignals(content: string, existingNotes: BrainNote[] = []): ExtractionResult {
  return {
    summary: summarize(content),
    keywords: keywords(content),
    headings: headings(content),
    links: links(content),
    relatedNoteIds: suggestBacklinks(content, existingNotes),
  };
}
