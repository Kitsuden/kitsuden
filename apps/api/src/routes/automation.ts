/**
 * Automation as SDK operations: the catalog and the dry run (docs/automation.md)
 * ============================================================================
 *
 * Stored actions keep their own router (`routes/actions.ts`, `/api/actions`).
 * What is new for rules is declared here with `defineOperation`, mounted at
 * `/api/automation`:
 *
 *   GET  /catalog              the events a rule can listen to and the steps it can use
 *   POST /actions/:id/dry-run  what an action WOULD do for an event, without doing it
 *
 * And, at `/api/admin/secret-access`, who opened which sealed secret of a kon
 * (docs/kons/secrets.md).
 *
 * All three are the administrator's and run as the system: `actions` and
 * `secret_access_log` are system-only tables, so there is no row policy to
 * apply on behalf of whoever asks. None is an MCP tool: writing a rule is a
 * person's task, and the access log is an audit trail.
 */

import { defineOperation } from "@kitsuden/shared";
import { z } from "zod";

// Deep imports, not the facade: the facade reaches the loader, which reaches the routes.
import { AppError } from "../../../../packages/engine/src/errors";
import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { isSecretColumn } from "../../../../packages/engine/src/secret-columns";
import { getAction } from "../lib/actions";
import { registerCoreOperations } from "../lib/core-operations";
import { eventCatalog } from "../lib/kon-contributions";
import { requireAuth, optionalAuth } from "../middleware/auth";

export const AUTOMATION_KON = "kon-automation";
export const AUTOMATION_ROUTE = "/api/automation";
export const SECRET_ACCESS_KON = "kon-secret-access";
export const SECRET_ACCESS_ROUTE = "/api/admin/secret-access";

const adminOnly = {
  access: "session" as const,
  permission: { roles: ["admin"] },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The rule engine (lib/actions/rules.ts). Deferred: it reaches the webhook and
 * agent handlers, which reach the agent engine.
 */
async function rules() {
  return import("../lib/actions/rules");
}

/**
 * Keys whose value is a credential, by name: `secret`, `apiToken`, `Authorization`, `X-Api-Key`,
 * `cookie`… Case-insensitive and anywhere in the name (`isSecretColumn` needs a letter or an
 * underscore before `token`, so `X-Api-Token` slipped through it).
 */
const CREDENTIAL_KEY =
  /(token|secret|passw(or)?d|authorization|api[-_ ]?key|cookie|credential|signature|bearer)/i;

/**
 * A step's config as it may be shown: a value under a key that names a credential is replaced, and
 * so is every value under `headers` (any header may carry one). A dry run is read by whoever is
 * debugging a rule, and a webhook's signing secret or `Authorization` header is not part of that.
 */
function withoutSecrets(value: unknown, depth = 0, hideAll = false): unknown {
  if (depth > 12 || value === null || typeof value !== "object") {
    return hideAll && value !== null && value !== undefined ? "[hidden]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, depth + 1, hideAll));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (hideAll || CREDENTIAL_KEY.test(key) || isSecretColumn(key)) {
      output[key] = item === null || item === undefined ? item : "[hidden]";
    } else {
      output[key] = withoutSecrets(item, depth + 1, key.toLowerCase() === "headers");
    }
  }
  return output;
}

const Event = z.object({
  name: z.string(),
  source: z.string(),
  description: z.string(),
  payload: z.record(z.string(), z.string()),
  listeners: z.array(z.string()),
});

const Handler = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  description: z.string(),
  config: z.record(z.string(), z.string()),
});

const Outcome = z.object({
  condition: z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() }),
  actual: z.unknown().optional(),
  passed: z.boolean(),
});

export const automationOperations: AnyOperation[] = [
  defineOperation({
    ...adminOnly,
    id: "catalog",
    method: "GET",
    route: "/catalog",
    tags: ["automation"],
    summary: "Events and steps available to rules",
    description:
      "The events a rule can listen to (the core's, and the ones loaded kons declare with `events.emits`, each with its payload fields and who listens) and the steps it can use (`core:webhook`, `core:send-mail`, `core:run-agent`, and the ones kons contribute), each with its config fields.",
    output: { schema: z.object({ events: z.array(Event), handlers: z.array(Handler) }) },
    mcp: { exclude: "Writing a rule is a person's task in the panel." },
    handle: async () => ({
      events: eventCatalog(),
      handlers: (await rules()).listRuleHandlers(),
    }),
  }),
  defineOperation({
    ...adminOnly,
    id: "dry-run-action",
    method: "POST",
    route: "/actions/:id/dry-run",
    readOnly: true,
    tags: ["automation"],
    summary: "What an action would do for an event",
    description:
      "Evaluates the action's conditions against `payload` and, for a rule, fills each step's config and asks its handler for a preview. Nothing is sent, nothing is written and no execution is recorded. For the other types of action only the conditions are checked. Values under keys that name a secret are hidden.",
    input: {
      params: z.object({ id: z.string().regex(UUID, "must be a uuid") }),
      body: z.object({
        event: z.string().max(300).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    output: {
      schema: z.object({
        wouldRun: z.boolean(),
        conditions: z.object({ passed: z.boolean(), outcomes: z.array(Outcome) }),
        steps: z.array(
          z.object({
            handler: z.string(),
            config: z.record(z.string(), z.unknown()),
            preview: z.unknown().optional(),
            problem: z.string().optional(),
          })
        ),
        note: z.string().optional(),
      }),
    },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { exclude: "Writing and testing a rule is a person's task in the panel." },
    handle: async (e) => {
      const { id } = e.params as { id: string };
      const body = e.body as { event?: string; payload?: Record<string, unknown> };
      const action = await getAction(id);
      if (!action) throw AppError.notFound("There is no such action.");
      const result = await (
        await rules()
      ).dryRunAction(action, { event: body.event, payload: body.payload ?? {} });
      return {
        ...result,
        steps: result.steps.map((step) => ({
          ...step,
          config: withoutSecrets(step.config) as Record<string, unknown>,
        })),
      };
    },
  }),
];

export const secretAccessOperations: AnyOperation[] = [
  defineOperation({
    ...adminOnly,
    id: "list-secret-access",
    method: "GET",
    route: "/",
    tags: ["secrets"],
    summary: "Who opened which sealed secret",
    description:
      "The openings and refusals of secrets kons sealed with `ctx.secrets`, newest first: the kon, the purpose, the subject the kon named, the account and the request. Never a value.",
    input: {
      query: z.object({
        kon: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    output: {
      schema: z.object({
        entries: z.array(
          z.object({
            id: z.string(),
            konId: z.string(),
            outcome: z.string(),
            purpose: z.string(),
            subject: z.string().nullable(),
            actorUserId: z.string().nullable(),
            requestId: z.string().nullable(),
            createdAt: z.string(),
          })
        ),
      }),
    },
    mcp: { exclude: "An audit trail for administrators." },
    handle: async (e) => {
      const query = e.query as { kon?: string; limit?: number };
      const { listSecretAccess } = await import("../lib/kon-secrets");
      const entries = await listSecretAccess({ konId: query.kon, limit: query.limit });
      return {
        entries: entries.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
      };
    },
  }),
];

export const automationKon = {
  id: AUTOMATION_KON,
  name: "Automation",
  version: "1.0.0",
  mountPath: AUTOMATION_ROUTE,
  operations: automationOperations,
};

export const secretAccessKon = {
  id: SECRET_ACCESS_KON,
  name: "Secret access log",
  version: "1.0.0",
  mountPath: SECRET_ACCESS_ROUTE,
  operations: secretAccessOperations,
};

registerCoreOperations({
  konId: AUTOMATION_KON,
  mountPath: AUTOMATION_ROUTE,
  description:
    "The catalog of events and steps for automation rules, and the dry run of an action.",
  operations: automationOperations,
});

registerCoreOperations({
  konId: SECRET_ACCESS_KON,
  mountPath: SECRET_ACCESS_ROUTE,
  description: "Who opened which secret a kon sealed with ctx.secrets (for administrators).",
  operations: secretAccessOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const automationRoutes = operationsRouter(AUTOMATION_KON, automationOperations, context);
export const secretAccessRoutes = operationsRouter(
  SECRET_ACCESS_KON,
  secretAccessOperations,
  context
);
