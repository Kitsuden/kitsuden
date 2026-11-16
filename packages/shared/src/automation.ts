/**
 * Automation rules: conditions, templates and steps (docs/automation.md)
 * ============================================================================
 *
 * A rule is a stored action of type `rule`:
 *
 *   WHEN  an event arrives (or a cron fires, or someone runs it by hand)
 *   IF    its payload meets the conditions
 *   THEN  run these steps, in order
 *
 * Each step names a HANDLER. The core brings a few (`core:webhook`,
 * `core:send-mail`, `core:run-agent`) and a kon contributes its own with
 * `defineKon({ actionHandlers })`: the CRM knows how to create an activity,
 * the core does not and must not.
 *
 * This file is the part that is pure: evaluating a condition, filling a
 * template, checking the shape of a rule. The host runs the steps.
 *
 * ── WHY NOT CODE ───────────────────────────────────────────────────────────
 *
 * A `code` action can already do anything. A rule is for the person who is
 * not going to write code: it is data, so the panel can draw it, an agent can
 * read it, and a dry run can say what WOULD happen without doing it.
 */

import type { KonContext } from "./kon-api";

// ─────────────────────────────────────────────────────────────────────────────
// Conditions
// ─────────────────────────────────────────────────────────────────────────────

export const RULE_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "in",
  "exists",
] as const;

export type RuleOperator = (typeof RULE_OPERATORS)[number];

export interface RuleCondition {
  /** Dot path into the event payload: `deal.amount`, `status`. */
  field: string;
  op: RuleOperator;
  /** Not used by `exists`, where `false` means "must be absent". */
  value?: unknown;
}

/** `all`: every condition holds (default). `any`: at least one. */
export type RuleMatch = "all" | "any";

export const MAX_RULE_CONDITIONS = 20;
export const MAX_RULE_STEPS = 20;
const MAX_PATH_DEPTH = 12;

/** Keys that walk out of the data and into the object machinery. */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export function isRulePath(path: unknown): path is string {
  if (typeof path !== "string" || !PATH.test(path)) return false;
  const parts = path.split(".");
  return parts.length <= MAX_PATH_DEPTH && parts.every((part) => !FORBIDDEN_KEYS.has(part));
}

/** Reads `a.b.c` from plain data. Never follows inherited properties. */
export function readPath(data: unknown, path: string): unknown {
  if (!isRulePath(path)) return undefined;
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function comparable(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.getTime();
  return null;
}

/** Numbers compare as numbers; two strings as strings; anything else does not compare. */
function order(left: unknown, right: unknown): number | null {
  const a = comparable(left);
  const b = comparable(right);
  if (a === null || b === null) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    // Two numeric strings are almost always amounts that arrived as text.
    const na = Number(a);
    const nb = Number(b);
    if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
      return na - nb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  // `"5"` from a form and `5` from an API are the same amount to whoever wrote the rule.
  return String(left) === String(right);
}

export function evaluateCondition(condition: RuleCondition, data: unknown): boolean {
  const actual = readPath(data, condition.field);
  const expected = condition.value;
  switch (condition.op) {
    case "exists": {
      const present = actual !== undefined && actual !== null;
      return expected === false ? !present : present;
    }
    case "eq":
      return sameValue(actual, expected);
    case "neq":
      return !sameValue(actual, expected);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const difference = order(actual, expected);
      if (difference === null) return false;
      if (condition.op === "gt") return difference > 0;
      if (condition.op === "gte") return difference >= 0;
      if (condition.op === "lt") return difference < 0;
      return difference <= 0;
    }
    case "contains":
      if (Array.isArray(actual)) return actual.some((item) => sameValue(item, expected));
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    case "starts_with":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().startsWith(expected.toLowerCase())
      );
    case "in":
      return Array.isArray(expected) && expected.some((item) => sameValue(actual, item));
    default:
      return false;
  }
}

export interface ConditionOutcome {
  condition: RuleCondition;
  /** What the payload had at `field`. */
  actual: unknown;
  passed: boolean;
}

export interface ConditionsResult {
  passed: boolean;
  outcomes: ConditionOutcome[];
}

/** No conditions means the rule always runs. */
export function evaluateConditions(
  conditions: readonly RuleCondition[] | undefined,
  data: unknown,
  match: RuleMatch = "all"
): ConditionsResult {
  const list = conditions ?? [];
  const outcomes = list.map((condition) => ({
    condition,
    actual: readPath(data, condition.field),
    passed: evaluateCondition(condition, data),
  }));
  if (outcomes.length === 0) return { passed: true, outcomes };
  const passed = match === "any" ? outcomes.some((o) => o.passed) : outcomes.every((o) => o.passed);
  return { passed, outcomes };
}

/** Why a list of conditions cannot be stored, or `null`. */
export function conditionsProblem(conditions: unknown, match?: unknown): string | null {
  if (match !== undefined && match !== "all" && match !== "any") {
    return 'match must be "all" or "any"';
  }
  if (conditions === undefined || conditions === null) return null;
  if (!Array.isArray(conditions)) return "conditions must be a list";
  if (conditions.length > MAX_RULE_CONDITIONS) {
    return `a rule takes at most ${MAX_RULE_CONDITIONS} conditions`;
  }
  for (const [index, raw] of conditions.entries()) {
    const condition = raw as Partial<RuleCondition> | null;
    if (!condition || typeof condition !== "object")
      return `condition ${index + 1} is not an object`;
    if (!isRulePath(condition.field)) {
      return `condition ${index + 1}: field must be a dot path such as "deal.amount"`;
    }
    if (!RULE_OPERATORS.includes(condition.op as RuleOperator)) {
      return `condition ${index + 1}: op must be one of ${RULE_OPERATORS.join(", ")}`;
    }
    if (condition.op === "in" && !Array.isArray(condition.value)) {
      return `condition ${index + 1}: "in" needs a list as value`;
    }
    if (condition.op !== "exists" && condition.value === undefined) {
      return `condition ${index + 1}: value is required for "${condition.op}"`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Fills `{{path}}` from `scope`, through strings, lists and objects.
 *
 * A string that is ONLY a placeholder keeps the type of what it points to
 * (`"{{event.amount}}"` becomes the number 500, not "500"): a handler that
 * expects a number must not have to parse one. A placeholder that points
 * nowhere becomes an empty string, or `null` when it stands alone.
 */
export function fillTemplate<T>(value: T, scope: unknown, depth = 0): T {
  if (depth > MAX_PATH_DEPTH) return value;
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) {
      const found = readPath(scope, whole[1]);
      return (found === undefined ? null : found) as T;
    }
    return value.replace(PLACEHOLDER, (_match, path: string) => asText(readPath(scope, path))) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fillTemplate(item, scope, depth + 1)) as T;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      output[key] = fillTemplate(item, scope, depth + 1);
    }
    return output as T;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps and handlers
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleStep {
  /** `core:webhook`, `kon-crm:create-activity`. */
  handler: string;
  /** The handler's settings. Strings may carry `{{event.field}}` placeholders. */
  config?: Record<string, unknown>;
  /** Keep going with the next step when this one fails. Default: stop. */
  continueOnError?: boolean;
}

/** `config` of a stored action of type `rule`. */
export interface RuleConfig {
  steps: RuleStep[];
}

/** What the trigger of a rule adds to the usual trigger config. */
export interface RuleTriggerConditions {
  conditions?: RuleCondition[];
  match?: RuleMatch;
}

/** `<source>:<name>`: `core:webhook`, `kon-crm:create-activity`. */
export const RULE_HANDLER_ID = /^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$/;

export interface AutomationHandlerInput {
  /** The step's config, with its placeholders already filled. */
  config: Record<string, unknown>;
  /** The event that fired the rule; absent for cron and manual runs. */
  event?: { name: string; data: Record<string, unknown> };
  rule: { id: string; name: string };
  /**
   * The account that answers for the rule: whoever created it. `null` when
   * that account no longer exists.
   */
  actorUserId: string | null;
}

/**
 * A step a kon contributes. Declared in `defineKon({ actionHandlers })`; the
 * host exposes it as `<kon id>:<id>`.
 */
export interface AutomationHandlerDefinition {
  /** Unique inside the kon: `create-activity`. */
  id: string;
  /** For the panel: "Create an activity". */
  label: string;
  description: string;
  /** The config, field by field: documentation for whoever writes the rule. */
  config?: Record<string, string>;
  /** Why this config cannot be saved, or `null`. Runs when the rule is stored. */
  validate?(config: Record<string, unknown>): string | null;
  /**
   * Does the work. Runs after the triggering request committed, outside any
   * request: `ctx.db.instance` is the system connection, so the handler must
   * apply `input.actorUserId` itself where ownership matters. It may run more
   * than once for the same event if the rule is run again by hand: make it
   * idempotent where a repeat would hurt.
   */
  run(input: AutomationHandlerInput, ctx: KonContext): Promise<unknown>;
  /**
   * What `run` WOULD do, without doing it: shown by a dry run. Without it the
   * dry run shows the filled config.
   */
  preview?(input: AutomationHandlerInput, ctx: KonContext): Promise<unknown> | unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules a kon keeps: `ctx.automation`
// ─────────────────────────────────────────────────────────────────────────────

/** `stage-42-enter`: unique inside the kon. */
export const KON_RULE_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** A rule a kon creates on behalf of its own configuration (a pipeline stage's "on enter"). */
export interface KonRule {
  /** Unique inside the kon; writing the same slug again replaces the rule. */
  slug: string;
  name: string;
  description?: string;
  /** The event that fires it. */
  event: string;
  conditions?: RuleCondition[];
  match?: RuleMatch;
  /** Only this kon's own handlers (`<kon id>:<id>`): a kon does not wire webhooks or agents for a person. */
  steps: RuleStep[];
  /** Default true. A paused rule is kept but does not run. */
  enabled?: boolean;
  /**
   * The account that answers for the rule (who configured the stage). Handlers
   * receive it as `actorUserId`.
   */
  ownerUserId?: string | null;
}

export interface KonRuleInfo {
  id: string;
  slug: string;
  name: string;
  event: string;
  enabled: boolean;
}

/**
 * `ctx.automation`. Its presence is the capability: a host that has it runs
 * kon-contributed steps, so a kon may retire its own runner.
 *
 * `konId` is the kon's own id. A kon only sees and changes the rules it wrote.
 */
export interface KonAutomation {
  /** Creates the rule or replaces the one with the same slug. Idempotent. */
  upsertRule(konId: string, rule: KonRule): Promise<KonRuleInfo>;
  /** `true` when there was one. */
  removeRule(konId: string, slug: string): Promise<boolean>;
  listRules(konId: string): Promise<KonRuleInfo[]>;
}

/** Why a rule's `config` cannot be stored, or `null`. Handler existence is the host's check. */
export function ruleConfigProblem(config: unknown): string | null {
  const steps = (config as Partial<RuleConfig> | null | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return "a rule needs at least one step";
  if (steps.length > MAX_RULE_STEPS) return `a rule takes at most ${MAX_RULE_STEPS} steps`;
  for (const [index, raw] of steps.entries()) {
    const step = raw as Partial<RuleStep> | null;
    if (!step || typeof step !== "object") return `step ${index + 1} is not an object`;
    if (typeof step.handler !== "string" || !RULE_HANDLER_ID.test(step.handler)) {
      return `step ${index + 1}: handler must look like "core:webhook"`;
    }
    if (
      step.config !== undefined &&
      (step.config === null || typeof step.config !== "object" || Array.isArray(step.config))
    ) {
      return `step ${index + 1}: config must be an object`;
    }
    if (step.continueOnError !== undefined && typeof step.continueOnError !== "boolean") {
      return `step ${index + 1}: continueOnError must be true or false`;
    }
  }
  return null;
}
