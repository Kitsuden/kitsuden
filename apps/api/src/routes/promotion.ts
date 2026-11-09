/**
 * Code promotion — the agent's routes and the panel's
 * ============================================================================
 *
 * `/api/promotion` — core kon `kon-promotion`, registered among the
 * MOUNTED operations (hence its MCP tools `promotion_*`). An agent
 * gets in with `promotion:propose` (or `promotion:*`, `kon:promotion:<op>`,
 * `admin`); a human admin, through the `ADMIN_ONLY_ROUTES` gate.
 *
 *   POST /drafts                 propose a draft: tests + scan +
 *                                decision (turbo or proposal), in the response
 *   GET  /drafts                 the agent's drafts (an admin: all)
 *   GET  /drafts/:id             one, with its code, reports and proposal
 *   POST /versions/:id/activate  the ACTIVATION. An agent only gets here
 *                                from the execution of ITS proposal approved
 *                                by a human (the process mark, which does not
 *                                travel over the network); on its own, 403. A human
 *                                admin activates an `approved` version that could
 *                                not be activated (ENABLE_CODE_ACTIONS off).
 *                                Outside MCP.
 *
 * `/api/approvals/promotion` — `kon-promotion-admin`, human admins ONLY
 * (`humansOnly` + `requireAdminRole`; it is NOT registered among the mounted ones: no
 * scope opens it and it is not an MCP tool). Configuration (turbo cap,
 * watch window), each agent's mode, versions, approve, reject,
 * roll back and activate.
 *
 * What an agent reads goes through the request's RLS transaction (it only sees
 * its own rows, rls-owned-tables.sql) and is also filtered by its id.
 */

import {
  VERSION_STATUSES,
  MAX_CODE_BYTES,
  MAX_TESTS_PER_DRAFT,
  PROMOTION_MODES,
  concedeScope,
  defineOperation,
} from "@kitsuden/shared";
import { desc, eq, inArray } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

// Deep imports (not the facade): the same reason as brain-memory/approvals (engine cycles).
import { AppError } from "../../../../packages/engine/src/errors";
import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { resolveExecutor } from "../../../../packages/engine/src/request-scope";
import { db } from "../db";
import { agentAuditLogs, agentIdentities, codeVersions } from "../db/schema";
import {
  approveProposal,
  internalExecutionOf,
  freshHuman,
  approvalsSnapshot,
  userNames,
  proposalById,
  rejectProposal,
  type Human,
} from "../lib/approvals";
import { registerCoreOperations } from "../lib/core-operations";
import {
  PromotionError,
  PROMOTION_KON,
  ACTIVATE_OPERATION,
  PROMOTION_ROUTE,
  SCOPE_PROMOTION,
  activateVersion,
  savePromotionConfig,
  savePromotionMode,
  readSavedConfig,
  listVersions,
  proposeDraft,
  syncWithProposal,
  versionById,
  versionView,
  goBack,
  type DraftInput,
  type Version,
} from "../lib/promotion";
import { enabledCodeActions } from "../lib/worker-sandbox";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { requireAdminRole } from "../middleware/auth-guard";
import type { AgentAuthContext } from "../services/agent-auth";

import { humansOnly } from "./approvals";

export { PROMOTION_KON, PROMOTION_ROUTE };
export const ADMIN_PROMOTION_KON = "kon-promotion-admin";
export const ADMIN_PROMOTION_ROUTE = "/api/approvals/promotion";

// ── Who ─────────────────────────────────────────────────────────────────────

function get(c: Context, k: string): unknown {
  return (c.get as (k: string) => unknown)(k);
}

function agentOf(c: Context): AgentAuthContext | null {
  const a = get(c, "agent") as AgentAuthContext | undefined;
  return a?.agentId ? a : null;
}

async function humanOf(c: Context): Promise<Human | null> {
  const u = get(c, "user") as { id?: string; role?: string } | null;
  if (!u?.id || u.role === "agent" || u.id.startsWith("machine-")) return null;
  return freshHuman(u.id);
}

/** The request's executor: the RLS transaction (the agent only sees its own). */
function ex(): typeof db {
  return resolveExecutor(db) as typeof db;
}

/** From the pipeline error to problem+json (with the version as it ended up, if there is one). */
function translate(err: unknown): never {
  if (err instanceof PromotionError) {
    const details = {
      reason: err.reason,
      ...(err.version ? { version: versionView(err.version) } : {}),
    };
    if (err.status === 404) throw AppError.notFound(err.message, details);
    if (err.status === 403) throw AppError.forbidden(err.message, details);
    if (err.status === 422) throw AppError.validation(err.message, details);
    throw AppError.conflict(err.message, details);
  }
  throw err;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const Obj = z.record(z.string(), z.unknown());
const ParamId = z.object({ id: z.guid() });
const Response = z.object({
  status: z.number().int().min(100).max(599).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
const TestCase = z.object({
  name: z.string().min(1).max(200),
  event: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string().max(4000)).optional(),
  api: z.record(z.string().max(2100), Response).optional(),
  fetch: z.record(z.string().max(2100), Response).optional(),
  expect: z.object({
    success: z.boolean().optional(),
    result: z.unknown().optional(),
    resultContains: z.string().max(2000).optional(),
    errorContains: z.string().max(2000).optional(),
    logsContain: z.string().max(2000).optional(),
  }),
  timeoutMs: z.number().int().min(50).max(10_000).optional(),
});
const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
    "a hostname (a.com) or *.a.com"
  );
const Draft = z.object({
  target: z.object({
    actionId: z.guid().optional(),
    slug: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
  }),
  code: z.string().min(1).max(MAX_CODE_BYTES),
  scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
  fetchAllow: z.array(Host).max(50).optional(),
  timeoutMs: z.number().int().min(50).max(60_000).optional(),
  memoryLimitMb: z.number().int().min(8).max(256).optional(),
  maxCalls: z.number().int().min(0).max(500).optional(),
  tests: z.array(TestCase).max(MAX_TESTS_PER_DRAFT).optional(),
  description: z.string().max(2000).optional(),
});
const Version = z.record(z.string(), z.unknown());
const VersionFilter = z.object({
  status: z.enum(VERSION_STATUSES as [string, ...string[]]).optional(),
  slug: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── The agent's part (kon-promotion) ────────────────────────────────────────

const ofTheAgent = {
  access: "session" as const,
  tags: ["promotion"],
};

async function propose(c: Context, body: z.infer<typeof Draft>) {
  const agent = agentOf(c);
  if (!agent) {
    throw AppError.forbidden(
      "Drafts are submitted by agents (a human edits the action directly or approves drafts in the panel)"
    );
  }
  const channel =
    c.env && typeof c.env === "object" && "agent" in (c.env as object) ? "mcp" : "rest";
  try {
    const r = await proposeDraft(agent, body as DraftInput, channel);
    return c.json(
      { version: versionView(r.version, true), duplicate: r.duplicate },
      r.duplicate ? 200 : 201
    );
  } catch (err) {
    translate(err);
  }
}

async function listFromAgent(c: Context, f: z.infer<typeof VersionFilter>) {
  const agent = agentOf(c);
  // An agent: ITS drafts (RLS and, in addition, the filter). A human admin: all.
  const rows = await listVersions(agent ? ex() : db, {
    agentId: agent?.agentId ?? null,
    status: f.status,
    slug: f.slug,
    limit: f.limit,
    offset: f.offset,
  });
  return { versions: rows.filter((v) => v.origin === "agent").map((v) => versionView(v)) };
}

async function readFromAgent(c: Context, id: string) {
  const agent = agentOf(c);
  const [row] = await (agent ? ex() : db)
    .select()
    .from(codeVersions)
    .where(eq(codeVersions.id, id))
    .limit(1);
  if (!row || (agent && row.agentId !== agent.agentId)) throw AppError.notFound("Draft not found");
  const v = await syncWithProposal(row);
  const proposal = v.proposalId ? await proposalById(v.proposalId) : null;
  return {
    version: versionView(v, true),
    proposal: proposal
      ? {
          id: proposal.id,
          status: proposal.status,
          comment: proposal.decisionComment,
          expiresAt: proposal.expiresAt,
        }
      : null,
  };
}

async function activateFromRoute(c: Context, id: string, hash: string | undefined) {
  const agent = agentOf(c);
  try {
    if (agent) {
      // ONLY the execution of a proposal approved by a human carries this
      // mark (the process sets it; it does not come from the network). Not even with `admin`.
      const approval = internalExecutionOf(c)?.approval;
      if (!approval) {
        throw AppError.forbidden(
          "Agents cannot activate code: a human approves the draft's proposal (or turbo mode activates it when every check passes)"
        );
      }
      const v = await versionById(id);
      if (!v || v.agentId !== agent.agentId) throw AppError.notFound("Version not found");
      if (hash && hash !== v.contentHash)
        throw AppError.conflict("contentHash does not match the version", {
          reason: "hash_mismatch",
        });
      const active = await activateVersion(id, {
        type: "approval",
        proposalId: approval.proposalId,
        approvedBy: approval.approvedBy,
        agentId: agent.agentId,
      });
      return { version: versionView(active) };
    }
    const human = await humanOf(c);
    if (!human || human.role !== "admin")
      throw AppError.forbidden("Only an admin can activate a version");
    const v = await versionById(id);
    if (!v) throw AppError.notFound("Version not found");
    if (hash && hash !== v.contentHash)
      throw AppError.conflict("contentHash does not match the version", {
        reason: "hash_mismatch",
      });
    return { version: versionView(await activateVersion(id, { type: "human", userId: human.id })) };
  } catch (err) {
    translate(err);
  }
}

const GUIDE_PROPOSE = {
  whenToUse:
    "To change (or create) the code of a code action. Never edit an action's code directly: submit a draft with tests; it is tested in the sandbox, scanned and then either activated automatically (turbo mode, only when nothing widens permissions) or held for a human (suggestion mode).",
  before: ["target.actionId: from the actions list, or target.slug + target.name for a new action"],
  examples: [
    {
      title: "Change an action's code with one test",
      args: {
        body: {
          target: { slug: "sum" },
          code: "return { total: (event.a ?? 0) + (event.b ?? 0) };",
          tests: [{ name: "adds", event: { a: 2, b: 3 }, expect: { result: { total: 5 } } }],
        },
      },
    },
  ],
  traps: [
    {
      if: "status is awaiting_approval",
      then: "a human must approve it: poll promotion_status (or kitsuden_proposal_status with proposal.id); do not resubmit",
    },
    {
      if: "decision.reasons lists scope_escalation or new_outbound_hosts",
      then: "turbo never widens permissions: a human decides. Drop the new scope/host if you do not need it",
    },
    {
      if: "a test calls kitsuden.api and gets 404",
      then: 'tests never reach the real API: add the response under `api` ("GET /api/...") in that test',
    },
  ],
};

export const promotionOperations: AnyOperation[] = [
  defineOperation({
    ...ofTheAgent,
    id: "propose-draft",
    method: "POST",
    route: "/drafts",
    summary: "Submit a code draft for an action",
    description:
      "Submits a new VERSION of a code action's code (the active version is never edited). The draft's tests (plus the tests the action declares) run in the sandbox with simulated `kitsuden.api` and `fetch`; a local security scan checks the code and the DECLARED capabilities (scopes, outbound hosts, limits) are compared with the active version. Then: suggestion mode → a proposal for a human (status awaiting_approval, proposal id in the response); turbo mode → activated at once ONLY if every test and check passes and nothing widens permissions or touches secrets, users, roles, security config or sensitive operations; otherwise a proposal with the reasons (`decision.reasons`). Resubmitting the same content returns the same version (200, duplicate: true). Agents only; never approves anything.",
    permission: { scopes: [SCOPE_PROMOTION] },
    cost: 5,
    before: [bodyLimit({ maxSize: 2 * 1024 * 1024 })],
    input: { body: Draft },
    output: {
      schema: z.object({ version: Version, duplicate: z.boolean() }),
      status: 201,
      otherStatuses: [200],
    },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    mcp: { name: "promotion_propose" },
    guide: GUIDE_PROPOSE,
    handle: (e, { c }) => propose(c, e.body as z.infer<typeof Draft>),
  }),
  defineOperation({
    ...ofTheAgent,
    id: "list-drafts",
    method: "GET",
    route: "/drafts",
    summary: "List code drafts",
    description:
      "Your drafts (an admin sees every agent's), newest first, with status (awaiting_approval, approved, active, superseded, rolled_back, rejected, expired, failed), test and scan summaries and the decision.",
    permission: { scopes: [SCOPE_PROMOTION], roles: ["admin"] },
    input: { query: VersionFilter },
    output: { schema: z.object({ versions: z.array(Version) }) },
    mcp: { name: "promotion_list" },
    handle: (e, { c }) => listFromAgent(c, e.query as z.infer<typeof VersionFilter>),
  }),
  defineOperation({
    ...ofTheAgent,
    id: "read-draft",
    method: "GET",
    route: "/drafts/:id",
    summary: "A code draft in detail",
    description:
      "One of your drafts with its code, test cases, the full test report, the scan report, the capability diff, the decision and reasons, its proposal (status, reviewer comment) and, once active, the watch window and any rollback. Another agent's draft is 404.",
    permission: { scopes: [SCOPE_PROMOTION], roles: ["admin"] },
    input: { params: ParamId },
    output: { schema: z.object({ version: Version, proposal: Obj.nullable() }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "promotion_status" },
    handle: (e, { c }) => readFromAgent(c, (e.params as { id: string }).id),
  }),
  defineOperation({
    ...ofTheAgent,
    id: ACTIVATE_OPERATION,
    method: "POST",
    route: "/versions/:id/activate",
    summary: "Activate an approved version",
    description:
      "Makes the version the action's active code, with a watch window that rolls back automatically on errors. An agent can NOT call this by itself (403, even with `admin`): it only runs as the execution of the agent's proposal after a human approved it. An admin can activate a version that was approved but could not be activated (code actions were disabled). 409 if the action changed since the draft was tested (stale_base) or code actions are disabled (code_actions_disabled: the version stays approved).",
    permission: { scopes: [SCOPE_PROMOTION], roles: ["admin"] },
    sensitive: true,
    input: {
      params: ParamId,
      body: z.object({ contentHash: z.string().max(100).optional() }).optional(),
    },
    output: { schema: z.object({ version: Version }) },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    mcp: {
      exclude:
        "Activation is the execution of a proposal a human approved (or turbo's automatic activation); an agent never calls it as a tool.",
    },
    handle: (e, { c }) =>
      activateFromRoute(
        c,
        (e.params as { id: string }).id,
        (e.body as { contentHash?: string } | undefined)?.contentHash
      ),
  }),
];

// ── The panel's part (kon-promotion-admin) ──────────────────────────────────

const WITHOUT_MCP = {
  exclude:
    "Code promotion is decided by humans in the admin panel: no agent may approve, reject, roll back, activate or reconfigure it.",
};
const ADMIN: MiddlewareHandler[] = [humansOnly, requireAdminRole as unknown as MiddlewareHandler];
const fromAdmin = {
  access: "session" as const,
  permission: { roles: ["admin"] },
  before: ADMIN,
  mcp: WITHOUT_MCP,
  tags: ["promotion"],
};

async function agentNames(ids: (string | null)[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return {};
  const rows = await db
    .select({ id: agentIdentities.id, name: agentIdentities.name })
    .from(agentIdentities)
    .where(inArray(agentIdentities.id, unique));
  return Object.fromEntries(rows.map((f) => [f.id, f.name]));
}

async function panelView(list: Version[]) {
  const agents = await agentNames(list.map((v) => v.agentId));
  const people = await userNames(
    list.flatMap((v) => [v.sponsorUserId, v.activatedBy, v.rolledBackBy])
  );
  return list.map((v) => ({
    ...versionView(v),
    agentName: v.agentId ? (agents[v.agentId] ?? null) : null,
    sponsorName: v.sponsorUserId ? (people[v.sponsorUserId] ?? null) : null,
    activatedByName: v.activatedBy ? (people[v.activatedBy] ?? v.activatedBy) : null,
    rolledBackByName: v.rolledBackBy ? (people[v.rolledBackBy] ?? v.rolledBackBy) : null,
  }));
}

async function configuration() {
  const saved = await readSavedConfig();
  const approvalState = await approvalsSnapshot();
  const agents = await db
    .select({
      id: agentIdentities.id,
      name: agentIdentities.name,
      isActive: agentIdentities.isActive,
      mode: agentIdentities.promotionMode,
      approvalMode: agentIdentities.approvalMode,
      scopes: agentIdentities.scopes,
    })
    .from(agentIdentities)
    .orderBy(agentIdentities.name);
  return {
    config: saved.config,
    updatedBy: saved.updatedBy,
    updatedAt: saved.updatedAt,
    approvalsEnabled: approvalState.config.enabled,
    codeActionsEnabled: enabledCodeActions(),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      isActive: a.isActive,
      mode: a.mode,
      approvalMode: a.approvalMode,
      canPropose: Array.isArray(a.scopes) && concedeScope(a.scopes as string[], SCOPE_PROMOTION),
    })),
  };
}

async function detailForThePanel(id: string) {
  const row = await versionById(id);
  if (!row) throw AppError.notFound("Version not found");
  const v = await syncWithProposal(row);
  const [view] = await panelView([v]);
  const proposal = v.proposalId ? await proposalById(v.proposalId) : null;
  const previous = v.previousVersionId
    ? await versionById(v.previousVersionId)
    : v.parentVersionId
      ? await versionById(v.parentVersionId)
      : null;
  const ids = [v.id, ...(v.proposalId ? [v.proposalId] : [])];
  const events = await db
    .select()
    .from(agentAuditLogs)
    .where(inArray(agentAuditLogs.resourceId, ids))
    .orderBy(desc(agentAuditLogs.createdAt))
    .limit(100);
  const who = (d: unknown) => ((d as { by?: unknown } | null)?.by as string | undefined) ?? null;
  const names = await userNames(events.map((e) => who(e.details)));
  return {
    version: { ...view!, code: v.code, tests: v.tests },
    previous: previous ? { ...versionView(previous), code: previous.code } : null,
    proposal: proposal
      ? {
          id: proposal.id,
          status: proposal.status,
          decidedBy: proposal.decidedBy,
          decidedAt: proposal.decidedAt,
          comment: proposal.decisionComment,
          expiresAt: proposal.expiresAt,
          resultStatus: proposal.resultStatus,
          resultError: proposal.resultError,
        }
      : null,
    events: events.map((e) => ({
      id: e.id,
      at: e.createdAt,
      action: e.action,
      by: who(e.details),
      byName: who(e.details) ? (names[who(e.details)!] ?? who(e.details)) : null,
      success: e.success,
      details: e.details,
    })),
  };
}

async function decide(c: Context, id: string, comment: string | undefined, approve: boolean) {
  const human = await humanOf(c);
  if (!human) throw AppError.unauthenticated();
  const v = await versionById(id);
  if (!v) throw AppError.notFound("Version not found");
  if (v.status !== "awaiting_approval" || !v.proposalId) {
    throw AppError.conflict(`Version is ${v.status}`, {
      reason: "wrong_state",
      version: versionView(v),
    });
  }
  const r = approve
    ? await approveProposal(v.proposalId, human, comment)
    : await rejectProposal(v.proposalId, human, comment);
  if (!r.ok) {
    if (r.status === 403) throw AppError.forbidden(r.reason);
    if (r.status === 404) throw AppError.notFound(r.reason);
    throw AppError.conflict(r.reason, { reason: "proposal_state" });
  }
  return detailForThePanel(id);
}

const ConfigChange = z
  .object({
    turboAllowed: z.boolean().optional(),
    watchMinutes: z.number().int().optional(),
    minExecutions: z.number().int().optional(),
    maxErrorRate: z.number().optional(),
  })
  .strict();
const Decision = z.object({ comment: z.string().max(2000).optional() }).strict();

export const adminPromotionOperations: AnyOperation[] = [
  defineOperation({
    ...fromAdmin,
    id: "promotion-configuration",
    method: "GET",
    route: "/settings",
    summary: "Code promotion settings",
    description:
      "The global turbo cap (turboAllowed), the watch window (minutes, minimum executions, error rate that triggers a rollback), whether code actions and the approvals master switch are on, and every agent's promotion mode.",
    output: { schema: Obj },
    handle: () => configuration(),
  }),
  defineOperation({
    ...fromAdmin,
    id: "save-promotion-configuration",
    method: "PUT",
    route: "/settings",
    summary: "Change code promotion settings",
    description:
      "Partial update: turboAllowed (the GLOBAL CAP: off, no agent in turbo activates anything by itself), watchMinutes (1-1440), minExecutions (1-1000), maxErrorRate (0.01-1). Audited.",
    input: { body: ConfigChange },
    output: { schema: Obj },
    handle: async (e, { c }) => {
      const human = await humanOf(c);
      if (!human) throw AppError.unauthenticated();
      try {
        await savePromotionConfig(e.body as Record<string, unknown>, human.id);
      } catch (err) {
        throw AppError.validation(err instanceof Error ? err.message : String(err));
      }
      return configuration();
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "promotion-mode",
    method: "PUT",
    route: "/agents/:id/mode",
    summary: "Set an agent's promotion mode",
    description:
      "suggestion (default: every draft is a proposal for a human) or turbo (activated automatically when every test and check passes and nothing widens permissions; needs turboAllowed). Audited.",
    input: {
      params: z.object({ id: z.string().min(1).max(100) }),
      body: z.object({ mode: z.enum(PROMOTION_MODES as [string, ...string[]]) }).strict(),
    },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async (e, { c }) => {
      const human = await humanOf(c);
      if (!human) throw AppError.unauthenticated();
      const { id } = e.params as { id: string };
      const r = await savePromotionMode(
        id,
        (e.body as { mode: "suggestion" | "turbo" }).mode,
        human.id
      );
      if (!r) throw AppError.notFound("Agent not found");
      return { agentId: id, mode: r.after, previous: r.before };
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "versions",
    method: "GET",
    route: "/versions",
    summary: "Code versions (pipeline)",
    description:
      "Every agent's drafts and versions, newest first, with test, scan and decision summaries.",
    input: { query: VersionFilter.extend({ agentId: z.string().max(100).optional() }) },
    output: { schema: z.object({ versions: z.array(Version) }) },
    handle: async (e) => {
      const q = e.query as z.infer<typeof VersionFilter> & { agentId?: string };
      const rows = await listVersions(db, {
        agentId: q.agentId,
        status: q.status,
        slug: q.slug,
        limit: q.limit,
        offset: q.offset,
      });
      return { versions: await panelView(rows) };
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "version",
    method: "GET",
    route: "/versions/:id",
    summary: "A code version in detail",
    description:
      "The version with its code, the code it replaces, the full test and scan reports, the capability diff, the decision, its proposal and the audit trail.",
    input: { params: ParamId },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: (e) => detailForThePanel((e.params as { id: string }).id),
  }),
  defineOperation({
    ...fromAdmin,
    id: "approve-version",
    method: "POST",
    route: "/versions/:id/approve",
    summary: "Approve a draft (activates it)",
    description:
      "Approves the draft's proposal: it is executed once, as the agent, and activates the version (with its watch window). The same as approving it in the approvals inbox.",
    input: { params: ParamId, body: Decision },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: (e, { c }) =>
      decide(
        c,
        (e.params as { id: string }).id,
        (e.body as { comment?: string } | undefined)?.comment,
        true
      ),
  }),
  defineOperation({
    ...fromAdmin,
    id: "reject-version",
    method: "POST",
    route: "/versions/:id/reject",
    summary: "Reject a draft",
    description:
      "Rejects the draft's proposal: the version is never activated. The comment is shown to the agent.",
    input: { params: ParamId, body: Decision },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: (e, { c }) =>
      decide(
        c,
        (e.params as { id: string }).id,
        (e.body as { comment?: string } | undefined)?.comment,
        false
      ),
  }),
  defineOperation({
    ...fromAdmin,
    id: "rollback",
    method: "POST",
    route: "/versions/:id/rollback",
    summary: "Roll back an active version",
    description:
      "Restores the version that was active before this one (or pauses the action if this was its first version). Only from the active version. Audited and notified.",
    input: { params: ParamId, body: z.object({ reason: z.string().min(1).max(2000) }).strict() },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: async (e, { c }) => {
      const human = await humanOf(c);
      if (!human) throw AppError.unauthenticated();
      const { id } = e.params as { id: string };
      try {
        await goBack(id, (e.body as { reason: string }).reason, {
          type: "human",
          userId: human.id,
        });
      } catch (err) {
        translate(err);
      }
      return detailForThePanel(id);
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "activate-approved",
    method: "POST",
    route: "/versions/:id/activate",
    summary: "Activate an approved version",
    description:
      "Activates a version that was approved but could not be activated (code actions were disabled). 409 if the action changed meanwhile (stale_base) or code actions are still disabled.",
    input: { params: ParamId },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: async (e, { c }) => {
      const human = await humanOf(c);
      if (!human) throw AppError.unauthenticated();
      const { id } = e.params as { id: string };
      try {
        await activateVersion(id, { type: "human", userId: human.id });
      } catch (err) {
        translate(err);
      }
      return detailForThePanel(id);
    },
  }),
];

// ── Inventory and routers ───────────────────────────────────────────────────

export const promotionKon = {
  id: PROMOTION_KON,
  name: "Code promotion (agents)",
  version: "1.0.0",
  mountPath: PROMOTION_ROUTE,
  operations: promotionOperations,
};
export const adminPromotionKon = {
  id: ADMIN_PROMOTION_KON,
  name: "Code promotion (panel)",
  version: "1.0.0",
  mountPath: ADMIN_PROMOTION_ROUTE,
  operations: adminPromotionOperations,
};

registerCoreOperations({
  konId: PROMOTION_KON,
  mountPath: PROMOTION_ROUTE,
  description:
    "Code promotion: an agent submits versioned drafts of a code action's code; they are tested in the sandbox, scanned and activated by a human approval (suggestion) or automatically when nothing widens permissions (turbo), with a watch window and automatic rollback.",
  operations: promotionOperations,
});
registerCoreOperations({
  konId: ADMIN_PROMOTION_KON,
  mountPath: ADMIN_PROMOTION_ROUTE,
  description:
    "Code promotion for admins: settings, agents' modes, approve, reject, roll back and activate (humans only).",
  operations: adminPromotionOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const promotionRoutes = operationsRouter(PROMOTION_KON, promotionOperations, context);
export const promotionAdminRoutes = operationsRouter(
  ADMIN_PROMOTION_KON,
  adminPromotionOperations,
  context
);
