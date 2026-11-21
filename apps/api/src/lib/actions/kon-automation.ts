/**
 * `ctx.automation`: rules a kon keeps (docs/automation.md)
 * ============================================================================
 *
 * A kon's own configuration often IS a rule: "when a deal enters this stage,
 * create a task". The kon used to run those itself; now it writes them as
 * stored actions of type `rule` and the core's engine runs them, with the same
 * conditions, run history and dry run as a rule a person wrote in the panel.
 *
 * Two limits, because here the author is code and not a person:
 *
 *   · A kon's rule only uses that kon's OWN handlers. Calling a webhook or
 *     making an agent act is a person's decision (routes/actions.ts); a kon
 *     must not take it for them.
 *   · A kon only sees and replaces the rules it wrote. Their slug carries the
 *     kon's id (`kon-crm--stage-42-enter`), and that prefix is what is checked.
 */

import {
  conditionsProblem,
  isKonEventName,
  KON_RULE_SLUG,
  ruleConfigProblem,
  type KonAutomation,
  type KonRule,
  type KonRuleInfo,
} from "@kitsuden/shared";
import { and, eq, like } from "drizzle-orm";

import { db } from "../../db";
import { actions } from "../../db/schema";
import { konRuleHandler } from "../kon-contributions";

import { createAction, deleteAction, updateAction } from "./engine";

/**
 * A kon id with no `--` and no trailing `-`: the slug prefix `<kon id>--` must
 * name one kon. With `kon-crm--x` allowed, that kon's rule `y` and kon-crm's
 * rule `x--y` were one row, and kon-crm's `listRules` listed its rules (H65).
 */
const KON_ID = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The core's own events, as an action names them: `entry.created`. */
const CORE_EVENT = /^[a-z]+\.[a-z]+$/;

function slugFor(konId: string, slug: string): string {
  return `${konId}--${slug}`;
}

function requireKonId(konId: unknown): asserts konId is string {
  if (typeof konId !== "string" || !KON_ID.test(konId)) {
    throw new Error("automation: the kon id is required (the kon's own id)");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (c) => "\\" + c);
}

function info(row: typeof actions.$inferSelect, konId: string): KonRuleInfo {
  return {
    id: row.id,
    slug: row.slug.slice(konId.length + 2),
    name: row.name,
    event: (row.triggerConfig as { eventName?: string } | null)?.eventName ?? "",
    enabled: row.status === "active",
  };
}

function ruleProblem(konId: string, rule: KonRule): string | null {
  if (!rule || typeof rule !== "object") return "the rule must be an object";
  if (typeof rule.slug !== "string" || !KON_RULE_SLUG.test(rule.slug)) {
    return "slug must be lower case letters, digits and hyphens";
  }
  if (typeof rule.name !== "string" || rule.name.trim() === "") return "name is required";
  if (
    typeof rule.event !== "string" ||
    !(isKonEventName(rule.event) || CORE_EVENT.test(rule.event))
  ) {
    return `event "${String(rule.event)}" is not an event name`;
  }
  const conditions = conditionsProblem(rule.conditions, rule.match);
  if (conditions) return conditions;
  const shape = ruleConfigProblem({ steps: rule.steps });
  if (shape) return shape;
  for (const [index, step] of rule.steps.entries()) {
    if (!step.handler.startsWith(`${konId}:`)) {
      return `step ${index + 1}: a kon's rule only uses its own handlers, and "${step.handler}" is not one of ${konId}`;
    }
    const handler = konRuleHandler(step.handler);
    if (!handler) return `step ${index + 1}: ${konId} did not declare a handler "${step.handler}"`;
    const problem = handler.definition.validate?.(step.config ?? {});
    if (problem) return `step ${index + 1} (${step.handler}): ${problem}`;
  }
  return null;
}

async function find(konId: string, slug: string) {
  const [row] = await db
    .select()
    .from(actions)
    .where(and(eq(actions.slug, slugFor(konId, slug)), eq(actions.type, "rule")))
    .limit(1);
  return row ?? null;
}

export const konAutomation: KonAutomation = {
  async upsertRule(konId, rule) {
    requireKonId(konId);
    const problem = ruleProblem(konId, rule);
    if (problem) throw new Error(`automation: ${problem}`);

    const triggerConfig = {
      eventName: rule.event,
      ...(rule.conditions ? { conditions: rule.conditions } : {}),
      ...(rule.match ? { match: rule.match } : {}),
    };
    const config = { steps: rule.steps };
    const status = rule.enabled === false ? ("paused" as const) : ("active" as const);

    const existing = await find(konId, rule.slug);
    if (existing) {
      const updated = await updateAction(existing.id, {
        name: rule.name,
        description: rule.description,
        trigger: "event",
        triggerConfig,
        config,
        status,
      });
      if (rule.ownerUserId !== undefined && rule.ownerUserId !== existing.createdById) {
        await db
          .update(actions)
          .set({ createdById: rule.ownerUserId })
          .where(eq(actions.id, existing.id));
      }
      return info(updated ?? existing, konId);
    }
    const created = await createAction({
      name: rule.name,
      slug: slugFor(konId, rule.slug),
      description: rule.description,
      type: "rule",
      trigger: "event",
      triggerConfig,
      config,
      status,
      createdById: rule.ownerUserId ?? null,
    });
    return info(created, konId);
  },

  async removeRule(konId, slug) {
    requireKonId(konId);
    if (typeof slug !== "string" || !KON_RULE_SLUG.test(slug)) return false;
    const existing = await find(konId, slug);
    return existing ? deleteAction(existing.id) : false;
  },

  async listRules(konId) {
    requireKonId(konId);
    const rows = await db
      .select()
      .from(actions)
      .where(and(eq(actions.type, "rule"), like(actions.slug, `${escapeLike(konId)}--%`)));
    return rows.map((row) => info(row, konId)).sort((a, b) => a.slug.localeCompare(b.slug));
  },
};
