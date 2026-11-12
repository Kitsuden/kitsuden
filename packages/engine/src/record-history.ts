/**
 * Per-record change history — who changed a record, when, and which fields
 * ============================================================================
 *
 * One row of `record_changes` (core migration 0076) per create, update or delete
 * of a record, written at the point of the write:
 *
 *   · dataset entries      packages/core/datasets (create / update / delete entry)
 *   · model records        `modelOperations` (./models.ts)
 *   · explorer writes      apps/api/src/routes/data-explorer.ts
 *   · imports              packages/core/datasets/datasets.import-export.ts
 *   · GraphQL mutations    apps/api/src/routes/graphql.ts
 *   · core MCP record tools apps/api/src/services/mcp-tools.ts (datasets and native tables)
 *   · the kons' `repo()`   ./repository.ts (capped per call, `history: false` to skip)
 *
 * Retention: `pruneRecordHistory`, run hourly by the API
 * (`RECORD_HISTORY_RETENTION_DAYS`, 365 by default, `0` = forever).
 *
 * A record is addressed as the agent data ledger addresses it (`field_evidence`):
 * `dataset_entry` + the entry id, or `table:<name>` + the primary key. A model row
 * and the same row edited through the explorer are ONE record with one history, so
 * both use the table's column names as field names.
 *
 * What is kept is bounded and never a secret:
 *
 *   · only the fields that changed (a create lists the values it set, a delete
 *     the values it removed); timestamps the write itself moves are left out;
 *   · a secret column (`isSecretColumn`: token, password, hash) is listed as
 *     `{ field, redacted: true }` with NO value, and secret keys nested inside a
 *     JSON value are dropped;
 *   · a value over `MAX_VALUE_CHARS` becomes `{ truncated, bytes, preview }`, a
 *     change keeps at most `MAX_FIELDS` fields and `MAX_CHANGE_CHARS` in all.
 *
 * `recordChange` writes as the SYSTEM inside the request's transaction (the
 * table's RLS lets nobody else write) and in a savepoint: the history is part of
 * the write when the write commits, and a failure to record never undoes it.
 */

import { getTableColumns, getTableName, sql } from "drizzle-orm";

import { DB_METRICS_SERVICE, useRequest } from "./request-scope";
import { asSystem, attemptSql } from "./rls-request";
import { isSecretColumn } from "./secret-columns";

export type RecordAction = "create" | "update" | "delete";

export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
  /** A secret column: it changed, and its values are not kept. */
  redacted?: true;
}

export interface RecordActor {
  type: "user" | "agent" | "system";
  id: string | null;
  name: string | null;
}

export interface RecordChange {
  id: string;
  action: RecordAction;
  /** ISO timestamp. */
  at: string;
  actor: RecordActor;
  changes: FieldChange[];
  truncated: boolean;
  /** Set when the write was the execution of an approved proposal. */
  proposalId: string | null;
  approvedBy: string | null;
}

export const RECORD_HISTORY_LIMITS = {
  /** JSON characters of one value before it is cut to a preview. */
  valueChars: 2000,
  previewChars: 200,
  /** Fields kept per change. */
  fields: 60,
  /** JSON characters of the whole `changes` list. */
  changeChars: 48 * 1024,
  /** Entries per page of a read. */
  page: 200,
} as const;

/** The entity of a dataset entry and of a table row, as `field_evidence` names them. */
export const DATASET_ENTRY_ENTITY = "dataset_entry";
export const tableEntity = (table: string) => `table:${table}`;

type Row = Record<string, unknown>;

/** How a dataset entry is diffed: its own fields under `data`, never its keys. */
export const DATASET_ENTRY_DIFF = { nested: "data", skip: ["id", "dataSetId", "createdById"] };

/**
 * How a row of a Drizzle table is addressed in the history: `table:<name>`,
 * with COLUMN names (a Drizzle row comes keyed by property: `kpiName` →
 * `kpi_name`), the primary key `id` left out of the diff. The address the
 * explorer and `defineModel` use, so a row has one history whatever wrote it.
 */
export function tableHistoryTarget(table: unknown): {
  entity: string;
  idColumn: string;
  diff: DiffOptions;
  row: (row: Row | null | undefined) => Row | null;
} {
  const name = getTableName(table as never);
  // A dataset entry written as a table row is still a dataset entry: the
  // address and field names its own routes use (`data.<key>`).
  if (name === "data_entries") {
    return {
      entity: DATASET_ENTRY_ENTITY,
      idColumn: "id",
      diff: DATASET_ENTRY_DIFF,
      row: (row) => row ?? null,
    };
  }
  const columns = getTableColumns(table as never) as Record<string, { name: string }>;
  const idColumn = columns.id?.name ?? "id";
  return {
    entity: tableEntity(name),
    idColumn,
    diff: { skip: [idColumn] },
    row: (row) =>
      row
        ? Object.fromEntries(Object.entries(row).map(([k, v]) => [columns[k]?.name ?? k, v]))
        : null,
  };
}

/** Rows one bulk call may write and still be recorded, one history row each. */
export const BULK_HISTORY_CAP = 500;

/**
 * The changes of rows written to a Drizzle table, as `recordChanges` inputs.
 * More than `BULK_HISTORY_CAP` changes in one call → none (a bulk job, not an edit).
 */
export function tableChanges(
  table: unknown,
  changes: Array<{ action: RecordAction; before?: Row | null; after?: Row | null }>,
  user: unknown
): RecordChangeInput[] {
  if (changes.length === 0 || changes.length > BULK_HISTORY_CAP) return [];
  const target = tableHistoryTarget(table);
  return changes.map((c) => {
    const before = target.row(c.before);
    const after = target.row(c.after);
    return {
      entity: target.entity,
      rowId: (after ?? before)?.[target.idColumn],
      action: c.action,
      before,
      after,
      user,
      diff: target.diff,
    };
  });
}

/** A row written to some table by a multi-table call (a batch). */
export interface TableWrite {
  table: unknown;
  action: RecordAction;
  before?: Row | null;
  after?: Row | null;
}

/**
 * `tableChanges` for writes to several tables in one call: all of them, or none
 * when there are more than `BULK_HISTORY_CAP`.
 */
export function tableWritesChanges(writes: TableWrite[], user: unknown): RecordChangeInput[] {
  if (writes.length === 0 || writes.length > BULK_HISTORY_CAP) return [];
  return writes.flatMap((w) => tableChanges(w.table, [w], user));
}

/**
 * `runAsSystem` for `recordChanges` inside a transaction that is not the
 * request's own (a batch opens one): the INSERT goes in a savepoint of `tx`, as
 * the system, and the RLS context the transaction had is put back afterwards.
 * A failed INSERT rolls back only the savepoint, never the batch.
 */
export function systemSavepointOn(tx: {
  transaction(fn: (sp: HistoryExecutor) => Promise<unknown>): Promise<unknown>;
}): (insert: () => Promise<void>) => Promise<void> {
  return async (insert) => {
    await tx.transaction(async (sp) => {
      const [prior] = rowsOf(
        await sp.execute(sql`
          SELECT COALESCE(current_setting('app.current_user_id', true), '') AS id,
                 COALESCE(current_setting('app.current_user_role', true), '') AS role
        `)
      );
      await sp.execute(sql`SELECT set_config('app.current_user_id', '', true),
                                  set_config('app.current_user_role', '', true)`);
      await insert();
      await sp.execute(sql`SELECT set_config('app.current_user_id', ${String(prior?.id ?? "")}, true),
                                  set_config('app.current_user_role', ${String(prior?.role ?? "")}, true)`);
    });
  };
}

const plain = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** Columns every write moves by itself: listing them would bury the real change. */
const BOOKKEEPING = new Set([
  "updatedAt",
  "updated_at",
  "createdAt",
  "created_at",
  "updatedById",
  "updated_by_id",
]);

/** The last segment of a field path (`data.api_token` → `api_token`). */
const leaf = (field: string) => field.slice(field.lastIndexOf(".") + 1);

/** A JSON-safe copy (dates as ISO text) without secret keys, at any depth. */
function scrub(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => scrub(v) ?? null);
  if (typeof value === "object") {
    const out: Row = {};
    for (const [k, v] of Object.entries(value as Row)) {
      if (isSecretColumn(k)) continue;
      const clean = scrub(v);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  return value;
}

const text = (v: unknown): string => JSON.stringify(v ?? null) ?? "null";

function bounded(value: unknown, max: number): { value: unknown; cut: boolean } {
  const t = text(value);
  if (t.length <= max) return { value, cut: false };
  return {
    value: {
      truncated: true,
      bytes: t.length,
      preview: t.slice(0, RECORD_HISTORY_LIMITS.previewChars),
    },
    cut: true,
  };
}

/**
 * A record as flat fields. A dataset entry keeps its own fields under `data`:
 * they become `data.<key>` (the ledger's names). Keys starting with `_` are
 * internal (`_snapshots`, `_schemaVersion`) and left out.
 */
export function flattenRecord(row: Row | null | undefined, nested: string | null = null): Row {
  const out: Row = {};
  if (!row) return out;
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("_")) continue;
    if (nested && key === nested) {
      if (plain(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (!k.startsWith("_")) out[`${nested}.${k}`] = v;
        }
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface DiffOptions {
  /** The key whose object is the record's own fields (`data` for a dataset entry). */
  nested?: string | null;
  /** Only these fields are compared (the columns a PATCH set); default: every field. */
  only?: Iterable<string>;
  /** Fields never listed (the primary key). */
  skip?: Iterable<string>;
}

/**
 * The fields that differ between two versions of a record, redacted and bounded.
 * `before` null = a create (the values it set; nulls are not listed), `after`
 * null = a delete (the values it removed).
 */
export function diffRecord(
  before: Row | null | undefined,
  after: Row | null | undefined,
  options: DiffOptions = {}
): { changes: FieldChange[]; truncated: boolean } {
  const a = flattenRecord(before, options.nested ?? null);
  const b = flattenRecord(after, options.nested ?? null);
  const only = options.only ? new Set(options.only) : null;
  const skip = new Set(options.skip ?? []);
  const create = !before;
  const remove = !after;

  const changes: FieldChange[] = [];
  let truncated = false;
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (BOOKKEEPING.has(field) || skip.has(field)) continue;
    if (only && !only.has(field) && !only.has(field.split(".")[0]!)) continue;
    const x = scrub(a[field]);
    const y = scrub(b[field]);
    if (text(x) === text(y)) continue;
    if (isSecretColumn(leaf(field))) {
      changes.push({ field, redacted: true });
      continue;
    }
    const change: FieldChange = { field };
    if (!create) {
      const cut = bounded(x ?? null, RECORD_HISTORY_LIMITS.valueChars);
      change.before = cut.value;
      truncated ||= cut.cut;
    }
    if (!remove) {
      const cut = bounded(y ?? null, RECORD_HISTORY_LIMITS.valueChars);
      change.after = cut.value;
      truncated ||= cut.cut;
    }
    changes.push(change);
  }

  if (changes.length > RECORD_HISTORY_LIMITS.fields) {
    changes.length = RECORD_HISTORY_LIMITS.fields;
    truncated = true;
  }
  // Many long values together: previews only, then fewer fields.
  if (text(changes).length > RECORD_HISTORY_LIMITS.changeChars) {
    truncated = true;
    for (const c of changes) {
      if ("before" in c) c.before = bounded(c.before, RECORD_HISTORY_LIMITS.previewChars * 2).value;
      if ("after" in c) c.after = bounded(c.after, RECORD_HISTORY_LIMITS.previewChars * 2).value;
    }
    while (changes.length > 1 && text(changes).length > RECORD_HISTORY_LIMITS.changeChars) {
      changes.length = Math.ceil(changes.length / 2);
    }
  }
  return { changes, truncated };
}

/** Who is writing, from the request's `user` (an agent reaches the routes as `role: "agent"`). */
export function actorOf(user: unknown): RecordActor {
  if (!plain(user) || user.id === undefined || user.id === null || user.id === "") {
    return { type: "system", id: null, name: null };
  }
  const name =
    typeof user.name === "string" && user.name
      ? user.name
      : typeof user.email === "string" && user.email
        ? user.email
        : null;
  return {
    type: user.role === "agent" ? "agent" : "user",
    id: String(user.id).slice(0, 300),
    name: name ? name.slice(0, 300) : null,
  };
}

// ── The approved proposal this request executes, if it is one ───────────────────

const APPROVAL_SERVICE = "kitsuden.recordHistory.approval";

export interface ApprovalNote {
  proposalId: string;
  approvedBy: string;
}

/**
 * Called by the host when a request is the execution of an approved proposal:
 * what it writes is recorded with the proposal and who approved it.
 */
export function noteApprovedProposal(approval: ApprovalNote | null | undefined): void {
  const scope = useRequest();
  if (!scope || !approval) return;
  scope.services ??= {};
  scope.services[APPROVAL_SERVICE] = approval;
}

function approvalOfRequest(): ApprovalNote | null {
  const note = useRequest()?.services?.[APPROVAL_SERVICE] as ApprovalNote | undefined;
  return note && typeof note.proposalId === "string" ? note : null;
}

// ── Writing ─────────────────────────────────────────────────────────────────────

/** The minimum of a Drizzle connection. */
export interface HistoryExecutor {
  execute(query: unknown): Promise<unknown>;
}

export interface RecordChangeInput {
  entity: string;
  rowId: unknown;
  action: RecordAction;
  /** The row before the write (null for a create). */
  before?: Row | null;
  /** The row after the write (null for a delete). */
  after?: Row | null;
  /** The request's `user`. */
  user?: unknown;
  diff?: DiffOptions;
  onFailure?: (err: unknown) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The values of one `record_changes` row, or null when there is nothing to record. */
function prepare(input: RecordChangeInput, approval: ApprovalNote | null) {
  const rowId = input.rowId === undefined || input.rowId === null ? "" : String(input.rowId);
  if (!rowId || rowId.length > 300 || !input.entity || input.entity.length > 300) return null;

  const { changes, truncated } = diffRecord(
    input.action === "create" ? null : (input.before ?? {}),
    input.action === "delete" ? null : (input.after ?? {}),
    input.diff
  );
  if (input.action === "update" && changes.length === 0) return null;

  const actor = actorOf(input.user);
  const proposalId = approval && UUID.test(approval.proposalId) ? approval.proposalId : null;
  const approvedBy = proposalId ? String(approval!.approvedBy ?? "").slice(0, 300) || null : null;
  return sql`(${input.entity}, ${rowId}, ${input.action}, ${actor.type}, ${actor.id}, ${actor.name},
    ${JSON.stringify(changes)}::jsonb, ${truncated}, ${proposalId}::uuid, ${approvedBy})`;
}

/** Rows per INSERT when many records are written at once (a bulk create). */
const INSERT_BATCH = 100;

/**
 * Records the changes of several records in one go (one INSERT per 100). An
 * update that changed nothing (or only bookkeeping columns) writes no row. Never
 * throws: `onFailure` gets the error. Returns how many rows were written.
 */
export async function recordChanges(
  executor: HistoryExecutor,
  inputs: RecordChangeInput[],
  onFailure?: (err: unknown) => void,
  /**
   * How to run the INSERT as the system in a transaction that is not the
   * request's (the MCP tools open their own). Default: `asSystem` in a savepoint
   * of the request's transaction.
   */
  runAsSystem?: (fn: () => Promise<void>) => Promise<void>
): Promise<number> {
  const approval = approvalOfRequest();
  const rows = inputs.map((input) => prepare(input, approval)).filter((r) => r !== null);
  if (rows.length === 0) return 0;
  const failed = (err: unknown) => {
    // The caller's logger must not turn a lost history row into a failed write.
    try {
      onFailure?.(err);
    } catch {
      /* nothing to do */
    }
  };
  const insert = async () => {
    // The glass box counts the rows a request's writes touched: the history is
    // bookkeeping, not one of them. Its own INSERTs are left out of the count.
    const measures = useRequest()?.services?.[DB_METRICS_SERVICE] as { rows?: number } | undefined;
    const counted = measures?.rows;
    try {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await executor.execute(sql`
          INSERT INTO record_changes
            (entity, row_id, action, actor_type, actor_id, actor_name, changes, truncated,
             proposal_id, approved_by)
          VALUES ${sql.join(rows.slice(i, i + INSERT_BATCH), sql`, `)}
        `);
      }
    } finally {
      if (measures && typeof counted === "number") measures.rows = counted;
    }
  };
  if (runAsSystem) {
    try {
      await runAsSystem(insert);
      return rows.length;
    } catch (err) {
      failed(err);
      return 0;
    }
  }
  return attemptSql(
    async () => {
      await asSystem(insert);
      return rows.length;
    },
    0,
    failed
  );
}

/** Records one change of one record (see `recordChanges`). Returns whether a row was written. */
export async function recordChange(
  executor: HistoryExecutor,
  input: RecordChangeInput
): Promise<boolean> {
  return (await recordChanges(executor, [input], input.onFailure)) > 0;
}

// ── Retention ───────────────────────────────────────────────────────────────────

/** Days a history row is kept when `RECORD_HISTORY_RETENTION_DAYS` does not say. */
export const DEFAULT_RECORD_HISTORY_RETENTION_DAYS = 365;

/**
 * Days a `record_changes` row is kept: `RECORD_HISTORY_RETENTION_DAYS`. Unset,
 * empty or not a number = 365; `0` = kept forever (the convention of
 * `AGENT_KEY_DEFAULT_EXPIRY_DAYS`: empty is the default, `0` is never). Returns
 * `null` for "forever".
 */
export function recordHistoryRetentionDays(
  env: Record<string, string | undefined> = process.env
): number | null {
  const raw = env.RECORD_HISTORY_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RECORD_HISTORY_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RECORD_HISTORY_RETENTION_DAYS;
  if (n === 0) return null;
  return Math.max(1, Math.floor(n));
}

/** Rows deleted per statement, and statements per prune, so a prune never holds a long lock. */
const PRUNE_BATCH = 5000;
const PRUNE_ROUNDS = 40;

/**
 * Deletes the history rows older than `days`. Run it as the system (the global
 * connection, never inside a request: only the system may delete these rows).
 * `null` deletes nothing. At most `PRUNE_BATCH * PRUNE_ROUNDS` rows per call;
 * the next sweep takes the rest. Returns how many rows were deleted.
 */
export async function pruneRecordHistory(
  executor: HistoryExecutor,
  days: number | null = recordHistoryRetentionDays()
): Promise<number> {
  if (days === null || !Number.isFinite(days) || days <= 0) return 0;
  const whole = Math.floor(days);
  let deleted = 0;
  for (let round = 0; round < PRUNE_ROUNDS; round++) {
    const result = await executor.execute(sql`
      DELETE FROM record_changes
       WHERE id IN (
         SELECT id FROM record_changes
          WHERE created_at < now() - make_interval(days => ${whole}::int)
          LIMIT ${PRUNE_BATCH}
       )
    `);
    const n = Number((result as { rowCount?: number } | null)?.rowCount ?? 0);
    deleted += n;
    if (n < PRUNE_BATCH) break;
  }
  return deleted;
}

// ── Reading ─────────────────────────────────────────────────────────────────────

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

const iso = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const ACTOR_TYPES = new Set(["user", "agent", "system"]);

function toChange(row: Row): RecordChange {
  const stored = typeof row.changes === "string" ? safeParse(row.changes) : row.changes;
  const type = ACTOR_TYPES.has(String(row.actor_type)) ? String(row.actor_type) : "system";
  return {
    id: String(row.id),
    action: String(row.action) as RecordAction,
    at: iso(row.created_at),
    actor: {
      type: type as RecordActor["type"],
      id: row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id),
      name: row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name),
    },
    changes: Array.isArray(stored) ? (stored as FieldChange[]) : [],
    truncated: row.truncated === true,
    proposalId:
      row.proposal_id === null || row.proposal_id === undefined ? null : String(row.proposal_id),
    approvedBy:
      row.approved_by === null || row.approved_by === undefined ? null : String(row.approved_by),
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export interface RecordHistoryPage {
  history: RecordChange[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The history of one record, newest first. It runs on `executor` AS GIVEN: inside
 * a request's transaction the table's RLS decides what the caller may read. The
 * caller must already have checked that the record itself is visible.
 */
export async function readRecordHistory(
  executor: HistoryExecutor,
  entity: string,
  rowId: string,
  page: { limit?: number; offset?: number } = {}
): Promise<RecordHistoryPage> {
  const limit = Math.min(
    Math.max(Math.trunc(Number(page.limit)) || 50, 1),
    RECORD_HISTORY_LIMITS.page
  );
  const offset = Math.max(Math.trunc(Number(page.offset)) || 0, 0);
  const empty: RecordHistoryPage = { history: [], total: 0, limit, offset };
  if (!entity || !rowId) return empty;
  return attemptSql(async () => {
    const found = rowsOf(
      await executor.execute(sql`
        SELECT id, action, actor_type, actor_id, actor_name, changes, truncated,
               proposal_id, approved_by, created_at
          FROM record_changes
         WHERE entity = ${entity} AND row_id = ${rowId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit} OFFSET ${offset}
      `)
    );
    const counted = rowsOf(
      await executor.execute(sql`
        SELECT count(*)::int AS n FROM record_changes
         WHERE entity = ${entity} AND row_id = ${rowId}
      `)
    );
    return { history: found.map(toChange), total: Number(counted[0]?.n ?? 0), limit, offset };
  }, empty);
}
