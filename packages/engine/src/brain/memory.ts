/**
 * KITSUDEN Brain — agent memory with an OWNER (2026-10-28)
 * ============================================================================
 *
 * The brain used to be global: `brain_notes` had no owner, so any caller saw
 * and could overwrite every note. This module is the owner-aware layer that
 * the SDK operations (REST + OpenAPI + MCP, `apps/api/src/routes/brain-memory.ts`)
 * use. It never decides WHO sees what by itself: it runs on the request's
 * RLS transaction and Postgres applies the policies of
 * `rls-owned-tables.sql` («Agent memory»). What it adds on top:
 *
 *   · it STAMPS the owner (user or agent) and the agent's human signer, so
 *     the policies have something to compare;
 *   · writes are IDEMPOTENT: a note is addressed by the owner's `key`
 *     (writing the same key again updates that note, and writing the same
 *     content again changes nothing); a connection by (source, target,
 *     relation); a claim by (note, statement, source hash);
 *   · it answers 404 for what the caller cannot see (never "exists but
 *     forbidden"), and 403 for a visible note it does not own.
 *
 * Embeddings: `resolveEmbeddingProvider()` (lexical hash by default). Every
 * response that used vectors says which kind, and whether it is semantic.
 */

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import {
  brainClaims,
  brainConnections,
  brainNotes,
  brainSources,
} from "../../../../apps/api/src/db/schema-core";
import { AppError } from "../errors";

import {
  cosineSimilarity,
  type EmbeddingInfo,
  type PluggableEmbeddingProvider,
} from "./embeddings";
import type { BrainDb } from "./notes";
import { captureSource, hashContent, type BrainSourceInput } from "./sources";
import type { BrainNoteCategory } from "./types";

// ── Who ─────────────────────────────────────────────────────────────────────

export interface BrainActor {
  kind: "agent" | "user" | "system";
  id: string | null;
  role: string | null;
  /** The agent's human signer, stamped on what the agent writes. */
  sponsorUserId?: string | null;
}

/** From the request's user (`c.get("user")`, the shape agents also get). */
export function actorFromUser(user: unknown): BrainActor {
  const u = (user ?? null) as {
    id?: unknown;
    role?: unknown;
    sponsor?: { userId?: unknown; valid?: unknown } | null;
  } | null;
  if (!u || typeof u.id !== "string" || !u.id) return { kind: "system", id: null, role: null };
  const role = typeof u.role === "string" ? u.role : "user";
  if (role === "agent") {
    const s = u.sponsor;
    const sponsor = s && s.valid === true && typeof s.userId === "string" ? s.userId : null;
    return { kind: "agent", id: u.id, role, sponsorUserId: sponsor };
  }
  return { kind: "user", id: u.id, role };
}

/** How an actor is named in `verified_by` and OKF `by` fields. */
export function actorLabel(a: BrainActor): string {
  if (a.kind === "agent") return `agent:${a.id}`;
  if (a.kind === "user") return `human:${a.id}`;
  return "process:kitsuden-brain";
}

function ownerColumns(a: BrainActor): { ownerUserId: string | null; ownerAgentId: string | null } {
  if (a.kind === "agent") return { ownerUserId: null, ownerAgentId: a.id };
  if (a.kind === "user") return { ownerUserId: a.id, ownerAgentId: null };
  return { ownerUserId: null, ownerAgentId: null };
}

/** WHERE for "rows this actor owns" (the same rule as the policies). */
function ownedBy(
  a: BrainActor,
  cols: { ownerUserId: typeof brainNotes.ownerUserId; ownerAgentId: typeof brainNotes.ownerAgentId }
): SQL {
  if (a.kind === "agent") return eq(cols.ownerAgentId, a.id!);
  if (a.kind === "user") return and(isNull(cols.ownerAgentId), eq(cols.ownerUserId, a.id!))!;
  return and(isNull(cols.ownerAgentId), isNull(cols.ownerUserId))!;
}

/**
 * WHERE for "notes this actor can read": the SAME rule as the policy
 * `brain_notes_read`, applied in the query too (defense in depth: the
 * isolation holds even on a connection that bypasses RLS, such as a
 * superuser in a test suite). `undefined` = everything (admin, system).
 */
export function visibleTo(a: BrainActor): SQL | undefined {
  if (a.kind === "system" || a.role === "admin") return undefined;
  if (a.kind === "agent") {
    return sql`(${brainNotes.ownerAgentId} = ${a.id} OR ${brainNotes.visibility} = 'shared')`;
  }
  const team = a.role === "editor";
  return sql`((${brainNotes.ownerAgentId} IS NULL AND ${brainNotes.ownerUserId} = ${a.id})
    OR ${brainNotes.sponsorUserId} = ${a.id}
    ${team ? sql`OR ${brainNotes.visibility} = 'shared'` : sql``})`;
}

function owns(
  a: BrainActor,
  row: { ownerUserId: string | null; ownerAgentId: string | null }
): boolean {
  if (a.kind === "agent") return row.ownerAgentId === a.id;
  if (a.kind === "user") return row.ownerAgentId === null && row.ownerUserId === a.id;
  return row.ownerAgentId === null && row.ownerUserId === null;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export type BrainVisibility = "private" | "shared";

export interface MemoryNote {
  id: string;
  key: string | null;
  title: string;
  content: string;
  visibility: BrainVisibility;
  owner: { userId: string | null; agentId: string | null; sponsorUserId: string | null };
  category: string;
  source: string;
  tags: string[];
  importance: number;
  confidence: number;
  metadata: Record<string, unknown>;
  embeddingKind: string | null;
  createdAt: string;
  updatedAt: string;
}

type NoteRow = typeof brainNotes.$inferSelect;

function iso(d: unknown): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

export function toMemoryNote(r: NoteRow): MemoryNote {
  return {
    id: r.id,
    key: r.noteKey ?? null,
    title: r.title,
    content: r.content,
    visibility: (r.visibility as BrainVisibility) ?? "private",
    owner: {
      userId: r.ownerUserId ?? null,
      agentId: r.ownerAgentId ?? null,
      sponsorUserId: r.sponsorUserId ?? null,
    },
    category: r.category,
    source: r.source,
    tags: (r.tags as string[]) ?? [],
    importance: r.importance,
    confidence: r.confidence,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    embeddingKind: r.embeddingKind ?? null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export type ConnectionOrigin = "EXTRACTED" | "INFERRED" | "MANUAL";
export const CONNECTION_ORIGINS: readonly ConnectionOrigin[] = ["EXTRACTED", "INFERRED", "MANUAL"];

export interface MemoryConnection {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  relationType: string;
  origin: ConnectionOrigin;
  confidence: number;
  strength: number;
  owner: { userId: string | null; agentId: string | null };
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toConnection(r: typeof brainConnections.$inferSelect): MemoryConnection {
  return {
    id: r.id,
    sourceNoteId: r.sourceNoteId,
    targetNoteId: r.targetNoteId,
    relationType: r.relationType,
    origin: r.origin as ConnectionOrigin,
    confidence: r.confidence,
    strength: r.strength,
    owner: { userId: r.ownerUserId ?? null, agentId: r.ownerAgentId ?? null },
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: iso(r.createdAt),
  };
}

// ── Notes ───────────────────────────────────────────────────────────────────

export interface WriteNoteInput {
  key: string;
  title: string;
  content: string;
  visibility?: BrainVisibility;
  category?: BrainNoteCategory;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface WriteNoteResult {
  note: MemoryNote;
  /** created | updated | unchanged (same content: nothing was written). */
  outcome: "created" | "updated" | "unchanged";
  embedding: EmbeddingInfo;
}

async function findOwnNoteByKey(db: BrainDb, a: BrainActor, key: string): Promise<NoteRow | null> {
  const rows = await db
    .select()
    .from(brainNotes)
    .where(and(eq(brainNotes.noteKey, key), ownedBy(a, brainNotes)))
    .limit(1);
  return (rows[0] as NoteRow) ?? null;
}

function sameStringArray(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * Create or update the actor's note with this `key`. Idempotent: the same
 * input twice leaves one note, and the second call writes nothing.
 * The embedding is computed BEFORE the first query (an HTTP provider must
 * not hold the request's transaction open).
 */
export async function writeMemoryNote(
  db: BrainDb,
  actor: BrainActor,
  input: WriteNoteInput,
  provider: PluggableEmbeddingProvider
): Promise<WriteNoteResult> {
  if (actor.kind === "system") throw AppError.forbidden("A memory note needs an owner");
  const embedding = await provider.embed(`${input.title} ${input.content}`);
  const existing = await findOwnNoteByKey(db, actor, input.key);
  const visibility = input.visibility ?? (existing?.visibility as BrainVisibility) ?? "private";
  const tags = input.tags ?? (existing?.tags as string[]) ?? [];
  const category = input.category ?? (existing?.category as BrainNoteCategory) ?? "general";
  const importance = input.importance ?? existing?.importance ?? 50;
  const metadata = input.metadata ?? (existing?.metadata as Record<string, unknown>) ?? {};

  if (existing) {
    const unchanged =
      existing.title === input.title &&
      existing.content === input.content &&
      existing.visibility === visibility &&
      existing.category === category &&
      existing.importance === importance &&
      sameStringArray(existing.tags, tags) &&
      JSON.stringify(existing.metadata ?? {}) === JSON.stringify(metadata) &&
      existing.embeddingKind === provider.info.kind;
    if (unchanged) {
      return { note: toMemoryNote(existing), outcome: "unchanged", embedding: provider.info };
    }
    const [updated] = await db
      .update(brainNotes)
      .set({
        title: input.title,
        content: input.content,
        visibility,
        category,
        tags,
        importance,
        metadata,
        embedding,
        embeddingKind: provider.info.kind,
        sponsorUserId: actor.kind === "agent" ? (actor.sponsorUserId ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(brainNotes.id, existing.id))
      .returning();
    return { note: toMemoryNote(updated as NoteRow), outcome: "updated", embedding: provider.info };
  }

  const [created] = await db
    .insert(brainNotes)
    .values({
      title: input.title,
      content: input.content,
      source: actor.kind === "agent" ? "agent" : "user",
      category,
      tags,
      embedding,
      embeddingKind: provider.info.kind,
      importance,
      confidence: 80,
      metadata,
      noteKey: input.key,
      visibility,
      ...ownerColumns(actor),
      sponsorUserId: actor.kind === "agent" ? (actor.sponsorUserId ?? null) : null,
    })
    .returning();
  return { note: toMemoryNote(created as NoteRow), outcome: "created", embedding: provider.info };
}

/** A note the caller can SEE (RLS), or 404. */
export async function getVisibleNote(db: BrainDb, actor: BrainActor, id: string): Promise<NoteRow> {
  const rows = await db
    .select()
    .from(brainNotes)
    .where(and(eq(brainNotes.id, id), visibleTo(actor)))
    .limit(1);
  const row = rows[0] as NoteRow | undefined;
  if (!row) throw AppError.notFound("Note not found");
  return row;
}

export interface ListNotesFilter {
  visibility?: BrainVisibility;
  /** Only the caller's own notes. */
  mine?: boolean;
  tag?: string;
  keyPrefix?: string;
  limit?: number;
  offset?: number;
}

export async function listMemoryNotes(
  db: BrainDb,
  actor: BrainActor,
  f: ListNotesFilter = {}
): Promise<MemoryNote[]> {
  const conds: SQL[] = [];
  const vis = visibleTo(actor);
  if (vis) conds.push(vis);
  if (f.visibility) conds.push(eq(brainNotes.visibility, f.visibility));
  if (f.mine) conds.push(ownedBy(actor, brainNotes));
  if (f.tag) conds.push(sql`${brainNotes.tags} @> ${JSON.stringify([f.tag])}::jsonb`);
  if (f.keyPrefix) {
    const escaped = f.keyPrefix.replace(/[\\%_]/g, (m) => `\\${m}`);
    conds.push(sql`${brainNotes.noteKey} LIKE ${`${escaped}%`}`);
  }
  const rows = await db
    .select()
    .from(brainNotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(brainNotes.updatedAt), asc(brainNotes.id))
    .limit(Math.min(f.limit ?? 50, 200))
    .offset(f.offset ?? 0);
  return (rows as NoteRow[]).map(toMemoryNote);
}

export interface SearchHit {
  note: MemoryNote;
  score: number;
}

/**
 * Nearest notes to `query` among those the caller can see, comparing ONLY
 * vectors of the active provider's kind. With the default provider this is
 * a LEXICAL match (shared words), and the response says so.
 */
export async function searchMemoryNotes(
  db: BrainDb,
  actor: BrainActor,
  query: string,
  provider: PluggableEmbeddingProvider,
  opts: { limit?: number; threshold?: number; visibility?: BrainVisibility } = {}
): Promise<{ hits: SearchHit[]; embedding: EmbeddingInfo; compared: number }> {
  const queryVec = await provider.embed(query);
  const conds: SQL[] = [eq(brainNotes.embeddingKind, provider.info.kind)];
  const vis = visibleTo(actor);
  if (vis) conds.push(vis);
  if (opts.visibility) conds.push(eq(brainNotes.visibility, opts.visibility));
  const rows = (await db
    .select()
    .from(brainNotes)
    .where(and(...conds))) as NoteRow[];
  const threshold = opts.threshold ?? 0.1;
  const hits = rows
    .map((r) => {
      const v = Array.isArray(r.embedding) ? (r.embedding as number[]) : [];
      return { r, score: v.length === queryVec.length ? cosineSimilarity(queryVec, v) : 0 };
    })
    .filter((h) => h.score >= threshold)
    .sort((x, y) => y.score - x.score || x.r.id.localeCompare(y.r.id))
    .slice(0, Math.min(opts.limit ?? 10, 50))
    .map((h) => ({ note: toMemoryNote(h.r), score: Math.round(h.score * 10_000) / 10_000 }));
  return { hits, embedding: provider.info, compared: rows.length };
}

/** Delete the caller's note (404 if invisible, 403 if visible but not theirs). */
export async function deleteMemoryNote(db: BrainDb, actor: BrainActor, id: string): Promise<void> {
  const row = await getVisibleNote(db, actor, id);
  if (!owns(actor, row) && actor.role !== "admin") {
    throw AppError.forbidden("Only the note's owner (or an admin) can delete it");
  }
  const deleted = await db
    .delete(brainNotes)
    .where(eq(brainNotes.id, id))
    .returning({ id: brainNotes.id });
  if (deleted.length === 0)
    throw AppError.forbidden("Only the note's owner (or an admin) can delete it");
}

// ── Connections ─────────────────────────────────────────────────────────────

export async function listNoteConnections(
  db: BrainDb,
  actor: BrainActor,
  noteId: string
): Promise<MemoryConnection[]> {
  await getVisibleNote(db, actor, noteId);
  const rows = await db
    .select()
    .from(brainConnections)
    .where(
      sql`${brainConnections.sourceNoteId} = ${noteId} OR ${brainConnections.targetNoteId} = ${noteId}`
    )
    .orderBy(desc(brainConnections.confidence), asc(brainConnections.id));
  // Only the ones whose OTHER end is visible too (as the policy does).
  const others = [
    ...new Set(rows.map((r) => (r.sourceNoteId === noteId ? r.targetNoteId : r.sourceNoteId))),
  ];
  const visible = others.length
    ? new Set(
        (
          await db
            .select({ id: brainNotes.id })
            .from(brainNotes)
            .where(and(inArray(brainNotes.id, others), visibleTo(actor)))
        ).map((x) => x.id)
      )
    : new Set<string>();
  return rows
    .filter((r) => visible.has(r.sourceNoteId === noteId ? r.targetNoteId : r.sourceNoteId))
    .map(toConnection);
}

export interface ConnectInput {
  sourceNoteId: string;
  targetNoteId: string;
  relationType?: string;
  origin?: ConnectionOrigin;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/** Idempotent by (source, target, relation): the existing one is returned. */
export async function connectNotes(
  db: BrainDb,
  actor: BrainActor,
  input: ConnectInput
): Promise<{ connection: MemoryConnection; created: boolean }> {
  if (actor.kind === "system") throw AppError.forbidden("A connection needs an owner");
  if (input.sourceNoteId === input.targetNoteId) {
    throw AppError.validation("A note cannot be connected to itself");
  }
  await getVisibleNote(db, actor, input.sourceNoteId);
  await getVisibleNote(db, actor, input.targetNoteId);
  const relationType = input.relationType ?? "related";
  const origin = input.origin ?? "MANUAL";
  const confidence = input.confidence ?? (origin === "INFERRED" ? 0.5 : 1);
  const [created] = await db
    .insert(brainConnections)
    .values({
      sourceNoteId: input.sourceNoteId,
      targetNoteId: input.targetNoteId,
      relationType,
      strength: confidence,
      origin,
      confidence,
      metadata: input.metadata ?? {},
      ...ownerColumns(actor),
    })
    .onConflictDoNothing({
      target: [
        brainConnections.sourceNoteId,
        brainConnections.targetNoteId,
        brainConnections.relationType,
      ],
    })
    .returning();
  if (created) return { connection: toConnection(created), created: true };
  const [existing] = await db
    .select()
    .from(brainConnections)
    .where(
      and(
        eq(brainConnections.sourceNoteId, input.sourceNoteId),
        eq(brainConnections.targetNoteId, input.targetNoteId),
        eq(brainConnections.relationType, relationType)
      )
    )
    .limit(1);
  if (!existing) throw AppError.conflict("The connection exists but is not visible to you");
  return { connection: toConnection(existing), created: false };
}

// ── Claims with evidence ────────────────────────────────────────────────────

export interface ClaimRange {
  unit: "line" | "char";
  start: number;
  end: number;
}

export interface MemoryClaim {
  id: string;
  noteId: string;
  statement: string;
  source: { id: string | null; sha256: string; uri: string | null; range: ClaimRange | null };
  status: "fresh" | "stale";
  staleReason: string | null;
  checkedAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  owner: { userId: string | null; agentId: string | null };
  createdAt: string;
}

type ClaimRow = typeof brainClaims.$inferSelect;

function toClaim(r: ClaimRow): MemoryClaim {
  return {
    id: r.id,
    noteId: r.noteId,
    statement: r.statement,
    source: {
      id: r.sourceId ?? null,
      sha256: r.sourceSha256,
      uri: r.sourceUri ?? null,
      range: (r.sourceRange as ClaimRange | null) ?? null,
    },
    status: r.status as "fresh" | "stale",
    staleReason: r.staleReason ?? null,
    checkedAt: iso(r.checkedAt),
    verifiedAt: r.verifiedAt ? iso(r.verifiedAt) : null,
    verifiedBy: r.verifiedBy ?? null,
    owner: { userId: r.ownerUserId ?? null, agentId: r.ownerAgentId ?? null },
    createdAt: iso(r.createdAt),
  };
}

/** Does the range fit the content? `null` = it does. */
export function rangeProblem(content: string, range: ClaimRange | null | undefined): string | null {
  if (!range) return null;
  if (!(Number.isInteger(range.start) && Number.isInteger(range.end)) || range.start < 0) {
    return "range: start and end are integers ≥ 0";
  }
  if (range.end < range.start) return "range: end before start";
  const size = range.unit === "line" ? content.split(/\r?\n/).length : content.length;
  // lines are 1-based and inclusive; chars are 0-based, end exclusive
  if (range.unit === "line" ? range.start < 1 || range.end > size : range.end > size) {
    return `range out of bounds (source has ${size} ${range.unit === "line" ? "lines" : "characters"})`;
  }
  return null;
}

export interface ClaimCheck {
  status: "fresh" | "stale";
  reason: string | null;
  /** The newest source with the claim's uri, when it differs from the cited one. */
  newerSourceId: string | null;
}

/**
 * The deterministic verdict on a claim (pure: no DB). A claim is STALE when
 *   · its source row is gone,
 *   · the recorded SHA-256 is not the source row's hash,
 *   · a NEWER source with the same uri has another hash (sources are
 *     immutable: a changed document is captured as a new source), or
 *   · its range no longer fits the source.
 */
export function checkClaim(
  claim: {
    sourceId: string | null;
    sourceSha256: string;
    sourceUri: string | null;
    sourceRange: ClaimRange | null;
  },
  cited: { id: string; contentHash: string; content: string } | null,
  newest: { id: string; contentHash: string } | null
): ClaimCheck {
  if (!cited)
    return { status: "stale", reason: "source deleted", newerSourceId: newest?.id ?? null };
  if (cited.contentHash !== claim.sourceSha256) {
    return {
      status: "stale",
      reason: "recorded hash does not match the source",
      newerSourceId: null,
    };
  }
  if (newest && newest.id !== cited.id && newest.contentHash !== claim.sourceSha256) {
    return {
      status: "stale",
      reason: `source changed: newer capture of ${claim.sourceUri ?? "the same uri"} has sha256 ${newest.contentHash.slice(0, 12)}…`,
      newerSourceId: newest.id,
    };
  }
  const r = rangeProblem(cited.content, claim.sourceRange);
  if (r) return { status: "stale", reason: r, newerSourceId: null };
  return { status: "fresh", reason: null, newerSourceId: null };
}

async function sourceById(db: BrainDb, id: string | null) {
  if (!id) return null;
  const rows = await db
    .select({
      id: brainSources.id,
      contentHash: brainSources.contentHash,
      content: brainSources.content,
      uri: brainSources.uri,
      createdAt: brainSources.createdAt,
    })
    .from(brainSources)
    .where(eq(brainSources.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Who captured a source through a claim, as stored in its `metadata`. */
function capturerKey(owner: {
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
}): string | null {
  if (owner.ownerAgentId) return `agent:${owner.ownerAgentId}`;
  return owner.ownerUserId ? `user:${owner.ownerUserId}` : null;
}

/**
 * The newest capture of a uri that can speak for this claim: one the claim's owner
 * captured or cites in another claim (sources dedupe by content, so the row may
 * carry someone else's mark), or one with no capturer (operator imports through
 * `/api/brain`).
 *
 * `brain_sources` is global. Without this, anyone with `brain:write` could cite a
 * victim's uri in a claim of their own, turn the victim's claims stale, and have
 * a rebind move them onto the attacker's text.
 */
async function newestSourceForUri(
  db: BrainDb,
  uri: string | null,
  claim: { ownerUserId?: string | null; ownerAgentId?: string | null } = {}
) {
  if (!uri) return null;
  const capturedBy = sql`${brainSources.metadata}->>'capturedBy'`;
  const owner = capturerKey(claim);
  const ownClaims = claim.ownerAgentId
    ? eq(brainClaims.ownerAgentId, claim.ownerAgentId)
    : and(isNull(brainClaims.ownerAgentId), eq(brainClaims.ownerUserId, claim.ownerUserId ?? ""));
  const rows = await db
    .select({
      id: brainSources.id,
      contentHash: brainSources.contentHash,
      content: brainSources.content,
      createdAt: brainSources.createdAt,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.uri, uri),
        owner
          ? sql`(${capturedBy} IS NULL OR ${capturedBy} = ${owner} OR EXISTS (
              SELECT 1 FROM ${brainClaims} WHERE ${brainClaims.sourceId} = ${brainSources.id} AND ${ownClaims}))`
          : sql`${capturedBy} IS NULL`
      )
    )
    .orderBy(desc(brainSources.createdAt), desc(brainSources.id))
    .limit(1);
  return rows[0] ?? null;
}

export interface AddClaimInput {
  noteId: string;
  statement: string;
  /** An existing Layer-1 source… */
  sourceId?: string;
  /** …or the evidence itself, captured as a (content-addressed) source. */
  source?: BrainSourceInput;
  range?: ClaimRange;
}

/** Idempotent by (note, statement, source hash). Only the note's owner adds claims. */
export async function addClaim(
  db: BrainDb,
  actor: BrainActor,
  input: AddClaimInput
): Promise<{ claim: MemoryClaim; created: boolean }> {
  if (actor.kind === "system") throw AppError.forbidden("A claim needs an owner");
  if (!!input.sourceId === !!input.source) {
    throw AppError.validation("Give exactly one of sourceId or source");
  }
  const note = await getVisibleNote(db, actor, input.noteId);
  if (!owns(actor, note) && actor.role !== "admin") {
    throw AppError.forbidden("Only the note's owner can add claims to it");
  }
  let src: { id: string; contentHash: string; content: string; uri: string | null } | null;
  if (input.source) {
    // The capturer is the server's to say: it overwrites what the client sends.
    const { source } = await captureSource(db, {
      ...input.source,
      metadata: { ...input.source.metadata, capturedBy: capturerKey(ownerColumns(actor)) },
    });
    src = {
      id: source.id,
      contentHash: source.contentHash,
      content: source.content,
      uri: source.uri,
    };
  } else {
    src = await sourceById(db, input.sourceId!);
    if (!src) throw AppError.notFound("Source not found");
  }
  const problem = rangeProblem(src.content, input.range);
  if (problem) throw AppError.validation(problem);

  const statementHash = hashContent(input.statement);
  const [created] = await db
    .insert(brainClaims)
    .values({
      noteId: input.noteId,
      statement: input.statement,
      statementHash,
      sourceId: src.id,
      sourceSha256: src.contentHash,
      sourceUri: src.uri,
      sourceRange: input.range ?? null,
      status: "fresh",
      ...ownerColumns(actor),
    })
    .onConflictDoNothing({
      target: [brainClaims.noteId, brainClaims.statementHash, brainClaims.sourceSha256],
    })
    .returning();
  if (created) return { claim: toClaim(created as ClaimRow), created: true };
  const [existing] = await db
    .select()
    .from(brainClaims)
    .where(
      and(
        eq(brainClaims.noteId, input.noteId),
        eq(brainClaims.statementHash, statementHash),
        eq(brainClaims.sourceSha256, src.contentHash)
      )
    )
    .limit(1);
  return { claim: toClaim(existing as ClaimRow), created: false };
}

function claimsOfVisibleNotes(actor: BrainActor): SQL | undefined {
  const vis = visibleTo(actor);
  return vis
    ? sql`${brainClaims.noteId} IN (SELECT ${brainNotes.id} FROM ${brainNotes} WHERE ${vis})`
    : undefined;
}

export async function listClaims(
  db: BrainDb,
  actor: BrainActor,
  f: { noteId?: string; status?: "fresh" | "stale"; limit?: number } = {}
): Promise<MemoryClaim[]> {
  if (f.noteId) await getVisibleNote(db, actor, f.noteId);
  const conds: SQL[] = [];
  const vis = claimsOfVisibleNotes(actor);
  if (vis) conds.push(vis);
  if (f.noteId) conds.push(eq(brainClaims.noteId, f.noteId));
  if (f.status) conds.push(eq(brainClaims.status, f.status));
  const rows = await db
    .select()
    .from(brainClaims)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(brainClaims.createdAt), asc(brainClaims.id))
    .limit(Math.min(f.limit ?? 200, 1000));
  return (rows as ClaimRow[]).map(toClaim);
}

async function checkRow(db: BrainDb, r: ClaimRow): Promise<ClaimCheck> {
  const cited = await sourceById(db, r.sourceId ?? null);
  const newest = await newestSourceForUri(db, r.sourceUri ?? cited?.uri ?? null, r);
  // The cited source can be someone else's capture (sources dedupe by content): an
  // older one of ours does not make the claim stale.
  const newer = cited && newest && newest.createdAt <= cited.createdAt ? null : newest;
  return checkClaim(
    {
      sourceId: r.sourceId ?? null,
      sourceSha256: r.sourceSha256,
      sourceUri: r.sourceUri ?? null,
      sourceRange: (r.sourceRange as ClaimRange | null) ?? null,
    },
    cited,
    newer
  );
}

export interface ClaimsLint {
  checked: number;
  stale: { claimId: string; noteId: string; statement: string; reason: string }[];
  /** Claims whose stored status changed in this run (only rows the caller may write). */
  updated: number;
}

/**
 * Re-check every claim the caller can see and PERSIST the verdict where the
 * caller may write (RLS: its own claims; admin and the system: all). Pure
 * reads otherwise. Deterministic: no AI involved.
 */
export async function lintClaims(
  db: BrainDb,
  opts: { limit?: number; actor?: BrainActor } = {}
): Promise<ClaimsLint> {
  const rows = (await db
    .select()
    .from(brainClaims)
    .where(opts.actor ? claimsOfVisibleNotes(opts.actor) : undefined)
    .orderBy(asc(brainClaims.createdAt), asc(brainClaims.id))
    .limit(opts.limit ?? 5000)) as ClaimRow[];
  const out: ClaimsLint = { checked: rows.length, stale: [], updated: 0 };
  for (const r of rows) {
    const v = await checkRow(db, r);
    if (v.status === "stale") {
      out.stale.push({
        claimId: r.id,
        noteId: r.noteId,
        statement: r.statement,
        reason: v.reason ?? "stale",
      });
    }
    const mayWrite = !opts.actor || opts.actor.role === "admin" || owns(opts.actor, r);
    if (mayWrite && (v.status !== r.status || (v.reason ?? null) !== (r.staleReason ?? null))) {
      const changed = await db
        .update(brainClaims)
        .set({
          status: v.status,
          staleReason: v.reason,
          checkedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(brainClaims.id, r.id))
        .returning({ id: brainClaims.id });
      out.updated += changed.length;
    }
  }
  return out;
}

/**
 * Re-verify one claim. Without `rebind`, it records the verdict (and, if
 * fresh, who verified it and when). With `rebind: true` and a newer source
 * for the same uri, the claim moves to that source (new id + hash) — the
 * caller asserts the statement still holds there — and is fresh again.
 */
export async function reverifyClaim(
  db: BrainDb,
  actor: BrainActor,
  claimId: string,
  opts: { rebind?: boolean } = {}
): Promise<{ claim: MemoryClaim; check: ClaimCheck; rebound: boolean }> {
  const rows = (await db
    .select()
    .from(brainClaims)
    .where(eq(brainClaims.id, claimId))
    .limit(1)) as ClaimRow[];
  const r = rows[0];
  if (!r) throw AppError.notFound("Claim not found");
  if (!owns(actor, r) && actor.role !== "admin") {
    throw AppError.forbidden("Only the claim's owner (or an admin) can re-verify it");
  }
  let check = await checkRow(db, r);
  let rebound = false;
  const set: Partial<typeof brainClaims.$inferInsert> = {
    checkedAt: new Date(),
    updatedAt: new Date(),
  };
  if (opts.rebind && check.status === "stale" && check.newerSourceId) {
    const newer = await sourceById(db, check.newerSourceId);
    if (newer) {
      const fits = rangeProblem(newer.content, (r.sourceRange as ClaimRange | null) ?? null);
      if (!fits) {
        set.sourceId = newer.id;
        set.sourceSha256 = newer.contentHash;
        rebound = true;
        check = { status: "fresh", reason: null, newerSourceId: null };
      } else {
        check = { ...check, reason: `cannot rebind: ${fits}` };
      }
    }
  }
  set.status = check.status;
  set.staleReason = check.reason;
  if (check.status === "fresh") {
    set.verifiedAt = new Date();
    set.verifiedBy = actorLabel(actor);
  }
  const [updated] = await db
    .update(brainClaims)
    .set(set)
    .where(eq(brainClaims.id, claimId))
    .returning();
  if (!updated) throw AppError.forbidden("Only the claim's owner (or an admin) can re-verify it");
  return { claim: toClaim(updated as ClaimRow), check, rebound };
}

// ── Export: Open Knowledge Format v0.2 ──────────────────────────────────────
//
// Spec read on 2026-10-28 from
// https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md
// (the `okf/SPEC.md` the reference crates point to). A bundle is a directory
// of Markdown files with YAML frontmatter; `type` is the only required key;
// citations go in `sources` (with `id` used as the footnote label);
// `generated` / `verified` carry `{ by, at }`; a root `index.md` may declare
// `okf_version: "0.2"`. Producers may add keys: ours are prefixed `kitsuden_`.

function yamlString(s: string): string {
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

function slugPart(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w/-]+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/^[-/]+|[-/]+$/g, "")
      .slice(0, 120) || "note"
  );
}

export interface OkfFile {
  path: string;
  content: string;
}

export async function exportOkf(
  db: BrainDb,
  actor: BrainActor,
  opts: { noteIds?: string[]; limit?: number; producer?: string } = {}
): Promise<{ okfVersion: "0.2"; files: OkfFile[]; notes: number; claims: number }> {
  const notes = (await db
    .select()
    .from(brainNotes)
    .where(
      and(opts.noteIds?.length ? inArray(brainNotes.id, opts.noteIds) : undefined, visibleTo(actor))
    )
    .orderBy(asc(brainNotes.createdAt), asc(brainNotes.id))
    .limit(Math.min(opts.limit ?? 500, 2000))) as NoteRow[];
  const ids = notes.map((n) => n.id);
  const claims = ids.length
    ? ((await db
        .select()
        .from(brainClaims)
        .where(inArray(brainClaims.noteId, ids))
        .orderBy(asc(brainClaims.createdAt), asc(brainClaims.id))) as ClaimRow[])
    : [];
  const sourceIds = [...new Set(claims.map((c) => c.sourceId).filter((x): x is string => !!x))];
  const sources = sourceIds.length
    ? await db
        .select({
          id: brainSources.id,
          title: brainSources.title,
          uri: brainSources.uri,
          createdAt: brainSources.createdAt,
        })
        .from(brainSources)
        .where(inArray(brainSources.id, sourceIds))
    : [];
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const producer = opts.producer ?? "kitsuden-brain/1";

  const used = new Set<string>();
  const files: OkfFile[] = [];
  const index: string[] = [];
  for (const n of notes) {
    let base = `notes/${slugPart(n.noteKey ?? n.title)}`;
    if (used.has(base)) base = `${base}-${n.id.slice(0, 8)}`;
    used.add(base);
    const mine = claims.filter((c) => c.noteId === n.id);
    const fm: string[] = [
      "---",
      `type: ${yamlString("Brain Note")}`,
      `title: ${yamlString(n.title)}`,
    ];
    const tags = (n.tags as string[]) ?? [];
    if (tags.length) fm.push("tags:", ...tags.map((t) => `  - ${yamlString(t)}`));
    // A note with a stale claim is not "stable" any more: OKF's `draft`.
    fm.push(`status: ${mine.some((c) => c.status === "stale") ? "draft" : "stable"}`);
    const by = n.ownerAgentId
      ? `agent:${n.ownerAgentId}`
      : n.ownerUserId
        ? `human:${n.ownerUserId}`
        : producer;
    fm.push("generated:", `  by: ${yamlString(by)}`, `  at: ${yamlString(iso(n.updatedAt))}`);
    const verified = mine.filter((c) => c.verifiedAt && c.verifiedBy);
    if (verified.length) {
      fm.push("verified:");
      for (const c of verified) {
        fm.push(`  - by: ${yamlString(c.verifiedBy!)}`, `    at: ${yamlString(iso(c.verifiedAt))}`);
      }
    }
    const srcIds = [...new Set(mine.map((c) => c.sourceId).filter((x): x is string => !!x))];
    if (srcIds.length) {
      fm.push("sources:");
      for (const sid of srcIds) {
        const s = srcById.get(sid);
        fm.push(
          `  - id: ${yamlString(`src-${sid.slice(0, 8)}`)}`,
          `    resource: ${yamlString(s?.uri ?? `kitsuden:brain/sources/${sid}`)}`
        );
        if (s?.title) fm.push(`    title: ${yamlString(s.title)}`);
        if (s?.createdAt) fm.push(`    last_modified: ${yamlString(iso(s.createdAt))}`);
      }
    }
    fm.push(
      `kitsuden_note_id: ${yamlString(n.id)}`,
      `kitsuden_visibility: ${yamlString(n.visibility)}`
    );
    if (mine.length) {
      fm.push("kitsuden_claims:");
      for (const c of mine) {
        fm.push(
          `  - statement: ${yamlString(c.statement)}`,
          `    source_sha256: ${yamlString(c.sourceSha256)}`,
          `    status: ${yamlString(c.status)}`
        );
      }
    }
    fm.push("---", "");
    const body = [`# ${n.title}`, "", n.content.trim(), ""];
    if (mine.length) {
      body.push("## Claims", "");
      for (const c of mine) {
        const label = c.sourceId ? `[^src-${c.sourceId.slice(0, 8)}]` : "";
        body.push(
          `- ${c.statement}${label ? ` ${label}` : ""}${c.status === "stale" ? " (stale)" : ""}`
        );
      }
      body.push("");
      for (const sid of srcIds) {
        const s = srcById.get(sid);
        body.push(`[^src-${sid.slice(0, 8)}]: ${s?.title ?? s?.uri ?? sid}`);
      }
      body.push("");
    }
    files.push({ path: `${base}.md`, content: [...fm, ...body].join("\n") });
    index.push(`- [${n.title.replace(/[[\]]/g, "")}](/${base}.md) - ${n.visibility} note`);
  }
  files.unshift({
    path: "index.md",
    content: ["---", 'okf_version: "0.2"', "---", "", "# Brain notes", "", ...index, ""].join("\n"),
  });
  return { okfVersion: "0.2", files, notes: notes.length, claims: claims.length };
}
