/**
 * Automation rules: running the steps (docs/automation.md)
 * ============================================================================
 *
 * A stored action of type `rule` is a list of steps. Each step names a handler:
 *
 *   core:webhook      POST the event to a URL          (the webhook_out handler)
 *   core:send-mail    send a registered mail template  (the engine's mailer)
 *   core:run-agent    hand the event to an agent       (the agent handler)
 *   core:enqueue      queue a job on a kon's queue     (the job queue)
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
import { queue, queueHandlers, ruleQueues } from "../../../../../packages/engine/src/queue";
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
  /** Position of the step in the rule: a durable retry re-reads the step by it. */
  stepIndex: number;
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
    async run({ input, action, context, stepIndex }) {
      const { executeWebhookOutAction, retryableWebhookFailure } =
        await import("./handlers/webhook-out-handler");
      // One attempt here. The retries used to sleep in this process (a restart lost them); a failure
      // worth retrying now goes to the durable queue (RULE_WEBHOOKS_QUEUE below).
      const result = await executeWebhookOutAction(
        { ...action, type: "webhook_out", config: input.config } as Action,
        context,
        { inlineRetries: false }
      );
      if (result.success) return { statusCode: result.httpResponse?.statusCode ?? null };
      if (retryableWebhookFailure(result) && queue.configured()) {
        const job = await queueRuleWebhookRetry(action, context, stepIndex, input.config);
        if (job) {
          return {
            statusCode: result.httpResponse?.statusCode ?? null,
            retrying: true,
            jobId: job,
            error: result.error ?? null,
          };
        }
      }
      throw new StepFailed(result.error ?? "the webhook failed");
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
      promptTemplate:
        "optional prompt; {{event.field}} placeholders are filled from the event, marked as untrusted data, and then the agent's writes wait for a person",
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
  {
    id: "core:enqueue",
    source: "core",
    label: "Queue a job",
    description:
      "Queues a job on a queue that a kon opened to rules (see `queues` in the catalog). The work then runs in that queue's worker, with its retries and its concurrency. With `dedupeKey`, an event about a record that already has a job waiting queues nothing.",
    config: {
      queue: "name of a queue that accepts jobs from rules",
      job: 'optional name of the job within the queue (default "rule")',
      payload: "optional object for the handler; without it, the event's data",
      dedupeKey:
        "optional key, usually with a placeholder ({{event.contactId}}): not queued again while a job with it waits",
      delaySeconds: "optional: do not run before this many seconds",
      attempts: "optional maximum attempts (1-25, default 3)",
    },
    validate(config) {
      const problem = enqueueProblem(config);
      if (problem) return problem;
      const name = String(config.queue);
      if (!queueHandlers().get(name)?.rules) {
        const open = ruleQueues().map((q) => q.queue);
        return `the queue "${name}" does not accept jobs from rules; queues that do: ${open.join(", ") || "none"}`;
      }
      return null;
    },
    async run({ input }) {
      const problem = enqueueProblem(input.config);
      if (problem) throw new StepFailed(problem);
      const name = String(input.config.queue);
      // Checked again when it runs: the kon may have been removed since the rule was saved.
      if (!queueHandlers().get(name)?.rules) {
        throw new StepFailed(`the queue "${name}" does not accept jobs from rules`);
      }
      const dedupeKey = text(input.config.dedupeKey)?.slice(0, 200);
      // As the rule's owner, outside the emitting request: the job must not belong to whoever
      // caused the event (a visitor), and it must exist even if that request rolls back.
      const queued = await runInRequestScope(
        {
          user: input.actorUserId ? { id: input.actorUserId } : null,
          requestId: `rule:${input.rule.id}`,
        },
        () =>
          queue.dispatch(name, text(input.config.job) ?? "rule", enqueuePayload(input), {
            reason: `rule ${input.rule.name}`.slice(0, 200),
            dedupeKey,
            attempts:
              input.config.attempts === undefined ? undefined : Number(input.config.attempts),
            delayMs:
              input.config.delaySeconds === undefined
                ? undefined
                : Number(input.config.delaySeconds) * 1000,
          })
      );
      return { jobId: queued.id, deduplicated: queued.deduplicated === true };
    },
    preview({ input }) {
      const name = String(input.config.queue);
      return {
        queue: name,
        accepted: Boolean(queueHandlers().get(name)?.rules),
        job: text(input.config.job) ?? "rule",
        payload: enqueuePayload(input),
        dedupeKey: text(input.config.dedupeKey) ?? null,
      };
    },
  },
];

const JOB_NAME = /^[A-Za-z0-9_.:\-]{1,120}$/;
/** A week: a rule that parks work for longer is a schedule, and there are crons for that. */
const MAX_DELAY_SECONDS = 7 * 24 * 3600;

/** What is wrong with the shape of a `core:enqueue` config, or `null`. */
function enqueueProblem(config: Record<string, unknown>): string | null {
  const name = text(config.queue);
  if (!name) return "queue is required";
  if (!JOB_NAME.test(name)) return "queue is not a valid queue name";
  if (config.job !== undefined && !(typeof config.job === "string" && JOB_NAME.test(config.job))) {
    return "job must be a name of letters, digits and _.:- (a placeholder is not allowed here)";
  }
  if (
    config.payload !== undefined &&
    (config.payload === null || typeof config.payload !== "object" || Array.isArray(config.payload))
  ) {
    return "payload must be an object";
  }
  if (config.dedupeKey !== undefined && !text(config.dedupeKey)) {
    return "dedupeKey must be a non-empty string";
  }
  if (config.attempts !== undefined) {
    const n = Number(config.attempts);
    if (!Number.isInteger(n) || n < 1 || n > 25) return "attempts must be an integer from 1 to 25";
  }
  if (config.delaySeconds !== undefined) {
    const n = Number(config.delaySeconds);
    if (!Number.isFinite(n) || n < 0 || n > MAX_DELAY_SECONDS) {
      return `delaySeconds must be between 0 and ${MAX_DELAY_SECONDS}`;
    }
  }
  return null;
}

function enqueuePayload(input: AutomationHandlerInput): Record<string, unknown> {
  const given = input.config.payload;
  if (given && typeof given === "object") return given as Record<string, unknown>;
  const data = input.event?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data ?? null };
}

/** The queues a rule can reach with `core:enqueue`, for the catalog. */
export function listRuleQueues(): ReturnType<typeof ruleQueues> {
  return ruleQueues();
}

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

/** `{{path}}` as the shared templates write it. */
const PROMPT_PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * A step's config with its placeholders filled. `core:run-agent` is the
 * exception for `promptTemplate`: its `{{event.*}}` placeholders stay for the
 * agent handler, which wraps each event value in untrusted-content delimiters,
 * puts the untrusted-data notice first and so holds the agent's writes for a
 * person. Filled here with raw text, the event lost its provenance and the run
 * wrote freely (security audit 2026-11-19). Only `{{eventName}}` and
 * `{{rule.*}}`, which the system and the rule's author set, are filled here.
 */
function fillStepConfig(step: RuleStep, scope: Record<string, unknown>): Record<string, unknown> {
  const raw = step.config ?? {};
  if (step.handler === "core:send-mail") return fillMailConfig(raw, scope);
  if (step.handler !== "core:run-agent" || !Object.hasOwn(raw, "promptTemplate")) {
    return fillTemplate(raw, scope);
  }
  const { promptTemplate, ...rest } = raw;
  const filled = fillTemplate(rest, scope);
  if (typeof promptTemplate !== "string") return filled;
  return {
    ...filled,
    promptTemplate: promptTemplate.replace(PROMPT_PLACEHOLDER, (match, path: string) =>
      path === "eventName" || path.startsWith("rule.")
        ? // Wrapped so fillTemplate gives the text form, as for any other step.
          fillTemplate(`(${match})`, scope).slice(1, -1)
        : match
    ),
  };
}

/** Keys of a `core:send-mail` step's `data` that hold recipients. */
const MAIL_RECIPIENT_KEYS = ["to", "cc", "bcc", "replyTo"] as const;

/**
 * `core:send-mail`: a placeholder in a recipient key is always filled as TEXT
 * (hardening 2026-11-20). As a whole placeholder it kept the type of the event
 * value, so `"to": "{{event.email}}"` with an event carrying a list sent the mail
 * to every address in it. As text, a list becomes its JSON form, which the
 * mailer refuses as an address.
 */
function fillMailConfig(
  raw: Record<string, unknown>,
  scope: Record<string, unknown>
): Record<string, unknown> {
  const filled = fillTemplate(raw, scope);
  const rawData = raw.data;
  const data = filled.data;
  if (!rawData || typeof rawData !== "object" || !data || typeof data !== "object") return filled;
  const out = { ...(data as Record<string, unknown>) };
  for (const key of MAIL_RECIPIENT_KEYS) {
    const template = (rawData as Record<string, unknown>)[key];
    if (typeof template === "string" && template.includes("{{")) {
      // Wrapped so fillTemplate gives the text form, as in fillStepConfig.
      out[key] = fillTemplate(`(${template})`, scope).slice(1, -1);
    }
  }
  return { ...filled, data: out };
}

function stepInput(action: Action, context: ActionContext, step: RuleStep): AutomationHandlerInput {
  const event = context.event ? { name: context.event.name, data: context.event.data } : undefined;
  const scope = {
    event: event?.data ?? {},
    eventName: event?.name ?? null,
    rule: { id: action.id, name: action.name },
  };
  return {
    config: fillStepConfig(step, scope),
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
      const input = stepInput(action, context, step);
      // A kon's handler validated the stored config, placeholders and all; what it runs with is
      // that config filled from the event, which nobody had checked (H67). The core's handlers
      // check their filled values themselves (recipients, agent ids).
      if (handler.source !== "core" && !step.handler.startsWith("core:")) {
        const problem = await handler.validate?.(input.config);
        if (problem)
          throw new StepFailed(`the config filled from the event is refused: ${problem}`);
      }
      const result = await handler.run({
        input,
        action,
        context,
        stepIndex: steps.indexOf(step),
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
  const ruleSteps = ((action.config as Partial<RuleConfig> | null)?.steps ?? []) as RuleStep[];
  for (const [stepIndex, step] of ruleSteps.entries()) {
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
      else if (handler.preview) {
        entry.preview = await handler.preview({ input, action, context, stepIndex });
      }
    } catch (err: unknown) {
      entry.problem = messageOf(err) || "the preview failed";
    }
    steps.push(entry);
  }
  return { wouldRun: conditions.passed, conditions, steps };
}

// ─────────────────────────────────────────────────────────────────────────────
// core:webhook retries on the durable queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The queue that retries `core:webhook` deliveries. A system queue (`kitsuden-*`): never charged to an
 * agent. Its payload carries no secret and no filled config: the delivery re-reads the stored rule and
 * fills the step again from the event, so a secret rotated meanwhile is the one used, and a rule deleted
 * or paused meanwhile sends nothing.
 */
export const RULE_WEBHOOKS_QUEUE = "kitsuden-rule-webhooks";

interface RuleWebhookJob {
  actionId: string;
  stepIndex: number;
  executionId: string;
  event: { name: string; data: Record<string, unknown>; timestamp: string } | null;
  trigger: string;
}

function retryAttempts(config: Record<string, unknown>): number {
  const policy = config.retryPolicy as { maxRetries?: unknown } | undefined;
  const n = Number(policy?.maxRetries ?? 3);
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : 3, 1), 10);
}

async function queueRuleWebhookRetry(
  action: Action,
  context: ActionContext,
  stepIndex: number,
  config: Record<string, unknown>
): Promise<string | null> {
  const payload: RuleWebhookJob = {
    actionId: action.id,
    stepIndex,
    executionId: context.executionId,
    event: context.event ?? null,
    trigger: context.trigger,
  };
  try {
    const job = await queue.dispatch(RULE_WEBHOOKS_QUEUE, "deliver", payload, {
      attempts: retryAttempts(config),
      // The first try already happened here: the queue's backoff starts the next one later.
      delayMs: 2_000,
      // One retry chain per execution and step, even if the rule's run is repeated.
      dedupeKey: `${context.executionId}:${stepIndex}`,
    });
    return job.id;
  } catch {
    return null;
  }
}

/** One delivery attempt of a queued `core:webhook` retry. Throws to let the queue back off. */
export async function deliverRuleWebhook(job: { payload: unknown }): Promise<void> {
  const { PermanentError } = await import("../../../../../packages/engine/src/queue");
  const data = job.payload as RuleWebhookJob;
  const { getAction } = await import("./engine");
  const action = await getAction(data.actionId);
  // Deleted or paused since: nothing to send, and no point retrying.
  if (!action || action.status !== "active" || action.type !== "rule") return;
  const step = ((action.config as Partial<RuleConfig> | null)?.steps ?? [])[data.stepIndex] as
    RuleStep | undefined;
  if (!step || step.handler !== "core:webhook") return;

  const context = {
    actionId: action.id,
    actionName: action.name,
    actionType: "rule",
    trigger: data.trigger,
    event: data.event ?? undefined,
    env: {},
    executionId: data.executionId,
    startedAt: new Date(),
  } as ActionContext;
  const input = stepInput(action, context, step);
  const { executeWebhookOutAction, retryableWebhookFailure } =
    await import("./handlers/webhook-out-handler");
  const result = await executeWebhookOutAction(
    { ...action, type: "webhook_out", config: input.config } as Action,
    context,
    { inlineRetries: false }
  );
  if (result.success) return;
  if (!retryableWebhookFailure(result)) throw new PermanentError(result.error ?? "refused");
  throw new Error(result.error ?? "the webhook failed");
}

/** Registers the retry handler (called by the worker startup, lib/queue.ts). */
export function registerRuleWebhookDelivery(): void {
  queue.handle(RULE_WEBHOOKS_QUEUE, deliverRuleWebhook, { concurrency: 4 });
}
