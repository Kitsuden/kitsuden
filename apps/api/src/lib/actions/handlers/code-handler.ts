/**
 * Code Action Handler
 *
 * Runs an action's code in the isolated sandbox (QuickJS in a separate
 * process, see lib/worker-sandbox.ts). The Kitsuden API the code receives
 * comes with the identity decided by lib/sandbox/identity.ts.
 */

import { guardForExecution } from "../../customer-data-catalog";
import { effectStore } from "../../effects";
import { sandboxApiFor, actionIdentity } from "../../sandbox/identity";
import { executeSandbox } from "../../worker-sandbox";
import type { Action, ActionContext, ActionResult } from "../types";
import { unattendedRun } from "../types";

interface CodeActionConfig {
  code: string;
  timeoutMs?: number;
  memoryLimitMb?: number;
  envVars?: Record<string, string>;
  /** API scopes for the code (see lib/sandbox/identity.ts). */
  scopes?: string[];
  /** Hosts that `fetch` may call (`api.example.com`, `*.example.com`). */
  fetchAllow?: string[];
  /** Maximum fetch + API calls per execution. */
  maxCalls?: number;
  /** Hosts that may receive customer data (set by a person; docs/agents/egress.md). */
  customerDataHosts?: string[];
}

// Which runs are unattended: see `unattendedRun` in ../types.ts.
export { unattendedRun };

export async function executeCodeAction(
  action: Action,
  context: ActionContext
): Promise<ActionResult> {
  const startTime = Date.now();

  const config = action.config as CodeActionConfig;

  if (!config.code) {
    return {
      success: false,
      error: "No code configured for this action",
      durationMs: Date.now() - startTime,
    };
  }

  // Build the payload for the sandbox
  const payload: Record<string, unknown> = {
    action: {
      id: context.actionId,
      name: context.actionName,
      type: context.actionType,
    },
    trigger: context.trigger,
    event: context.event,
    request: context.request,
    timestamp: new Date().toISOString(),
  };

  const identity = await actionIdentity(action, context.executor);

  // Customer data: what the code receives in its event is tracked from the
  // start; what it reads through `kitsuden.api`, as it reads it (worker-sandbox.ts).
  const customerData = await guardForExecution({
    actionHosts: config.customerDataHosts,
    actionId: context.actionId,
    executionId: context.executionId,
    agentId: context.executor?.type === "agent" ? context.executor.agent.agentId : null,
  });
  customerData.marked.collect(context.event?.data);

  // Execute in sandbox
  const sandboxResult = await executeSandbox({
    code: config.code,
    payload,
    envVars: { ...config.envVars, ...context.env },
    timeoutMs: config.timeoutMs || 5000,
    memoryLimitMb: config.memoryLimitMb || 64,
    fetchAllow: Array.isArray(config.fetchAllow)
      ? config.fetchAllow.filter((h) => typeof h === "string")
      : [],
    maxCalls: config.maxCalls,
    api: identity ? sandboxApiFor(identity, action.id, unattendedRun(context)) : null,
    // `kitsuden.effect(key, fn)`: keys belong to THIS action, whatever its code
    // version, so a new version does not repeat what the old one already did.
    effects: { scope: `action:${action.id}`, runId: context.executionId, store: effectStore },
    customerData,
  });

  return {
    success: sandboxResult.success,
    result: sandboxResult.result,
    logs: sandboxResult.logs || undefined,
    error: sandboxResult.error || undefined,
    durationMs: sandboxResult.durationMs,
    memoryUsedBytes: sandboxResult.memoryUsedBytes,
  };
}
