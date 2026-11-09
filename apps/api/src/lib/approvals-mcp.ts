/**
 * Human approval in MCP
 * ============================================================================
 *
 * The same rule as REST (`lib/approvals.ts`), applied to `tools/call`
 * BEFORE running the tool:
 *
 *   · kon SDK tool → decided with its operation (method,
 *     path, declared sensitivity or the admin's), exactly like the equivalent
 *     REST route;
 *   · core tool (`kitsuden_*`) or an action's → key
 *     `mcp:<name>`; it writes if its scope is a write one (or it is an action);
 *     sensitive by default, the delete ones;
 *   · external MCP tool (`ext_*`, lib/external-mcp-bridge.ts) → key
 *     `mcp:<name>`, ALWAYS a write (its annotations are not fingerprinted, so
 *     they are not trusted). Whether the agent could call it is the bridge's
 *     scope check (`mcp-external:…`), not the core tools' `canTryTool`.
 *
 * If it must be held: it is not executed, the proposal is stored (channel `mcp`,
 * the tool and its arguments without secrets) and the tool returns a
 * NON-error result with `structuredContent.code =
 * "KITSUDEN_E_APPROVAL_REQUIRED"` and the proposal. The agent checks the
 * status with `kitsuden_proposal_status`.
 *
 * In an UNATTENDED run with `deny` configured, the call is refused instead:
 * an error result with `KITSUDEN_E_DENIED_UNATTENDED` and `alternative`.
 *
 * A run whose prompt carries third-party data (`holdWrites`) has every write
 * held as a proposal, even with approvals off; reads follow the usual rule.
 */

import { createHash } from "node:crypto";

import { listMCPTools } from "@kitsuden/engine";
import { buildProblem, isWriteMethod, mcpToolKey } from "@kitsuden/shared";

import type { AgentAuthContext } from "../services/agent-auth";
import { writingTool, canTryTool } from "../services/mcp-tools";

import {
  ReusedIdempotencyKey,
  ProposalNotAdmitted,
  agentCouldRun,
  computeDiff,
  createProposal,
  evaluateCoreTool,
  evaluateRequest,
  approvalsSnapshot,
  allOff,
  unattendedDenial,
  unattendedProblem,
  auditUnattendedDenial,
  statusUrl,
  agentView,
  type Proposal,
} from "./approvals";
import { isExternalToolName, resolveExternalTool } from "./external-mcp-bridge";
import { VALID_IDEMPOTENCY_KEY, containsSecret } from "./idempotency";
import { toolRequest } from "./operations-mcp";
import { ARG_IDEMPOTENCY } from "./operations-openapi";
import { errorResult } from "./problems-mcp";

/** The tool an agent uses to check its proposals. */
export const STATUS_TOOL = "kitsuden_proposal_status";

export const STATUS_TOOL_DEFINITION = {
  name: STATUS_TOOL,
  description:
    "Status of one of YOUR proposals (a request that needed human approval): pending, executing, executed, failed, rejected or expired, the reviewer's comment and, once executed, the real result. Call it with the proposal id returned by a tool whose result had code KITSUDEN_E_APPROVAL_REQUIRED.",
  inputSchema: {
    type: "object",
    properties: { proposal_id: { type: "string", description: "The proposal id (uuid)." } },
    required: ["proposal_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export interface McpAgent {
  agentId: string;
  agentName: string;
  apiKeyId: string;
  scopes: string[];
  allowedTools: string[];
  sponsor?: AgentAuthContext["sponsor"];
  /**
   * Nobody is waiting for the answer (an agent run started by a cron or event
   * action, or a POST with `Kitsuden-Unattended: true`): a call that would be
   * held can be refused with an alternative instead (lib/approvals.ts).
   */
  unattended?: boolean;
  /**
   * Hold EVERY write, whatever the configuration says: the turn carries
   * third-party data (an `agent` action with event data in its prompt), and
   * injected text must not write without a person seeing it (security review
   * 2026-11-04). Reads follow their usual rule.
   */
  holdWrites?: boolean;
}

export function sessionContext(a: McpAgent): AgentAuthContext {
  return {
    agentId: a.agentId,
    agentName: a.agentName,
    scopes: a.scopes,
    keyId: a.apiKeyId,
    allowedTools: a.allowedTools,
    rateLimit: 0,
    writesPerDay: null,
    budgetUnitsPerDay: null,
    sponsor: a.sponsor ?? null,
  };
}

/** The "pending approval" result (it is not an error). */
export function pendingResult(p: Proposal) {
  const view = agentView(p);
  const problem = buildProblem({
    code: "KITSUDEN_E_APPROVAL_REQUIRED",
    status: 202,
    detail:
      p.status === "pending"
        ? `Pending human approval: stored as proposal ${p.id}. It has NOT been executed.`
        : `Already stored as proposal ${p.id} (status: ${p.status}).`,
    instance: "/api/mcp",
    extensions: { proposal: view },
  });
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${problem.detail} Do not call the tool again; check the status with ` +
          `${STATUS_TOOL} { "proposal_id": "${p.id}" } or GET ${statusUrl(p.id)}.\n` +
          JSON.stringify({
            code: problem.code,
            status: 202,
            proposal: { id: p.id, status: p.status, expiresAt: p.expiresAt },
          }),
      },
    ],
    structuredContent: problem,
    isError: false,
  };
}

function toolFingerprint(name: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`mcp\n${name}\n${JSON.stringify(args)}`)
    .digest("hex");
}

function notAllowedError(reason: ProposalNotAdmitted["reason"]) {
  return errorResult(
    buildProblem({
      code: "KITSUDEN_E_APPROVAL_UNSUPPORTED",
      detail:
        reason === "secret"
          ? "This call needs human approval but its arguments carry a secret, and proposals never store secrets."
          : "This call needs human approval but cannot be stored as a proposal.",
      instance: "/api/mcp",
      extensions: { reason },
    })
  );
}

/** The refusal of an unattended run, as a tool error result. */
async function deniedResult(
  agent: McpAgent,
  alternative: string,
  d: { method: string; path: string; key: string | null; tool: string }
) {
  await auditUnattendedDenial({
    agent: sessionContext(agent),
    channel: "mcp",
    method: d.method,
    path: d.path,
    key: d.key,
    tool: d.tool,
  });
  const result = errorResult(
    unattendedProblem(alternative, "/api/mcp", null, { tool: d.tool, operation: d.key })
  );
  // The model reads the text: the alternative goes there too, not only in structuredContent.
  const first = result.content[0];
  return {
    ...result,
    content: [{ ...first, text: `${first.text}\nWhat to do instead: ${alternative}` }],
  };
}

/**
 * Must this call be held? If so, it stores the proposal and returns the
 * pending result; if not, `null` (the tool runs as usual).
 */
export async function holdToolIfNeeded(
  name: string,
  args: unknown,
  agent: McpAgent
): Promise<ReturnType<typeof pendingResult> | ReturnType<typeof errorResult> | null> {
  const i = await approvalsSnapshot();
  const force = agent.holdWrites === true;
  if (allOff(i) && !force) return null;
  const argsObject = (
    args && typeof args === "object" && !Array.isArray(args) ? args : {}
  ) as Record<string, unknown>;
  const ctx = sessionContext(agent);
  const user = { id: agent.agentId, role: "agent", scopes: agent.scopes };

  try {
    const sdk = toolRequest(name, argsObject);
    if (sdk) {
      if ("error" in sdk) return null;
      const decision =
        evaluateRequest(i, agent.agentId, sdk.method, sdk.path) ??
        (force && isWriteMethod(sdk.method)
          ? { reason: "propose_only" as const, sensitive: false, key: null, ofRoute: null }
          : null);
      if (!decision) return null;
      if (!(await agentCouldRun(decision.ofRoute, user))) return null;
      const denial = unattendedDenial(i, agent.agentId, agent.unattended === true, decision);
      if (denial) {
        return deniedResult(agent, denial.alternative, {
          method: sdk.method,
          path: sdk.path,
          key: decision.key,
          tool: name,
        });
      }
      if (containsSecret(argsObject)) return notAllowedError("secret");
      if (JSON.stringify(argsObject).length > 256 * 1024) return notAllowedError("too_large");
      const key = argsObject[ARG_IDEMPOTENCY];
      const { [ARG_IDEMPOTENCY]: _withoutKey, ...saved } = argsObject;
      const { proposal } = await createProposal({
        agent: ctx,
        channel: "mcp",
        method: sdk.method,
        path: `${sdk.path}${sdk.query}`,
        body: saved,
        type: "application/json",
        fingerprint: toolFingerprint(name, saved),
        idempotencyKey: typeof key === "string" && VALID_IDEMPOTENCY_KEY.test(key) ? key : null,
        reason: decision.reason,
        konId: sdk.konId,
        operationId: sdk.op.id,
        key: decision.key,
        tool: name,
        diff: await computeDiff(ctx, sdk.method, sdk.path, sdk.body),
      });
      return pendingResult(proposal);
    }

    // Core, action and external tools
    const isAction = listMCPTools().some((t) => t.name === name);
    const isExternal = !isAction && isExternalToolName(name);
    const writes = isAction || isExternal || writingTool(name);
    const decision =
      evaluateCoreTool(i, agent.agentId, name, writes) ??
      (force && writes
        ? { reason: "propose_only" as const, key: mcpToolKey(name), sensitive: false }
        : null);
    if (!decision) return null;
    // An external tool this agent cannot call is not proposed: the call is refused.
    if (isExternal && !(await resolveExternalTool(name, agent.scopes)).ok) return null;
    if (!isAction && !isExternal && !canTryTool(name, agent.scopes)) return null;
    const denial = unattendedDenial(i, agent.agentId, agent.unattended === true, decision);
    if (denial) {
      return deniedResult(agent, denial.alternative, {
        method: writes ? "POST" : "GET",
        path: `mcp:${name}`,
        key: decision.key,
        tool: name,
      });
    }
    if (containsSecret(argsObject)) return notAllowedError("secret");
    if (JSON.stringify(argsObject).length > 256 * 1024) return notAllowedError("too_large");
    const { proposal } = await createProposal({
      agent: ctx,
      channel: "mcp",
      method: writes ? "POST" : "GET",
      path: `mcp:${name}`,
      body: argsObject,
      type: "application/json",
      fingerprint: toolFingerprint(name, argsObject),
      idempotencyKey: null,
      reason: decision.reason,
      key: decision.key,
      tool: name,
      diff: { kind: "tool", tool: name, arguments: argsObject },
    });
    return pendingResult(proposal);
  } catch (err) {
    if (err instanceof ProposalNotAdmitted) return notAllowedError(err.reason);
    if (err instanceof ReusedIdempotencyKey) {
      return errorResult(
        buildProblem({
          code: "KITSUDEN_E_IDEMPOTENCY_KEY_REUSED",
          detail: "This idempotency_key already belongs to a different proposal of this agent.",
          instance: "/api/mcp",
        })
      );
    }
    throw err;
  }
}
