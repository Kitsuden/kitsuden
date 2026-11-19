/**
 * What a human approves, as one hash — and the approver's signature over it
 * ============================================================================
 *
 * A proposal (lib/approvals.ts) is shown to a person, who approves it; later the
 * stored row is executed. Nothing tied the two together: a row changed between
 * showing and executing (direct database access, a bug, a race) ran whatever it
 * held by then. Migration 0087 and docs/agents/approvals.md ("Binding").
 *
 *   operation hash  sha256 of the CANONICAL JSON of the operation: channel,
 *                   method, path with its query, content type, body, tool,
 *                   operation key and the sha256 of each held file. Computed when
 *                   the proposal is stored; recomputed from the row before it
 *                   executes. Canonical: object keys sorted, no whitespace, so
 *                   the order Postgres `jsonb` gives the keys back does not
 *                   change it.
 *   approval MAC    HMAC-SHA256 over proposal id, operation hash, approver,
 *                   decision time and the hash of the per-field decisions,
 *                   with a subkey of `KITSUDEN_SECRETS_KEY` (lib/secrets-key.ts).
 *                   A row edited after approval no longer verifies.
 *
 * Pure: no database, no environment. The key is passed in.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Bump when the canonical form changes (old hashes stop matching on purpose). */
export const OPERATION_HASH_VERSION = 1;

/**
 * JSON with object keys sorted (by UTF-16 code units) and no whitespace.
 * Follows `JSON.stringify` for everything else: `undefined`, functions and
 * symbols are dropped from objects and become `null` in arrays, non-finite
 * numbers become `null`, `toJSON` (Date) is honoured.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set()) ?? "null";
}

function encode(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return "null";
  if (value === undefined || typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (typeof value === "bigint") throw new TypeError("canonicalJson: BigInt is not JSON");
  if (typeof value !== "object") return JSON.stringify(value);
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") return encode(withToJson.toJSON(), seen);
  if (seen.has(value)) throw new TypeError("canonicalJson: circular structure");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => encode(v, seen) ?? "null").join(",")}]`;
    }
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const v = encode((value as Record<string, unknown>)[key], seen);
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${v}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export const sha256Hex = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");

/** The operation as stored in `agent_proposals` (plus its held files). */
export interface OperationInput {
  channel: string;
  method: string;
  /** With its query (`/api/x?y=1`), or `mcp:<tool>`. */
  path: string;
  contentType: string | null | undefined;
  body: unknown;
  tool: string | null | undefined;
  operationKey: string | null | undefined;
  /** sha256 (hex) of each held file, in their order. */
  files?: readonly string[] | null;
}

/** The object that is hashed (exported for the docs and the tests). */
export function operationDocument(o: OperationInput) {
  return {
    v: OPERATION_HASH_VERSION,
    channel: o.channel,
    method: o.method.toUpperCase(),
    path: o.path,
    contentType: o.contentType ?? null,
    body: o.body === undefined ? null : o.body,
    tool: o.tool ?? null,
    operationKey: o.operationKey ?? null,
    files: [...(o.files ?? [])],
  };
}

export function operationHash(o: OperationInput): string {
  return sha256Hex(canonicalJson(operationDocument(o)));
}

/**
 * The hash of what the approver decided per field, together with the per-field
 * diff those decisions apply to. `null` for both when the proposal was approved
 * whole.
 */
export function decisionsHash(fieldDecisions: unknown, fieldDiff: unknown): string {
  return sha256Hex(
    canonicalJson({ fieldDecisions: fieldDecisions ?? null, fieldDiff: fieldDiff ?? null })
  );
}

export interface ApprovalBinding {
  proposalId: string;
  /** `null` for a proposal stored before 0087 (legacy): it signs the empty string. */
  operationHash: string | null;
  decidedBy: string;
  decidedAt: Date;
  decisionsHash: string;
}

function macMessage(b: ApprovalBinding): string {
  return [
    `kitsuden-approval-v${OPERATION_HASH_VERSION}`,
    b.proposalId,
    b.operationHash ?? "",
    b.decidedBy,
    b.decidedAt.toISOString(),
    b.decisionsHash,
  ].join("|");
}

export function approvalMac(key: Uint8Array, b: ApprovalBinding): string {
  return createHmac("sha256", key).update(macMessage(b)).digest("hex");
}

export function verifyApprovalMac(
  key: Uint8Array,
  b: ApprovalBinding,
  mac: string | null | undefined
): boolean {
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const expected = Buffer.from(approvalMac(key, b), "hex");
  return timingSafeEqual(expected, Buffer.from(mac, "hex"));
}

/** Same JSON value, whatever the key order? */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a === undefined ? null : a) === canonicalJson(b === undefined ? null : b);
}
