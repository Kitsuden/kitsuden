/**
 * What kons contribute to the core's shared surfaces
 * ============================================================================
 *
 * A kon declares, in `defineKon`, things the CORE then offers to everyone:
 *
 *   events          → the event catalog          (docs/kons/events.md)
 *   actionHandlers  → steps for automation rules (docs/automation.md)
 *   reports         → reports it ships           (docs/reports.md)
 *
 * The loader calls `registerKonContributions` once per kon. This module only
 * keeps the registries: no database, no imports of the engines that read them,
 * so those engines can import it without a cycle.
 *
 * A malformed contribution is REPORTED and skipped, it does not stop the kon:
 * a typo in a report must not take the CRM's routes down with it.
 */

import {
  buildKonEventCatalog,
  konEventsProblem,
  reportDefinitionProblem,
  RULE_HANDLER_ID,
  type AutomationHandlerDefinition,
  type KonContext,
  type KonDefinition,
  type KonEventCatalogEntry,
  type KonEventsDeclaration,
  type ReportDefinition,
} from "@kitsuden/shared";

import { forgetKonEventSharing, setKonEventSharing } from "./kon-event-access";

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

const eventDeclarations = new Map<string, KonEventsDeclaration>();

/** Events the core itself emits, under the names an action listens to. */
const CORE_EVENTS: KonEventCatalogEntry[] = [
  {
    name: "entry.created",
    source: "core",
    description: "A dataset entry was created.",
    payload: { datasetId: "uuid of the dataset", entry: "the entry as stored" },
    listeners: [],
  },
  {
    name: "entry.updated",
    source: "core",
    description: "A dataset entry was updated.",
    payload: { datasetId: "uuid of the dataset", entry: "the entry as stored" },
    listeners: [],
  },
  {
    name: "entry.deleted",
    source: "core",
    description: "A dataset entry was deleted.",
    payload: { datasetId: "uuid of the dataset", entry: "the entry that was deleted" },
    listeners: [],
  },
  {
    name: "post.published",
    source: "core",
    description: "A blog post was published.",
    payload: { post: "the post as stored" },
    listeners: [],
  },
  {
    name: "page:updated",
    source: "core",
    description:
      "A page-builder page or one of its blocks changed (after commit). What a site's cache purge listens to (docs/install/inti.md).",
    payload: {
      id: "uuid of the page",
      slug: "the page's slug now",
      previousSlug: "only when the page was renamed: the slug it had, which a site must purge too",
    },
    listeners: [],
  },
  {
    name: "page:deleted",
    source: "core",
    description: "A page-builder page was deleted (after commit).",
    payload: { id: "uuid of the page", slug: "the slug it had" },
    listeners: [],
  },
];

/** Every event a rule can listen to: the core's, then each kon's. */
export function eventCatalog(): KonEventCatalogEntry[] {
  return [...CORE_EVENTS, ...buildKonEventCatalog(eventDeclarations)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule handlers contributed by kons
// ─────────────────────────────────────────────────────────────────────────────

export interface KonRuleHandler {
  /** `<kon id>:<handler id>`. */
  id: string;
  konId: string;
  definition: AutomationHandlerDefinition;
  /** The context the kon was loaded with: what `run` receives. */
  context: KonContext;
}

const konRuleHandlers = new Map<string, KonRuleHandler>();

export function konRuleHandler(id: string): KonRuleHandler | undefined {
  return konRuleHandlers.get(id);
}

export function listKonRuleHandlers(): KonRuleHandler[] {
  return [...konRuleHandlers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports shipped by kons
// ─────────────────────────────────────────────────────────────────────────────

export interface KonReport {
  /** `kon:<kon id>/<report id>`. */
  id: string;
  konId: string;
  definition: ReportDefinition;
}

const konReports = new Map<string, KonReport>();

export function konReport(id: string): KonReport | undefined {
  return konReports.get(id);
}

export function listKonReports(): KonReport[] {
  return [...konReports.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/** Removes everything a kon contributed: before re-registering it, or when it is turned off. */
export function forgetKonContributions(konId: string): void {
  eventDeclarations.delete(konId);
  forgetKonEventSharing(konId);
  for (const [id, handler] of konRuleHandlers) {
    if (handler.konId === konId) konRuleHandlers.delete(id);
  }
  for (const [id, report] of konReports) {
    if (report.konId === konId) konReports.delete(id);
  }
}

/**
 * Registers what the kon declared. Returns the problems found, one sentence
 * each, so the loader can show them next to the kon; whatever is well formed
 * is registered regardless.
 */
export function registerKonContributions(
  konDef: Pick<KonDefinition, "id" | "events" | "actionHandlers" | "reports">,
  context: KonContext
): string[] {
  const problems: string[] = [];
  forgetKonContributions(konDef.id);

  if (konDef.events) {
    const problem = konEventsProblem(konDef.events);
    if (problem) problems.push(`events: ${problem}`);
    else {
      eventDeclarations.set(konDef.id, konDef.events);
      // Who may hear its events besides itself (lib/kon-event-access.ts).
      for (const p of setKonEventSharing(konDef.id, konDef.events)) problems.push(p);
    }
  }

  const seenHandlers = new Set<string>();
  for (const definition of konDef.actionHandlers ?? []) {
    const id = `${konDef.id}:${definition?.id}`;
    if (!definition || typeof definition.run !== "function" || !RULE_HANDLER_ID.test(id)) {
      problems.push(
        `actionHandlers: "${id}" needs an id (lower case, digits, "-") and a run function`
      );
      continue;
    }
    if (typeof definition.label !== "string" || definition.label.trim() === "") {
      problems.push(`actionHandlers: "${id}" needs a label`);
      continue;
    }
    if (seenHandlers.has(id)) {
      problems.push(`actionHandlers: "${id}" is declared twice`);
      continue;
    }
    seenHandlers.add(id);
    konRuleHandlers.set(id, { id, konId: konDef.id, definition, context });
  }

  const seenReports = new Set<string>();
  for (const definition of konDef.reports ?? []) {
    const problem = reportDefinitionProblem(definition);
    if (problem) {
      problems.push(`reports: ${problem}`);
      continue;
    }
    if (seenReports.has(definition.id)) {
      problems.push(`reports: "${definition.id}" is declared twice`);
      continue;
    }
    seenReports.add(definition.id);
    const id = `kon:${konDef.id}/${definition.id}`;
    konReports.set(id, { id, konId: konDef.id, definition });
  }

  return problems;
}
