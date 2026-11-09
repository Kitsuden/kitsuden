/**
 * KITSUDEN Brain — Operations (capture / sync / lint / digest)
 * ============================================================================
 *
 * The four operations of the Karpathy method, with a DETERMINISTIC core:
 *
 *   - capture: ingests a source (Layer 1) → derives/updates its wiki page
 *              (Layer 2) → discovers connections. Only the prose uses the author.
 *   - sync:    reconciles Layer 2 from Layer 1 (creates missing pages).
 *   - lint:    100% deterministic health-check (no AI): broken links, orphans,
 *              stale, duplicates, thin pages.
 *   - digest:  aggregates recent activity and produces a recap (pluggable author).
 *
 * The author (instruction | api | cli) is injected; by default instruction
 * (offline, deterministic). See author.ts.
 */

import { desc } from "drizzle-orm";

import { brainNotes } from "../../../../apps/api/src/db/schema-core";

import { resolveAuthor, type WikiAuthor } from "./author";
import { suggestConnections } from "./connections";
import { extractSignals } from "./extraction";
import { lintClaims } from "./memory";
import { createBrainConnection, listBrainNotes, upsertBrainNote, type BrainDb } from "./notes";
import { captureSource, listSources, type BrainSourceInput } from "./sources";
import type { BrainNote } from "./types";

// Vault rules the author must respect (subset of BRAIN.md).
const SCHEMA_RULES = [
  "- The wiki is interpretation; the sources (Layer 1) are immutable and the truth.",
  "- Do not invent data that is not in the raw source.",
  "- Cross-link concepts with [[Title]] syntax.",
  "- Every page starts with a 2-3 sentence summary.",
].join("\n");

const SOURCE_PATH_PREFIX = "source:";

// ── capture ──────────────────────────────────────────────────────────────────

export interface CaptureResult {
  sourceId: string;
  noteId: string;
  deduped: boolean;
  authoredBy: string;
  pendingAgent: boolean;
  connectionsCreated: number;
}

/**
 * Ingests a source and derives its wiki page.
 * Idempotent by content hash (recapturing does not duplicate the source).
 */
export async function capture(
  db: BrainDb,
  input: BrainSourceInput,
  author: WikiAuthor = resolveAuthor()
): Promise<CaptureResult> {
  const { source, deduped } = await captureSource(db, input);

  const existingNotes = await listBrainNotes(db, { limit: 10000 });
  const signals = extractSignals(source.content, existingNotes);

  const byId = new Map(existingNotes.map((n) => [n.id, n]));
  const relatedTitles = signals.relatedNoteIds
    .map((id) => byId.get(id)?.title)
    .filter((t): t is string => Boolean(t));

  const authored = await author.author({
    title: source.title,
    content: source.content,
    signals,
    relatedTitles,
    schemaRules: SCHEMA_RULES,
  });

  const note = await upsertBrainNote(db, {
    title: source.title,
    content: authored.markdown,
    source: "insight",
    // sourcePath ties the page to its source → recapturing updates the same note.
    sourcePath: `${SOURCE_PATH_PREFIX}${source.id}`,
    category: "general",
    tags: signals.keywords.slice(0, 5),
    importance: 55,
    confidence: authored.pendingAgent ? 40 : 80,
    metadata: {
      sourceId: source.id,
      contentHash: source.contentHash,
      authoredBy: authored.authoredBy,
      pendingAgent: authored.pendingAgent,
      keywords: signals.keywords,
    },
    relatedNoteIds: signals.relatedNoteIds,
  });

  // Discover and persist connections.
  const candidates = await listBrainNotes(db, { limit: 10000 });
  const suggestions = suggestConnections(note, candidates, { limit: 5, threshold: 0.25 });
  let connectionsCreated = 0;
  for (const s of suggestions) {
    try {
      await createBrainConnection(db, {
        sourceNoteId: note.id,
        targetNoteId: s.noteId,
        relationType: "related",
        strength: s.strength,
      });
      connectionsCreated++;
    } catch {
      // duplicate connection (unique index) — ignore
    }
  }

  return {
    sourceId: source.id,
    noteId: note.id,
    deduped,
    authoredBy: authored.authoredBy,
    pendingAgent: authored.pendingAgent,
    connectionsCreated,
  };
}

// ── sync ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  sourcesTotal: number;
  notesCreated: number;
  notesUpToDate: number;
  errors: string[];
}

/**
 * Reconciles Layer 2 from Layer 1: for each source without a page, derives it.
 * With `force`, re-derives all of them.
 */
export async function sync(
  db: BrainDb,
  options: { force?: boolean; author?: WikiAuthor } = {}
): Promise<SyncResult> {
  const author = options.author ?? resolveAuthor();
  const sources = await listSources(db, 10000);
  const notes = await listBrainNotes(db, { limit: 10000 });
  const notesBySourcePath = new Map(notes.map((n) => [n.sourcePath ?? "", n]));

  const result: SyncResult = {
    sourcesTotal: sources.length,
    notesCreated: 0,
    notesUpToDate: 0,
    errors: [],
  };

  for (const source of sources) {
    const existing = notesBySourcePath.get(`${SOURCE_PATH_PREFIX}${source.id}`);
    const upToDate =
      existing &&
      (existing.metadata as Record<string, unknown>)?.contentHash === source.contentHash;

    if (upToDate && !options.force) {
      result.notesUpToDate++;
      continue;
    }

    try {
      await capture(
        db,
        {
          title: source.title,
          content: source.content,
          sourceType: source.sourceType as BrainSourceInput["sourceType"],
          uri: source.uri ?? undefined,
        },
        author
      );
      result.notesCreated++;
    } catch (err) {
      result.errors.push(`source ${source.id}: ${(err as Error).message}`);
    }
  }

  return result;
}

// ── lint ─────────────────────────────────────────────────────────────────────

export interface LintReport {
  totalNotes: number;
  brokenLinks: { noteId: string; title: string; target: string }[];
  orphanNotes: { noteId: string; title: string }[];
  staleNotes: { noteId: string; title: string; reason: string }[];
  duplicateTitles: { title: string; noteIds: string[] }[];
  thinNotes: { noteId: string; title: string; length: number }[];
  /**
   * Claims whose evidence changed (0051): the source was re-captured with
   * another hash, deleted, or the range no longer fits. `lint` also PERSISTS
   * the verdict (status fresh|stale) where the caller may write.
   */
  staleClaims: { claimId: string; noteId: string; statement: string; reason: string }[];
  claimsChecked: number;
  healthy: boolean;
}

const BACKLINK_RE = /\[\[([^\]]+)\]\]/g;
const THIN_THRESHOLD = 120;

/**
 * 100% deterministic health-check of the wiki. No AI.
 */
export async function lint(db: BrainDb): Promise<LintReport> {
  const notes = await listBrainNotes(db, { limit: 10000 });
  const titleSet = new Set(notes.map((n) => n.title.toLowerCase()));

  const brokenLinks: LintReport["brokenLinks"] = [];
  const orphanNotes: LintReport["orphanNotes"] = [];
  const staleNotes: LintReport["staleNotes"] = [];
  const thinNotes: LintReport["thinNotes"] = [];

  // Broken links + stale + thin
  for (const note of notes) {
    for (const match of note.content.matchAll(BACKLINK_RE)) {
      const target = match[1].trim();
      if (!titleSet.has(target.toLowerCase())) {
        brokenLinks.push({ noteId: note.id, title: note.title, target });
      }
    }

    const meta = (note.metadata ?? {}) as Record<string, unknown>;
    if (meta.pendingAgent === true) {
      staleNotes.push({
        noteId: note.id,
        title: note.title,
        reason: "pendingAgent (AGENT-TASK not completed)",
      });
    }

    if (note.content.trim().length < THIN_THRESHOLD) {
      thinNotes.push({ noteId: note.id, title: note.title, length: note.content.trim().length });
    }
  }

  // Orphans: no incoming or outgoing backlinks.
  const hasOutgoing = new Set<string>();
  const hasIncoming = new Set<string>();
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.id]));
  for (const note of notes) {
    for (const match of note.content.matchAll(BACKLINK_RE)) {
      const targetId = byTitle.get(match[1].trim().toLowerCase());
      if (targetId) {
        hasOutgoing.add(note.id);
        hasIncoming.add(targetId);
      }
    }
    if ((note.relatedNoteIds ?? []).length > 0) hasOutgoing.add(note.id);
    for (const rid of note.relatedNoteIds ?? []) hasIncoming.add(rid);
  }
  for (const note of notes) {
    if (!hasOutgoing.has(note.id) && !hasIncoming.has(note.id)) {
      orphanNotes.push({ noteId: note.id, title: note.title });
    }
  }

  // Duplicate titles.
  const byTitleGroup = new Map<string, string[]>();
  for (const note of notes) {
    const key = note.title.toLowerCase();
    const list = byTitleGroup.get(key) ?? [];
    list.push(note.id);
    byTitleGroup.set(key, list);
  }
  const duplicateTitles = Array.from(byTitleGroup.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([title, noteIds]) => ({ title, noteIds }));

  const claims = await lintClaims(db);

  const healthy =
    brokenLinks.length === 0 &&
    orphanNotes.length === 0 &&
    staleNotes.length === 0 &&
    duplicateTitles.length === 0 &&
    claims.stale.length === 0;

  return {
    totalNotes: notes.length,
    brokenLinks,
    orphanNotes,
    staleNotes,
    duplicateTitles,
    thinNotes,
    staleClaims: claims.stale,
    claimsChecked: claims.checked,
    healthy,
  };
}

// ── digest ─────────────────────────────────────────────────────────────────────

export interface DigestResult {
  since: string;
  notesConsidered: number;
  markdown: string;
  authoredBy: string;
}

/**
 * Generates a recap of recent activity. The author writes; the selection of
 * what goes into the digest is deterministic (notes created/updated since `since`).
 */
export async function digest(
  db: BrainDb,
  options: { since?: Date; author?: WikiAuthor } = {}
): Promise<DigestResult> {
  const author = options.author ?? resolveAuthor();
  const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const recent = await db.select().from(brainNotes).orderBy(desc(brainNotes.updatedAt)).limit(200);

  const inWindow = (recent as BrainNote[]).filter((n) => new Date(n.updatedAt) >= since);

  const corpus = inWindow
    .map((n) => `## ${n.title}\n${n.content.slice(0, 400)}`)
    .join("\n\n")
    .slice(0, 8000);

  const signals = extractSignals(corpus, inWindow);

  const authored = await author.author({
    title: `Digest since ${since.toISOString().slice(0, 10)}`,
    content: corpus || "(no activity in the window)",
    signals,
    relatedTitles: inWindow.slice(0, 10).map((n) => n.title),
    schemaRules: SCHEMA_RULES,
  });

  return {
    since: since.toISOString(),
    notesConsidered: inWindow.length,
    markdown: authored.markdown,
    authoredBy: authored.authoredBy,
  };
}
