/**
 * Agent data ledger — per-field decisions, evidence per field, later reviews
 * ============================================================================
 *
 * An agent proposes a record with the evidence for each field; a person accepts
 * or rejects it FIELD BY FIELD (and may edit a value). The mechanism serves any
 * record an agent writes; a kon only adds its vocabulary. Guide:
 * docs/agents/ledger.md. The approval itself (holding, reserving, executing with
 * the agent's identity) stays in lib/approvals.ts; this module is what it calls:
 *
 *   · `recordTarget()`: does this proposal write a record, and how are its
 *     fields laid out? (dataset entries over REST, `kitsuden_create_record` /
 *     `kitsuden_update_record` over MCP, any kon SDK operation with a JSON body);
 *   · `computeFieldDiff()`: field by field against the current row (read AS THE
 *     AGENT by approvals.ts: it never shows what the agent could not read);
 *   · `parseEvidence()`: the optional `_evidence` section of the body;
 *   · `resolveDecisions()` / `applyDecisions()`: the reviewer's choice and the
 *     body that is really executed (only the accepted fields);
 *   · `persistEvidence()` / `evidenceForRows()`: the evidence that stays with each
 *     field of the row once applied, and how provenance reads it;
 *   · later reviews (`ledger_reviews`): a queue job with a run date turns them due.
 */

import { driverFromEnv } from "@kitsuden/engine/src/mail/drivers";
import { MCP_BODY_ARGUMENT } from "@kitsuden/shared";
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";

import { queue, type QueueJob } from "../../../../packages/engine/src/queue";
import { db } from "../db";
import { agentProposals, authUsers, dataSets, fieldEvidence, ledgerReviews } from "../db/schema";
import { registerAgentAction } from "../services/agent-audit";

import { containsSecret } from "./idempotency";
import { logger } from "./logger";

type Proposal = typeof agentProposals.$inferSelect;

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function trim(value: unknown, max = 8 * 1024): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= max) return value;
  return { truncated: true, bytes: text.length, preview: text.slice(0, 1000) };
}

/** An error the caller turns into a 422 (`message` says what is wrong). */
export class LedgerInputError extends Error {}

// ═══════════════════════════════════════════════════════════════════════════
// Evidence
// ═══════════════════════════════════════════════════════════════════════════

/** The optional body section (REST) or argument (MCP) with the evidence. */
export const EVIDENCE_KEY = "_evidence";
export const MAX_EVIDENCE_ITEMS = 200;

export interface Evidence {
  field: string;
  /** A URL or a reference to a document (`doc:contract-2026.pdf#p4`, a source id…). */
  source: string;
  quote: string | null;
  /** 0 to 1. */
  confidence: number | null;
  /** ISO date. */
  retrievedAt: string | null;
}

/**
 * Validates `_evidence`: an array of `{ field, source, quote?|excerpt?,
 * confidence?, retrievedAt? }`. Throws `LedgerInputError` with the first problem
 * (an agent can fix its call); `undefined`/`null` = no evidence.
 */
export function parseEvidence(raw: unknown): Evidence[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LedgerInputError(`${EVIDENCE_KEY} must be an array`);
  if (raw.length > MAX_EVIDENCE_ITEMS)
    throw new LedgerInputError(`${EVIDENCE_KEY} has more than ${MAX_EVIDENCE_ITEMS} items`);
  return raw.map((item, i) => {
    const at = `${EVIDENCE_KEY}[${i}]`;
    if (!plain(item)) throw new LedgerInputError(`${at} must be an object`);
    const field = item.field;
    if (typeof field !== "string" || !field.trim() || field.length > 300)
      throw new LedgerInputError(`${at}.field must be a field name (1-300 chars)`);
    const source = item.source;
    if (typeof source !== "string" || !source.trim() || source.length > 2000)
      throw new LedgerInputError(
        `${at}.source must be a URL or a document reference (1-2000 chars)`
      );
    const quoteRaw = item.quote ?? item.excerpt ?? null;
    if (quoteRaw !== null && typeof quoteRaw !== "string")
      throw new LedgerInputError(`${at}.quote must be text`);
    const confidence = item.confidence ?? null;
    if (
      confidence !== null &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1)
    )
      throw new LedgerInputError(`${at}.confidence must be a number from 0 to 1`);
    const retrieved = item.retrievedAt ?? null;
    let retrievedAt: string | null = null;
    if (retrieved !== null) {
      const d = typeof retrieved === "string" ? new Date(retrieved) : null;
      if (!d || Number.isNaN(d.getTime()))
        throw new LedgerInputError(`${at}.retrievedAt must be an ISO date`);
      retrievedAt = d.toISOString();
    }
    return {
      field: field.trim(),
      source: source.trim(),
      quote: quoteRaw === null ? null : quoteRaw.slice(0, 4000),
      confidence,
      retrievedAt,
    };
  });
}

/**
 * Takes `_evidence` out of what the agent sent, so that the stored (and executed)
 * body is the request without it. Over REST it is a key of the body; over MCP an
 * argument of the tool or, for a kon SDK tool, a key of its `body` argument.
 */
export function splitEvidence(
  channel: "rest" | "mcp",
  body: unknown
): { body: unknown; raw: unknown } {
  if (!plain(body)) return { body, raw: undefined };
  if (EVIDENCE_KEY in body) {
    const { [EVIDENCE_KEY]: raw, ...rest } = body;
    return { body: rest, raw };
  }
  const inner = body[MCP_BODY_ARGUMENT];
  if (channel === "mcp" && plain(inner) && EVIDENCE_KEY in inner) {
    const { [EVIDENCE_KEY]: raw, ...rest } = inner;
    return { body: { ...body, [MCP_BODY_ARGUMENT]: rest }, raw };
  }
  return { body, raw: undefined };
}

// ═══════════════════════════════════════════════════════════════════════════
// What a proposal writes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `entry`       a dataset entry (`title`, editorial fields and `data.<key>`)
 * `mcp-record`  the arguments of `kitsuden_create_record` / `kitsuden_update_record`
 *               (`data.<key>` and `status`; `collection` and `id` address it)
 * `body`        any kon SDK operation: the top-level keys of its JSON body
 */
export type TargetShape = "entry" | "mcp-record" | "body";

export interface RecordTarget {
  kind: "create" | "update";
  shape: TargetShape;
  /** `dataset_entry`, `table:<name>`, `sdk:<kon>`; null if it cannot be told. */
  entity: string | null;
  /** Known for an update of an entry or an MCP record; else read from the result. */
  rowId: string | null;
  /** The record body is `body.body` (a kon SDK tool over MCP), not the body itself. */
  inArgs?: boolean;
  /** The REST PATCH of an entry REPLACES `data`: execution merges over the current row. */
  replacesData?: boolean;
  /** Where approvals.ts reads the current row as the agent (an update). */
  readPath?: string | null;
}

const ENTRY_COLLECTION = /^\/api\/datasets\/([0-9a-f-]{36})\/entries\/?$/i;
const ENTRY_ONE = /^\/api\/datasets\/([0-9a-f-]{36})\/entries\/([0-9a-f-]{36})\/?$/i;
/** Top-level keys of an entry that are fields (the rest the route ignores). */
const ENTRY_TOP = ["title", "status", "sortOrder", "thumbnailId", "ownerId"];

/** The record inside the stored body (`body` itself, or its `body` argument). */
export function recordBody(target: RecordTarget, body: unknown): Record<string, unknown> | null {
  const b = target.inArgs && plain(body) ? body[MCP_BODY_ARGUMENT] : body;
  return plain(b) ? b : null;
}

/**
 * Does this proposal write a record? `null` = no (a delete, a tool that is not
 * a record, a bulk array, a legacy route): it is decided whole, as before.
 */
export async function recordTarget(p: {
  channel: "rest" | "mcp";
  method: string;
  path: string;
  tool?: string | null;
  konId?: string | null;
  body: unknown;
}): Promise<RecordTarget | null> {
  const method = p.method.toUpperCase();
  const path = p.path.split("?")[0]!;
  const viaSdkTool = p.channel === "mcp" && !!p.konId;
  const inArgs = viaSdkTool || undefined;
  const record = inArgs && plain(p.body) ? p.body[MCP_BODY_ARGUMENT] : p.body;

  // Core MCP record tools
  if (p.channel === "mcp" && !p.konId) {
    if (p.tool !== "kitsuden_create_record" && p.tool !== "kitsuden_update_record") return null;
    if (!plain(p.body) || !plain(p.body.data)) return null;
    const kind = p.tool === "kitsuden_create_record" ? "create" : "update";
    const collection = typeof p.body.collection === "string" ? p.body.collection : null;
    const id =
      typeof p.body.id === "string"
        ? p.body.id
        : typeof p.body.entryId === "string"
          ? p.body.entryId
          : null;
    let entity: string | null = null;
    let readPath: string | null = null;
    if (!collection && kind === "update" && id) {
      entity = "dataset_entry"; // legacy `entryId`
    } else if (collection) {
      const [ds] = await db
        .select({ id: dataSets.id })
        .from(dataSets)
        .where(eq(dataSets.slug, collection))
        .limit(1)
        .catch(() => []);
      entity = ds ? "dataset_entry" : `table:${collection}`;
      if (ds && kind === "update" && id && isUuid(id))
        readPath = `/api/datasets/${ds.id}/entries/${id}`;
    }
    return {
      kind,
      shape: "mcp-record",
      entity,
      rowId: kind === "update" ? id : null,
      readPath,
    };
  }

  if (!plain(record)) return null;
  const one = path.match(ENTRY_ONE);
  if (one && method === "PATCH") {
    return {
      kind: "update",
      shape: "entry",
      entity: "dataset_entry",
      rowId: one[2]!,
      inArgs,
      replacesData: true,
      readPath: path,
    };
  }
  if (ENTRY_COLLECTION.test(path) && method === "POST") {
    return { kind: "create", shape: "entry", entity: "dataset_entry", rowId: null, inArgs };
  }
  // Any other kon SDK operation with a JSON object body.
  if (!p.konId || !["POST", "PUT", "PATCH"].includes(method)) return null;
  return {
    kind: method === "POST" ? "create" : "update",
    shape: "body",
    entity: `sdk:${p.konId}`,
    rowId: null,
    inArgs,
    readPath: method === "POST" ? null : path,
  };
}

/** The proposed fields with their values (what the agent asks to write). */
export function proposedFields(target: RecordTarget, body: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (target.shape === "mcp-record") {
    if (!plain(body)) return out;
    if (plain(body.data)) for (const [k, v] of Object.entries(body.data)) out.set(`data.${k}`, v);
    if (body.status !== undefined) out.set("status", body.status);
    return out;
  }
  const r = recordBody(target, body);
  if (!r) return out;
  if (target.shape === "entry") {
    for (const k of ENTRY_TOP) if (r[k] !== undefined) out.set(k, r[k]);
    if (plain(r.data)) for (const [k, v] of Object.entries(r.data)) out.set(`data.${k}`, v);
    return out;
  }
  for (const [k, v] of Object.entries(r)) if (k !== EVIDENCE_KEY) out.set(k, v);
  return out;
}

function currentValue(current: Record<string, unknown>, field: string): unknown {
  if (field.startsWith("data.") && plain(current.data)) return current.data[field.slice(5)];
  return current[field];
}

export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
  /** `add` (no value before), `update`, `remove` (the PATCH of an entry drops the key). */
  change: "add" | "update" | "remove";
}

export interface FieldDiff {
  target: RecordTarget;
  fields: FieldChange[];
  /** The current row could not be read as the agent (status or error). */
  currentUnavailable?: number | string;
}

/**
 * Field by field. `current` is the row as the AGENT reads it (null for a create,
 * or when it could not be read: then every field counts as changed).
 */
export function computeFieldDiff(
  target: RecordTarget,
  body: unknown,
  current: Record<string, unknown> | null,
  unavailable?: number | string
): FieldDiff {
  const fields: FieldChange[] = [];
  const proposed = proposedFields(target, body);
  for (const [field, after] of proposed) {
    if (target.kind === "update" && current) {
      const before = currentValue(current, field);
      if (equal(before, after)) continue;
      fields.push({
        field,
        before: trim(before),
        after: trim(after),
        change: before === undefined ? "add" : "update",
      });
    } else {
      fields.push({
        field,
        after: trim(after),
        change: target.kind === "create" ? "add" : "update",
      });
    }
  }
  // The REST PATCH of an entry replaces `data`: a key the agent left out is removed.
  const r = recordBody(target, body);
  if (target.replacesData && current && r && plain(r.data) && plain(current.data)) {
    for (const [k, before] of Object.entries(current.data)) {
      if (!(k in r.data))
        fields.push({ field: `data.${k}`, before: trim(before), change: "remove" });
    }
  }
  const diff: FieldDiff = { target, fields };
  if (target.kind === "update" && !current && unavailable !== undefined)
    diff.currentUnavailable = unavailable;
  return diff;
}

/** Evidence must name a field the agent proposes (catches typos while it can fix them). */
export function checkEvidenceFields(target: RecordTarget, body: unknown, ev: Evidence[]): void {
  if (ev.length === 0) return;
  const names = new Set(proposedFields(target, body).keys());
  for (const e of ev) {
    if (!names.has(e.field))
      throw new LedgerInputError(
        `${EVIDENCE_KEY}: "${e.field}" is not a field of this request (fields: ${[...names].join(", ") || "none"})`
      );
  }
}

export function readFieldDiff(p: Pick<Proposal, "fieldDiff">): FieldDiff | null {
  const d = p.fieldDiff as FieldDiff | null;
  return d && plain(d) && Array.isArray(d.fields) && plain(d.target) ? d : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// The reviewer's decision
// ═══════════════════════════════════════════════════════════════════════════

export interface FieldDecisionInput {
  field: string;
  decision: "accept" | "reject";
  /** Only with `accept`: the value to apply instead of the agent's. */
  value?: unknown;
}

export interface FieldDecision {
  field: string;
  decision: "accept" | "reject";
  edited: boolean;
  value?: unknown;
}

/**
 * The decision for EVERY field of the diff. A field that is not listed is
 * REJECTED: with a list, only what a person said yes to runs (without a list
 * the caller approves the whole request and never gets here). Throws
 * `LedgerInputError` for an empty list, an unknown or repeated field, a value
 * on a rejection, a value with a secret or a value over 64 KiB.
 */
export function resolveDecisions(diff: FieldDiff, inputs: FieldDecisionInput[]): FieldDecision[] {
  if (inputs.length === 0)
    throw new LedgerInputError(
      "fields is empty: list the fields you accept, or leave fields out to approve the whole request"
    );
  const known = new Map(diff.fields.map((f) => [f.field, f]));
  const given = new Map<string, FieldDecisionInput>();
  for (const d of inputs) {
    if (!known.has(d.field))
      throw new LedgerInputError(`"${d.field}" is not a field of this proposal`);
    if (given.has(d.field)) throw new LedgerInputError(`"${d.field}" is decided twice`);
    if (d.decision !== "accept" && d.decision !== "reject")
      throw new LedgerInputError(`"${d.field}": decision must be accept or reject`);
    if (d.value !== undefined) {
      if (d.decision === "reject")
        throw new LedgerInputError(`"${d.field}": a rejected field takes no value`);
      if (containsSecret({ [d.field.replace(/^data\./, "")]: d.value }) || containsSecret(d.value))
        throw new LedgerInputError(`"${d.field}": the value carries a secret`);
      const text = JSON.stringify(d.value);
      if (text === undefined || text.length > 64 * 1024)
        throw new LedgerInputError(`"${d.field}": the value must be JSON of at most 64 KiB`);
    }
    given.set(d.field, d);
  }
  return diff.fields.map((f) => {
    const d = given.get(f.field);
    if (!d) return { field: f.field, decision: "reject", edited: false };
    const edited = d.decision === "accept" && d.value !== undefined;
    return edited
      ? { field: f.field, decision: "accept", edited: true, value: d.value }
      : { field: f.field, decision: d.decision, edited: false };
  });
}

export function readDecisions(p: Pick<Proposal, "fieldDecisions">): FieldDecision[] | null {
  return Array.isArray(p.fieldDecisions) ? (p.fieldDecisions as FieldDecision[]) : null;
}

/** Does this decision apply a removal (`remove` accepted without a new value)? */
function removes(diff: FieldDiff, d: FieldDecision): boolean {
  return !d.edited && diff.fields.find((f) => f.field === d.field)?.change === "remove";
}

/**
 * The body that is really executed: only the accepted fields, with the edited
 * values. For the REST PATCH of an entry (which replaces `data`), the accepted
 * `data.*` fields are applied over `current` (the row as the agent reads it NOW);
 * without it they cannot be applied and it throws `current_unavailable`.
 */
export function applyDecisions(
  diff: FieldDiff,
  body: unknown,
  decisions: FieldDecision[],
  current: Record<string, unknown> | null
): unknown {
  const t = diff.target;
  const accepted = decisions.filter((d) => d.decision === "accept");
  const rejected = new Set(decisions.filter((d) => d.decision === "reject").map((d) => d.field));
  const editedValue = new Map(accepted.filter((d) => d.edited).map((d) => [d.field, d.value]));

  if (t.shape === "mcp-record") {
    const args = clone(plain(body) ? body : {}) as Record<string, unknown>;
    const data = plain(args.data) ? args.data : {};
    for (const k of Object.keys(data)) if (rejected.has(`data.${k}`)) delete data[k];
    for (const [f, v] of editedValue) if (f.startsWith("data.")) data[f.slice(5)] = v;
    args.data = data;
    if (rejected.has("status")) delete args.status;
    if (editedValue.has("status")) args.status = editedValue.get("status");
    return args;
  }

  const outer = clone(plain(body) ? body : {}) as Record<string, unknown>;
  const original = (t.inArgs ? outer[MCP_BODY_ARGUMENT] : outer) as Record<string, unknown>;
  let record: Record<string, unknown>;

  if (t.shape === "entry" && t.replacesData) {
    // Only what was accepted, over the current row.
    record = {};
    for (const d of accepted) {
      if (d.field.startsWith("data.")) continue;
      record[d.field] = d.edited ? d.value : original[d.field];
    }
    const dataDecisions = accepted.filter((d) => d.field.startsWith("data."));
    if (dataDecisions.length > 0) {
      if (!current) throw new Error("current_unavailable");
      const data = clone(plain(current.data) ? current.data : {}) as Record<string, unknown>;
      const proposed = plain(original.data) ? original.data : {};
      for (const d of dataDecisions) {
        const k = d.field.slice(5);
        if (removes(diff, d)) delete data[k];
        else data[k] = d.edited ? d.value : proposed[k];
      }
      record.data = data;
    }
  } else {
    record = clone(original);
    for (const f of rejected) {
      if (f.startsWith("data.") && t.shape === "entry" && plain(record.data))
        delete record.data[f.slice(5)];
      else delete record[f];
    }
    for (const [f, v] of editedValue) {
      if (f.startsWith("data.") && t.shape === "entry") {
        record.data = plain(record.data) ? record.data : {};
        (record.data as Record<string, unknown>)[f.slice(5)] = v;
      } else record[f] = v;
    }
  }
  if (t.inArgs) {
    outer[MCP_BODY_ARGUMENT] = record;
    return outer;
  }
  return record;
}

/** The value that ended up in a field (the edited one, or the agent's). */
export function appliedValue(
  target: RecordTarget,
  body: unknown,
  field: string,
  decisions: FieldDecision[] | null
): unknown {
  const d = decisions?.find((x) => x.field === field);
  if (d?.edited) return d.value;
  return proposedFields(target, body).get(field);
}

/** The id of the row the execution wrote, from its result. */
export function rowIdFromResult(target: RecordTarget, resultBody: unknown): string | null {
  if (target.rowId) return target.rowId;
  const idOf = (v: unknown): string | null => {
    if (!plain(v)) return null;
    const id = v.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
  };
  const direct = idOf(resultBody);
  if (direct) return direct;
  if (plain(resultBody)) {
    const sc = resultBody.structuredContent;
    const fromSc = idOf(sc) ?? (plain(sc) ? idOf(sc.body) : null);
    if (fromSc) return fromSc;
    const content = resultBody.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        const text = plain(c) && typeof c.text === "string" ? c.text : "";
        const m = text.match(/Created (?:dataset|native) record: ([\w-]+)/);
        if (m) return m[1]!;
        try {
          const id = idOf(JSON.parse(text));
          if (id) return id;
        } catch {
          /* not JSON */
        }
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Evidence kept with the row
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After a successful execution: the evidence of each ACCEPTED field goes with the
 * row (`field_evidence`). Written by the system (no request context), so the
 * table's RLS lets nobody else write it. Best-effort: the data is already applied.
 */
export async function persistEvidence(p: {
  proposal: Proposal;
  diff: FieldDiff | null;
  target: RecordTarget;
  evidence: Evidence[];
  decisions: FieldDecision[] | null;
  rowId: string | null;
  acceptedBy: string;
}): Promise<number> {
  if (!p.target.entity || !p.rowId || p.evidence.length === 0) return 0;
  const rejected = new Set(
    (p.decisions ?? []).filter((d) => d.decision === "reject").map((d) => d.field)
  );
  // A field not in the diff (unchanged on an update) was not written by this proposal.
  const inDiff = p.diff ? new Set(p.diff.fields.map((f) => f.field)) : null;
  const rows = p.evidence
    .filter((e) => !rejected.has(e.field) && (!inDiff || inDiff.has(e.field)))
    .map((e) => {
      const edited = !!p.decisions?.find((d) => d.field === e.field && d.edited);
      return {
        entity: p.target.entity!,
        rowId: p.rowId!,
        field: e.field,
        value: (trim(appliedValue(p.target, p.proposal.body, e.field, p.decisions), 16 * 1024) ??
          null) as never,
        source: e.source,
        quote: e.quote,
        confidence: e.confidence,
        retrievedAt: e.retrievedAt ? new Date(e.retrievedAt) : null,
        edited,
        proposalId: p.proposal.id,
        agentId: p.proposal.agentId,
        acceptedBy: p.acceptedBy,
      };
    });
  if (rows.length === 0) return 0;
  await db.insert(fieldEvidence).values(rows);
  return rows.length;
}

/**
 * Evidence of a write that runs at once (an agent in `direct` mode, or a write no
 * rule holds). What `persistDirectEvidence` needs after the write succeeds.
 */
export interface DirectEvidence {
  target: RecordTarget;
  /** The body as executed (without `_evidence`). */
  body: unknown;
  evidence: Evidence[];
}

/**
 * Direct mode: a write that is not held may carry `_evidence` too. When it writes
 * a record (`recordTarget`), the evidence is validated as for a held one (throws
 * `LedgerInputError`, nothing runs) and taken out of the body. `stripped` = the
 * caller must run `body` instead of what it received. Anything else (not a
 * record, no `_evidence`) is left exactly as it came.
 */
export async function prepareDirectEvidence(p: {
  channel: "rest" | "mcp";
  method: string;
  path: string;
  tool?: string | null;
  konId?: string | null;
  body: unknown;
}): Promise<{ body: unknown; stripped: boolean; pending: DirectEvidence | null }> {
  const split = splitEvidence(p.channel, p.body);
  if (split.raw === undefined) return { body: p.body, stripped: false, pending: null };
  const target = await recordTarget({ ...p, body: split.body });
  if (!target) return { body: p.body, stripped: false, pending: null };
  const evidence = parseEvidence(split.raw);
  checkEvidenceFields(target, split.body, evidence);
  return {
    body: split.body,
    stripped: true,
    pending: evidence.length > 0 ? { target, body: split.body, evidence } : null,
  };
}

/**
 * After a direct write succeeded: its evidence stays with the row, like that of
 * an approved proposal, but with no proposal and nobody who accepted it
 * (`proposalId` and `acceptedBy` null: provenance shows it as the agent's own).
 * Best-effort: the data is already written.
 */
export async function persistDirectEvidence(
  d: DirectEvidence,
  rowId: string | null,
  agentId: string
): Promise<number> {
  if (!d.target.entity || !rowId || d.evidence.length === 0) return 0;
  const proposed = proposedFields(d.target, d.body);
  const rows = d.evidence.map((e) => ({
    entity: d.target.entity!,
    rowId,
    field: e.field,
    value: (trim(proposed.get(e.field), 16 * 1024) ?? null) as never,
    source: e.source,
    quote: e.quote,
    confidence: e.confidence,
    retrievedAt: e.retrievedAt ? new Date(e.retrievedAt) : null,
    edited: false,
    proposalId: null,
    agentId,
    acceptedBy: null,
  }));
  await db.insert(fieldEvidence).values(rows);
  return rows.length;
}

export interface FieldEvidenceView {
  source: string;
  quote: string | null;
  confidence: number | null;
  retrievedAt: string | null;
  /** The value the evidence was applied with. */
  value: unknown;
  /** Does the row still hold that value? (`null` = the caller did not say) */
  current: boolean | null;
  edited: boolean;
  proposalId: string | null;
  agentId: string | null;
  acceptedBy: string | null;
  acceptedAt: string;
}

let tableSeen: { ok: boolean; at: number } | null = null;

/** Is `field_evidence` there? (cached; without migration 0068 provenance carries on as before) */
async function evidenceTable(): Promise<boolean> {
  if (tableSeen && (tableSeen.ok || Date.now() - tableSeen.at < 60_000)) return tableSeen.ok;
  try {
    const r = (await db.execute(
      sql`SELECT to_regclass('public.field_evidence') IS NOT NULL AS ok`
    )) as unknown;
    const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{
      ok?: unknown;
    }>;
    tableSeen = { ok: rows[0]?.ok === true, at: Date.now() };
  } catch {
    tableSeen = { ok: false, at: Date.now() };
  }
  return tableSeen.ok;
}

interface Executor {
  select: (...args: never[]) => unknown;
}

/**
 * The newest evidence per field of these rows. `executor` is the request's
 * (its RLS decides what the reader may see); `rows` (optional) lets each field say
 * whether the row still holds the value the evidence backs.
 */
export async function evidenceForRows(
  entity: string,
  rowIds: string[],
  executor: Executor = db as unknown as Executor,
  rows?: Map<string, Record<string, unknown>>
): Promise<Map<string, Record<string, FieldEvidenceView>>> {
  const out = new Map<string, Record<string, FieldEvidenceView>>();
  const ids = [...new Set(rowIds.filter(Boolean))].slice(0, 1000);
  if (ids.length === 0 || !(await evidenceTable())) return out;
  const found = (await (executor as unknown as typeof db)
    .select()
    .from(fieldEvidence)
    .where(and(eq(fieldEvidence.entity, entity), inArray(fieldEvidence.rowId, ids)))
    .orderBy(asc(fieldEvidence.rowId), asc(fieldEvidence.field), desc(fieldEvidence.createdAt))
    .limit(5000)) as Array<typeof fieldEvidence.$inferSelect>;
  for (const e of found) {
    const fields = out.get(e.rowId) ?? {};
    if (fields[e.field]) continue; // the newest one is first
    const row = rows?.get(e.rowId);
    fields[e.field] = {
      source: e.source,
      quote: e.quote,
      confidence: e.confidence,
      retrievedAt: e.retrievedAt ? e.retrievedAt.toISOString() : null,
      value: e.value,
      current: row ? equal(currentValue(row, e.field), e.value) : null,
      edited: e.edited,
      proposalId: e.proposalId,
      agentId: e.agentId,
      acceptedBy: e.acceptedBy,
      acceptedAt: e.acceptedAt.toISOString(),
    };
    out.set(e.rowId, fields);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Later reviews
// ═══════════════════════════════════════════════════════════════════════════

export const REVIEW_QUEUE = "kitsuden-ledger-reviews";
const MAX_REVIEW_DAYS = 366;
const REVIEWABLE = new Set(["executed", "failed", "rejected"]);

export type Review = typeof ledgerReviews.$inferSelect;

/** `reviewAt` → a date in the future, at most a year ahead (or it throws). */
export function reviewDate(raw: unknown, now = Date.now()): Date {
  const d = typeof raw === "string" ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) throw new LedgerInputError("reviewAt must be an ISO date");
  if (d.getTime() <= now + 1000) throw new LedgerInputError("reviewAt must be in the future");
  if (d.getTime() > now + MAX_REVIEW_DAYS * 86_400_000)
    throw new LedgerInputError(`reviewAt must be within ${MAX_REVIEW_DAYS} days`);
  return d;
}

/**
 * Schedules a later look at what was decided on this proposal. The row is the
 * review item; a queue job with that run date turns it `due` (and the listing also
 * counts a scheduled one past its date as due, should the job be lost).
 */
export async function scheduleReview(p: {
  proposal: Proposal;
  dueAt: Date;
  note?: string | null;
  fields?: string[];
  by: string;
}): Promise<Review> {
  if (!REVIEWABLE.has(p.proposal.status))
    throw new LedgerInputError(
      `Only a decided proposal can be reviewed later (this one is ${p.proposal.status})`
    );
  const diff = readFieldDiff(p.proposal);
  const fields = [...new Set(p.fields ?? [])].slice(0, 200);
  if (diff) {
    const known = new Set(diff.fields.map((f) => f.field));
    for (const f of fields)
      if (!known.has(f)) throw new LedgerInputError(`"${f}" is not a field of this proposal`);
  }
  const target = diff?.target ?? null;
  const rowId = target ? rowIdFromResult(target, p.proposal.resultBody) : null;
  const [review] = await db
    .insert(ledgerReviews)
    .values({
      proposalId: p.proposal.id,
      entity: target?.entity ?? null,
      rowId,
      fields,
      note: p.note?.trim() ? p.note.trim().slice(0, 2000) : null,
      dueAt: p.dueAt,
      scheduledBy: p.by,
    })
    .returning();
  try {
    const { id } = await queue.dispatch(
      REVIEW_QUEUE,
      "review.due",
      { reviewId: review!.id },
      {
        delayMs: Math.max(0, p.dueAt.getTime() - Date.now()),
        attempts: 5,
        reason: `Follow-up review of proposal ${p.proposal.id}`,
      }
    );
    await db.update(ledgerReviews).set({ jobId: id }).where(eq(ledgerReviews.id, review!.id));
    review!.jobId = id;
  } catch (err) {
    // The listing still turns it due by its date: the job is the notice, not the truth.
    logger.warn({ err, reviewId: review!.id }, "[ledger] could not queue the review job");
  }
  await registerAgentAction({
    agentId: p.proposal.agentId,
    action: "proposal_review_scheduled",
    resource: `${p.proposal.method} ${p.proposal.path}`,
    resourceId: p.proposal.id,
    details: { by: p.by, reviewId: review!.id, dueAt: p.dueAt.toISOString(), fields },
    success: true,
  }).catch(() => undefined);
  return review!;
}

/** The queue handler: the review is due now. Idempotent. */
export async function markReviewDue(reviewId: string): Promise<boolean> {
  if (!isUuid(reviewId)) return false;
  const [r] = await db
    .update(ledgerReviews)
    .set({ status: "due", becameDueAt: new Date() })
    .where(and(eq(ledgerReviews.id, reviewId), eq(ledgerReviews.status, "scheduled")))
    .returning();
  if (!r) return false;
  const [p] = await db
    .select({
      agentId: agentProposals.agentId,
      method: agentProposals.method,
      path: agentProposals.path,
    })
    .from(agentProposals)
    .where(eq(agentProposals.id, r.proposalId))
    .limit(1);
  await registerAgentAction({
    agentId: p?.agentId ?? null,
    action: "proposal_review_due",
    resource: p ? `${p.method} ${p.path}` : undefined,
    resourceId: r.proposalId,
    details: { reviewId: r.id, by: r.scheduledBy },
    success: true,
  }).catch(() => undefined);
  await notifyReviewDue(r, p ?? null).catch((err) =>
    logger.warn({ err, reviewId: r.id }, "[ledger] could not send the due-review email")
  );
  return true;
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Who hears that a review is due, outside the panel: the person who scheduled
 * it or, if that account is gone, the administrators. Only by email and only
 * when mail is really configured (with the `log`/`memory` driver the panel's
 * Reviews tab is the notice, as before). Once per review: it runs when the
 * review turns due, and that happens once (`scheduled → due`).
 */
export async function reviewDueRecipients(scheduledBy: string): Promise<string[]> {
  const [own] = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, scheduledBy))
    .limit(1);
  if (own?.email) return [own.email];
  const admins = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.role, "admin"))
    .limit(20);
  return admins.map((a) => a.email).filter(Boolean);
}

async function notifyReviewDue(
  r: Review,
  p: { method: string; path: string } | null
): Promise<number> {
  const driver = driverFromEnv(process.env as Record<string, string | undefined>).name;
  if (driver === "log" || driver === "memory") return 0;
  const to = await reviewDueRecipients(r.scheduledBy);
  if (to.length === 0) return 0;
  const panel = (process.env.ADMIN_URL || "http://localhost:5173").replace(/\/$/, "");
  const link = `${panel}/approvals?tab=reviews&id=${encodeURIComponent(r.proposalId)}`;
  const what = p ? `${p.method} ${p.path}` : "an agent proposal";
  const note = r.note ? `\n\nYour note: ${r.note}` : "";
  const subject = "A decision on an agent proposal is due for review";
  const text = `The review you scheduled is due: ${what}.${note}\n\nOpen it: ${link}`;
  const html =
    `<p>The review you scheduled is due: <code>${escapeHtml(what)}</code>.</p>` +
    (r.note ? `<p>Your note: ${escapeHtml(r.note)}</p>` : "") +
    `<p><a href="${escapeHtml(link)}">Open it in the panel</a></p>`;
  const { emailQueue } = await import("./queue");
  let sent = 0;
  for (const address of to) {
    const job = await emailQueue.add("ledger.review-due", { to: address, subject, html, text });
    if (job) sent++;
    else logger.error({ reviewId: r.id }, "[ledger] could not enqueue the due-review email");
  }
  return sent;
}

export function registerLedgerReviews(): void {
  queue.handle(
    REVIEW_QUEUE,
    async (job: QueueJob) => {
      const id = (job.payload as { reviewId?: unknown } | null)?.reviewId;
      if (typeof id === "string") await markReviewDue(id);
    },
    { concurrency: 1 }
  );
}

export type ReviewFilter = "due" | "scheduled" | "done" | "cancelled" | "all";

function reviewWhere(status: ReviewFilter, now = new Date()): SQL | undefined {
  if (status === "due")
    return or(
      eq(ledgerReviews.status, "due"),
      and(eq(ledgerReviews.status, "scheduled"), lte(ledgerReviews.dueAt, now))
    );
  if (status === "scheduled")
    return and(eq(ledgerReviews.status, "scheduled"), sql`${ledgerReviews.dueAt} > ${now}`);
  if (status === "all") return undefined;
  return eq(ledgerReviews.status, status);
}

/** Review items; `due` also counts the scheduled ones past their date. */
export async function listReviews(f: {
  status?: ReviewFilter;
  proposalId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; reviews: Review[] }> {
  const conditions = [reviewWhere(f.status ?? "due")];
  if (f.proposalId) conditions.push(eq(ledgerReviews.proposalId, f.proposalId));
  const where = and(...conditions.filter((c): c is SQL => !!c));
  const reviews = await db
    .select()
    .from(ledgerReviews)
    .where(where)
    .orderBy(asc(ledgerReviews.dueAt))
    .limit(Math.min(Math.max(f.limit ?? 50, 1), 200))
    .offset(Math.max(f.offset ?? 0, 0));
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ledgerReviews)
    .where(where);
  return { total: total?.n ?? 0, reviews };
}

/** A person looked again: the review is done (or cancelled, before its date). */
export async function closeReview(
  id: string,
  by: string,
  comment: string | null | undefined,
  status: "done" | "cancelled" = "done"
): Promise<Review | null> {
  if (!isUuid(id)) return null;
  const [r] = await db
    .update(ledgerReviews)
    .set({
      status,
      doneBy: by,
      doneAt: new Date(),
      doneComment: comment?.trim() ? comment.trim().slice(0, 2000) : null,
    })
    .where(and(eq(ledgerReviews.id, id), inArray(ledgerReviews.status, ["scheduled", "due"])))
    .returning();
  if (!r) return null;
  const [p] = await db
    .select({ agentId: agentProposals.agentId })
    .from(agentProposals)
    .where(eq(agentProposals.id, r.proposalId))
    .limit(1);
  await registerAgentAction({
    agentId: p?.agentId ?? null,
    action: "proposal_review_done",
    resourceId: r.proposalId,
    details: { by, reviewId: r.id, status, comment: r.doneComment },
    success: true,
  }).catch(() => undefined);
  return r;
}

export async function reviewById(id: string): Promise<Review | null> {
  if (!isUuid(id)) return null;
  const [r] = await db.select().from(ledgerReviews).where(eq(ledgerReviews.id, id)).limit(1);
  return r ?? null;
}
