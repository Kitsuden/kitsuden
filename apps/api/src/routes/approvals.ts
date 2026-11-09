/**
 * Human approval — the panel routes and the agent's route
 * ============================================================================
 *
 * `/api/approvals` — HUMANS ONLY from the team (admin or editor). An agent
 * NEVER gets in, not even with `admin`: it cannot approve its proposals or touch the
 * configuration (`humansOnly`, in addition to the `ADMIN_ONLY_ROUTES` gate).
 *
 *   GET  /proposals                 inbox (filters: status, agentId)
 *   GET  /proposals/count           pending (the panel's counter)
 *   GET  /proposals/:id             detail with the diff and whether YOU can decide
 *   POST /proposals/:id/approve     approves and executes (once); comment
 *   POST /proposals/:id/reject      rejects (never executed); comment
 *   GET  /proposals/:id/files/:fileId  the retained image of an upload (the
 *                                   panel's thumbnail; private, no cache)
 *   GET  /settings                  configuration + catalog of operations
 *   PUT  /settings                  ADMIN ONLY: switch, lifetime, operations,
 *                                   legacy rules
 *   PUT  /agents/:id/mode           ADMIN ONLY: inherit / propose / direct
 *   PUT  /agents/:id/unattended     ADMIN ONLY: hold / deny / null and the
 *                                   alternative text for unattended runs
 *   GET  /audit                     who turned on what, proposed, approved…
 *   POST /proposals/:id/review      schedule a later review of a decided proposal
 *   GET  /reviews                   later reviews (due by default)
 *   POST /reviews/:id/done          a person looked again (or cancelled it)
 *   GET  /evidence                  the evidence kept per field of a row
 *
 * Agent data ledger (lib/ledger.ts, docs/agents/ledger.md): approve takes an
 * optional `fields` list (accept/reject per field, with an edited value), and
 * approve/reject an optional `reviewAt` that schedules a later review.
 *
 * `/api/proposals` — the AGENT queries its own (another agent's: 404);
 * the team, any.
 *
 *   GET  /                          its proposals
 *   GET  /:id                       status and, if it was executed, the result
 *
 * These are SDK operations (OpenAPI with schemas; outside MCP with their reason)
 * of a core "kon", `kon-approvals`, which is NOT registered among the
 * mounted operations: no fine-grained scope (`kon:*`) opens these routes. The
 * agent queries its proposals through MCP with the tool
 * `kitsuden_proposal_status` (routes/mcp.ts).
 */

import { listMCPTools } from "@kitsuden/engine";
import {
  PROPOSAL_STATUSES,
  APPROVAL_MODES,
  PROPOSAL_RETENTIONS,
  mcpToolKey,
  defineOperation,
  isReadOnly,
  defaultSensitiveMcpTool,
  konShortName,
  UNATTENDED_MODES,
  ALTERNATIVE_MAX,
  DEFAULT_UNATTENDED_ALTERNATIVE,
} from "@kitsuden/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { detectRealType } from "../../../../packages/core/media/real-type";
import {
  mountedOperations,
  operationsRouter,
  type AnyOperation,
} from "../../../../packages/engine/src/operations";
import { db } from "../db";
import { agentAuditLogs, agentIdentities } from "../db/schema";
import {
  approveProposal,
  expireProposals,
  countPending,
  proposalFile,
  proposalFiles,
  saveApprovalsConfig,
  saveAgentMode,
  saveAgentUnattended,
  freshHuman,
  approvalsSnapshot,
  listProposals,
  reasonNotToApprove,
  userNames,
  proposalById,
  rejectProposal,
  operationSensitivity,
  agentView,
  type Human,
  type Proposal,
} from "../lib/approvals";
import { registerCoreOperations } from "../lib/core-operations";
import {
  LedgerInputError,
  closeReview,
  evidenceForRows,
  listReviews,
  readDecisions,
  readFieldDiff,
  reviewById,
  reviewDate,
  scheduleReview,
  type Review,
} from "../lib/ledger";
import { logger } from "../lib/logger";
import { proposalChannel, type ProposalView } from "../lib/proposal-notifications";
import { subscribe } from "../lib/valkey";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { requireAdminRole, requireStaff } from "../middleware/auth-guard";
import { writingTool, listHardcodedMCPTools } from "../services/mcp-tools";

// ── Who ─────────────────────────────────────────────────────────────────────

function get(c: Context, k: string): unknown {
  return (c.get as (k: string) => unknown)(k);
}

/**
 * An agent NEVER decides or configures approvals, whatever scopes it
 * carries (`admin` included). Neither do the inherited `kitsuden_sk_*` keys
 * (a synthetic "admin", already retired).
 */
export const humansOnly: MiddlewareHandler = async (c, next) => {
  const user = get(c, "user") as { id?: string; role?: string } | null;
  if (get(c, "agent") || user?.role === "agent" || user?.id?.startsWith("machine-")) {
    return c.json(
      { error: "Forbidden", message: "Agents cannot decide proposals or change approval settings" },
      403
    );
  }
  await next();
};

/** The agent (its own) or the team (everything). */
const agentOrTeam: MiddlewareHandler = async (c, next) => {
  if (get(c, "agent")) return next();
  return (requireStaff as unknown as MiddlewareHandler)(c, next);
};

/** The human making the request, with their role NOW (not the cookie's). */
async function humanOf(c: Context): Promise<Human | null> {
  const u = get(c, "user") as { id?: string } | null;
  return u?.id ? freshHuman(u.id) : null;
}

// ── Views ───────────────────────────────────────────────────────────────────

/**
 * What replaces the body, the diffs and the result for someone who could NOT
 * approve the proposal (security review 2026-11-04): an editor sees that there
 * is a request to an admin route (method, path, agent, status), not what it carries.
 */
export const REDACTED_CONTENT = { redacted: true, reason: "viewer_cannot_approve" } as const;

/** May this human see the content? Only someone who could approve it (in any state). */
async function canSeeContent(human: Human | null | undefined, p: Proposal): Promise<boolean> {
  if (!human) return false;
  return (await reasonNotToApprove(human, p)) === null;
}

async function teamView(p: Proposal & { agentName?: string | null }, human?: Human | null) {
  const names = await userNames([p.decidedBy, p.sponsorUserId]);
  // After deciding, the row arrives from the UPDATE without the agent's name: it is looked up.
  if (p.agentName === undefined) {
    const [a] = await db
      .select({ name: agentIdentities.name })
      .from(agentIdentities)
      .where(eq(agentIdentities.id, p.agentId))
      .limit(1);
    p = { ...p, agentName: a?.name ?? null };
  }
  const seeContent = await canSeeContent(human, p);
  const cannotDecide = human && p.status === "pending" ? await reasonNotToApprove(human, p) : null;
  const decisions = readDecisions(p);
  const fieldDiff = readFieldDiff(p);
  return {
    ...agentView(p),
    agentId: p.agentId,
    agentName: p.agentName ?? null,
    keyId: p.keyId,
    body: seeContent || p.body === null ? p.body : REDACTED_CONTENT,
    bodyRedacted: !seeContent && p.body !== null,
    contentType: p.contentType,
    idempotencyKey: p.idempotencyKey,
    scopes: p.scopes,
    diff: seeContent || p.diff === null ? p.diff : REDACTED_CONTENT,
    injectionCheck: p.injectionCheck ?? null,
    konId: p.konId,
    operationId: p.operationId,
    decidedBy: p.decidedBy,
    decidedByName: p.decidedBy ? (names[p.decidedBy] ?? p.decidedBy) : null,
    // The agent's human signer (when proposing and, once executed, the one used).
    sponsorUserId: p.sponsorUserId ?? null,
    sponsorName: p.sponsorUserId ? (names[p.sponsorUserId] ?? p.sponsorUserId) : null,
    // The retained images of an upload (empty if it is not one, or if they were already deleted).
    files: await proposalFiles(p.id),
    // Agent data ledger: the per-field diff, the agent's evidence and the decision per field.
    fieldDiff: seeContent || fieldDiff === null ? fieldDiff : REDACTED_CONTENT,
    evidence: Array.isArray(p.evidence) ? p.evidence : [],
    // Without the content: which fields were accepted or rejected, not their edited values.
    fieldDecisions:
      seeContent || !decisions
        ? decisions
        : decisions.map((f) => ({ field: f.field, decision: f.decision, edited: f.edited })),
    reviews: (
      await listReviews({ status: "all", proposalId: p.id, limit: 50 }).catch(() => ({
        reviews: [] as Review[],
      }))
    ).reviews.map(reviewView),
    result:
      p.status === "executed" || p.status === "failed"
        ? {
            status: p.resultStatus,
            contentType: p.resultContentType,
            body: seeContent || p.resultBody === null ? p.resultBody : REDACTED_CONTENT,
            error: p.resultError,
          }
        : null,
    ...(human
      ? {
          canDecide: p.status === "pending" ? cannotDecide === null : false,
          cannotDecideReason: p.status === "pending" ? cannotDecide : null,
        }
      : {}),
  };
}

// ── Inbox ───────────────────────────────────────────────────────────────────

const InboxFilter = z
  .object({
    status: z.enum(PROPOSAL_STATUSES as [string, ...string[]]).optional(),
    agentId: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

async function inbox(c: Context, filter: z.infer<typeof InboxFilter>) {
  await expireProposals();
  const { proposals, total } = await listProposals(filter);
  const names = await userNames(proposals.map((p) => p.decidedBy));
  const human = await humanOf(c);
  const views = [];
  for (const p of proposals) {
    const view = agentView(p);
    // Nor the result of a route this human could not approve.
    if (
      "result" in view &&
      view.result &&
      view.result.body !== null &&
      !(await canSeeContent(human, p))
    ) {
      view.result = { ...view.result, body: REDACTED_CONTENT as never };
    }
    views.push({
      ...view,
      agentId: p.agentId,
      agentName: p.agentName,
      decidedBy: p.decidedBy,
      decidedByName: p.decidedBy ? (names[p.decidedBy] ?? p.decidedBy) : null,
    });
  }
  return c.json({ total, proposals: views });
}

async function detail(c: Context, id: string) {
  await expireProposals();
  const p = await proposalById(id);
  if (!p) return c.json({ error: "Proposal not found" }, 404);
  const [a] = await db
    .select({ name: agentIdentities.name })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, p.agentId))
    .limit(1);
  return c.json(await teamView({ ...p, agentName: a?.name ?? null }, await humanOf(c)));
}

const FieldDecisionInput = z
  .object({
    field: z.string().min(1).max(300),
    decision: z.enum(["accept", "reject"]),
    value: z.unknown().optional(),
  })
  .strict();

const Decision = z
  .object({
    comment: z.string().max(2000).optional(),
    fields: z
      .array(FieldDecisionInput)
      .max(500)
      .optional()
      .describe(
        "Per-field decision for a proposal that writes a record (see fieldDiff): accept or reject each field, optionally with an edited value. Fields not listed are accepted. Approve only."
      ),
    reviewAt: z
      .string()
      .max(64)
      .optional()
      .describe("ISO date: schedule a later review of this decision (within a year)"),
    reviewNote: z.string().max(2000).optional(),
  })
  .strict();
type DecisionBody = z.infer<typeof Decision>;

function reviewView(r: Review) {
  const due = r.status === "due" || (r.status === "scheduled" && r.dueAt <= new Date());
  return {
    id: r.id,
    proposalId: r.proposalId,
    entity: r.entity,
    rowId: r.rowId,
    fields: r.fields,
    note: r.note,
    dueAt: r.dueAt,
    status: due && r.status === "scheduled" ? "due" : r.status,
    scheduledBy: r.scheduledBy,
    becameDueAt: r.becameDueAt,
    doneBy: r.doneBy,
    doneAt: r.doneAt,
    doneComment: r.doneComment,
    createdAt: r.createdAt,
  };
}

const errorName = (status: number) =>
  status === 404
    ? "Not found"
    : status === 403
      ? "Forbidden"
      : status === 422
        ? "Validation failed"
        : "Conflict";

async function decide(c: Context, id: string, body: DecisionBody | undefined, approve: boolean) {
  const human = await humanOf(c);
  if (!human) return c.json({ error: "Unauthorized" }, 401);
  const comment = body?.comment;
  if (!approve && body?.fields) {
    return c.json(
      {
        error: "Validation failed",
        message: "fields is for approving; reject decides the whole proposal",
      },
      422
    );
  }
  // The review date is checked BEFORE deciding: a bad date does not leave half a decision.
  let dueAt: Date | null = null;
  if (body?.reviewAt !== undefined) {
    try {
      dueAt = reviewDate(body.reviewAt);
    } catch (err) {
      if (err instanceof LedgerInputError)
        return c.json({ error: "Validation failed", message: err.message }, 422);
      throw err;
    }
  }
  const r = approve
    ? await approveProposal(id, human, comment, { fields: body?.fields })
    : await rejectProposal(id, human, comment);
  if (!r.ok) {
    return c.json(
      {
        error: errorName(r.status),
        message: r.reason,
        ...(r.proposal ? { proposal: await teamView(r.proposal, human) } : {}),
      },
      r.status
    );
  }
  if (dueAt) {
    // The decision already stands: a review that cannot be stored does not undo it.
    await scheduleReview({
      proposal: r.proposal,
      dueAt,
      note: body?.reviewNote,
      by: human.id,
    }).catch((err) =>
      logger.error({ err, proposalId: r.proposal.id }, "[ledger] could not schedule the review")
    );
  }
  return c.json({ proposal: await teamView(r.proposal, human) });
}

// ── Later reviews and evidence (agent data ledger) ──────────────────────────

const ReviewRequest = z
  .object({
    reviewAt: z.string().max(64),
    note: z.string().max(2000).optional(),
    fields: z.array(z.string().min(1).max(300)).max(200).optional(),
  })
  .strict();

async function scheduleLater(c: Context, id: string, body: z.infer<typeof ReviewRequest>) {
  const human = await humanOf(c);
  if (!human) return c.json({ error: "Unauthorized" }, 401);
  const p = await proposalById(id);
  if (!p) return c.json({ error: "Proposal not found" }, 404);
  try {
    const review = await scheduleReview({
      proposal: p,
      dueAt: reviewDate(body.reviewAt),
      note: body.note,
      fields: body.fields,
      by: human.id,
    });
    return c.json({ review: reviewView(review) }, 201);
  } catch (err) {
    if (err instanceof LedgerInputError)
      return c.json({ error: "Validation failed", message: err.message }, 422);
    throw err;
  }
}

const ReviewFilter = z
  .object({
    status: z.enum(["due", "scheduled", "done", "cancelled", "all"]).optional(),
    proposalId: z.guid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

async function reviewsList(c: Context, f: z.infer<typeof ReviewFilter>) {
  const { total, reviews } = await listReviews(f);
  const due =
    f.status === "due" || !f.status
      ? total
      : (await listReviews({ status: "due", limit: 1 })).total;
  return c.json({ total, due, reviews: reviews.map(reviewView) });
}

const ReviewClose = z
  .object({
    comment: z.string().max(2000).optional(),
    cancel: z.boolean().optional().describe("true: cancel it instead of marking it done"),
  })
  .strict();

async function reviewDone(c: Context, id: string, body: z.infer<typeof ReviewClose> | undefined) {
  const human = await humanOf(c);
  if (!human) return c.json({ error: "Unauthorized" }, 401);
  const r = await closeReview(id, human.id, body?.comment, body?.cancel ? "cancelled" : "done");
  if (!r) {
    const existing = await reviewById(id);
    if (!existing) return c.json({ error: "Review not found" }, 404);
    return c.json({ error: "Conflict", message: `Review is ${existing.status}` }, 409);
  }
  return c.json({ review: reviewView(r) });
}

const EvidenceQuery = z
  .object({
    entity: z.string().min(1).max(200),
    rowId: z.string().min(1).max(200),
  })
  .strict();

async function evidenceOfRow(c: Context, q: z.infer<typeof EvidenceQuery>) {
  const found = await evidenceForRows(q.entity, [q.rowId]);
  return c.json({ entity: q.entity, rowId: q.rowId, fields: found.get(q.rowId) ?? {} });
}

/**
 * The retained image of an upload, for the panel's thumbnail. Human staff
 * only (the operation's gates). It is served with its REAL type, checked
 * again against the bytes, with no shared cache and without letting the browser
 * treat it as anything else (`nosniff`, empty CSP, `inline`).
 */
async function retainedFile(c: Context, id: string, fileId: string) {
  const f = await proposalFile(id, fileId);
  if (!f) return c.json({ error: "File not found" }, 404);
  const bytes = new Uint8Array(f.content);
  const real = detectRealType(bytes);
  if (!real || real.mime !== f.mimeType || !real.mime.startsWith("image/")) {
    return c.json({ error: "File not found" }, 404);
  }
  const name = f.filename.replace(/[^\w.-]+/g, "_").slice(0, 120) || `image.${real.extension}`;
  return c.body(bytes, 200, {
    "Content-Type": real.mime,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `inline; filename="${name}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-site",
  });
}

// ── Configuration ───────────────────────────────────────────────────────────

async function configuration(c: Context) {
  const i = await approvalsSnapshot();
  const operations = [];
  for (const { konId, mountPath, operations: ops } of mountedOperations()) {
    for (const op of ops) {
      const s = operationSensitivity(i.config, konId, op);
      operations.push({
        key: s.key,
        konId,
        kon: konShortName(konId),
        id: op.id,
        method: op.method,
        path: op.route === "/" ? mountPath : `${mountPath}${op.route}`,
        summary: op.summary,
        default: s.isDefault,
        override: s.changed ? i.config.operations[s.key] : null,
        sensitive: s.sensitive,
        readOnly: isReadOnly(op),
      });
    }
  }
  const dynamic = new Set(listMCPTools().map((t) => t.name));
  const tools = [...listHardcodedMCPTools().map((t) => t.function.name), ...dynamic].map((name) => {
    const key = mcpToolKey(name);
    const changed = Object.prototype.hasOwnProperty.call(i.config.operations, key);
    const defaultValue = defaultSensitiveMcpTool(name);
    return {
      key,
      name,
      write: dynamic.has(name) || writingTool(name),
      default: defaultValue,
      override: changed ? i.config.operations[key] : null,
      sensitive: changed ? i.config.operations[key] : defaultValue,
    };
  });
  const agents = await db
    .select({
      id: agentIdentities.id,
      name: agentIdentities.name,
      mode: agentIdentities.approvalMode,
      unattended: agentIdentities.unattendedApproval,
      unattendedAlternative: agentIdentities.unattendedAlternative,
      isActive: agentIdentities.isActive,
    })
    .from(agentIdentities)
    .orderBy(agentIdentities.name);
  const names = await userNames([i.updatedBy]);
  return c.json({
    config: i.config,
    updatedBy: i.updatedBy,
    updatedByName: i.updatedBy ? (names[i.updatedBy] ?? i.updatedBy) : null,
    updatedAt: i.updatedAt,
    modes: APPROVAL_MODES,
    retentions: PROPOSAL_RETENTIONS,
    unattendedModes: UNATTENDED_MODES,
    defaultAlternative: DEFAULT_UNATTENDED_ALTERNATIVE,
    operations,
    mcpTools: tools,
    agents,
  });
}

const ConfigChange = z
  .object({
    enabled: z.boolean().optional(),
    proposeRetention: z.enum(PROPOSAL_RETENTIONS as [string, ...string[]]).optional(),
    ttlHours: z.number().int().optional(),
    operations: z.record(z.string(), z.union([z.boolean(), z.null()])).optional(),
    legacyRules: z
      .array(
        z
          .object({
            method: z.string(),
            path: z.string(),
            alternative: z.string().max(ALTERNATIVE_MAX).optional(),
          })
          .strict()
      )
      .optional(),
    unattended: z.enum(UNATTENDED_MODES as [string, ...string[]]).optional(),
    unattendedAlternative: z.union([z.string().max(ALTERNATIVE_MAX), z.null()]).optional(),
    alternatives: z
      .record(z.string(), z.union([z.string().max(ALTERNATIVE_MAX), z.null()]))
      .optional(),
  })
  .strict();

const UnattendedChange = z
  .object({
    mode: z.union([z.enum(UNATTENDED_MODES as [string, ...string[]]), z.null()]).optional(),
    alternative: z.union([z.string().max(ALTERNATIVE_MAX), z.null()]).optional(),
  })
  .strict();

async function saveConfig(c: Context, change: z.infer<typeof ConfigChange>) {
  const human = await humanOf(c);
  if (!human) return c.json({ error: "Unauthorized" }, 401);
  try {
    await saveApprovalsConfig(change, human.id);
  } catch (err) {
    return c.json({ error: "Validation failed", message: (err as Error).message }, 422);
  }
  return configuration(c);
}

async function saveMode(c: Context, agentId: string, mode: string) {
  const human = await humanOf(c);
  if (!human) return c.json({ error: "Unauthorized" }, 401);
  const r = await saveAgentMode(agentId, mode as never, human.id);
  if (!r) return c.json({ error: "Agent not found" }, 404);
  return c.json({ agentId, mode: r.after, previous: r.before });
}

async function saveUnattended(
  c: Context,
  agentId: string,
  change: z.infer<typeof UnattendedChange>
) {
  const human = await humanOf(c);
  if (!human) return c.json({ error: "Unauthorized" }, 401);
  let r: Awaited<ReturnType<typeof saveAgentUnattended>>;
  try {
    r = await saveAgentUnattended(agentId, change, human.id);
  } catch (err) {
    return c.json({ error: "Validation failed", message: (err as Error).message }, 422);
  }
  if (!r) return c.json({ error: "Agent not found" }, 404);
  return c.json({ agentId, ...r.after, previous: r.before });
}

// ── Audit ───────────────────────────────────────────────────────────────────

const AUDIT_ACTIONS = [
  "approval_settings_changed",
  "approval_mode_changed",
  "unattended_setting_changed",
  "unattended_denied",
  "proposal_created",
  "proposal_approved",
  "proposal_rejected",
  "proposal_executed",
  "proposal_failed",
  "proposal_expired",
  "proposal_review_scheduled",
  "proposal_review_due",
  "proposal_review_done",
  // Code promotion (lib/promotion.ts) is also audited here.
  "promotion_submitted",
  "promotion_activated",
  "promotion_activation_blocked",
  "promotion_activation_failed",
  "promotion_rejected",
  "promotion_rolled_back",
  "promotion_manual_edit",
  "promotion_watch_passed",
  "promotion_settings_changed",
  "promotion_mode_changed",
];

const AuditFilter = z
  .object({
    agentId: z.string().min(1).max(100).optional(),
    proposalId: z.guid().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

async function listAudit(c: Context, f: z.infer<typeof AuditFilter>) {
  const conditions = [inArray(agentAuditLogs.action, AUDIT_ACTIONS)];
  if (f.agentId) conditions.push(eq(agentAuditLogs.agentId, f.agentId));
  if (f.proposalId) conditions.push(eq(agentAuditLogs.resourceId, f.proposalId));
  const where = and(...conditions);
  const rows = await db
    .select({ log: agentAuditLogs, agentName: agentIdentities.name })
    .from(agentAuditLogs)
    .leftJoin(agentIdentities, eq(agentAuditLogs.agentId, agentIdentities.id))
    .where(where)
    .orderBy(desc(agentAuditLogs.createdAt))
    .limit(f.limit ?? 100)
    .offset(f.offset ?? 0);
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentAuditLogs)
    .where(where);
  const by = (d: unknown) => ((d as { by?: unknown } | null)?.by as string | undefined) ?? null;
  const names = await userNames(rows.map((r) => by(r.log.details)));
  return c.json({
    total: total?.n ?? 0,
    events: rows.map(({ log, agentName }) => ({
      id: log.id,
      at: log.createdAt,
      action: log.action,
      agentId: log.agentId,
      agentName,
      proposalId: log.resourceId,
      resource: log.resource,
      by: by(log.details),
      byName: by(log.details) ? (names[by(log.details)!] ?? by(log.details)) : null,
      success: log.success,
      details: log.details,
    })),
  });
}

// ── The agent's part ────────────────────────────────────────────────────────

const AgentFilter = z
  .object({
    status: z.enum(PROPOSAL_STATUSES as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

async function agentOwn(c: Context, f: z.infer<typeof AgentFilter>) {
  const agent = get(c, "agent") as { agentId: string } | undefined;
  await expireProposals();
  const { proposals, total } = await listProposals({ ...f, agentId: agent?.agentId ?? null });
  return c.json({ total, proposals: proposals.map((p) => agentView(p)) });
}

async function statusForAgent(c: Context, id: string) {
  const agent = get(c, "agent") as { agentId: string } | undefined;
  await expireProposals();
  const p = await proposalById(id);
  // Another agent's proposal does not exist for this one (404, not 403: nothing is confirmed).
  if (!p || (agent && p.agentId !== agent.agentId))
    return c.json({ error: "Proposal not found" }, 404);
  return c.json(agentView(p));
}

/** States in which a proposal no longer changes. */
const RESOLVED = new Set(["executed", "failed", "rejected", "expired"]);
/** An event stream closes after 15 minutes without resolution (the agent reconnects). */
const FLOW_LIFETIME_MS = 15 * 60_000;

/**
 * B3: the changes of ONE proposal, as a flow. First how it stands now; then
 * each change that `notifyResolution` publishes on the bus (with or without Valkey), and
 * it closes when resolved. Every 30 s without news it is re-read from the database, in case
 * the notice was lost (another replica, a bus outage).
 */
async function* proposalEvents(id: string, initial: ProposalView): AsyncGenerator<ProposalView> {
  yield initial;
  if (RESOLVED.has(initial.status)) return;
  const received: ProposalView[] = [];
  let wakeUp: (() => void) | null = null;
  const leaveNow = await subscribe(proposalChannel(id), (_channel, message) => {
    try {
      received.push(JSON.parse(message) as ProposalView);
    } catch {
      return;
    }
    wakeUp?.();
  });
  let last = initial.status;
  const until = Date.now() + FLOW_LIFETIME_MS;
  try {
    while (Date.now() < until) {
      if (received.length === 0) {
        await new Promise<void>((ok) => {
          wakeUp = ok;
          setTimeout(ok, 30_000).unref?.();
        });
        wakeUp = null;
      }
      let view = received.shift();
      if (!view) {
        const p = await proposalById(id);
        if (!p) return;
        view = agentView(p);
      }
      if (view.status === last) continue;
      last = view.status;
      yield view;
      if (RESOLVED.has(view.status)) return;
    }
  } finally {
    await leaveNow();
  }
}

// ── The operations (kon SDK) ────────────────────────────────────────────────

const Obj = z.record(z.string(), z.unknown());
const ParamId = z.object({ id: z.guid() });
const WITHOUT_MCP = {
  exclude:
    "Human approval of agent proposals: a human decides in the admin panel; no agent may approve, reject or reconfigure approvals. Agents read their own proposals with the MCP tool kitsuden_proposal_status.",
};
const TEAM: MiddlewareHandler[] = [humansOnly, requireStaff as unknown as MiddlewareHandler];
const ADMIN: MiddlewareHandler[] = [humansOnly, requireAdminRole as unknown as MiddlewareHandler];

const ofTheTeam = {
  access: "session" as const,
  permission: { roles: ["admin", "editor"] },
  before: TEAM,
  mcp: WITHOUT_MCP,
  tags: ["approvals"],
};
const fromAdmin = { ...ofTheTeam, permission: { roles: ["admin"] }, before: ADMIN };

export const approvalOperations: AnyOperation[] = [
  defineOperation({
    ...ofTheTeam,
    id: "list-proposals",
    method: "GET",
    route: "/proposals",
    summary: "Approval inbox",
    description:
      "Agent proposals, newest first, with their status (pending, executing, executed, failed, rejected, expired). Pending ones past their expiry are marked expired first.",
    input: { query: InboxFilter },
    output: { schema: Obj },
    handle: (e, { c }) => inbox(c, e.query as z.infer<typeof InboxFilter>),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "count-pending",
    method: "GET",
    route: "/proposals/count",
    summary: "Pending proposals",
    description: "How many proposals are waiting for a human (the panel's counter).",
    output: { schema: z.object({ pending: z.number() }) },
    handle: async (_e, { c }) => {
      await expireProposals();
      return c.json({ pending: await countPending() });
    },
  }),
  defineOperation({
    ...ofTheTeam,
    id: "proposal-detail",
    method: "GET",
    route: "/proposals/:id",
    summary: "A proposal in detail",
    description:
      "The stored request (method, path, body without secrets), the expected diff, the agent and key, the decision and the real result. `canDecide` says whether the caller may approve it.",
    input: { params: ParamId },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (e, { c }) => detail(c, (e.params as { id: string }).id),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "approve-proposal",
    method: "POST",
    route: "/proposals/:id/approve",
    summary: "Approve and execute a proposal",
    description:
      "Executes the stored request once, with the agent's CURRENT identity and permissions, and records the approver. A second approval gets 409. If the agent was deactivated, its key revoked or expired, or its permission removed, the proposal ends as failed without executing. With `fields` (a proposal that writes a record), only the fields it accepts are executed, with any edited value; a field the list leaves out is rejected, and every field rejected is a rejection. `reviewAt` schedules a later review.",
    input: { params: ParamId, body: Decision },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT", "KITSUDEN_E_VALIDATION"],
    handle: (e, { c }) =>
      decide(c, (e.params as { id: string }).id, e.body as DecisionBody | undefined, true),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "reject-proposal",
    method: "POST",
    route: "/proposals/:id/reject",
    summary: "Reject a proposal",
    description:
      "The request is never executed. The comment is shown to the agent. `reviewAt` schedules a later review.",
    input: { params: ParamId, body: Decision },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT", "KITSUDEN_E_VALIDATION"],
    handle: (e, { c }) =>
      decide(c, (e.params as { id: string }).id, e.body as DecisionBody | undefined, false),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "schedule-proposal-review",
    method: "POST",
    route: "/proposals/:id/review",
    summary: "Schedule a later review of a decided proposal",
    description:
      "At `reviewAt` (ISO date, within a year) the review becomes due and is listed in GET /reviews for a person to look again at what was decided, optionally only some `fields`. Only for executed, failed or rejected proposals.",
    input: { params: ParamId, body: ReviewRequest },
    output: { status: 201, schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION"],
    handle: (e, { c }) =>
      scheduleLater(c, (e.params as { id: string }).id, e.body as z.infer<typeof ReviewRequest>),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "list-reviews",
    method: "GET",
    route: "/reviews",
    summary: "Later reviews of decided proposals",
    description:
      "Review items, soonest first. `status=due` (the default) also counts a scheduled review past its date; `due` in the answer is how many are due.",
    input: { query: ReviewFilter },
    output: { schema: Obj },
    handle: (e, { c }) => reviewsList(c, e.query as z.infer<typeof ReviewFilter>),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "close-review",
    method: "POST",
    route: "/reviews/:id/done",
    summary: "Mark a later review as done",
    description:
      "A person looked again at what was decided. `cancel: true` cancels it instead. A review already closed gets 409.",
    input: { params: ParamId, body: ReviewClose },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: (e, { c }) =>
      reviewDone(c, (e.params as { id: string }).id, e.body as z.infer<typeof ReviewClose>),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "row-evidence",
    method: "GET",
    route: "/evidence",
    summary: "The evidence of each field of a row",
    description:
      "The newest evidence kept per field of one row (`entity`: dataset_entry, table:<name> or sdk:<kon>; `rowId`), as applied from approved agent proposals: source, quote, confidence, retrieval date, the value applied, the proposal and who accepted it.",
    input: { query: EvidenceQuery },
    output: { schema: Obj },
    handle: (e, { c }) => evidenceOfRow(c, e.query as z.infer<typeof EvidenceQuery>),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "proposal-image",
    method: "GET",
    route: "/proposals/:id/files/:fileId",
    summary: "An image held in a proposal",
    description:
      "The bytes of an image an agent uploaded while waiting for approval (a held multipart upload), for the panel's thumbnail. Team members only; never public and never cached. Deleted when the proposal is rejected, expires or is executed, after which this answers 404.",
    input: { params: z.object({ id: z.guid(), fileId: z.guid() }) },
    output: { type: "image/*", description: "The image bytes (JPEG, PNG, GIF, WebP or AVIF)" },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (e, { c }) => {
      const p = e.params as { id: string; fileId: string };
      return retainedFile(c, p.id, p.fileId);
    },
  }),
  defineOperation({
    ...ofTheTeam,
    id: "approvals-configuration",
    method: "GET",
    route: "/settings",
    summary: "Approval settings",
    description:
      "The global switch, proposal lifetime, legacy route rules, every SDK operation and core MCP tool with its default and overridden sensitivity, and each agent's mode.",
    output: { schema: Obj },
    handle: (_e, { c }) => configuration(c),
  }),
  defineOperation({
    ...fromAdmin,
    id: "save-approvals-configuration",
    method: "PUT",
    route: "/settings",
    summary: "Change approval settings (admin)",
    description:
      "Partial update: enabled (the MASTER switch: off, no agent asks for approval, not even those in propose), proposeRetention (selective: propose does not hold POSTs declared read-only; strict: it holds every write), ttlHours (1-720), operations { key: true | false | null }, legacyRules [{ method, path, alternative? }], unattended (hold | deny: what an unattended run does with a request that would be held), unattendedAlternative (text | null) and alternatives { key: text | null } per operation. Takes effect without a restart and is audited.",
    input: { body: ConfigChange },
    output: { schema: Obj },
    handle: (e, { c }) => saveConfig(c, e.body as z.infer<typeof ConfigChange>),
  }),
  defineOperation({
    ...fromAdmin,
    id: "agent-mode",
    method: "PUT",
    route: "/agents/:id/mode",
    summary: "Set an agent's approval mode (admin)",
    description:
      "inherit (only sensitive operations wait), propose (its writes become proposals too, per proposeRetention) or direct (never asks). With the master switch off nobody asks, whatever the mode. Audited.",
    input: {
      params: z.object({ id: z.string().min(1) }),
      body: z.object({ mode: z.enum(APPROVAL_MODES as [string, ...string[]]) }).strict(),
    },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (e, { c }) =>
      saveMode(c, (e.params as { id: string }).id, (e.body as { mode: string }).mode),
  }),
  defineOperation({
    ...fromAdmin,
    id: "agent-unattended",
    method: "PUT",
    route: "/agents/:id/unattended",
    summary: "Set what an agent's unattended runs do with held writes (admin)",
    description:
      "When nobody is attending the run (a cron or event action, an agent run they started, or a request with `Kitsuden-Unattended: true`), a request that would be held for approval is held (`hold`, 202) or refused (`deny`, 403 KITSUDEN_E_DENIED_UNATTENDED) with `alternative`: what to do instead. `mode: null` follows the global `unattended` setting; `alternative: null` uses the global text. Audited.",
    input: {
      params: z.object({ id: z.string().min(1) }),
      body: UnattendedChange,
    },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (e, { c }) =>
      saveUnattended(
        c,
        (e.params as { id: string }).id,
        e.body as z.infer<typeof UnattendedChange>
      ),
  }),
  defineOperation({
    ...ofTheTeam,
    id: "approvals-audit",
    method: "GET",
    route: "/audit",
    summary: "Approval audit trail",
    description:
      "Who changed each switch and when, who proposed, who approved or rejected, and the result of each execution.",
    input: { query: AuditFilter },
    output: { schema: Obj },
    handle: (e, { c }) => listAudit(c, e.query as z.infer<typeof AuditFilter>),
  }),
];

const ofTheAgent = {
  access: "session" as const,
  before: [agentOrTeam],
  mcp: WITHOUT_MCP,
  tags: ["approvals"],
};

export const proposalOperations: AnyOperation[] = [
  defineOperation({
    ...ofTheAgent,
    id: "my-proposals",
    method: "GET",
    route: "/",
    summary: "My proposals (agent)",
    description:
      "An agent's own proposals with their status and, once executed, the real result. A staff member sees every proposal.",
    input: { query: AgentFilter },
    output: { schema: Obj },
    handle: (e, { c }) => agentOwn(c, e.query as z.infer<typeof AgentFilter>),
  }),
  defineOperation({
    ...ofTheAgent,
    id: "proposal-status",
    method: "GET",
    route: "/:id",
    summary: "Proposal status (agent)",
    description:
      "pending, executing, executed, failed, rejected or expired; the reviewer's comment; and, once executed, `result` with the real status and body. Another agent's proposal is 404.",
    input: { params: ParamId },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (e, { c }) => statusForAgent(c, (e.params as { id: string }).id),
  }),
  defineOperation({
    ...ofTheAgent,
    id: "proposal-events",
    method: "GET",
    route: "/:id/events",
    summary: "Proposal events (agent, Server-Sent Events)",
    description:
      "The proposal as its agent sees it, now and on every change, until it is executed, failed, rejected or expired; then `event: end`. Instead of polling `/api/proposals/:id`. Closes after 15 minutes without a resolution (reconnect). For a push to your own server instead, an admin sets the agent's notify URL (signed webhook).",
    input: { params: ParamId },
    output: { flow: true, schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    async handle(e, { c }) {
      const id = (e.params as { id: string }).id;
      // A normal 404 BEFORE opening the stream (another agent's proposal does not exist either).
      const res = await statusForAgent(c, id);
      if (res.status !== 200) return res;
      return proposalEvents(id, (await res.json()) as ProposalView);
    },
  }),
];

/** For the inventory (OpenAPI, coverage): it is not registered among the mounted ones. */
export const approvalsKon = {
  id: "kon-approvals",
  name: "Human approval",
  version: "1.0.0",
  mountPath: "/api/approvals",
  operations: approvalOperations,
};
export const proposalsKon = {
  id: "kon-proposals",
  name: "Agent proposals",
  version: "1.0.0",
  mountPath: "/api/proposals",
  operations: proposalOperations,
};

registerCoreOperations({
  konId: "kon-approvals",
  mountPath: "/api/approvals",
  description: "Human approval of agent proposals (team members only; never an agent).",
  operations: approvalOperations,
});
registerCoreOperations({
  konId: "kon-proposals",
  mountPath: "/api/proposals",
  description: "An agent reads the status and result of its own proposals.",
  operations: proposalOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const approvalsRoutes = operationsRouter("kon-approvals", approvalOperations, context);
export const proposalsRoutes = operationsRouter("kon-proposals", proposalOperations, context);
