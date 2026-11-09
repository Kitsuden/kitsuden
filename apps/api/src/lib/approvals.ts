/**
 * Human approval of what agents request — the execution
 * ============================================================================
 *
 * The contract (types, default configuration, the decision table) is in
 * `@kitsuden/shared` (`approvals.ts`); the public guide in
 * `docs/agents/approvals.md`. Here:
 *
 *   · the cached CONFIGURATION (re-read every `APPROVALS_CACHE_SECONDS`, 10
 *     by default, and instantly in this process when an admin changes it).
 *     With everything off (the default) an agent request makes NO extra
 *     query: it only costs a cache lookup; a human's, not even that;
 *   · `approvalGate()`: the REST middleware. It goes after authentication,
 *     the gates and the `Idempotency-Key` (so the 202 is stored and a retry
 *     with the same key gets the SAME proposal);
 *   · creating the proposal (body without secrets, cheap diff, deduplicated by
 *     idempotency key or by fingerprint while pending);
 *   · approving (with atomic reservation: two simultaneous approvals execute ONCE),
 *     rejecting and expiring;
 *   · executing with the agent's identity (re-read from the database: scopes of
 *     NOW; if revoked, it is not executed) recording the human;
 *   · UNATTENDED runs (`unattendedDenial`): a request that would be held is
 *     refused with an alternative when the global or the agent's setting is
 *     `deny` and nobody is waiting (a cron/event/HTTP action's sandbox, an agent
 *     run those triggers started, or `Kitsuden-Unattended: true`). See the
 *     contract in @kitsuden/shared `approvals.ts`.
 *
 * ── HOW AN APPROVED PROPOSAL IS EXECUTED ──────────────────────────────────
 *
 * Through the SAME path as the original request:
 *
 *   rest  the request (method, path, body) re-enters the app
 *         (`app.fetch`) with the agent identity set by the process in
 *         the `env` (`INTERNAL_RUN_MARK`, a symbol: it does not arrive from the
 *         network). It goes through denials, gates, operation permission,
 *         RLS and handler again. The only things skipped: this gate and
 *         quotas (already counted when proposing).
 *   mcp   the tool is called again with its arguments and a
 *         reconstructed agent session (see routes/mcp.ts).
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_APPROVALS_CONFIG,
  buildProblem,
  mcpToolKey,
  decideApproval,
  operationDenial,
  isWriteMethod,
  isApprovalMode,
  isSensitive,
  isReadOnly,
  mergeApprovalsConfig,
  defaultSensitiveMcpTool,
  readApprovalsConfig,
  legacyHouseRule,
  operationFineScope,
  decideUnattended,
  pickAlternative,
  isUnattendedMode,
  invalidAlternativeReason,
  type UnattendedMode,
  type ApprovalsConfig,
  type ProposalStatus,
  type ApprovalMode,
  type ProposalReason,
} from "@kitsuden/shared";
import { and, asc, desc, eq, gt, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Context, Next } from "hono";

import { detectRealType } from "../../../../packages/core/media/real-type";
import {
  grantsOperation,
  routeOperation,
  type RouteOperation,
} from "../../../../packages/engine/src/operations";
import { db } from "../db";
import {
  agentIdentities,
  agentProposalFiles,
  agentProposals,
  approvalSettings,
  authUsers,
} from "../db/schema";
import { ADMIN_ONLY_ROUTES, EARLY_ADMIN_ONLY_ROUTES, ruleFor } from "../middleware/auth-guard";
import { registerAgentAction, type AuditAction } from "../services/agent-audit";
import { agentContextForApproval, type AgentAuthContext } from "../services/agent-auth";

import {
  VALID_IDEMPOTENCY_KEY,
  containsSecret,
  bodyWithSecret,
  bodyWithSecretForRoute,
  requestFingerprint,
  routeReceivesSecrets,
} from "./idempotency";
import { enqueueClassification } from "./injection-classifier";
import {
  LedgerInputError,
  applyDecisions,
  checkEvidenceFields,
  EVIDENCE_KEY,
  computeFieldDiff,
  parseEvidence,
  persistDirectEvidence,
  persistEvidence,
  prepareDirectEvidence,
  readDecisions,
  readFieldDiff,
  recordTarget,
  resolveDecisions,
  rowIdFromResult,
  splitEvidence,
  type Evidence,
  type FieldDecision,
  type FieldDecisionInput,
} from "./ledger";
import { logger } from "./logger";
import { notifyResolution } from "./proposal-notifications";

export type Proposal = typeof agentProposals.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// Configuration (cached)
// ═══════════════════════════════════════════════════════════════════════════

export interface ApprovalsSnapshot {
  config: ApprovalsConfig;
  /** Only agents that are NOT on `inherit`. */
  modes: Map<string, ApprovalMode>;
  /** Only agents with their own unattended setting or alternative. */
  unattended: Map<string, AgentUnattended>;
  read: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

const ID_CONFIG = "global";

function cacheLifetimeMs(): number {
  const n = Number(process.env.APPROVALS_CACHE_SECONDS);
  return (Number.isFinite(n) && n >= 0 && n <= 3600 ? n : 10) * 1000;
}

/** An agent's own unattended setting (columns of migration 0066). */
export interface AgentUnattended {
  /** `null` = the global setting. */
  mode: UnattendedMode | null;
  alternative: string | null;
}

/**
 * Read on its own: a database without migration 0066 must not take the rest of
 * the configuration (and with it every approval) down to the default.
 */
async function readAgentUnattended(): Promise<Map<string, AgentUnattended>> {
  const out = new Map<string, AgentUnattended>();
  try {
    const rows = await db
      .select({
        id: agentIdentities.id,
        mode: agentIdentities.unattendedApproval,
        alternative: agentIdentities.unattendedAlternative,
      })
      .from(agentIdentities)
      .where(
        sql`${agentIdentities.unattendedApproval} IS NOT NULL OR ${agentIdentities.unattendedAlternative} IS NOT NULL`
      );
    for (const r of rows) {
      out.set(r.id, {
        mode: isUnattendedMode(r.mode) ? r.mode : null,
        alternative: r.alternative ?? null,
      });
    }
  } catch (err) {
    logger.warn({ err }, "[approvals] could not read the agents' unattended settings");
  }
  return out;
}

let cache: ApprovalsSnapshot | null = null;
let inFlight: Promise<ApprovalsSnapshot> | null = null;
let notifiedWithoutTable = false;

async function readFromDb(): Promise<ApprovalsSnapshot> {
  try {
    const [row] = await db
      .select()
      .from(approvalSettings)
      .where(eq(approvalSettings.id, ID_CONFIG))
      .limit(1);
    const rows = await db
      .select({ id: agentIdentities.id, mode: agentIdentities.approvalMode })
      .from(agentIdentities)
      .where(ne(agentIdentities.approvalMode, "inherit"));
    const modes = new Map<string, ApprovalMode>();
    for (const f of rows)
      if (isApprovalMode(f.mode) && f.mode !== "inherit") modes.set(f.id, f.mode);
    cache = {
      config: readApprovalsConfig(row?.value),
      modes,
      unattended: await readAgentUnattended(),
      read: Date.now(),
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
    return cache;
  } catch (err) {
    // Without migration 0048 (or without a database): the last known one; with none, the
    // default (off), which is exactly the previous behavior.
    if (!notifiedWithoutTable) {
      notifiedWithoutTable = true;
      logger.warn(
        { err },
        "[approvals] could not read the configuration; using the last known one or the default"
      );
    }
    if (cache) return { ...cache, read: Date.now() };
    return {
      config: { ...DEFAULT_APPROVALS_CONFIG },
      modes: new Map(),
      unattended: new Map(),
      read: Date.now(),
      updatedBy: null,
      updatedAt: null,
    };
  }
}

export async function approvalsSnapshot(): Promise<ApprovalsSnapshot> {
  if (cache && Date.now() - cache.read < cacheLifetimeMs()) return cache;
  if (!inFlight) inFlight = readFromDb().finally(() => (inFlight = null));
  return inFlight;
}

/** After a change: the next request re-reads (in this process, instantly). */
export function invalidateApprovalsConfig(): void {
  cache = null;
}

/**
 * Is anything turned on? If not, the gate looks at nothing else. The global one is the
 * MASTER switch: when off, nobody asks for approval (not even `propose`).
 */
export function allOff(i: ApprovalsSnapshot): boolean {
  return !i.config.enabled;
}

export async function saveApprovalsConfig(
  change: Partial<Record<keyof ApprovalsConfig, unknown>>,
  who: string
): Promise<{ before: ApprovalsConfig; after: ApprovalsConfig }> {
  invalidateApprovalsConfig();
  const before = (await readFromDb()).config;
  const after = mergeApprovalsConfig(before, change); // throws with the reason
  await db
    .insert(approvalSettings)
    .values({ id: ID_CONFIG, value: after, updatedBy: who, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: approvalSettings.id,
      set: { value: after, updatedBy: who, updatedAt: new Date() },
    });
  invalidateApprovalsConfig();
  await audit({
    agentId: null,
    action: "approval_settings_changed",
    resource: "approval_settings",
    details: { by: who, before, after },
  });
  return { before, after };
}

export async function saveAgentMode(
  agentId: string,
  mode: ApprovalMode,
  who: string
): Promise<{ before: string; after: ApprovalMode } | null> {
  const [a] = await db
    .select({ mode: agentIdentities.approvalMode })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, agentId))
    .limit(1);
  if (!a) return null;
  await db
    .update(agentIdentities)
    .set({ approvalMode: mode, updatedAt: new Date() })
    .where(eq(agentIdentities.id, agentId));
  invalidateApprovalsConfig();
  await audit({
    agentId,
    action: "approval_mode_changed",
    resource: "approval_mode",
    details: { by: who, before: a.mode, after: mode },
  });
  return { before: a.mode, after: mode };
}

/** An agent's unattended setting: mode (`null` = global) and alternative text. */
export async function saveAgentUnattended(
  agentId: string,
  change: { mode?: unknown; alternative?: unknown },
  who: string
): Promise<{ before: AgentUnattended; after: AgentUnattended } | null> {
  if (change.mode !== undefined && change.mode !== null && !isUnattendedMode(change.mode)) {
    throw new Error("mode must be hold, deny or null (the global setting)");
  }
  const reason = invalidAlternativeReason(change.alternative);
  if (reason) throw new Error(`alternative: ${reason}`);
  const [a] = await db
    .select({
      mode: agentIdentities.unattendedApproval,
      alternative: agentIdentities.unattendedAlternative,
    })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, agentId))
    .limit(1);
  if (!a) return null;
  const before: AgentUnattended = {
    mode: isUnattendedMode(a.mode) ? a.mode : null,
    alternative: a.alternative ?? null,
  };
  const after: AgentUnattended = {
    mode: change.mode === undefined ? before.mode : (change.mode as UnattendedMode | null),
    alternative:
      change.alternative === undefined
        ? before.alternative
        : typeof change.alternative === "string"
          ? change.alternative.trim()
          : null,
  };
  await db
    .update(agentIdentities)
    .set({
      unattendedApproval: after.mode,
      unattendedAlternative: after.alternative,
      updatedAt: new Date(),
    })
    .where(eq(agentIdentities.id, agentId));
  invalidateApprovalsConfig();
  await audit({
    agentId,
    action: "unattended_setting_changed",
    resource: "unattended_approval",
    details: { by: who, before, after },
  });
  return { before, after };
}

// ═══════════════════════════════════════════════════════════════════════════
// The decision
// ═══════════════════════════════════════════════════════════════════════════

export interface ApprovalDecision {
  reason: ProposalReason;
  sensitive: boolean;
  /** Configuration key of the operation (`kon:blog:delete-post`), if there is one. */
  key: string | null;
  ofRoute: RouteOperation | null;
  /** The alternative of the legacy rule that matched, if it has one. */
  ruleAlternative?: string | null;
}

/** The sensitivity of an SDK operation: the admin's, or the declared one. */
export function operationSensitivity(
  config: ApprovalsConfig,
  konId: string,
  op: RouteOperation["op"]
): { key: string; sensitive: boolean; isDefault: boolean; changed: boolean } {
  const key = operationFineScope(konId, op.id);
  const defaultValue = isSensitive(op);
  const changed = Object.prototype.hasOwnProperty.call(config.operations, key);
  return {
    key,
    sensitive: changed ? config.operations[key]! : defaultValue,
    isDefault: defaultValue,
    changed,
  };
}

export function agentMode(i: ApprovalsSnapshot, agentId: string): ApprovalMode {
  return i.modes.get(agentId) ?? "inherit";
}

/** Must this agent's REST request be held? */
export function evaluateRequest(
  i: ApprovalsSnapshot,
  agentId: string,
  method: string,
  path: string,
  /** A POST that deletes (see `batchDeletes`): for the legacy rules it counts as a DELETE. */
  options: { deletes?: boolean } = {}
): ApprovalDecision | null {
  const mode = agentMode(i, agentId);
  if (!i.config.enabled || mode === "direct") return null;
  // What does not go through this gate is not held over MCP either (same criterion).
  if (excluded(path)) return null;
  const ofRoute = routeOperation(method, path);
  let sensitive: boolean;
  let key: string | null = null;
  let ruleAlternative: string | null = null;
  if (ofRoute) {
    const s = operationSensitivity(i.config, ofRoute.konId, ofRoute.op);
    sensitive = s.sensitive;
    key = s.key;
  } else {
    const ruleMethod = options.deletes ? "DELETE" : method;
    const rule = i.config.legacyRules.find((r) => legacyHouseRule(r, ruleMethod, path));
    sensitive = !!rule;
    ruleAlternative = rule?.alternative ?? null;
  }
  const reason = decideApproval({
    mode,
    globalActive: i.config.enabled,
    sensitive,
    write: isWriteMethod(method),
    readOnly: ofRoute ? isReadOnly(ofRoute.op) : false,
    retention: i.config.proposeRetention,
  });
  return reason ? { reason, sensitive, key, ofRoute, ruleAlternative } : null;
}

/**
 * A request that WOULD be held, in an unattended run: refused (with the text
 * that says what to do instead) or held as usual (`null`).
 */
export function unattendedDenial(
  i: ApprovalsSnapshot,
  agentId: string,
  unattended: boolean,
  p: { key?: string | null; ruleAlternative?: string | null }
): { alternative: string } | null {
  const own = i.unattended.get(agentId);
  const outcome = decideUnattended({
    unattended,
    global: i.config.unattended ?? "hold",
    agent: own?.mode ?? null,
  });
  if (outcome !== "deny") return null;
  return {
    alternative: pickAlternative(
      p.key ? i.config.alternatives?.[p.key] : null,
      p.ruleAlternative,
      own?.alternative,
      i.config.unattendedAlternative
    ),
  };
}

/** The header with which an agent says nobody is waiting for this request. */
export const UNATTENDED_HEADER = "kitsuden-unattended";

/** `Kitsuden-Unattended: true` (or `1`). Only makes things stricter, so it is trusted. */
export function unattendedHeader(value: string | null | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Is nobody waiting for the answer to this request? */
export function unattendedRequest(c: Context): boolean {
  if (internalExecutionOf(c)?.sandbox?.unattended) return true;
  return unattendedHeader(c.req.header(UNATTENDED_HEADER));
}

/** The 403 of an unattended refusal (problem+json with `alternative`). */
export function unattendedProblem(
  alternative: string,
  instance: string,
  requestId?: string | null,
  extra: Record<string, unknown> = {}
) {
  return buildProblem({
    code: "KITSUDEN_E_DENIED_UNATTENDED",
    detail:
      "This request needs human approval, and nobody is attending this run, so it was refused instead of being held. Nothing was executed.",
    instance,
    requestId,
    extensions: { alternative, ...extra },
  });
}

/** Audits an unattended refusal (it never blocks the answer). */
export async function auditUnattendedDenial(d: {
  agent: AgentAuthContext;
  channel: "rest" | "mcp";
  method: string;
  path: string;
  key: string | null;
  tool?: string | null;
}): Promise<void> {
  await audit({
    agentId: d.agent.agentId.startsWith("action:") ? null : d.agent.agentId,
    keyId: d.agent.keyId || undefined,
    action: "unattended_denied",
    resource: `${d.method} ${d.path}`,
    details: {
      channel: d.channel,
      operation: d.key,
      tool: d.tool ?? null,
      ...(d.agent.agentId.startsWith("action:") ? { action: d.agent.agentId } : {}),
    },
    success: false,
  }).catch(() => undefined);
}

/** Must this call to an MCP tool that is NOT from the SDK be held? */
export function evaluateCoreTool(
  i: ApprovalsSnapshot,
  agentId: string,
  name: string,
  writes: boolean
): { reason: ProposalReason; key: string; sensitive: boolean } | null {
  const mode = agentMode(i, agentId);
  if (!i.config.enabled || mode === "direct") return null;
  const key = mcpToolKey(name);
  const sensitive = Object.prototype.hasOwnProperty.call(i.config.operations, key)
    ? i.config.operations[key]!
    : defaultSensitiveMcpTool(name);
  const reason = decideApproval({ mode, globalActive: i.config.enabled, sensitive, write: writes });
  return reason ? { reason, key, sensitive } : null;
}

/**
 * Could the agent do it NOW? If not, it is not proposed: the request carries on and
 * the route answers its usual 403 (proposing something that will fail only fills the
 * inbox). It is only known for SDK operations.
 */
export async function agentCouldRun(
  ofRoute: RouteOperation | null,
  user: { id: string; role: string; scopes: string[] }
): Promise<boolean> {
  if (!ofRoute) return true;
  if (operationDenial(user.scopes, ofRoute.konId, ofRoute.op)) return false;
  if (!ofRoute.op.permission || ofRoute.op.permission.policy?.inHandler) return true;
  return grantsOperation(ofRoute.konId, ofRoute.op, user);
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal execution (the agent's identity without its secret)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set by the PROCESS in the `env` of `app.fetch`: Bun only passes
 * `{ ip }` to requests that arrive over the network, so nobody outside
 * can forge it.
 */
export const INTERNAL_EXECUTION_MARK: unique symbol = Symbol(
  "kitsuden.approvals.internal-execution"
);

export interface InternalExecution {
  agent: AgentAuthContext;
  /** Present when executing an approved proposal. */
  approval?: { proposalId: string; approvedBy: string };
  /** Auxiliary read (the diff): no side effects. */
  read?: boolean;
  /**
   * Call from an action's code in the sandbox (lib/worker-sandbox.ts).
   * It is NOT an already approved proposal: it goes through the approval gate and
   * the quotas like any request from that identity. `unattended`: a cron or
   * event trigger, nobody waits for the answer (see `unattendedDenial`).
   */
  sandbox?: { actionId: string; unattended?: boolean };
}

/**
 * Has this internal request already passed approval and paid its quota? Those of an
 * approved proposal and the diff reads have; the sandbox's have not.
 */
export function executionAlreadyBilled(c: Context): boolean {
  const e = internalExecutionOf(c);
  return !!e && !e.sandbox;
}

export function internalExecutionOf(c: Context): InternalExecution | null {
  const env = c.env as Record<string | symbol, unknown> | undefined;
  if (!env || typeof env !== "object") return null;
  const e = env[INTERNAL_EXECUTION_MARK] as InternalExecution | undefined;
  return e && typeof e === "object" && e.agent ? e : null;
}

/** The `user` with which an agent reaches the routes (the same shape as in index.ts). */
export function agentUser(a: AgentAuthContext) {
  return {
    id: a.agentId,
    name: a.agentName,
    email: `agent@${a.agentId}.kitsuden.local`,
    image: null,
    role: "agent",
    scopes: a.scopes,
    sponsor: a.sponsor ?? null,
  };
}

type AppFetch = (
  req: Request,
  env: Record<string | symbol, unknown>
) => Response | Promise<Response>;
let appFetch: AppFetch | null = null;

/** Called by index.ts with the app already mounted. */
export function setApprovalsApp(fn: AppFetch): void {
  appFetch = fn;
}

export interface ApprovalMcpResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}
type McpExecutor = (
  tool: string,
  args: Record<string, unknown>,
  agent: AgentAuthContext,
  approval: { proposalId: string; approvedBy: string }
) => Promise<ApprovalMcpResult>;
let mcpExecutor: McpExecutor | null = null;

/** Called by routes/mcp.ts: how to call a tool again. */
export function setApprovalsMcpExecutor(fn: McpExecutor): void {
  mcpExecutor = fn;
}

export async function internalRequest(
  e: InternalExecution,
  method: string,
  path: string,
  bodyValue?: unknown,
  type?: string | null
): Promise<Response> {
  if (!appFetch) throw new Error("The app did not register its fetch for approvals");
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | FormData | undefined;
  if (bodyValue instanceof FormData) {
    // A held upload: the `Request` sets the `content-type` with its boundary itself.
    body = bodyValue;
  } else if (bodyValue !== undefined && bodyValue !== null && method !== "GET") {
    headers["content-type"] = type || "application/json";
    body = JSON.stringify(bodyValue);
  }
  const req = new Request(`http://localhost${path}`, { method, headers, body });
  return appFetch(req, { [INTERNAL_EXECUTION_MARK]: e });
}

// ═══════════════════════════════════════════════════════════════════════════
// Create the proposal
// ═══════════════════════════════════════════════════════════════════════════

/** Largest body that is held (256 KiB). */
const MAX_BODY_BYTES = 256 * 1024;
/** The largest thing stored from a diff or a result. */
const MAX_SAVED_BYTES = 256 * 1024;

export class ProposalNotAdmitted extends Error {
  constructor(readonly reason: "secret" | "multipart" | "not_image" | "not_json" | "too_large") {
    super(reason);
  }
}

// ── Held IMAGE uploads (owner decision, 2026-10-26) ─────────────────────────
//
// A multipart upload can be held ONLY if every file is an image
// whose REAL type (the signature of its first bytes, `real-type.ts` of the
// media library) is JPEG, PNG, GIF, WebP or AVIF; each one fits within the maximum size
// of the media library; and the text fields carry no secrets. The bytes wait
// in `agent_proposal_files` (private; see migration 0050), not in `/media`.
// When it is approved, the form is rebuilt and executed with the agent's
// identity, like a JSON body. When it is rejected, expires or is executed, the
// files are deleted.

/** The media library IMAGE formats that are held (no video or PDF). */
export const RETAINABLE_IMAGES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** Files per held upload: the same as the media library accepts. */
export const MAX_RETAINED_IMAGES = 20;

/**
 * Maximum size of ONE held image: `APPROVALS_MAX_UPLOAD_MB` (1-100), and
 * if not set, 10 MB, the same as the media library (`MAX_BYTES_PER_FILE`).
 */
export function maxBytesPerImage(): number {
  const n = Number(process.env.APPROVALS_MAX_UPLOAD_MB);
  return (Number.isFinite(n) && n > 0 && n <= 100 ? n : 10) * 1024 * 1024;
}

/** The most that is read from a multipart request before cutting off. */
function maxUploadBytes(): number {
  return maxBytesPerImage() * MAX_RETAINED_IMAGES + MAX_BODY_BYTES;
}

export function isMultipart(type: string | null | undefined): boolean {
  return (type ?? "").toLowerCase().includes("multipart/");
}

/** Type under which a held upload is stored (without the boundary, which changes on every send). */
export const HELD_UPLOAD_TYPE = "multipart/form-data";

export interface RetainedImage {
  field: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  sha256: string;
}

/** What remains in `agent_proposals.body` for an upload (without bytes). */
export interface UploadBody {
  multipart: true;
  fields: { name: string; value: string }[];
  files: { field: string; filename: string; mimeType: string; size: number; sha256: string }[];
}

export function isUploadBody(v: unknown): v is UploadBody {
  return !!v && typeof v === "object" && (v as { multipart?: unknown }).multipart === true;
}

/** What is looked at on the request (works with Bun's `Request` and undici's). */
interface ReadableRequest {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** Reads the body with a cap: more than `max` bytes → `too_large` without reading the rest. */
async function readWithCap(req: ReadableRequest, max: number): Promise<Uint8Array> {
  const declaredOne = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredOne) && declaredOne > max) throw new ProposalNotAdmitted("too_large");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ProposalNotAdmitted("too_large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let i = 0;
  for (const t of chunks) {
    output.set(t, i);
    i += t.byteLength;
  }
  return output;
}

/**
 * The multipart upload, checked, to store it as a proposal; or it throws
 * `ProposalNotAdmitted` with the reason (`not_image`, `too_large`, `secret`,
 * `multipart` if the form is broken). `fingerprint` is a CANONICAL form
 * (fields + sha256 of each file): the boundary changes on every send and with
 * the raw bytes an identical retry would be a different request.
 */
export async function uploadForProposal(
  req: ReadableRequest,
  type: string
): Promise<{ body: UploadBody; images: RetainedImage[]; fingerprint: Uint8Array }> {
  const raw = await readWithCap(req, maxUploadBytes());
  let form: FormData;
  try {
    form = (await new Response(raw as unknown as ConstructorParameters<typeof Response>[0], {
      headers: { "content-type": type },
    }).formData()) as unknown as FormData;
  } catch {
    throw new ProposalNotAdmitted("multipart");
  }
  const fields: UploadBody["fields"] = [];
  const images: RetainedImage[] = [];
  let textBytes = 0;
  const maxImage = maxBytesPerImage();
  for (const [name, input] of form.entries()) {
    const value = input as unknown as string | File;
    if (typeof value === "string") {
      textBytes += name.length + value.length;
      fields.push({ name, value });
      continue;
    }
    if (images.length >= MAX_RETAINED_IMAGES) throw new ProposalNotAdmitted("too_large");
    if (value.size > maxImage) throw new ProposalNotAdmitted("too_large");
    const bytes = new Uint8Array(await value.arrayBuffer());
    const real = detectRealType(bytes);
    // The type the client states and the extension do not count: only the signature.
    if (!real || !RETAINABLE_IMAGES.has(real.mime)) throw new ProposalNotAdmitted("not_image");
    images.push({
      field: name,
      name: String(value.name || "image")
        .normalize("NFKC")
        .slice(0, 255),
      mime: real.mime,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (textBytes > MAX_BODY_BYTES) throw new ProposalNotAdmitted("too_large");
  // Secrets: in the text fields (by name or by value) and in the file names.
  const asObject: Record<string, unknown> = {};
  for (const f of fields) asObject[f.name] = f.value;
  if (
    containsSecret(asObject) ||
    containsSecret(fields.map((f) => f.value)) ||
    containsSecret(images.map((i) => i.name))
  ) {
    throw new ProposalNotAdmitted("secret");
  }
  const body: UploadBody = {
    multipart: true,
    fields,
    files: images.map((i) => ({
      field: i.field,
      filename: i.name,
      mimeType: i.mime,
      size: i.bytes.byteLength,
      sha256: i.sha256,
    })),
  };
  return { body, images, fingerprint: new TextEncoder().encode(JSON.stringify(body)) };
}

/** The held files of a proposal, without the bytes (for the panel). */
export async function proposalFiles(proposalId: string) {
  return db
    .select({
      id: agentProposalFiles.id,
      field: agentProposalFiles.field,
      filename: agentProposalFiles.filename,
      mimeType: agentProposalFiles.mimeType,
      size: agentProposalFiles.size,
    })
    .from(agentProposalFiles)
    .where(eq(agentProposalFiles.proposalId, proposalId))
    .orderBy(asc(agentProposalFiles.position));
}

/** A held file with its bytes (the panel thumbnail). */
export async function proposalFile(proposalId: string, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId) || !/^[0-9a-f-]{36}$/i.test(proposalId)) return null;
  const [f] = await db
    .select()
    .from(agentProposalFiles)
    .where(and(eq(agentProposalFiles.proposalId, proposalId), eq(agentProposalFiles.id, fileId)))
    .limit(1);
  return f ?? null;
}

/** Deletes the held files of these proposals (rejected, expired or executed). */
export async function deleteProposalFiles(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db
    .delete(agentProposalFiles)
    .where(inArray(agentProposalFiles.proposalId, ids))
    .returning({ id: agentProposalFiles.id });
  return deleted.length;
}

/** The form of a held upload, rebuilt to execute it. */
async function proposalForm(p: Proposal): Promise<FormData> {
  if (!isUploadBody(p.body)) throw new Error("The proposal is not an upload");
  const rows = await db
    .select()
    .from(agentProposalFiles)
    .where(eq(agentProposalFiles.proposalId, p.id))
    .orderBy(asc(agentProposalFiles.position));
  if (rows.length !== p.body.files.length) throw new Error("files_missing");
  const form = new FormData();
  for (const f of p.body.fields) form.append(f.name, f.value);
  for (const f of rows) {
    const bytes = new Uint8Array(f.content);
    // The same as what was proposed: if the bytes do not match their fingerprint, it is not executed.
    if (createHash("sha256").update(bytes).digest("hex") !== f.sha256)
      throw new Error("files_tampered");
    form.append(f.field, new File([bytes], f.filename, { type: f.mimeType }));
  }
  return form;
}

export class ReusedIdempotencyKey extends Error {}

function trim(value: unknown, max = MAX_SAVED_BYTES): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  if (text.length <= max) return value;
  return { truncated: true, bytes: text.length, preview: text.slice(0, 2000) };
}

function unwrap(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  // `{ data: {...} }` and `{ post: {...} }`: what is inside is the resource.
  const keys = Object.keys(o);
  if (keys.length <= 3) {
    for (const k of ["data", "item", "entry", "post", "record"]) {
      const v = o[k];
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    }
  }
  return o;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The CHEAP diff: a read of the resource with the agent's identity (what
 * it could see; nothing more) and the field-by-field comparison with what was proposed.
 * If it cannot be read, that is stated and nothing happens.
 */
export async function computeDiff(
  agent: AgentAuthContext,
  method: string,
  path: string,
  body: unknown
): Promise<unknown> {
  const m = method.toUpperCase();
  // The evidence travels beside the record, it is not one of its fields (lib/ledger.ts).
  body = splitEvidence("rest", body).body;
  if (m === "POST") return { kind: "create", proposed: trim(body, 64 * 1024) };
  if (m !== "PATCH" && m !== "PUT" && m !== "DELETE") return null;
  const withoutQuery = path.split("?")[0]!;
  let actual: Record<string, unknown> | null = null;
  let read: number | string = "skipped";
  try {
    const res = await Promise.race([
      internalRequest({ agent, read: true }, "GET", withoutQuery),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    read = res.status;
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      actual = unwrap(await res.json());
    }
  } catch (err) {
    read = err instanceof Error ? err.message : "error";
  }
  if (m === "DELETE") {
    return actual
      ? { kind: "delete", current: trim(actual, 64 * 1024) }
      : { kind: "delete", current: null, currentUnavailable: read };
  }
  const proposed = unwrap(body) ?? {};
  if (!actual) {
    return {
      kind: m === "PUT" ? "replace" : "update",
      proposed: trim(proposed, 64 * 1024),
      currentUnavailable: read,
    };
  }
  const changes = Object.keys(proposed)
    .filter((k) => !equal(actual![k], proposed[k]))
    .map((k) => ({
      field: k,
      before: trim(actual![k], 8 * 1024),
      after: trim(proposed[k], 8 * 1024),
    }));
  return { kind: m === "PUT" ? "replace" : "update", changes };
}

export interface ProposalData {
  agent: AgentAuthContext;
  channel: "rest" | "mcp";
  method: string;
  path: string;
  body: unknown;
  type: string | null;
  fingerprint: string;
  idempotencyKey: string | null;
  reason: ProposalReason;
  konId?: string | null;
  operationId?: string | null;
  key?: string | null;
  tool?: string | null;
  /** Path to read the current state (diff); `null` = no read diff. */
  diffPath?: string | null;
  diff?: unknown;
  /** The images of a held multipart upload (stored separately, private). */
  images?: RetainedImage[];
}

/** Reads a resource as the agent (no side effects), for a diff. */
async function readAsAgent(
  agent: AgentAuthContext,
  path: string
): Promise<{ current: Record<string, unknown> | null; status: number | string }> {
  try {
    const res = await Promise.race([
      internalRequest({ agent, read: true }, "GET", path.split("?")[0]!),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      return { current: unwrap(await res.json()), status: res.status };
    }
    return { current: null, status: res.status };
  } catch (err) {
    return { current: null, status: err instanceof Error ? err.message : "error" };
  }
}

/**
 * The ledger part of a new proposal: the body without `_evidence`, the validated
 * evidence and, when it writes a record, the per-field diff against the row as
 * the agent reads it.
 */
async function prepareLedger(d: ProposalData): Promise<{
  body: unknown;
  evidence: Evidence[];
  fieldDiff: ReturnType<typeof computeFieldDiff> | null;
}> {
  if (isUploadBody(d.body)) return { body: d.body, evidence: [], fieldDiff: null };
  const split = splitEvidence(d.channel, d.body);
  const evidence = parseEvidence(split.raw);
  const target = await recordTarget({
    channel: d.channel,
    method: d.method,
    path: d.path,
    tool: d.tool,
    konId: d.konId,
    body: split.body,
  });
  if (!target) return { body: split.body, evidence, fieldDiff: null };
  checkEvidenceFields(target, split.body, evidence);
  let current: Record<string, unknown> | null = null;
  let status: number | string | undefined;
  if (target.kind === "update") {
    if (target.readPath) ({ current, status } = await readAsAgent(d.agent, target.readPath));
    else status = "not_readable";
  }
  return {
    body: split.body,
    evidence,
    fieldDiff: computeFieldDiff(target, split.body, current, status),
  };
}

/**
 * Stores the proposal, or returns the one that already exists:
 *   · with the same idempotency key and the same fingerprint → that one (any
 *     state: the agent sees where it ended up); with a different fingerprint → error 422;
 *   · without a key: a PENDING one with the same fingerprint → that one (the
 *     inbox is not duplicated because the agent retries).
 */
export async function createProposal(
  d: ProposalData
): Promise<{ proposal: Proposal; next: boolean }> {
  const agentId = d.agent.agentId;
  // The last filter before the database (security review 2026-11-04): whatever
  // the channel (REST, MCP, upload), a proposal never stores a secret. Approving
  // it runs the STORED body, so it cannot be stored redacted: it is refused.
  if (bodyWithSecretForRoute(d.path, d.body)) throw new ProposalNotAdmitted("secret");
  if (d.idempotencyKey) {
    const [earlier] = await db
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.agentId, agentId),
          eq(agentProposals.idempotencyKey, d.idempotencyKey)
        )
      )
      .limit(1);
    if (earlier) {
      if (earlier.fingerprint !== d.fingerprint) throw new ReusedIdempotencyKey();
      return { proposal: earlier, next: false };
    }
  } else {
    const [earlier] = await db
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.agentId, agentId),
          eq(agentProposals.fingerprint, d.fingerprint),
          eq(agentProposals.status, "pending"),
          gt(agentProposals.expiresAt, new Date())
        )
      )
      .limit(1);
    if (earlier) return { proposal: earlier, next: false };
  }

  // Agent data ledger: the evidence goes out of the body, and a record gets its
  // per-field diff (lib/ledger.ts). Invalid evidence throws `LedgerInputError` (422).
  const ledger = await prepareLedger(d);
  d = { ...d, body: ledger.body };

  const { config } = await approvalsSnapshot();
  const computedDiff =
    d.diff !== undefined
      ? d.diff
      : d.diffPath
        ? await computeDiff(d.agent, d.method, d.diffPath, d.body)
        : null;
  // The diff only informs: if it (or the current state it read) carries a secret, it is not stored.
  const diff = computedDiff && containsSecret(computedDiff) ? { omitted: "secret" } : computedDiff;
  // The proposal and its images, together: either both or neither.
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(agentProposals)
      .values({
        agentId,
        keyId: d.agent.keyId || null,
        channel: d.channel,
        method: d.method.toUpperCase(),
        path: d.path,
        konId: d.konId ?? null,
        operationId: d.operationId ?? null,
        operationKey: d.key ?? null,
        tool: d.tool ?? null,
        body: (d.body ?? null) as never,
        contentType: d.type,
        fingerprint: d.fingerprint,
        idempotencyKey: d.idempotencyKey,
        scopes: d.agent.scopes,
        reason: d.reason,
        diff: (diff ?? null) as never,
        status: "pending",
        // The agent's human signer when proposing (updated on execution).
        sponsorUserId: d.agent.sponsor?.userId ?? null,
        expiresAt: new Date(Date.now() + config.ttlHours * 3_600_000),
        fieldDiff: (ledger.fieldDiff ?? null) as never,
        evidence: (ledger.evidence.length ? ledger.evidence : null) as never,
      })
      .onConflictDoNothing()
      .returning();
    const next = rows[0];
    if (next && d.images?.length) {
      await tx.insert(agentProposalFiles).values(
        d.images.map((img, position) => ({
          proposalId: next.id,
          position,
          field: img.field,
          filename: img.name,
          mimeType: img.mime,
          size: img.bytes.byteLength,
          sha256: img.sha256,
          content: Buffer.from(img.bytes),
        }))
      );
    }
    return rows;
  });
  const proposal = inserted[0];
  if (!proposal) {
    // Race with another request with the same key: theirs wins.
    const [other] = await db
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.agentId, agentId),
          eq(agentProposals.idempotencyKey, d.idempotencyKey ?? "")
        )
      )
      .limit(1);
    if (!other) throw new Error("Could not store the proposal");
    if (other.fingerprint !== d.fingerprint) throw new ReusedIdempotencyKey();
    return { proposal: other, next: false };
  }
  await audit({
    agentId,
    keyId: d.agent.keyId || undefined,
    action: "proposal_created",
    resource: `${proposal.method} ${proposal.path}`,
    resourceId: proposal.id,
    details: {
      channel: d.channel,
      reason: d.reason,
      operation: d.key ?? null,
      tool: d.tool ?? null,
      idempotencyKey: d.idempotencyKey ? true : false,
      sponsor: d.agent.sponsor?.userId ?? null,
      files: d.images?.length ?? 0,
    },
  });
  // D5: second opinion from an injection classifier, if any (it decides nothing).
  await enqueueClassification(proposal.id);
  return { proposal, next: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// What the agent sees
// ═══════════════════════════════════════════════════════════════════════════

export function statusUrl(id: string): string {
  return `/api/proposals/${id}`;
}

/** The proposal as ITS agent sees it (without who decided or the diff). */
export function agentView(p: Proposal) {
  const finished = p.status === "executed" || p.status === "failed";
  return {
    id: p.id,
    status: p.status as ProposalStatus,
    reason: p.reason,
    channel: p.channel,
    method: p.method,
    path: p.path,
    tool: p.tool,
    operation: p.operationKey,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    decidedAt: p.decidedAt,
    comment: p.decisionComment,
    executedAt: p.executedAt,
    statusUrl: statusUrl(p.id),
    // Decided field by field: which of its fields were applied (lib/ledger.ts).
    ...(readDecisions(p)
      ? {
          fieldDecisions: readDecisions(p)!.map((f) => ({
            field: f.field,
            decision: f.decision,
            edited: f.edited,
          })),
        }
      : {}),
    ...(finished
      ? {
          result: {
            status: p.resultStatus,
            contentType: p.resultContentType,
            body: p.resultBody,
            error: p.resultError,
          },
        }
      : {}),
  };
}

/** The body of the 202 (problem+json with the proposal). */
export function proposalProblem(p: Proposal, instance: string, requestId?: string | null) {
  return buildProblem({
    code: "KITSUDEN_E_APPROVAL_REQUIRED",
    status: 202,
    detail:
      p.status === "pending"
        ? `This request needs human approval. It was stored as proposal ${p.id} and has NOT been executed.`
        : `This request was already stored as proposal ${p.id} (status: ${p.status}).`,
    instance,
    requestId,
    extensions: { proposal: agentView(p) },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The REST gate
// ═══════════════════════════════════════════════════════════════════════════

/** What does not go through this gate: MCP (has its own), auth and the routes themselves. */
export const EXCLUDED_FROM_APPROVAL = [
  "/api/auth",
  "/api/mcp",
  "/api/approvals",
  "/api/proposals",
  // Code promotion has its own human gate (a draft
  // IS already a proposal). Holding the draft submission would mean asking twice.
  "/api/promotion",
  // What an agent chose NOT to do (lib/agent-decisions.ts): it changes nothing,
  // and it is what an unattended run is told to do instead of a held write.
  "/api/agent/decisions",
];

function excluded(path: string): boolean {
  return EXCLUDED_FROM_APPROVAL.some((p) => path === p || path.startsWith(`${p}/`));
}

function notAdmittedProblem(
  reason: ProposalNotAdmitted["reason"],
  instance: string,
  requestId?: string | null
) {
  const that: Record<ProposalNotAdmitted["reason"], string> = {
    secret:
      "its body carries a secret (a token, password, key, credential header or a value for the secrets store), and proposals never store secrets; a human or an agent in direct mode has to send it",
    multipart: "the multipart form could not be read",
    not_image:
      "only image uploads (JPEG, PNG, GIF, WebP or AVIF, checked by their content) can be held as proposals; any other file has to be uploaded by a human or an agent in direct mode",
    not_json: "only JSON bodies and image uploads can be held as proposals",
    too_large: `the body is larger than ${MAX_BODY_BYTES / 1024} KiB of JSON or text, or an upload has more than ${MAX_RETAINED_IMAGES} images or one larger than ${maxBytesPerImage() / 1024 / 1024} MB`,
  };
  return buildProblem({
    code: "KITSUDEN_E_APPROVAL_UNSUPPORTED",
    detail: `This request needs human approval but cannot be stored as a proposal: ${that[reason]}.`,
    instance,
    requestId,
    extensions: { reason },
  });
}

function reusedKeyProblem(instance: string, requestId?: string | null) {
  return buildProblem({
    code: "KITSUDEN_E_IDEMPOTENCY_KEY_REUSED",
    detail: "This Idempotency-Key already belongs to a different proposal of this agent.",
    instance,
    requestId,
  });
}

function respondJson(c: Context, body: unknown, status: number, type = "application/problem+json") {
  return c.body(JSON.stringify(body), status as never, { "Content-Type": type });
}

/** The request body, to store it (JSON and without secrets), or it throws. */
export function bodyForProposal(type: string, bytes: Uint8Array, path?: string): unknown {
  if (bytes.byteLength === 0) return null;
  // To the secrets store: the body is the secret, whatever the field is called.
  if (path && routeReceivesSecrets(path)) throw new ProposalNotAdmitted("secret");
  const t = type.toLowerCase();
  if (t.includes("multipart/")) throw new ProposalNotAdmitted("multipart");
  if (bytes.byteLength > MAX_BODY_BYTES) throw new ProposalNotAdmitted("too_large");
  if (!t.includes("json")) throw new ProposalNotAdmitted("not_json");
  if (bodyWithSecret(t, bytes)) throw new ProposalNotAdmitted("secret");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProposalNotAdmitted("not_json");
  }
}

/**
 * The REST middleware. For an AGENT whose request needs approval: it is NOT
 * executed; the proposal is stored and 202 is returned. Everything else passes.
 */
/**
 * Does this `POST /api/datasets/batch` delete anything? The gate looks at method
 * and path, and a batch `delete` is a POST: it escaped the rule that holds every
 * DELETE. A body that cannot be read counts as deleting (the route will refuse it).
 */
export async function batchDeletes(c: Context, method: string, path: string): Promise<boolean> {
  if (method !== "POST" || path.replace(/\/+$/, "") !== "/api/datasets/batch") return false;
  try {
    const body = (await c.req.raw.clone().json()) as { operations?: Array<{ op?: unknown }> };
    return !Array.isArray(body.operations) || body.operations.some((o) => o?.op === "delete");
  } catch {
    return true;
  }
}

export function approvalGate() {
  return async (c: Context, next: Next) => {
    if (executionAlreadyBilled(c)) return next();
    const agent = (c.get as (k: string) => unknown)("agent") as AgentAuthContext | undefined;
    if (!agent?.agentId) return next();
    const method = c.req.method.toUpperCase();
    if (method === "OPTIONS" || method === "HEAD") return next();
    const path = c.req.path;
    if (!path.startsWith("/api/") || excluded(path)) return next();

    const i = await approvalsSnapshot();
    if (allOff(i)) return next();
    const decision = evaluateRequest(i, agent.agentId, method, path, {
      deletes: await batchDeletes(c, method, path),
    });
    if (!decision) return next();
    const user = { id: agent.agentId, role: "agent", scopes: agent.scopes ?? [] };
    if (!(await agentCouldRun(decision.ofRoute, user))) return next();

    const requestId =
      ((c.get as (k: string) => unknown)("requestId") as string | undefined) ?? null;
    // Nobody is waiting: refused with an alternative instead of held (if so configured).
    const denial = unattendedDenial(i, agent.agentId, unattendedRequest(c), decision);
    if (denial) {
      await auditUnattendedDenial({
        agent,
        channel: "rest",
        method,
        path,
        key: decision.key,
      });
      return respondJson(
        c,
        unattendedProblem(denial.alternative, path, requestId, {
          reason: decision.reason,
          operation: decision.key,
        }),
        403
      );
    }
    const url = new URL(c.req.url);
    const type = c.req.header("content-type") ?? "";
    let body: unknown;
    let images: RetainedImage[] | undefined;
    // What goes into the fingerprint: the JSON bytes, or the canonical form of the upload.
    let forFingerprint: Uint8Array;
    let savedType: string | null;
    let fingerprintType = type;
    try {
      if (isMultipart(type)) {
        const s = await uploadForProposal(c.req.raw.clone() as unknown as ReadableRequest, type);
        body = s.body;
        images = s.images;
        forFingerprint = s.fingerprint;
        savedType = HELD_UPLOAD_TYPE;
        fingerprintType = HELD_UPLOAD_TYPE;
      } else {
        const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
        body = bodyForProposal(type, bytes, path);
        forFingerprint = bytes;
        savedType = bytes.byteLength > 0 ? type : null;
      }
    } catch (err) {
      if (err instanceof ProposalNotAdmitted)
        return respondJson(c, notAdmittedProblem(err.reason, path, requestId), 403);
      throw err;
    }
    const key = c.req.header("idempotency-key");
    try {
      const { proposal } = await createProposal({
        agent,
        channel: "rest",
        method,
        path: `${path}${url.search}`,
        body,
        type: savedType,
        fingerprint: requestFingerprint({
          method,
          path,
          query: url.search,
          type: fingerprintType,
          body: forFingerprint,
        }),
        images,
        idempotencyKey: key && VALID_IDEMPOTENCY_KEY.test(key) ? key : null,
        reason: decision.reason,
        konId: decision.ofRoute?.konId ?? null,
        operationId: decision.ofRoute?.op.id ?? null,
        key: decision.key,
        diffPath: path,
      });
      c.header("Location", statusUrl(proposal.id));
      return respondJson(c, proposalProblem(proposal, path, requestId), 202, "application/json");
    } catch (err) {
      if (err instanceof ReusedIdempotencyKey) {
        return respondJson(c, reusedKeyProblem(path, requestId), 422);
      }
      if (err instanceof ProposalNotAdmitted) {
        return respondJson(c, notAdmittedProblem(err.reason, path, requestId), 403);
      }
      if (err instanceof LedgerInputError) {
        return respondJson(c, evidenceProblem(err.message, path, requestId), 422);
      }
      throw err;
    }
  };
}

/** `_evidence` that cannot be read: the agent can fix it and send again. */
export function evidenceProblem(
  message: string,
  instance: string,
  requestId?: string | null,
  held = true
) {
  return buildProblem({
    code: "KITSUDEN_E_VALIDATION",
    status: 422,
    detail: held
      ? `This request needs human approval and its evidence is not valid: ${message}. Nothing was stored or executed.`
      : `The evidence of this request is not valid: ${message}. Nothing was executed.`,
    instance,
    requestId,
    extensions: { reason: "evidence" },
  });
}

/** The parsed JSON of a response, or null (not JSON, empty, too large). */
async function jsonOf(res: Response): Promise<unknown> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const text = await res.clone().text();
    return text.length > 0 && text.length <= 1024 * 1024 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Evidence of the writes that are NOT held (an agent in `direct` mode, or a write
 * no rule holds). Goes right after `approvalGate()`: what reaches it runs now.
 * When the request writes a record and carries `_evidence`, the evidence is
 * validated (422 and nothing runs if it is wrong, as when held), the route gets
 * the body without it and, if the write succeeds, the evidence stays with the
 * row (`field_evidence`, no proposal, nobody who accepted it). Any other request
 * goes through untouched. The approved execution of a proposal has its own path.
 */
export function directEvidence() {
  return async (c: Context, next: Next) => {
    const agent = (c.get as (k: string) => unknown)("agent") as AgentAuthContext | undefined;
    // An approved proposal keeps its evidence on its own path; sandbox calls run now.
    if (!agent?.agentId || agent.agentId.startsWith("machine-") || executionAlreadyBilled(c))
      return next();
    const method = c.req.method.toUpperCase();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") return next();
    if (!(c.req.header("content-type") ?? "").includes("json")) return next();
    const text = await c.req.raw.clone().text();
    if (!text.includes(EVIDENCE_KEY)) return next();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return next(); // the route answers its own 400
    }
    const path = c.req.path;
    const requestId =
      ((c.get as (k: string) => unknown)("requestId") as string | undefined) ?? null;
    let prepared: Awaited<ReturnType<typeof prepareDirectEvidence>>;
    try {
      prepared = await prepareDirectEvidence({
        channel: "rest",
        method,
        path,
        konId: routeOperation(method, path)?.konId ?? null,
        body,
      });
    } catch (err) {
      if (err instanceof LedgerInputError)
        return respondJson(c, evidenceProblem(err.message, path, requestId, false), 422);
      throw err;
    }
    if (!prepared.stripped) return next();

    // The route reads the body without `_evidence` (and nothing read before it is cached).
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: JSON.stringify(prepared.body),
      signal: c.req.raw.signal,
    });
    (c.req as unknown as { bodyCache: Record<string, unknown> }).bodyCache = {};
    await next();

    const pending = prepared.pending;
    if (!pending || !c.res.ok) return;
    try {
      const rowId = rowIdFromResult(pending.target, await jsonOf(c.res));
      const kept = await persistDirectEvidence(pending, rowId, agent.agentId);
      if (kept === 0 && pending.target.entity)
        logger.info({ path }, "[ledger] direct write without a row id: its evidence is not kept");
    } catch (err) {
      logger.warn({ err, path }, "[ledger] could not keep the evidence of a direct write");
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Decide: approve, reject, expire
// ═══════════════════════════════════════════════════════════════════════════

async function audit(e: {
  agentId: string | null;
  keyId?: string;
  action: AuditAction;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  success?: boolean;
  errorMessage?: string;
}): Promise<void> {
  try {
    await registerAgentAction({ ...e, success: e.success ?? true });
  } catch (err) {
    logger.error({ err, action: e.action }, "[approvals] could not write the audit");
    throw err;
  }
}

/** Marks as expired the pending ones that are past their date (and audits it). */
export async function expireProposals(): Promise<number> {
  const expiredProposals = await db
    .update(agentProposals)
    .set({ status: "expired" })
    .where(and(eq(agentProposals.status, "pending"), lte(agentProposals.expiresAt, new Date())))
    .returning({
      id: agentProposals.id,
      agentId: agentProposals.agentId,
      method: agentProposals.method,
      path: agentProposals.path,
    });
  // An expired upload waits for nobody: its images are deleted right away.
  await deleteProposalFiles(expiredProposals.map((p) => p.id));
  for (const p of expiredProposals) {
    await audit({
      agentId: p.agentId,
      action: "proposal_expired",
      resource: `${p.method} ${p.path}`,
      resourceId: p.id,
    }).catch(() => undefined);
    // B3: the agent finds out (SSE and, if it has a notification URL, a signed webhook).
    const complete = await proposalById(p.id).catch(() => null);
    if (complete)
      await notifyResolution(complete.agentId, agentView(complete)).catch(() => undefined);
  }
  return expiredProposals.length;
}

let sweep: ReturnType<typeof setInterval> | null = null;
/** Sweeps the expired ones every 5 minutes (without holding the process open). */
export function startProposalSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    expireProposals().catch(() => undefined);
  }, 5 * 60_000);
  (sweep as { unref?: () => void }).unref?.();
}

export async function proposalById(id: string): Promise<Proposal | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [p] = await db.select().from(agentProposals).where(eq(agentProposals.id, id)).limit(1);
  return p ?? null;
}

export interface Human {
  id: string;
  role: string;
}

/** The role as of NOW (from the database, not from the session's cookie cache). */
export async function freshHuman(id: string): Promise<Human | null> {
  const [u] = await db
    .select({ id: authUsers.id, role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  return u ? { id: u.id, role: (u.role as string | null) ?? "user" } : null;
}

/**
 * Can THIS human approve it? Only what they themselves could do:
 *
 *   · `admin`: everything.
 *   · `editor`: the SDK operations their role grants (scopes ∪ roles
 *     ∪ kon policy, the same check as the route) and the legacy routes
 *     behind a team gate ("staff"). Never what requires
 *     admin (`/api/admin/*`, the admin gates), nor a legacy route without a
 *     gate (what it checks inside is unknown), nor a core MCP
 *     tool. Nor a proposal of an agent they sponsor: the signer would be
 *     approving their own agent's write, the four-eyes check would be one
 *     pair of eyes. An admin may (admins are trusted, and a solo install has
 *     a single human, who sponsors every agent).
 *   · anyone else: nothing.
 *
 * Returns the reason CODE for the "no" (`REASONS_NOT_TO_APPROVE`), or
 * `null` if they can.
 */
export type ReasonNotToApprove =
  | "not_staff"
  | "core_mcp_tool"
  | "admin_route"
  | "role_cannot"
  | "legacy_without_gate"
  | "own_agent";

/** The (English) text of each reason; the panel translates the code. */
export const REASONS_NOT_TO_APPROVE: Record<ReasonNotToApprove, string> = {
  not_staff: "Only admins and editors can decide proposals",
  core_mcp_tool: "Only an admin can approve a core MCP tool",
  admin_route: "Only an admin can approve a request to an admin-only route",
  role_cannot: "Your role cannot perform this operation, so you cannot approve it",
  legacy_without_gate: "Only an admin can approve a legacy route without a staff gate",
  own_agent: "You sponsor this agent: another admin or editor has to approve its proposals",
};

/**
 * Does `userId` sign for the agent behind `p`? Both the signer recorded when
 * the agent proposed and the agent's signer NOW: changing the sponsor after
 * proposing must not open the door either way.
 */
async function sponsorsAgent(userId: string, p: Proposal): Promise<boolean> {
  if (p.sponsorUserId === userId) return true;
  if (!p.agentId) return false;
  const [a] = await db
    .select({ sponsorUserId: agentIdentities.sponsorUserId })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, p.agentId))
    .limit(1);
  return a?.sponsorUserId === userId;
}

export async function reasonNotToApprove(
  h: Human,
  p: Proposal
): Promise<ReasonNotToApprove | null> {
  if (h.role === "admin") return null;
  if (h.role !== "editor") return "not_staff";
  if (await sponsorsAgent(h.id, p)) return "own_agent";
  if (p.channel === "mcp" && !p.konId) return "core_mcp_tool";
  const path = p.path.split("?")[0]!;
  if (path === "/api/admin" || path.startsWith("/api/admin/")) return "admin_route";
  const rule = ruleFor([...EARLY_ADMIN_ONLY_ROUTES, ...ADMIN_ONLY_ROUTES], p.method, path);
  if (rule && rule.role !== "staff") return "admin_route";
  const ofRoute = routeOperation(p.method, path);
  if (ofRoute) {
    if (!ofRoute.op.permission) return null;
    const can = await grantsOperation(ofRoute.konId, ofRoute.op, { id: h.id, role: h.role });
    return can ? null : "role_cannot";
  }
  return rule ? null : "legacy_without_gate";
}

export type DecisionResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; status: 403 | 404 | 409 | 422; reason: string; proposal?: Proposal };

export interface ApproveOptions {
  /**
   * Agent data ledger: the decision per field (`accept` / `reject`, and an
   * optional edited value). Fields not listed are accepted. Only for proposals
   * that write a record (they carry a per-field diff). See lib/ledger.ts.
   */
  fields?: FieldDecisionInput[];
}

/** For the audit: which fields went in, which stayed out, which were edited. */
function decisionSummary(decisions: FieldDecision[] | null) {
  if (!decisions) return null;
  return {
    accepted: decisions.filter((d) => d.decision === "accept").map((d) => d.field),
    rejected: decisions.filter((d) => d.decision === "reject").map((d) => d.field),
    edited: decisions.filter((d) => d.edited).map((d) => d.field),
  };
}

async function saveResult(
  id: string,
  status: "executed" | "failed",
  r: {
    status: number | null;
    contentType?: string | null;
    body?: unknown;
    error?: string | null;
    /** The signer it was executed with (undefined = unchanged). */
    sponsorUserId?: string | null;
  }
): Promise<Proposal> {
  const [p] = await db
    .update(agentProposals)
    .set({
      ...(r.sponsorUserId !== undefined ? { sponsorUserId: r.sponsorUserId } : {}),
      status,
      executedAt: new Date(),
      resultStatus: r.status,
      resultContentType: r.contentType ?? null,
      resultBody: (r.body === undefined ? null : r.body) as never,
      resultError: r.error ?? null,
    })
    .where(eq(agentProposals.id, id))
    .returning();
  return p!;
}

async function readHttpResult(
  res: Response
): Promise<{ body: unknown; contentType: string | null }> {
  const type = res.headers.get("content-type");
  if (res.status === 204) return { body: null, contentType: type };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bodyWithSecret(type ?? "", bytes)) return { body: { omitted: "secret" }, contentType: type };
  const text = new TextDecoder().decode(bytes);
  if ((type ?? "").includes("json")) {
    try {
      return { body: trim(JSON.parse(text)), contentType: type };
    } catch {
      /* as text */
    }
  }
  return { body: trim({ text: text.slice(0, 64 * 1024) }), contentType: type };
}

/**
 * Approves and EXECUTES. Only once: the proposal is reserved with an atomic
 * UPDATE (`pending → executing`); the second approval (or a simultaneous one)
 * receives 409 with the current state. If the agent can no longer (disabled,
 * key revoked or expired, permission withdrawn), it ends up `failed` without being executed.
 */
export async function approveProposal(
  id: string,
  human: Human,
  comment?: string | null,
  options: ApproveOptions = {}
): Promise<DecisionResult> {
  const p = await proposalById(id);
  if (!p) return { ok: false, status: 404, reason: "Proposal not found" };
  if (p.status === "pending" && p.expiresAt <= new Date()) await expireProposals();
  const actual = (await proposalById(id))!;
  if (actual.status !== "pending") {
    return { ok: false, status: 409, reason: `Proposal is ${actual.status}`, proposal: actual };
  }
  const reason = await reasonNotToApprove(human, actual);
  if (reason) return { ok: false, status: 403, reason: REASONS_NOT_TO_APPROVE[reason] };

  // Field by field (lib/ledger.ts): validated BEFORE reserving, so a bad decision
  // leaves the proposal pending.
  let decisions: FieldDecision[] | null = null;
  if (options.fields) {
    const fieldDiff = readFieldDiff(actual);
    if (!fieldDiff) {
      return {
        ok: false,
        status: 422,
        reason: "This proposal does not write a record: it can only be approved or rejected whole",
      };
    }
    try {
      decisions = resolveDecisions(fieldDiff, options.fields);
    } catch (err) {
      if (err instanceof LedgerInputError) return { ok: false, status: 422, reason: err.message };
      throw err;
    }
    // Every field rejected: nothing would run. That is a rejection.
    if (decisions.length > 0 && decisions.every((f) => f.decision === "reject")) {
      return rejectProposal(id, human, comment, { fieldDecisions: decisions });
    }
  }

  const [reserved] = await db
    .update(agentProposals)
    .set({
      status: "executing",
      decidedBy: human.id,
      decidedAt: new Date(),
      decisionComment: comment?.trim() ? comment.trim().slice(0, 2000) : null,
      ...(decisions ? { fieldDecisions: decisions as never } : {}),
    })
    .where(
      and(
        eq(agentProposals.id, id),
        eq(agentProposals.status, "pending"),
        gt(agentProposals.expiresAt, new Date())
      )
    )
    .returning();
  if (!reserved) {
    const other = (await proposalById(id))!;
    return { ok: false, status: 409, reason: `Proposal is ${other.status}`, proposal: other };
  }
  await audit({
    agentId: reserved.agentId,
    action: "proposal_approved",
    resource: `${reserved.method} ${reserved.path}`,
    resourceId: reserved.id,
    details: {
      by: human.id,
      sponsor: reserved.sponsorUserId ?? null,
      comment: reserved.decisionComment,
      ...(decisions ? { fields: decisionSummary(decisions) } : {}),
    },
  });

  const final = await runReserved(reserved, human);
  return { ok: true, proposal: final };
}

/**
 * What is really executed: the stored body or, decided field by field, only the
 * accepted fields (lib/ledger.ts). The REST PATCH of an entry replaces `data`, so
 * its accepted fields are applied over the row as the agent reads it NOW. Throws
 * `current_unavailable` when that row cannot be read.
 */
async function executedBody(p: Proposal, agent: AgentAuthContext): Promise<unknown> {
  const decisions = readDecisions(p);
  const fieldDiff = readFieldDiff(p);
  if (!decisions || !fieldDiff) return p.body;
  let current: Record<string, unknown> | null = null;
  const t = fieldDiff.target;
  if (
    t.replacesData &&
    t.readPath &&
    decisions.some((f) => f.decision === "accept" && f.field.startsWith("data."))
  ) {
    current = (await readAsAgent(agent, t.readPath)).current;
  }
  return applyDecisions(fieldDiff, p.body, decisions, current);
}

const UNAVAILABLE = Symbol("current_unavailable");
/** `current_unavailable` from `executedBody` becomes a marker; anything else is rethrown. */
function unavailable(err: unknown): typeof UNAVAILABLE {
  if (err instanceof Error && err.message === "current_unavailable") return UNAVAILABLE;
  throw err;
}

/** Once executed: the evidence of each accepted field stays with the row. */
async function keepEvidence(p: Proposal, human: Human): Promise<void> {
  const fieldDiff = readFieldDiff(p);
  const evidence = Array.isArray(p.evidence) ? (p.evidence as Evidence[]) : [];
  if (!fieldDiff || evidence.length === 0) return;
  const kept = await persistEvidence({
    proposal: p,
    diff: fieldDiff,
    target: fieldDiff.target,
    evidence,
    decisions: readDecisions(p),
    rowId: rowIdFromResult(fieldDiff.target, p.resultBody),
    acceptedBy: human.id,
  });
  if (kept === 0 && fieldDiff.target.entity) {
    logger.info(
      { proposalId: p.id },
      "[ledger] no row id in the result: the evidence stays on the proposal only"
    );
  }
}

async function runReserved(p: Proposal, human: Human): Promise<Proposal> {
  const approval = { proposalId: p.id, approvedBy: human.id };
  let final: Proposal;
  let executed: unknown;
  try {
    // 1. The agent, re-read from the database (scopes as of NOW).
    const ctx = await agentContextForApproval(p.agentId, p.keyId);
    if (!ctx.ok) {
      final = await saveResult(p.id, "failed", {
        status: null,
        error: `not_executed: ${ctx.reason}`,
      });
    } else {
      // 2. Can it still? (SDK operation: denial and permission).
      const path = p.path.split("?")[0]!;
      const ofRoute = p.konId ? routeOperation(p.method, path) : null;
      const user = { id: ctx.context.agentId, role: "agent", scopes: ctx.context.scopes };
      if (ofRoute && !(await agentCouldRun(ofRoute, user))) {
        final = await saveResult(p.id, "failed", {
          status: 403,
          error: "not_executed: agent_permission_revoked",
        });
      } else if (
        (executed = await executedBody(p, ctx.context).catch(unavailable)) === UNAVAILABLE
      ) {
        final = await saveResult(p.id, "failed", {
          status: null,
          error: "not_executed: current_unavailable",
        });
      } else if (p.channel === "mcp" && p.tool) {
        if (!mcpExecutor) throw new Error("MCP did not register its executor");
        const args = (executed && typeof executed === "object" ? executed : {}) as Record<
          string,
          unknown
        >;
        const r = await mcpExecutor(p.tool, args, ctx.context, approval);
        const sc = r.structuredContent as { status?: unknown } | undefined;
        const status = typeof sc?.status === "number" ? sc.status : r.isError ? 400 : 200;
        const withoutSecrets = containsSecret(r) ? { omitted: "secret" } : trim(r);
        final = await saveResult(p.id, r.isError ? "failed" : "executed", {
          sponsorUserId: ctx.context.sponsor?.userId ?? null,
          status,
          contentType: "application/json",
          body: withoutSecrets,
        });
      } else {
        // A held upload becomes again the form the agent sent.
        const body = isMultipart(p.contentType) ? await proposalForm(p) : executed;
        const res = await internalRequest(
          { agent: ctx.context, approval },
          p.method,
          p.path,
          body,
          p.contentType
        );
        const read = await readHttpResult(res);
        final = await saveResult(p.id, res.status < 400 ? "executed" : "failed", {
          sponsorUserId: ctx.context.sponsor?.userId ?? null,
          status: res.status,
          contentType: read.contentType,
          body: read.body,
        });
      }
    }
  } catch (err) {
    logger.error({ err, proposalId: p.id }, "[approvals] failure executing an approved proposal");
    final = await saveResult(p.id, "failed", { status: 500, error: "execution_error" });
  }
  if (final.status === "executed") {
    await keepEvidence(final, human).catch((err) => {
      logger.error({ err, proposalId: p.id }, "[ledger] could not keep the evidence of the fields");
    });
  }
  // Executed (or failed: it is not retried): what was held is already in place or is surplus.
  await deleteProposalFiles([p.id]).catch((err) => {
    logger.error({ err, proposalId: p.id }, "[approvals] could not delete the held files");
  });
  await audit({
    agentId: final.agentId,
    action: final.status === "executed" ? "proposal_executed" : "proposal_failed",
    resource: `${final.method} ${final.path}`,
    resourceId: final.id,
    // Agent (agentId), signer and approver: all three (owner decision).
    details: {
      by: human.id,
      sponsor: final.sponsorUserId ?? null,
      status: final.resultStatus,
      error: final.resultError,
    },
    success: final.status === "executed",
    errorMessage: final.resultError ?? undefined,
  }).catch(() => undefined);
  // B3: executed or failed, the agent finds out without polling.
  await notifyResolution(final.agentId, agentView(final)).catch(() => undefined);
  return final;
}

/** Rejects: it is NEVER executed. */
export async function rejectProposal(
  id: string,
  human: Human,
  comment?: string | null,
  options: { fieldDecisions?: FieldDecision[] } = {}
): Promise<DecisionResult> {
  const p = await proposalById(id);
  if (!p) return { ok: false, status: 404, reason: "Proposal not found" };
  if (p.status === "pending" && p.expiresAt <= new Date()) await expireProposals();
  if (!["admin", "editor"].includes(human.role)) {
    return { ok: false, status: 403, reason: "Only admins and editors can decide proposals" };
  }
  const [rejected] = await db
    .update(agentProposals)
    .set({
      status: "rejected",
      decidedBy: human.id,
      decidedAt: new Date(),
      decisionComment: comment?.trim() ? comment.trim().slice(0, 2000) : null,
      ...(options.fieldDecisions ? { fieldDecisions: options.fieldDecisions as never } : {}),
    })
    .where(and(eq(agentProposals.id, id), eq(agentProposals.status, "pending")))
    .returning();
  if (!rejected) {
    const other = (await proposalById(id))!;
    return { ok: false, status: 409, reason: `Proposal is ${other.status}`, proposal: other };
  }
  // Once rejected it is never executed: its held images are surplus.
  await deleteProposalFiles([rejected.id]);
  await audit({
    agentId: rejected.agentId,
    action: "proposal_rejected",
    resource: `${rejected.method} ${rejected.path}`,
    resourceId: rejected.id,
    details: {
      by: human.id,
      comment: rejected.decisionComment,
      ...(options.fieldDecisions ? { fields: decisionSummary(options.fieldDecisions) } : {}),
    },
  });
  await notifyResolution(rejected.agentId, agentView(rejected)).catch(() => undefined);
  return { ok: true, proposal: rejected };
}

// ═══════════════════════════════════════════════════════════════════════════
// Listings (panel and agent)
// ═══════════════════════════════════════════════════════════════════════════

export async function listProposals(f: {
  status?: string | null;
  agentId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ proposals: (Proposal & { agentName: string | null })[]; total: number }> {
  const conditions: SQL[] = [];
  if (f.status) conditions.push(eq(agentProposals.status, f.status));
  if (f.agentId) conditions.push(eq(agentProposals.agentId, f.agentId));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db
    .select({ p: agentProposals, agentName: agentIdentities.name })
    .from(agentProposals)
    .leftJoin(agentIdentities, eq(agentProposals.agentId, agentIdentities.id))
    .where(where)
    .orderBy(desc(agentProposals.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 50, 1), 200))
    .offset(Math.max(f.offset ?? 0, 0));
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentProposals)
    .where(where);
  return { proposals: rows.map((r) => ({ ...r.p, agentName: r.agentName })), total: total?.n ?? 0 };
}

export async function countPending(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentProposals)
    .where(and(eq(agentProposals.status, "pending"), gt(agentProposals.expiresAt, new Date())));
  return r?.n ?? 0;
}

/** Names of the accounts that appear in a list (to show who decided). */
export async function userNames(
  ids: (string | null | undefined)[]
): Promise<Record<string, string>> {
  const unique = [
    ...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0)),
  ];
  if (unique.length === 0) return {};
  const rows = await db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(inArray(authUsers.id, unique));
  return Object.fromEntries(rows.map((u) => [u.id, u.name || u.email || u.id]));
}
