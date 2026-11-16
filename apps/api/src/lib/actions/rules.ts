/**
 * Automation rules: running the steps (docs/automation.md)
 * ============================================================================
 *
 * A stored action of type `rule` is a list of steps. Each step names a handler:
 *
 *   core:webhook      POST the event to a URL          (the webhook_out handler)
 *   core:send-mail    send a registered mail template  (the engine's mailer)
 *   core:run-agent    hand the event to an agent       (the agent handler)
 *   <kon id>:<id>     whatever a kon contributed       (defineKon({ actionHandlers }))
 *
 * The three core steps REUSE the handlers single-purpose actions already have,
 * so a webhook sent from a rule passes the same target check, the same
 * customer-data guard and the same signing as a `webhook_out` action. A rule
 * adds order, conditions and a dry run; it does not add a second way to reach
 * the network.
 *
 * Steps run in order. A failing step stops the rule unless it says
 * `continueOnError`. Placeholders in a step's config (`{{event.dealId}}`) are
 * filled from the event that fired the rule.
 */

// Deep imports, not the facade: the facade reaches the loader, which imports this file.
import {
  evaluateConditions,
  fillTemplate,
  ruleConfigProblem,
  conditionsProblem,
  type AutomationHandlerInput,
  type ConditionsResult,
  type RuleCondition,
  type RuleConfig,
  type RuleMatch,
  type RuleStep,
} from "@kitsuden/shared";

import { messageOf } from "../../../../../packages/engine/src/errors";
import { mail } from "../../../../../packages/engine/src/mail";
import { runInRequestScope } from "../../../../../packages/engine/src/request-scope";
import { konRuleHandler, listKonRuleHandlers } from "../kon-contributions";

import type { Action, ActionContext, ActionResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

interface StepRun {
  input: AutomationHandlerInput;
  /** The stored rule and the execution context: what the reused handlers need. */
  action: Action;
  context: ActionContext;
}

interface RuleHandler {
  id: string;
  source: string;
  label: string;
  description: string;
  config: Record<string, string>;
  /** Why this config cannot be saved, or `null`. */
  validate?(config: Record<string, unknown>): Promise<string | null> | string | null;
  run(step: StepRun): Promise<unknown>;
  preview?(step: StepRun): Promise<unknown> | unknown;
}

/** The step failed and the reused handler already said why. */
class StepFailed extends Error {}

const PLACEHOLDER = /\{\{[^}]*\}\}/g;

/**
 * Does a placeholder sit in the authority of the URL (what is between `://` and the first `/`, `?`
 * or `#`, user info and port included)? A string with no scheme counts as all authority.
 */
function hostIsTemplated(url: string): boolean {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim());
  return (withScheme ? withScheme[1] : url).includes("{{");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const coreHandlers: RuleHandler[] = [
  {
    id: "core:webhook",
    source: "core",
    label: "Call a webhook",
    description:
      "Sends the event as a signed POST to a URL, with the same target check and customer-data guard as a webhook_out action.",
    config: {
      url: "https URL to call",
      headers: "optional object of extra headers",
      secret: "optional secret for the HMAC signature",
      customerDataHosts:
        "optional list of hosts that may receive customer data (only a person sets it)",
      customerData: 'optional: "redact" (default) or "refuse" for other hosts',
    },
    async validate(config) {
      const { webhookConfigUrlProblem } = await import("./handlers/webhook-out-handler");
      if (typeof config.url === "string" && config.url.includes("{{")) {
        // The host is where the whole payload goes: event data (a form a visitor filled in) must not
        // be able to choose it. A placeholder is fine in the path or the query.
        if (hostIsTemplated(config.url)) {
          return "the host of the URL must be written out: a placeholder there lets the event choose where the payload is sent";
        }
        // The literal part passes the same target check as any webhook URL.
        return webhookConfigUrlProblem(config.url.replace(PLACEHOLDER, "x"));
      }
      return webhookConfigUrlProblem(config.url);
    },
    async run({ input, action, context }) {
      const { executeWebhookOutAction } = await import("./handlers/webhook-out-handler");
      const result = await executeWebhookOutAction(
        { ...action, type: "webhook_out", config: input.config } as Action,
        context
      );
      if (!result.success) throw new StepFailed(result.error ?? "the webhook failed");
      return { statusCode: result.httpResponse?.statusCode ?? null };
    },
  },
  {
    id: "core:send-mail",
    source: "core",
    label: "Send an email",
    description:
      "Sends one of the registered mail templates (the core's or a kon's). `data` is what the template expects; most take a `to`.",
    config: {
      mailable: "name of a registered mail template",
      data: "object with the template's data; strings may carry {{event.field}} placeholders",
      locale: "optional locale",
    },
    validate(config) {
      const name = text(config.mailable);
      if (!name) return "mailable is required";
      if (!mail.has(name)) {
        return `no mail template is registered as "${name}"; registered: ${mail.list().join(", ") || "none"}`;
      }
      if (config.data !== undefined && (config.data === null || typeof config.data !== "object")) {
        return "data must be an object";
      }
      return null;
    },
    async run({ input }) {
      const name = text(input.config.mailable);
      if (!name || !mail.has(name)) throw new StepFailed(`no mail template "${String(name)}"`);
      const result = await mail.send(name, input.config.data ?? {}, text(input.config.locale));
      if (!result.ok) throw new StepFailed(result.error ?? "the email was not sent");
      return { messageId: result.messageId ?? null };
    },
    preview({ input }) {
      const name = text(input.config.mailable);
      if (!name || !mail.has(name)) return { error: `no mail template "${String(name)}"` };
      const message = mail.render(name, input.config.data ?? {}, text(input.config.locale));
      return { to: message.to, subject: message.subject };
    },
  },
  {
    id: "core:run-agent",
    source: "core",
    label: "Hand it to an agent",
    description:
      "Runs one of the core's agents with the event as its message, with that agent's scopes, tools, approvals and traces.",
    config: {
      agentId: "id of the agent identity that answers",
      promptTemplate: "optional prompt; {{event.field}} placeholders are filled from the event",
      customerDataHosts:
        "optional list of model hosts that may receive customer data (only a person sets it)",
    },
    validate(config) {
      return text(config.agentId) ? null : "agentId is required";
    },
    async run({ input, action, context }) {
      const { executeAgentAction } = await import("./handlers/agent-handler");
      const result = await executeAgentAction(
        { ...action, type: "agent", config: input.config } as Action,
        context
      );
      if (!result.success) throw new StepFailed(result.error ?? "the agent run failed");
      return result.result ?? null;
    },
  },
];

function handlerById(id: string): RuleHandler | undefined {
  const core = coreHandlers.find((h) => h.id === id);
  if (core) return core;
  const fromKon = konRuleHandler(id);
  if (!fromKon) return undefined;
  const { definition, context: konContext } = fromKon;
  return {
    id: fromKon.id,
    source: fromKon.konId,
    label: definition.label,
    description: definition.description,
    config: definition.config ?? {},
    validate: definition.validate ? (config) => definition.validate!(config) : undefined,
    // As the rule's owner. The event was delivered from the request that emitted it, so without this
    // `useRequest().user` would be whoever triggered the event (a visitor, another user), and
    // `ctx.entities` and `ctx.secrets` would attribute the write or the opening to them. The scope
    // has no transaction: the database is the system connection, as for any listener.
    run: ({ input }) =>
      runInRequestScope(
        {
          user: input.actorUserId ? { id: input.actorUserId } : null,
          requestId: `rule:${input.rule.id}`,
        },
        () => definition.run(input, konContext)
      ),
    preview: definition.preview ? ({ input }) => definition.preview!(input, konContext) : undefined,
  };
}

export interface RuleHandlerInfo {
  id: string;
  source: string;
  label: string;
  description: string;
  config: Record<string, string>;
}

/** Every step a rule can use right now: the core's and each loaded kon's. */
export function listRuleHandlers(): RuleHandlerInfo[] {
  const fromKons = listKonRuleHandlers().map((h) => ({
    id: h.id,
    source: h.konId,
    label: h.definition.label,
    description: h.definition.description,
    config: h.definition.config ?? {},
  }));
  const core = coreHandlers.map(({ id, source, label, description, config }) => ({
    id,
    source,
    label,
    description,
    config,
  }));
  return [...core, ...fromKons];
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a rule cannot be stored, or `null`: the shape, that every handler
 * exists, and what each handler says about its own config.
 *
 * A handler of a kon that is not loaded is refused. A rule that silently does
 * nothing is worse than one that cannot be saved.
 */
export async function ruleProblem(config: unknown): Promise<string | null> {
  const shape = ruleConfigProblem(config);
  if (shape) return shape;
  for (const [index, step] of (config as RuleConfig).steps.entries()) {
    const handler = handlerById(step.handler);
    if (!handler) {
      return `step ${index + 1}: no handler "${step.handler}" (see GET /api/automation/catalog)`;
    }
    const problem = await handler.validate?.(step.config ?? {});
    if (problem) return `step ${index + 1} (${step.handler}): ${problem}`;
  }
  return null;
}

/** The agents a rule would make act: what the route checks an agent author against. */
export function ruleAgentIds(config: unknown): unknown[] {
  const steps = (config as Partial<RuleConfig> | null | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step) => step?.handler === "core:run-agent")
    .map((step) => (step.config as { agentId?: unknown } | undefined)?.agentId);
}

/** The webhook-shaped configs inside a rule: what the customer-data policy check reads. */
export function ruleStepConfigs(config: unknown): Record<string, unknown>[] {
  const steps = (config as Partial<RuleConfig> | null | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => (step?.config ?? {}) as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditions
// ─────────────────────────────────────────────────────────────────────────────

interface ConditionedTrigger {
  conditions?: RuleCondition[];
  match?: RuleMatch;
}

/** Why the conditions of a trigger cannot be stored, or `null`. Any action type may carry them. */
export function triggerConditionsProblem(triggerConfig: unknown): string | null {
  const trigger = (triggerConfig ?? {}) as ConditionedTrigger;
  return conditionsProblem(trigger.conditions, trigger.match);
}

/** Does the payload meet the action's conditions? With none, always. */
export function checkTriggerConditions(triggerConfig: unknown, data: unknown): ConditionsResult {
  const trigger = (triggerConfig ?? {}) as ConditionedTrigger;
  // What is stored was validated on the way in; a row edited by hand must not throw here.
  if (!Array.isArray(trigger.conditions)) return { passed: true, outcomes: [] };
  return evaluateConditions(trigger.conditions, data, trigger.match === "any" ? "any" : "all");
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

export interface StepOutcome {
  handler: string;
  status: "success" | "error" | "skipped";
  result?: unknown;
  error?: string;
  durationMs: number;
}

function stepInput(action: Action, context: ActionContext, step: RuleStep): AutomationHandlerInput {
  const event = context.event ? { name: context.event.name, data: context.event.data } : undefined;
  const scope = {
    event: event?.data ?? {},
    eventName: event?.name ?? null,
    rule: { id: action.id, name: action.name },
  };
  return {
    config: fillTemplate(step.config ?? {}, scope),
    event,
    rule: { id: action.id, name: action.name },
    actorUserId: action.createdById ?? null,
  };
}

export async function executeRuleAction(
  action: Action,
  context: ActionContext
): Promise<ActionResult> {
  const started = Date.now();
  const steps = (action.config as Partial<RuleConfig> | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { success: false, error: "The rule has no steps", durationMs: 0 };
  }

  const outcomes: StepOutcome[] = [];
  let failure: string | undefined;

  for (const step of steps) {
    if (failure !== undefined) {
      outcomes.push({ handler: step.handler, status: "skipped", durationMs: 0 });
      continue;
    }
    const stepStarted = Date.now();
    const handler = handlerById(step.handler);
    try {
      if (!handler) throw new StepFailed(`no handler "${step.handler}": is its kon installed?`);
      const result = await handler.run({
        input: stepInput(action, context, step),
        action,
        context,
      });
      outcomes.push({
        handler: step.handler,
        status: "success",
        result: result ?? null,
        durationMs: Date.now() - stepStarted,
      });
    } catch (err: unknown) {
      const error = messageOf(err) || "the step failed";
      outcomes.push({
        handler: step.handler,
        status: "error",
        error,
        durationMs: Date.now() - stepStarted,
      });
      if (!step.continueOnError) failure = `${step.handler}: ${error}`;
    }
  }

  const failed = outcomes.filter((o) => o.status === "error");
  return {
    success: failure === undefined,
    result: { steps: outcomes },
    error: failure,
    logs: failed.length > 0 ? failed.map((o) => `${o.handler}: ${o.error}`).join("\n") : undefined,
    durationMs: Date.now() - started,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry run
// ─────────────────────────────────────────────────────────────────────────────

export interface DryRunStep {
  handler: string;
  /** The config with its placeholders filled from the sample event. */
  config: Record<string, unknown>;
  /** What the handler says it would do, when it can tell. */
  preview?: unknown;
  /** Why the step could not run at all (an unknown handler, a bad config). */
  problem?: string;
}

export interface DryRunResult {
  /** Would the action run for this event? `false` when the conditions reject it. */
  wouldRun: boolean;
  conditions: ConditionsResult;
  /** The steps, for a rule. Empty for the other action types, which have one handler. */
  steps: DryRunStep[];
  /** What a dry run cannot tell for this type of action. */
  note?: string;
}

/**
 * What the action WOULD do for this event, without doing it: nothing is sent,
 * nothing is written, and no execution is recorded.
 */
export async function dryRunAction(
  action: Action,
  sample: { event?: string; payload?: Record<string, unknown> }
): Promise<DryRunResult> {
  const payload = sample.payload ?? {};
  const conditions = checkTriggerConditions(action.triggerConfig, payload);
  if (action.type !== "rule") {
    return {
      wouldRun: conditions.passed,
      conditions,
      steps: [],
      note: `A dry run of a "${action.type}" action only checks its conditions; its handler is not simulated.`,
    };
  }

  const eventName =
    sample.event ?? (action.triggerConfig as { eventName?: string } | null)?.eventName ?? "manual";
  const context = {
    actionId: action.id,
    actionName: action.name,
    actionType: action.type,
    trigger: action.trigger,
    event: { name: eventName, data: payload, timestamp: new Date().toISOString() },
    env: {},
    executionId: "dry-run",
    startedAt: new Date(),
  } as ActionContext;

  const steps: DryRunStep[] = [];
  for (const step of ((action.config as Partial<RuleConfig> | null)?.steps ?? []) as RuleStep[]) {
    const input = stepInput(action, context, step);
    const handler = handlerById(step.handler);
    if (!handler) {
      steps.push({
        handler: step.handler,
        config: input.config,
        problem: `no handler "${step.handler}": is its kon installed?`,
      });
      continue;
    }
    const entry: DryRunStep = { handler: step.handler, config: input.config };
    try {
      const problem = await handler.validate?.(input.config);
      if (problem) entry.problem = problem;
      else if (handler.preview) entry.preview = await handler.preview({ input, action, context });
    } catch (err: unknown) {
      entry.problem = messageOf(err) || "the preview failed";
    }
    steps.push(entry);
  }
  return { wouldRun: conditions.passed, conditions, steps };
}
