/**
 * Code Action Handler
 *
 * Runs an action's code in the isolated sandbox (QuickJS in a separate
 * process, see lib/worker-sandbox.ts). The Kitsuden API the code receives
 * comes with the identity decided by lib/sandbox/identity.ts.
 */

import { hasCredentials, resolveCredentials, VaultError } from "../../credential-vault";
import { customerDataHosts } from "../../customer-data";
import { guardForExecution } from "../../customer-data-catalog";
import { effectStore } from "../../effects";
import { parseRules, type EgressRule } from "../../egress-policy";
import { sandboxApiFor, actionIdentity } from "../../sandbox/identity";
import {
  isOpenSandboxRuntime,
  openSandboxConfig,
  runInOpenSandbox,
} from "../../sandbox/opensandbox";
import { egressRulesFor, enabledCodeActions, executeSandbox } from "../../worker-sandbox";
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
  /** Egress rules for `fetch` (lib/egress-policy.ts). */
  egress?: { rules?: unknown };
  /** Vault credentials added to matching requests (set by a person; lib/credential-vault.ts). */
  credentials?: unknown;
  /** `quickjs` (default) or `opensandbox:python` / `opensandbox:shell`. */
  runtime?: string;
}

async function runOnOpenSandbox(
  action: Action,
  config: CodeActionConfig,
  payload: Record<string, unknown>,
  egress: EgressRule[],
  startTime: number
): Promise<ActionResult> {
  const fail = (error: string): ActionResult => ({
    success: false,
    error,
    durationMs: Date.now() - startTime,
  });
  if (!isOpenSandboxRuntime(config.runtime))
    return fail(`Unknown runtime: ${String(config.runtime)}`);
  if (!enabledCodeActions()) {
    return fail(
      "Code actions are disabled on this server (set ENABLE_CODE_ACTIONS=true to enable them)."
    );
  }
  const cfg = openSandboxConfig();
  if (!cfg) {
    return fail(
      "The OpenSandbox runtime is not configured on this server (KITSUDEN_OPENSANDBOX_URL and KITSUDEN_OPENSANDBOX_IMAGE)."
    );
  }
  if (hasCredentials(config)) {
    return fail(
      "Vault credentials are not available on the OpenSandbox runtime; use the default runtime."
    );
  }
  const r = await runInOpenSandbox(
    {
      runtime: config.runtime,
      code: config.code,
      payload,
      timeoutMs: Math.min(config.timeoutMs || 5000, 60_000),
      memoryLimitMb: config.memoryLimitMb || 256,
      rules: egressRulesFor({ egress, fetchAllow: config.fetchAllow }),
      customerDataHosts: customerDataHosts(config.customerDataHosts),
      actionId: action.id,
    },
    cfg
  );
  return {
    success: r.success,
    result: r.result,
    logs: r.logs || undefined,
    error: r.error || undefined,
    durationMs: r.durationMs,
    memoryUsedBytes: r.memoryUsedBytes,
  };
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

  // Egress rules and vault credentials: an invalid entry stops the run rather
  // than running with a wider or a credential-less policy.
  const egress = parseRules(config.egress?.rules);
  if (typeof egress === "string") {
    return {
      success: false,
      error: `Invalid egress rules: ${egress}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Python or shell in OpenSandbox (opt-in by the operator; see lib/sandbox/opensandbox.ts).
  if (config.runtime !== undefined && config.runtime !== "quickjs") {
    return runOnOpenSandbox(action, config, payload, egress, startTime);
  }
  let credentials;
  try {
    credentials = await resolveCredentials(config.credentials);
  } catch (err) {
    const message = err instanceof VaultError ? err.message : "Credentials could not be loaded";
    return { success: false, error: message, durationMs: Date.now() - startTime };
  }

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
    egress,
    credentials,
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
