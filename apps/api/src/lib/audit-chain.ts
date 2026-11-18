/**
 * The agent audit log as a verifiable hash chain
 * ============================================================================
 *
 * Every row of `agent_audit_logs` written since migration 0088 carries:
 *
 *   · `seq`         1, 2, 3… for the whole table, with no gaps;
 *   · `prev_hash`   the previous row's `row_hash` (64 zeros for the first one,
 *                   or a checkpoint's `row_hash` after a retention prune);
 *   · `row_hash`    sha256 (hex) of `canonicalRow()`: the audited fields and
 *                   `prev_hash`, in a fixed order, with `details` serialized
 *                   with sorted keys;
 *   · `mac`         HMAC-SHA256 (hex) of `row_hash` with a key derived from
 *                   KITSUDEN_SECRETS_KEY (HKDF, its own label: it is never the
 *                   encryption key);
 *   · `key_version` a fingerprint of that key, so it can rotate.
 *
 * Who writes: services/agent-audit.ts (one transaction per batch, under the
 * advisory lock `AUDIT_CHAIN_LOCK`). Who checks: `verifyAuditChain()` here,
 * `GET /api/admin/audit/verify` and `bun run scripts/verify-audit.ts`.
 * Design and threat model: docs/agents/audit-chain.md.
 *
 * The pure part (canonical form, hash, MAC, keys, `verifyRows`) has no database
 * import, so unit tests load it without one; the database is imported lazily.
 */

import { createHash, createHmac, hkdfSync } from "node:crypto";

import { masterSecretValue } from "./secrets-key";

type Env = Record<string, string | undefined>;

/** The `prev_hash` of the first row of a chain that was never pruned. */
export const GENESIS_HASH = "0".repeat(64);

/** The advisory lock writers and the prune take (same constant in 0088). */
export const AUDIT_CHAIN_LOCK = 7243290401;

/** Version of the canonical form; part of what is hashed. */
const CANONICAL_VERSION = "kitsuden-audit-v1";

// ═══════════════════════════════════════════════════════════════════════════
// Canonical form
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JSON with object keys sorted (recursively) and `undefined` members dropped.
 * Numbers and strings as `JSON.stringify` writes them. Applied to values that
 * already went through `toStoredJson`, it gives the same text for what was
 * written and for what Postgres returns from the jsonb column (jsonb reorders
 * keys; values that survive a JSON round trip compare equal).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Postgres rejects NUL in text and in jsonb strings: it becomes U+FFFD. */
function withoutNul(s: string): string {
  // split/join instead of a regex: no control character in a pattern (no-control-regex).
  return s.includes("\u0000") ? s.split("\u0000").join("�") : s;
}

function cleanStrings(v: unknown): unknown {
  if (typeof v === "string") return withoutNul(v);
  if (Array.isArray(v)) return v.map(cleanStrings);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[withoutNul(k)] = cleanStrings(x);
    return out;
  }
  return v;
}

/**
 * `details` exactly as it will be stored: a JSON round trip (Dates become
 * strings, `undefined` disappears, NaN becomes null) without NUL characters.
 * The hash is computed from THIS value, never from what the caller passed.
 */
export function toStoredJson(details: unknown): Record<string, unknown> {
  if (details === undefined || details === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(details));
  } catch {
    // A cycle or a BigInt: the caller's object cannot be stored as JSON.
    return { unserializable: true };
  }
  const clean = cleanStrings(parsed);
  return clean && typeof clean === "object" && !Array.isArray(clean)
    ? (clean as Record<string, unknown>)
    : { value: clean };
}

/** The audited fields of a row, as stored. */
export interface AuditedFields {
  id: string;
  seq: number;
  createdAt: Date;
  agentId: string | null;
  keyId: string | null;
  action: string;
  resource: string | null;
  resourceId: string | null;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  prevHash: string;
}

/** A text column as stored: NUL replaced, `undefined` as NULL. */
export function storedText(v: string | null | undefined): string | null {
  return typeof v === "string" ? withoutNul(v) : null;
}

/** `duration_ms` is an `integer`: the value Postgres would keep, decided here. */
export function storedInteger(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return Math.max(-2147483648, Math.min(2147483647, n));
}

/** The text that is hashed. Fixed order; every value from the stored row. */
export function canonicalRow(f: AuditedFields): string {
  return canonicalJson([
    CANONICAL_VERSION,
    String(f.seq),
    f.id.toLowerCase(),
    f.createdAt.toISOString(),
    f.agentId,
    f.keyId,
    f.action,
    f.resource,
    f.resourceId,
    f.details ?? null,
    f.ipAddress,
    f.userAgent,
    f.durationMs,
    f.success,
    f.errorMessage,
    f.prevHash,
  ]);
}

export function rowHash(f: AuditedFields): string {
  return createHash("sha256").update(canonicalRow(f), "utf8").digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════════
// Keys
// ═══════════════════════════════════════════════════════════════════════════

export interface AuditKey {
  key: Buffer;
  /** 16 hex characters: identifies the key without revealing it. */
  version: string;
  /** In a keyring: 0 = the current key, higher = older. */
  rank?: number;
}

/** Without any secret configured (development only): a known key, flagged. */
const UNKEYED_RAW = "kitsuden-audit-unkeyed";
export const UNKEYED_VERSION = "unkeyed";

/** The MAC subkey: HKDF-SHA256 of the master value, with its own salt and label. */
export function auditKeyFromMaster(raw: string): AuditKey {
  const key = Buffer.from(
    hkdfSync("sha256", raw, "kitsuden-audit-chain", "agent-audit-mac-v1", 32)
  );
  const version =
    raw === UNKEYED_RAW
      ? UNKEYED_VERSION
      : createHmac("sha256", key).update("kitsuden-audit-key-version").digest("hex").slice(0, 16);
  return { key, version };
}

/** The key new rows are signed with: from KITSUDEN_SECRETS_KEY (or its development fallback). */
export function currentAuditKey(env: Env = process.env): AuditKey {
  return auditKeyFromMaster(masterSecretValue(env) ?? UNKEYED_RAW);
}

/**
 * Every key a row may have been signed with, newest first: the current one
 * (rank 0), the previous master (`KITSUDEN_SECRETS_KEY_OLD`, the re-key's
 * variable), the session secret (what the master was derived from before a
 * dedicated key existed) and the development fallback. Along the chain the rank
 * may only go down (older key, then newer key); a row signed with an older key
 * AFTER one signed with a newer key is refused (see `checkMac`). So holding an
 * old key, or the session secret, does not let anyone add or rewrite rows
 * after the rotation.
 */
export function auditKeyring(env: Env = process.env): Map<string, AuditKey> {
  const ring = new Map<string, AuditKey>();
  const raws = [
    masterSecretValue(env),
    env["KITSUDEN_SECRETS_KEY_OLD"],
    env["BETTER_AUTH_SECRET"],
    UNKEYED_RAW,
  ];
  for (const raw of raws) {
    if (!raw?.trim()) continue;
    const k = auditKeyFromMaster(raw);
    if (!ring.has(k.version)) ring.set(k.version, { ...k, rank: ring.size });
  }
  return ring;
}

export function macOf(key: Buffer, hash: string): string {
  return createHmac("sha256", key).update(hash, "utf8").digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════════
// Verification (pure)
// ═══════════════════════════════════════════════════════════════════════════

export type ChainFailure =
  "hash_mismatch" | "mac_mismatch" | "seq_gap" | "prev_hash_mismatch" | "checkpoint_mismatch";

export interface StoredChainRow extends Omit<AuditedFields, "seq" | "prevHash"> {
  seq: number | null;
  prevHash: string | null;
  rowHash: string | null;
  mac: string | null;
  keyVersion: string | null;
}

export interface VerifyState {
  /** The seq the next row must have. */
  expectedSeq: number;
  /** The row_hash the next row must point to. */
  prevHash: string;
  checked: number;
  /** The newest key (lowest rank) seen so far: an older one after it is refused. */
  minRank: number;
  unkeyedRows: number;
}

export interface VerifyFailure {
  reason: ChainFailure;
  firstBadSeq: number;
  detail: string;
}

export function startState(expectedSeq: number, prevHash: string): VerifyState {
  return {
    expectedSeq,
    prevHash,
    checked: 0,
    minRank: Number.MAX_SAFE_INTEGER,
    unkeyedRows: 0,
  };
}

/** Checks one MAC against the keyring and the rotation order. */
export function checkMac(
  keyring: Map<string, AuditKey>,
  state: VerifyState,
  version: string | null,
  hash: string,
  mac: string | null
): string | null {
  if (!version || !mac) return "row has no MAC";
  const k = keyring.get(version);
  if (!k)
    return `signed with key ${version}, which is not configured (KITSUDEN_SECRETS_KEY / KITSUDEN_SECRETS_KEY_OLD)`;
  const rank = k.rank ?? 0;
  if (rank > state.minRank) return `signed with key ${version} after a newer key had been used`;
  if (macOf(k.key, hash) !== mac) return "MAC does not match";
  state.minRank = rank;
  if (version === UNKEYED_VERSION) state.unkeyedRows++;
  return null;
}

/**
 * Walks consecutive chained rows (ordered by seq) from `state`. Returns the
 * first failure, or null; `state` advances past every row that verified.
 */
export function verifyRows(
  rows: StoredChainRow[],
  state: VerifyState,
  keyring: Map<string, AuditKey>
): VerifyFailure | null {
  for (const row of rows) {
    if (row.seq !== state.expectedSeq) {
      return {
        reason: "seq_gap",
        firstBadSeq: state.expectedSeq,
        detail: `expected seq ${state.expectedSeq}, found ${row.seq}`,
      };
    }
    if (row.prevHash !== state.prevHash) {
      return {
        reason: "prev_hash_mismatch",
        firstBadSeq: row.seq,
        detail: "prev_hash is not the previous row's row_hash",
      };
    }
    const computed = rowHash({ ...row, seq: row.seq, prevHash: row.prevHash });
    if (computed !== row.rowHash) {
      return {
        reason: "hash_mismatch",
        firstBadSeq: row.seq,
        detail: "the stored fields do not hash to row_hash: the row was changed",
      };
    }
    const macProblem = checkMac(keyring, state, row.keyVersion, computed, row.mac);
    if (macProblem) {
      return { reason: "mac_mismatch", firstBadSeq: row.seq, detail: macProblem };
    }
    state.prevHash = computed;
    state.expectedSeq++;
    state.checked++;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Against the database
// ═══════════════════════════════════════════════════════════════════════════

export interface ChainHead {
  seq: number;
  rowHash: string;
  mac: string;
  keyVersion: string;
  createdAt: string | null;
  /** `checkpoint` when every chained row has been pruned. */
  source: "row" | "checkpoint" | "genesis";
}

export interface AuditVerifyResult {
  ok: boolean;
  /** Chained rows verified. */
  checked: number;
  firstBadSeq?: number;
  reason?: ChainFailure;
  detail?: string;
  /** The first and last seq looked at. */
  fromSeq?: number;
  toSeq?: number;
  /** The checkpoint the chain starts from, if it was pruned. */
  checkpointSeq?: number;
  /** Rows written before 0088: not chained, not verified. */
  legacyRows: number;
  /** Rows signed with the development fallback key (no secret configured). */
  unkeyedRows: number;
  head: ChainHead | null;
}

interface Executor {
  execute: (q: unknown) => Promise<unknown>;
}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r)
    ? (r as Record<string, unknown>[])
    : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

async function database(): Promise<{ db: Executor; sql: typeof import("drizzle-orm").sql }> {
  const [{ db }, { sql }] = await Promise.all([import("../db"), import("drizzle-orm")]);
  return { db: db as unknown as Executor, sql };
}

function toStoredRow(r: Record<string, unknown>): StoredChainRow {
  const created = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
  let details = r.details;
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch {
      /* compared as it is */
    }
  }
  return {
    id: String(r.id),
    seq: num(r.seq),
    createdAt: created,
    agentId: (r.agent_id as string | null) ?? null,
    keyId: (r.key_id as string | null) ?? null,
    action: String(r.action),
    resource: (r.resource as string | null) ?? null,
    resourceId: (r.resource_id as string | null) ?? null,
    details: details ?? null,
    ipAddress: (r.ip_address as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
    durationMs: num(r.duration_ms),
    success: r.success === true || r.success === "t",
    errorMessage: (r.error_message as string | null) ?? null,
    prevHash: (r.prev_hash as string | null) ?? null,
    rowHash: (r.row_hash as string | null) ?? null,
    mac: (r.mac as string | null) ?? null,
    keyVersion: (r.key_version as string | null) ?? null,
  };
}

const ROW_COLUMNS = `id, seq, created_at, agent_id, key_id, action, resource, resource_id, details,
  ip_address, user_agent, duration_ms, success, error_message, prev_hash, row_hash, mac, key_version`;

/** The newest link of the chain: the last row or, if all were pruned, the last checkpoint. */
export async function auditChainHead(): Promise<ChainHead | null> {
  const { db, sql } = await database();
  const [row] = rowsOf(
    await db.execute(sql`SELECT seq, row_hash, mac, key_version, created_at FROM agent_audit_logs
      WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1`)
  );
  const [cp] = rowsOf(
    await db.execute(sql`SELECT seq, row_hash, mac, key_version, pruned_at FROM agent_audit_checkpoints
      ORDER BY seq DESC LIMIT 1`)
  );
  const rowSeq = num(row?.seq);
  const cpSeq = num(cp?.seq);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  if (row && rowSeq !== null && (cpSeq === null || rowSeq > cpSeq)) {
    return {
      seq: rowSeq,
      rowHash: String(row.row_hash),
      mac: String(row.mac),
      keyVersion: String(row.key_version),
      createdAt: iso(row.created_at),
      source: "row",
    };
  }
  if (cp && cpSeq !== null) {
    return {
      seq: cpSeq,
      rowHash: String(cp.row_hash),
      mac: String(cp.mac),
      keyVersion: String(cp.key_version),
      createdAt: iso(cp.pruned_at),
      source: "checkpoint",
    };
  }
  return null;
}

const PAGE = 1000;

/**
 * Verifies the chain (or the range `fromSeq..toSeq`): seq without gaps, each
 * prev_hash, each row_hash recomputed from the stored fields, each MAC, and
 * the checkpoint the remaining chain starts from after a prune.
 *
 * What it cannot see on its own: the newest rows removed together (the chain
 * simply ends earlier). Compare `head` with a value anchored outside the
 * database (docs/agents/audit-chain.md).
 */
export async function verifyAuditChain(
  options: { fromSeq?: number; toSeq?: number } = {},
  env: Env = process.env
): Promise<AuditVerifyResult> {
  const { db, sql } = await database();
  const keyring = auditKeyring(env);

  const [legacy] = rowsOf(
    await db.execute(sql`SELECT count(*)::int AS n FROM agent_audit_logs WHERE seq IS NULL`)
  );
  const legacyRows = num(legacy?.n) ?? 0;
  const head = await auditChainHead();
  const [bounds] = rowsOf(
    await db.execute(sql`SELECT min(seq) AS first FROM agent_audit_logs WHERE seq IS NOT NULL`)
  );
  const firstSeq = num(bounds?.first);

  const base = { legacyRows, head, unkeyedRows: 0 };
  if (firstSeq === null) return { ok: true, checked: 0, ...base };

  const fail = (f: VerifyFailure, state: VerifyState, extra: Partial<AuditVerifyResult> = {}) => ({
    ok: false,
    checked: state.checked,
    reason: f.reason,
    firstBadSeq: f.firstBadSeq,
    detail: f.detail,
    ...base,
    unkeyedRows: state.unkeyedRows,
    ...extra,
  });

  // Where to start, and what the first row must point to.
  let state: VerifyState;
  let checkpointSeq: number | undefined;
  const from = options.fromSeq && options.fromSeq > firstSeq ? options.fromSeq : firstSeq;
  if (from > firstSeq) {
    const [prev] = rowsOf(
      await db.execute(sql`SELECT row_hash FROM agent_audit_logs WHERE seq = ${from - 1}`)
    );
    state = startState(from, prev ? String(prev.row_hash) : "");
    if (!prev) {
      return fail(
        { reason: "seq_gap", firstBadSeq: from - 1, detail: `row ${from - 1} is missing` },
        state
      );
    }
  } else if (firstSeq === 1) {
    state = startState(1, GENESIS_HASH);
  } else {
    // Pruned: the first remaining row links to the checkpoint of the last pruned one.
    state = startState(firstSeq, "");
    const [cp] = rowsOf(
      await db.execute(sql`SELECT seq, row_hash, mac, key_version FROM agent_audit_checkpoints
        WHERE seq = ${firstSeq - 1}`)
    );
    if (!cp) {
      return fail(
        {
          reason: "checkpoint_mismatch",
          firstBadSeq: firstSeq,
          detail: `the chain starts at ${firstSeq} and there is no checkpoint for ${firstSeq - 1}: rows were removed outside retention`,
        },
        state
      );
    }
    const problem = checkMac(
      keyring,
      state,
      cp.key_version as string,
      String(cp.row_hash),
      cp.mac as string
    );
    if (problem) {
      return fail(
        {
          reason: "checkpoint_mismatch",
          firstBadSeq: firstSeq,
          detail: `checkpoint ${firstSeq - 1}: ${problem}`,
        },
        state
      );
    }
    checkpointSeq = firstSeq - 1;
    state.prevHash = String(cp.row_hash);
  }

  const to = options.toSeq ?? Number.MAX_SAFE_INTEGER;
  let after = state.expectedSeq - 1;
  for (;;) {
    const page = rowsOf(
      await db.execute(
        sql`SELECT ${sql.raw(ROW_COLUMNS)} FROM agent_audit_logs
             WHERE seq > ${after} AND seq <= ${to} ORDER BY seq LIMIT ${PAGE}`
      )
    ).map(toStoredRow);
    if (page.length === 0) break;
    const failure = verifyRows(page, state, keyring);
    if (failure) return fail(failure, state, { fromSeq: from, checkpointSeq });
    after = page[page.length - 1]!.seq!;
    if (page.length < PAGE) break;
  }

  return {
    ok: true,
    checked: state.checked,
    fromSeq: from,
    toSeq: state.expectedSeq - 1,
    ...(checkpointSeq !== undefined ? { checkpointSeq } : {}),
    ...base,
    unkeyedRows: state.unkeyedRows,
  };
}
