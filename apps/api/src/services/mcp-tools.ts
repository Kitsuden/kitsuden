/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MCP Hardcoded Tools — Kitsuden Agents Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Shared service that exposes Kitsuden's hardcoded MCP tools.
 * Used by:
 *   - apps/api/src/routes/mcp.ts (MCP server)
 *   - apps/api/src/services/agent-tools.ts (Agent Engine tool calling)
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { setRlsContext, messageOf } from "@kitsuden/engine";
import {
  accessToDataset,
  buildDatasetWhere,
  schemaFields,
  checkReadAccess,
  checkWriteAccess,
  concedeScope,
  agentSignature,
  publishedOrOwn,
  type DatasetAction,
  type AgentSigner,
  type PolicyJson,
  type RLSRule,
} from "@kitsuden/shared";
import { and, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import { db, mergedSchema } from "@/db";
import { actions, dataEntries, dataSets, installedKons, modules, siteSettings } from "@/db/schema";
import {
  CodeOutsidePromotion,
  CUSTOMER_DATA_HOSTS_MESSAGE,
  TABLES_ONLY_VIA_THEIR_ROUTE,
  bringsCode,
  changesCustomerDataPolicy,
} from "@/lib/actions-code";
import { emailProblem, type CustomerDataGuard } from "@/lib/customer-data";
import {
  withoutSecretColumns,
  ADMIN_WRITE_TABLES,
  isForbiddenNativeTable,
} from "@/lib/explorable-tables";
import { encodeResponse, type Format, type RequestedFormat } from "@/lib/formats";
import {
  EVIDENCE_KEY,
  LedgerInputError,
  persistDirectEvidence,
  prepareDirectEvidence,
  rowIdFromResult,
  type DirectEvidence,
} from "@/lib/ledger";
import { logger } from "@/lib/logger";
import { WRAPPER_MODES, type WrapperMode } from "@/lib/mcp-settings";
import { wrapRows, rowProvenance, type Provenance } from "@/lib/provenance";
import { emailQueue } from "@/lib/queue";
import { KON_REGISTRY } from "@/services/module-registry";

import { generateReact } from "../../../../packages/codegen/src/generators/react";
import { generateSvelte } from "../../../../packages/codegen/src/generators/svelte";
import { generateVue } from "../../../../packages/codegen/src/generators/vue";

import type { LLMTool } from "./llm/types";
import { introspectTable } from "./schema-introspector";

/**
 * Minimum scopes required to run each hardcoded tool.
 * Tools not listed require the default scope "mcp:read".
 */
const TOOL_SCOPES: Record<string, string> = {
  kitsuden_query_collection: "mcp:read",
  kitsuden_query_dataset: "mcp:read",
  kitsuden_list_datasets: "mcp:read",
  kitsuden_describe_collection: "mcp:read",
  kitsuden_system_status: "mcp:read",
  kitsuden_create_record: "mcp:write",
  kitsuden_update_record: "mcp:write",
  kitsuden_delete_record: "mcp:write",
  kitsuden_insert_record: "mcp:write",
  kitsuden_create_dataset: "mcp:admin",
  // These three change what the API runs or how people sign in. Their REST
  // twins (/api/modules, /api/actions, /api/settings) are admin only, so
  // `mcp:admin` alone is not enough (security review 2026-11-03).
  kitsuden_install_kon: "admin",
  kitsuden_define_action: "admin",
  kitsuden_enable_auth: "admin",
  // Queues emails to any recipient: `mcp:write` is not enough, since it
  // has the "data-editor" preset (security audit).
  kitsuden_dispatch_worker: "mail:send",
  kitsuden_generate_frontend_hook: "mcp:read",
};

/**
 * Validation of each tool's arguments
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS is the boundary. What reaches `executeHardcodedTool` was written by a
 * MODEL, not by a client of ours: it is generated text that can have any
 * shape, extra fields or wrong types. Before, it was read with `args as any` and
 * traveled straight to an `.insert()` or an `.update()`.
 *
 * `as any` is not a typing detail here: it is the absence of the check.
 * With it, `data` could be a string, `limit` an object, and `collection`
 * anything that was later compared against the schema.
 *
 * It is validated ONCE, at dispatch, before entering any handler. This way a
 * tool cannot be added and forgotten: without an entry here, it does not
 * run (see the `default` of `schemaOf`) and a test checks it.
 *
 * Error messages are returned to the model as text: they are so that it
 * retries properly, so they say WHICH field and WHAT was expected.
 */

/**
 * Result format. `auto` (the default) picks for EACH response the shortest
 * among compact JSON, TOON and TRON that gives back exactly the same
 * data (lib/formats.ts). The chosen format goes in the result's `_meta`
 * (`kitsuden/format`).
 */
const FORMAT = z.enum(["auto", "json", "toon", "tron"]).default("auto");
const JSON_SCHEMA_FORMAT = {
  type: "string",
  enum: ["auto", "json", "toon", "tron"] as string[],
  default: "auto",
  description:
    "Result format. 'auto' (default) returns compact JSON, TOON or TRON, whichever is shortest for this result without losing data; the result's _meta['kitsuden/format'] says which. 'json' always returns compact JSON.",
};
/**
 * How to wrap text written by others (lib/provenance.ts). Without it,
 * the agent's (panel) or `none`: existing clients see no change.
 */
const WRAPPER = z.enum(WRAPPER_MODES).optional();
const WRAPPER_JSON_SCHEMA = {
  type: "string",
  enum: [...WRAPPER_MODES] as string[],
  description:
    "Wrap text written by users/other agents: 'delimiters' (<untrusted-content>…</untrusted-content>) or 'object' ({\"untrusted\": \"…\"}). Default: the agent's setting, else 'none'. Who wrote each record is always in _meta['kitsuden/provenance'].",
};
/** A record: plain object. Never an array or a scalar. */
const DATA = z.record(z.string(), z.unknown());

/**
 * Status of an entry. It is a Postgres ENUM (`content_status`), not free
 * text — with `z.string()` a model could send "posted" and the query
 * blew up against the column type, with a database error instead
 * of a message the model could correct. The checker exposed it
 * as soon as the `as any` was removed.
 */
const STATUS = z.enum(["draft", "published", "archived"]);

/**
 * Payload of an email queue job.
 *
 * `emailQueue.add` requires `EmailJobData` (to/subject/html). Before, the payload
 * came in as a free object, so a model could enqueue a job the
 * worker does not know how to process: the failure appeared FAR away, in the worker, and with no
 * visible relation to whoever enqueued it.
 */
const PAYLOAD_EMAIL = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(500),
  html: z.string().min(1),
  text: z.string().optional(),
});

const ARGS_SCHEMAS = {
  kitsuden_list_datasets: z.object({ format: FORMAT }),

  kitsuden_describe_collection: z.object({
    collection: z.string().min(1),
    format: FORMAT,
  }),

  kitsuden_system_status: z.object({}),

  kitsuden_query_collection: z.object({
    collection: z.string().min(1),
    // The cap belongs to the server, not the model: a huge `limit` is the
    // easiest way for a read tool to take the database down.
    limit: z.number().int().min(1).max(1000).default(50),
    offset: z.number().int().min(0).default(0),
    search: z.string().max(500).optional(),
    sort: z.string().max(120).optional(),
    where: DATA.optional(),
    format: FORMAT,
    untrusted_wrap: WRAPPER,
  }),

  kitsuden_create_record: z.object({
    collection: z.string().min(1),
    data: DATA,
    status: STATUS.default("published"),
  }),

  // Accepts the new schema {collection, id} and the legacy {entryId}. The
  // `superRefine` requires one of the two to be present: before, this was checked
  // by hand inside the handler and returned a loose string.
  kitsuden_update_record: z
    .object({
      collection: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      entryId: z.string().min(1).optional(),
      data: DATA,
      status: STATUS.optional(),
    })
    .superRefine((v, ctx) => {
      if (!v.id && !v.entryId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "'id' is required (or 'entryId' in legacy mode).",
        });
      }
    }),

  kitsuden_delete_record: z
    .object({
      collection: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      entryId: z.string().min(1).optional(),
    })
    .superRefine((v, ctx) => {
      if (!v.id && !v.entryId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "'id' is required (or 'entryId' in legacy mode).",
        });
      }
    }),

  kitsuden_query_dataset: z.object({
    datasetId: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
    status: STATUS.optional(),
    format: FORMAT,
    untrusted_wrap: WRAPPER,
  }),

  kitsuden_insert_record: z.object({
    datasetId: z.string().min(1),
    data: DATA,
    status: STATUS.default("draft"),
  }),

  kitsuden_create_dataset: z.object({
    name: z.string().min(1).max(200),
    // The slug ends up in a URL: it is restricted here instead of escaped later.
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens only."),
    fields: z.array(DATA).min(1),
    rlsEnabled: z.boolean().default(true),
    description: z.string().max(2000).optional(),
  }),

  kitsuden_install_kon: z.object({
    // Becomes a path (`kons/<id>`) the loader imports: no dots or slashes.
    konId: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens only."),
    source: z.enum(["local", "npm", "marketplace"]).default("npm"),
  }),

  kitsuden_define_action: z.object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(120),
    type: z.enum(["code", "webhook_out", "webhook_in", "agent"]),
    trigger: z.enum(["manual", "cron", "event", "http"]),
    triggerConfig: DATA.optional(),
    config: DATA.optional(),
  }),

  kitsuden_enable_auth: z.object({
    methods: z.array(z.string().min(1)).min(1),
    requireEmailVerification: z.boolean().default(true),
  }),

  kitsuden_dispatch_worker: z.object({
    queueName: z.literal("email"),
    jobName: z.string().min(1).max(120),
    payload: PAYLOAD_EMAIL,
  }),

  kitsuden_generate_frontend_hook: z.object({
    collection: z.string().min(1),
    framework: z.enum(["react", "vue", "svelte"]).default("react"),
    type: z.enum(["hook", "component", "form", "types", "all"]).default("all"),
  }),
} as const;

export type ToolName = keyof typeof ARGS_SCHEMAS;

/** Already-validated shape of a tool's arguments. */
type ArgsOf<N extends ToolName> = z.infer<(typeof ARGS_SCHEMAS)[N]>;

/** The names that have a schema. Used by the test that prevents adding one without it. */
export function namesWithSchema(): string[] {
  return Object.keys(ARGS_SCHEMAS);
}

/**
 * Validates a tool's arguments.
 *
 * Throws if the tool has no schema: this is deliberate. A tool without
 * declared validation must not be able to run "by default" — this way the oversight
 * shows up on first use and not when someone sends something odd.
 */
function validateArgs<N extends ToolName>(
  name: N,
  args: Record<string, unknown>
): z.infer<(typeof ARGS_SCHEMAS)[N]> {
  const schema = ARGS_SCHEMAS[name];
  if (!schema) throw new Error(`The tool '${name}' does not declare an argument schema`);

  const r = schema.safeParse(args ?? {});
  if (!r.success) {
    const detail = r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid arguments for '${name}' — ${detail}`);
  }
  return r.data as z.infer<(typeof ARGS_SCHEMAS)[N]>;
}

function hasToolScope(scopes: string[], required: string): boolean {
  // Kitsuden's single rule (wildcards and denials): @kitsuden/shared.
  return concedeScope(scopes, required);
}

/**
 * Tools that read or write a DATASET, and the action they request on it.
 * For them the permission is decided with the dataset already resolved:
 *
 *   1. a `!datasets:<slug>:<action>` denial (or a broader one) → no;
 *   2. `datasets:<slug>:<action>` (or `datasets:*:<action>`…) → yes;
 *   3. otherwise, the tool's broad scope (`mcp:read`/`mcp:write`),
 *      as always.
 *
 * On a native table (not a dataset) only the broad one applies.
 */
const DATASET_ACTION: Partial<Record<string, DatasetAction>> = {
  kitsuden_list_datasets: "read",
  kitsuden_describe_collection: "read",
  kitsuden_query_collection: "read",
  kitsuden_query_dataset: "read",
  kitsuden_create_record: "write",
  kitsuden_insert_record: "write",
  kitsuden_update_record: "write",
  kitsuden_delete_record: "delete",
};

class ToolPermission extends Error {
  readonly status = 403;
  readonly code = "FORBIDDEN";
}

/**
 * Who is calling the tool (the MCP session's agent), for the rules
 * that do not depend only on scopes: the dataset's policy, its `rlsRules`
 * and the signer. Set once per call in `executeHardcodedTool`.
 */
interface ActorMcp {
  id: string;
  scopes: string[];
  sponsor: AgentSigner | null;
  /** The call's RLS transaction (see `executeHardcodedTool`). */
  tx?: unknown;
  /** The human who approved this call, when it replays a held proposal. Set only by the server. */
  approvedBy?: string;
  /** Wrapper for the agent's untrusted content (lib/provenance.ts). */
  untrustedWrap?: WrapperMode;
  /** The engine run's customer-data guard (lib/customer-data.ts), when there is one. */
  customerData?: CustomerDataGuard;
}
const callActor = new AsyncLocalStorage<ActorMcp>();
const actor = (): ActorMcp => callActor.getStore() ?? { id: "", scopes: [], sponsor: null };

/**
 * The tools' connection: the call's RLS transaction, or the
 * global one outside of one (e.g. a test that calls a loose function).
 * Security audit: `/api/mcp` did not run in the RLS transaction and all
 * the queries here went through `db` with the empty context, which the
 * policies treat as "system".
 */
const bd = (): typeof db => (actor().tx as typeof db | undefined) ?? db;

/** An agent facing a dataset's policy (as kon-datasets sees it over REST). */
const asAgent = () => ({ id: actor().id || "agent", role: "agent" });

/** The minimum of a dataset needed to decide. */
interface DatasetWithPolicy {
  slug: string;
  policyJson?: unknown;
}

/**
 * Does the dataset's POLICY open this action to an agent that only carries
 * the tool's broad scope? human approval, owner's decision: same as
 * REST (kon-datasets) — reading needs a `readAccess` that admits a session
 * (`public`/`authenticated`) or the `dataset:view` policy scope
 * (`admin` covers it); writing also needs `writeAccess` or
 * `dataset-entry:<create|update|delete>`. No policy = admin only.
 */
function policyOpens(scopes: string[], ds: DatasetWithPolicy, action: DatasetAction): boolean {
  const policy = (ds.policyJson ?? null) as PolicyJson | null;
  const lee = checkReadAccess(policy, asAgent()) || concedeScope(scopes, "dataset:view");
  if (action === "read") return lee;
  const permission = action === "delete" ? "dataset-entry:delete" : "dataset-entry:create";
  return lee && (checkWriteAccess(policy, asAgent()) || concedeScope(scopes, permission));
}

/**
 * Can this session use `tool` on the dataset? Throws 403 if not.
 *
 *   1. a `!datasets:<slug>:<action>` denial → no;
 *   2. `datasets:<slug>:<action>` → yes (the per-dataset scope opens it);
 *   3. otherwise, the tool's broad scope opens the TOOL, and the
 *      dataset's policy decides (human approval; before, `mcp:read` read any
 *      dataset, including the "admin only" ones).
 */
/**
 * Can this agent READ the dataset? The same rule as the tools
 * (per-dataset scope, denials, policy), without throwing. Used by the MCP
 * resources (`kitsuden://datasets`), which used to list all of them.
 */
export function agentCanReadDataset(
  agent: { agentId: string; scopes: string[] },
  ds: DatasetWithPolicy
): boolean {
  return callActor.run({ id: agent.agentId, scopes: agent.scopes, sponsor: null }, () => {
    try {
      requireDataset("kitsuden_list_datasets", agent.scopes, ds);
      return true;
    } catch {
      return false;
    }
  });
}

function requireDataset(
  toolName: string,
  scopes: string[] | undefined,
  ds: DatasetWithPolicy
): void {
  const action = DATASET_ACTION[toolName] ?? "read";
  const list = scopes ?? [];
  const access = accessToDataset(list, ds.slug, action);
  if (access === "denied") {
    throw new ToolPermission(
      `Agent key is denied '${action}' on dataset '${ds.slug}' (tool '${toolName}')`
    );
  }
  if (access === "granted") return;
  assertToolScope(toolName, list);
  if (!policyOpens(list, ds, action)) {
    throw new ToolPermission(
      `Dataset '${ds.slug}' policy does not allow '${action}' for agents (tool '${toolName}'). ` +
        `Grant 'datasets:${ds.slug}:${action}' or change the dataset's policy.`
    );
  }
}

/**
 * The policy's `rlsRules`, as in REST: they always apply to an agent
 * (it is not on the team), even if the dataset is opened to it by scope.
 */
function whereVisibleToAgent(datasetId: string, ds: { policyJson?: unknown }) {
  const rules = ((ds.policyJson ?? null) as PolicyJson | null)?.rlsRules as RLSRule[] | undefined;
  return buildDatasetWhere(datasetId, rules, asAgent()).where;
}

/**
 * Which rows of a dataset this agent reads: like REST outside the team, the
 * published and its own (`created_by_id`: their owner is its sponsor). An agent
 * with `admin` stands for the team.
 */
function readableRows(scopes: string[]) {
  return hasToolScope(scopes, "admin") ? undefined : publishedOrOwn(actor().id || null);
}

/**
 * The row an update or delete by id may touch, or `null` (treated as not found:
 * a hidden row does not exist for this agent). `policyJson.rlsRules` always apply.
 *
 * Like REST (`dataset-entry:update|delete`): an agent let in by a scope that names
 * the action (`datasets:<slug>:<action>`, `dataset-entry:<verb>`, `admin`) edits
 * any row it can see; one let in only by `mcp:write` plus the dataset's policy
 * edits only its own. Before, that one edited or deleted any row by id.
 */
async function editableRow(
  ds: DatasetWithPolicy,
  dataSetId: string,
  entryId: string,
  action: "write" | "delete",
  scopes: string[] | undefined
): Promise<typeof dataEntries.$inferSelect | null> {
  const [row] = await bd()
    .select()
    .from(dataEntries)
    .where(
      and(
        whereVisibleToAgent(dataSetId, ds) ?? eq(dataEntries.dataSetId, dataSetId),
        eq(dataEntries.id, entryId)
      )
    )
    .limit(1);
  if (!row) return null;
  const list = scopes ?? [];
  const me = actor().id;
  if (!me) return row;
  // A human reviewed this exact call, so it is not limited to the agent's own rows.
  if (actor().approvedBy) return row;
  const verb = action === "delete" ? "dataset-entry:delete" : "dataset-entry:update";
  if (accessToDataset(list, ds.slug, action) === "granted" || concedeScope(list, verb)) return row;
  return row.ownerId === me || row.createdById === me ? row : null;
}

/**
 * The owner of an entry the agent creates: its human SIGNER (human approval,
 * @kitsuden/shared signer.ts). No signer, no owner (except an agent with
 * `admin` that names it in `data.ownerId`). Throws 403 if invalid.
 */
function inputOwner(request: unknown): string | null {
  const a = actor();
  if (!a.id) return typeof request === "string" ? request : null;
  const signature = agentSignature(
    { role: "agent", scopes: a.scopes, sponsor: a.sponsor },
    typeof request === "string" ? request : null,
    "nobody"
  );
  if (!signature.ok) throw new ToolPermission(`${signature.code}: ${signature.message}`);
  return signature.author;
}

/** Can it see THIS dataset in a listing? (without throwing) */
function veDataset(scopes: string[] | undefined, ds: DatasetWithPolicy): boolean {
  const slug = ds.slug;
  const access = accessToDataset(scopes ?? [], slug, "read");
  if (access === "denied") return false;
  if (access === "granted") return true;
  return (
    hasToolScope(scopes ?? [], TOOL_SCOPES.kitsuden_list_datasets!) &&
    policyOpens(scopes ?? [], ds, "read")
  );
}

/**
 * Does the session have ANY path to this datasets tool? (the broad one,
 * or a dataset scope with that action). If not, it is cut off before touching anything.
 */
function canTryDataset(toolName: string, scopes: string[] | undefined): boolean {
  const action = DATASET_ACTION[toolName];
  if (!action) return false;
  const list = scopes ?? [];
  if (hasToolScope(list, TOOL_SCOPES[toolName] || "mcp:read")) return true;
  return list.some((s) => {
    if (s.startsWith("!") || !s.startsWith("datasets:")) return false;
    const parts = s.split(":");
    const last = parts[parts.length - 1];
    return last === action || last === "*";
  });
}

/**
 * Checks whether the agent's context has the required scope for a tool.
 */
/** Does this core tool write? (for the day's write quota) */
export function writingTool(toolName: string): boolean {
  const s = TOOL_SCOPES[toolName];
  return s === "mcp:write" || s === "mcp:admin" || s === "admin" || s === "mail:send";
}

/**
 * Could this session use the core tool? (without throwing). If
 * not, the call is not held as a proposal; it carries on and gives its usual error.
 */
export function canTryTool(toolName: string, scopes?: string[]): boolean {
  const list = scopes ?? [];
  if (DATASET_ACTION[toolName] && canTryDataset(toolName, list)) return true;
  return hasToolScope(list, TOOL_SCOPES[toolName] || "mcp:read");
}

export function assertToolScope(toolName: string, scopes?: string[]): void {
  const required = TOOL_SCOPES[toolName] || "mcp:read";
  if (!hasToolScope(scopes || [], required)) {
    throw new Error(`Agent lacks required scope '${required}' to execute tool '${toolName}'`);
  }
}

export interface MCPSessionContext {
  /** The human who approved this call, when it replays a held proposal. */
  approvedBy?: string;
  agentId: string;
  agentName: string;
  apiKeyId?: string;
  scopes?: string[];
  /** The agent's human signer (owner of what it creates). */
  sponsor?: AgentSigner | null;
  /** Default wrapper for untrusted content (panel, lib/mcp-settings.ts). */
  untrustedWrap?: WrapperMode;
  /**
   * The engine run's customer-data guard (docs/agents/egress.md): the rows a
   * tool returns are tracked in it, and the email tool checks what it sends.
   */
  customerData?: CustomerDataGuard;
}

export interface MCPExecutionCallbacks {
  /**
   * Called after mutating data to invalidate caches (e.g. GraphQL).
   */
  onMutate?: () => Promise<void> | void;
}

/**
 * List of hardcoded MCP tools available to agents.
 */
/**
 * The format the text of the tool being run came out in.
 * Tools return text; whoever needs to know the format (the MCP
 * route, to put it in `_meta`) calls `executeHardcodedToolWithFormat`.
 */
const outputFormat = new AsyncLocalStorage<{ format?: Format; provenance?: Provenance }>();

/** Encodes a tool's result in the requested format (`auto` by default). */
function outputValue(data: unknown, request: RequestedFormat | undefined, tool: string): string {
  // Marked values the run receives, from the structure (the text may be TOON).
  actor().customerData?.marked.collect(data);
  const r = encodeResponse(data, request ?? "auto", { key: `mcp:${tool}` });
  const registry = outputFormat.getStore();
  if (registry) registry.format = r.format;
  return r.text;
}

/**
 * Like `executeHardcodedTool`, and it also says which format the text came out in
 * (`undefined` if the tool returned a message and not data).
 */
export async function executeHardcodedToolWithFormat(
  name: string,
  args: Record<string, unknown>,
  session?: MCPSessionContext,
  callbacks?: MCPExecutionCallbacks
): Promise<{ text: string; format?: Format; provenance?: Provenance }> {
  const registry: { format?: Format; provenance?: Provenance } = {};
  const text = await outputFormat.run(registry, () =>
    executeHardcodedTool(name, args, session, callbacks)
  );
  return { text, format: registry.format, provenance: registry.provenance };
}

/**
 * Who wrote each row (lib/provenance.ts) and, if requested, the text of
 * the untrusted ones wrapped. The provenance is left in the call's
 * record so the MCP route can put it in `_meta`.
 */
async function withProvenance<T>(
  rows: T[],
  request: WrapperMode | undefined,
  /** What the rows are: each record then carries the evidence of its fields (lib/ledger.ts). */
  entity?: string
): Promise<T[]> {
  const mode = request ?? actor().untrustedWrap ?? "none";
  const provenance = await rowProvenance(rows, bd() as never, {
    reader: actor().id || null,
    wrap: mode,
    entity,
  });
  const registry = outputFormat.getStore();
  if (registry) registry.provenance = provenance;
  return wrapRows(rows, provenance, mode);
}

/** Does this core tool only read? (`read` toolset, lib/mcp-settings.ts) */
export function readOnlyCoreTool(toolName: string): boolean {
  return TOOL_SCOPES[toolName] === "mcp:read";
}

/** Is it a core datasets/collections tool? (`data` toolset) */
export function dataCoreTool(toolName: string): boolean {
  return /^kitsuden_(list_datasets|describe_collection|query_collection|query_dataset|create_record|update_record|delete_record|insert_record)$/.test(
    toolName
  );
}

export function listHardcodedMCPTools(): LLMTool[] {
  return HARD_CODED_TOOLS;
}

/**
 * Runs a hardcoded MCP tool by name.
 */
export async function executeHardcodedTool(
  name: string,
  args: Record<string, unknown>,
  session?: MCPSessionContext,
  callbacks?: MCPExecutionCallbacks
): Promise<string> {
  // The datasets ones decide with the resolved dataset (see DATASET_ACTION);
  // here only whoever has NO path at all is cut off. For the others, their scope.
  if (DATASET_ACTION[name]) {
    if (!canTryDataset(name, session?.scopes)) assertToolScope(name, session?.scopes);
  } else {
    assertToolScope(name, session?.scopes);
  }
  const scopes = session?.scopes ?? [];
  // Agent data ledger: a record tool that runs now (not held) may carry
  // `_evidence` too. Validated before anything runs, taken out of the arguments
  // (the schemas would drop it) and kept with the row once written.
  let evidence: DirectEvidence | null = null;
  if (RECORD_TOOLS.has(name) && args && EVIDENCE_KEY in args && session?.agentId) {
    try {
      const prepared = await prepareDirectEvidence({
        channel: "mcp",
        method: "POST",
        path: `mcp:${name}`,
        tool: name,
        body: args,
      });
      if (prepared.stripped) {
        args = prepared.body as Record<string, unknown>;
        evidence = prepared.pending;
      }
    } catch (err) {
      if (err instanceof LedgerInputError) return `Invalid ${EVIDENCE_KEY}: ${err.message}`;
      throw err;
    }
  }
  const text = await runInAgentTransaction(name, args, scopes, session, callbacks);
  // Only what was really written (`Created …`/`Updated … record: <id>`, never "not found").
  const written = /^(Created|Updated) (dataset|native) record: [\w-]+$/.exec(text);
  if (evidence && written && session?.agentId && !session.agentId.startsWith("machine-")) {
    try {
      const rowId =
        evidence.target.kind === "create"
          ? rowIdFromResult(evidence.target, { content: [{ type: "text", text }] })
          : text.slice(text.lastIndexOf(" ") + 1);
      await persistDirectEvidence(evidence, rowId, session.agentId);
    } catch (err) {
      logger.warn({ err, tool: name }, "[ledger] could not keep the evidence of a direct write");
    }
  }
  return text;
}

/** The record tools whose fields can carry evidence (lib/ledger.ts, `mcp-record`). */
const RECORD_TOOLS = new Set(["kitsuden_create_record", "kitsuden_update_record"]);

function runInAgentTransaction(
  name: string,
  args: Record<string, unknown>,
  scopes: string[],
  session: MCPSessionContext | undefined,
  callbacks: MCPExecutionCallbacks | undefined
): Promise<string> {
  // Inside a transaction with the agent's RLS context, the SAME one it
  // would have over REST (`role: "agent"`, see index.ts), and with its scopes in
  // `app.agent_scopes`: Postgres filters per row here too, not only each
  // tool's logic. The `data_entries` policies know the
  // application's two paths — fine-grained scopes and human approval (the
  // tool's scope + `policyJson`), see `kitsuden_agent_opens_by_policy` in
  // rls-policies.sql (security audit).
  return db.transaction(async (tx) => {
    const user = { id: session?.agentId ?? "", role: "agent", scopes };
    await setRlsContext(tx as never, user);
    return callActor.run(
      {
        id: session?.agentId ?? "",
        scopes,
        sponsor: session?.sponsor ?? null,
        approvedBy: session?.approvedBy,
        tx,
        untrustedWrap: session?.untrustedWrap,
        customerData: session?.customerData,
      },
      () => runWithActor(name, args, scopes, callbacks)
    );
  });
}

async function runWithActor(
  name: string,
  args: Record<string, unknown>,
  scopes: string[],
  callbacks?: MCPExecutionCallbacks
): Promise<string> {
  // No tool runs without a declared schema. This is not an extra
  // defensive check: if someone adds one and forgets the schema, this fails on
  // first use instead of letting it through unvalidated.
  if (!(name in ARGS_SCHEMAS)) {
    throw new Error(`Unknown hardcoded MCP tool: ${name}`);
  }

  // `validateArgs` is called with the LITERAL name in each branch, not with a
  // variable: this way TypeScript knows exactly what shape it returns and the
  // handlers receive a concrete type. With a common `validateArgs(name, args)`
  // every call would need a cast, which is swapping one `as any` for another
  // cast and leaving the safeguard just as misleading.
  switch (name) {
    case "kitsuden_list_datasets":
      return kitsudenListDatasets(validateArgs("kitsuden_list_datasets", args), scopes);
    case "kitsuden_describe_collection":
      return kitsudenDescribeCollection(validateArgs("kitsuden_describe_collection", args), scopes);
    case "kitsuden_system_status":
      return kitsudenSystemStatus();
    case "kitsuden_query_collection":
      return kitsudenQueryCollection(validateArgs("kitsuden_query_collection", args), scopes);
    case "kitsuden_create_record":
      return kitsudenCreateRecord(validateArgs("kitsuden_create_record", args), callbacks, scopes);
    case "kitsuden_update_record":
      return kitsudenUpdateRecord(validateArgs("kitsuden_update_record", args), callbacks, scopes);
    case "kitsuden_delete_record":
      return kitsudenDeleteRecord(validateArgs("kitsuden_delete_record", args), callbacks, scopes);
    case "kitsuden_query_dataset":
      return kitsudenQueryDataset(validateArgs("kitsuden_query_dataset", args), scopes);
    case "kitsuden_insert_record":
      return kitsudenInsertRecord(validateArgs("kitsuden_insert_record", args), callbacks, scopes);
    case "kitsuden_create_dataset":
      return kitsudenCreateDataset(validateArgs("kitsuden_create_dataset", args), callbacks);
    case "kitsuden_install_kon":
      return kitsudenInstallKon(validateArgs("kitsuden_install_kon", args), callbacks);
    case "kitsuden_define_action":
      return kitsudenDefineAction(validateArgs("kitsuden_define_action", args));
    case "kitsuden_enable_auth":
      return kitsudenEnableAuth(validateArgs("kitsuden_enable_auth", args));
    case "kitsuden_dispatch_worker":
      return kitsudenDispatchWorker(validateArgs("kitsuden_dispatch_worker", args));
    case "kitsuden_generate_frontend_hook":
      return kitsudenGenerateFrontendHook(validateArgs("kitsuden_generate_frontend_hook", args));
    default:
      throw new Error(`Unknown hardcoded MCP tool: ${name}`);
  }
}

/**
 * Agent data ledger (lib/ledger.ts): evidence per field. When the call is held,
 * the reviewer sees it next to each field; once written (held and approved, or
 * run at once) it stays with the row (`_provenance.fields`).
 */
const EVIDENCE_PARAMETER = {
  type: "array",
  description:
    "Optional. Evidence for the fields you write: shown to the human reviewer when the call needs approval, and kept with the row once written (also when it runs at once): [{ field: 'data.<key>' or 'status', source: URL or document reference, quote?: excerpt, confidence?: 0-1, retrievedAt?: ISO date }].",
  items: {
    type: "object",
    properties: {
      field: { type: "string" },
      source: { type: "string" },
      quote: { type: "string" },
      confidence: { type: "number" },
      retrievedAt: { type: "string" },
    },
    required: ["field", "source"],
  },
};

const HARD_CODED_TOOLS: LLMTool[] = [
  {
    type: "function",
    function: {
      name: "kitsuden_list_datasets",
      description:
        "List all available datasets with their field schemas. Useful for discovering data structure before querying.",
      parameters: {
        type: "object",
        properties: {
          format: JSON_SCHEMA_FORMAT,
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_describe_collection",
      description:
        "Get the schema (columns/fields) of any collection — dataset or native table. Essential before querying unknown collections.",
      parameters: {
        type: "object",
        properties: {
          collection: {
            type: "string",
            description: "Dataset slug or native table name, e.g. 'blog-posts' or 'games'",
          },
          format: JSON_SCHEMA_FORMAT,
        },
        required: ["collection"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_system_status",
      description:
        "Get full system health: database, queue, realtime, memory, active kons, and GraphQL schema status.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_query_collection",
      description:
        "Query records from ANY collection — dataset or native kon table. Uses the unified /api/items/{collection} endpoint. Respects RLS. Supports search, sort and pagination; the result comes in the shortest lossless format (see 'format').",
      parameters: {
        type: "object",
        properties: {
          collection: {
            type: "string",
            description: "Dataset slug or table name, e.g. 'blog-posts', 'games', 'tasks'",
          },
          limit: { type: "number", default: 50, description: "Max records (max 1000)" },
          offset: { type: "number", default: 0, description: "Pagination offset" },
          search: { type: "string", description: "Full-text search on title/name fields" },
          sort: {
            type: "string",
            description: "Sort field, e.g. 'createdAt' or '-createdAt' for desc",
          },
          where: {
            type: "object",
            description: "JSON filter object, e.g. {status: 'published'}",
          },
          format: JSON_SCHEMA_FORMAT,
          untrusted_wrap: WRAPPER_JSON_SCHEMA,
        },
        required: ["collection"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_create_record",
      description:
        "Insert a new record into ANY collection — dataset or native table. Uses /api/items/{collection}.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Dataset slug or table name" },
          data: { type: "object", description: "Record payload" },
          status: {
            type: "string",
            default: "published",
            description: "Initial status (datasets only)",
          },
          _evidence: EVIDENCE_PARAMETER,
        },
        required: ["collection", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_update_record",
      description:
        "Update a record by ID in ANY collection — dataset or native table. Uses /api/items/{collection}/{id}.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Dataset slug or table name" },
          id: { type: "string", description: "Record UUID or primary key" },
          data: { type: "object", description: "Fields to update" },
          _evidence: EVIDENCE_PARAMETER,
        },
        required: ["collection", "id", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_delete_record",
      description:
        "Delete a record by ID from ANY collection — dataset or native table. Uses /api/items/{collection}/{id}.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Dataset slug or table name" },
          id: { type: "string", description: "Record UUID or primary key" },
        },
        required: ["collection", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_query_dataset",
      description:
        "[Legacy] Query records from a dataset by UUID. Prefer kitsuden_query_collection for new code.",
      parameters: {
        type: "object",
        properties: {
          datasetId: { type: "string", description: "UUID of the dataset" },
          limit: { type: "number", default: 50, description: "Max records (max 100)" },
          offset: { type: "number", default: 0, description: "Pagination offset" },
          status: {
            type: "string",
            enum: ["draft", "published", "archived"],
            description: "Filter by status",
          },
          format: JSON_SCHEMA_FORMAT,
          untrusted_wrap: WRAPPER_JSON_SCHEMA,
        },
        required: ["datasetId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_insert_record",
      description:
        "[Legacy] Insert a record into a dataset by UUID. Prefer kitsuden_create_record for new code.",
      parameters: {
        type: "object",
        properties: {
          datasetId: { type: "string", description: "UUID of the dataset" },
          data: { type: "object", description: "Record data matching dataset schema" },
          status: { type: "string", enum: ["draft", "published", "archived"], default: "draft" },
        },
        required: ["datasetId", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_create_dataset",
      description:
        "Create a new JSONB dataset with a defined schema. This is the primary way to store custom user-defined data when no kon exists for the use case.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name of the dataset" },
          slug: { type: "string", description: "URL-friendly identifier" },
          fields: { type: "array", description: "Schema fields", items: { type: "object" } },
          rlsEnabled: {
            type: "boolean",
            default: true,
            description: "Enable row-level security",
          },
          description: { type: "string", description: "Optional description" },
        },
        required: ["name", "slug", "fields"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_install_kon",
      description:
        "Install a kon (domain module). Registers it in the database, runs SQL migrations if found locally, and enables it in the module registry.",
      parameters: {
        type: "object",
        properties: {
          konId: { type: "string", description: "e.g. kon-crm" },
          source: {
            type: "string",
            enum: ["local", "npm", "marketplace"],
            default: "npm",
            description: "Installation source",
          },
          autoEnable: {
            type: "boolean",
            default: true,
            description: "Enable immediately in modules table",
          },
        },
        required: ["konId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_define_action",
      description:
        "Create a unified action (code, webhook, or agent trigger) that runs automation in response to events.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          type: { type: "string", enum: ["code", "webhook_out", "webhook_in", "agent"] },
          trigger: { type: "string", enum: ["manual", "cron", "event", "http"] },
          triggerConfig: {
            type: "object",
            description: "e.g. {cronExpression, eventName, httpPath}",
          },
          config: { type: "object", description: "e.g. {code, url, method}" },
        },
        required: ["name", "slug", "type", "trigger"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_enable_auth",
      description:
        "Configure authentication methods for the project. Updates the site settings to reflect enabled auth providers.",
      parameters: {
        type: "object",
        properties: {
          methods: {
            type: "array",
            items: { type: "string" },
            description: "Auth providers: email, google, github, microsoft",
          },
          requireEmailVerification: { type: "boolean", default: true },
        },
        required: ["methods"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_dispatch_worker",
      description: "Enqueue an async background email job. Only the 'email' queue exists today.",
      parameters: {
        type: "object",
        properties: {
          // It used to say "email, webhooks". The webhooks one does not exist: the handler
          // answers `Unknown queue`. Announcing a queue that does not exist only makes
          // the model try it and fail.
          queueName: { type: "string", enum: ["email"], description: "Queue name" },
          jobName: { type: "string", description: "Job handler name, e.g. system.welcome" },
          payload: {
            type: "object",
            description: "Email payload: {to, subject, html, text?}",
            properties: {
              to: { type: "string" },
              subject: { type: "string" },
              html: { type: "string" },
              text: { type: "string" },
            },
            required: ["to", "subject", "html"],
          },
        },
        required: ["queueName", "jobName", "payload"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kitsuden_generate_frontend_hook",
      description:
        "Generate complete, strongly-typed frontend code (React hooks, Vue composables, Svelte stores, components, forms, types) for any collection. Uses the real codegen engine.",
      parameters: {
        type: "object",
        properties: {
          collection: {
            type: "string",
            description: "Dataset slug or table name, e.g. 'blog-posts' or 'games'",
          },
          framework: { type: "string", enum: ["react", "vue", "svelte"], default: "react" },
          type: {
            type: "string",
            enum: ["hook", "component", "form", "types", "all"],
            default: "all",
          },
        },
        required: ["collection"],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function kitsudenListDatasets(
  args: ArgsOf<"kitsuden_list_datasets">,
  scopes: string[]
): Promise<string> {
  const format = (args.format as RequestedFormat) || "auto";
  const allDatasets = (await bd().select().from(dataSets).orderBy(dataSets.name)).filter((ds) =>
    veDataset(scopes, ds)
  );
  const mapped = allDatasets.map((ds: any) => ({
    id: ds.id,
    name: ds.name,
    slug: ds.slug,
    description: ds.description,
    fields:
      schemaFields(ds.schema)
        .map((f: any) => `${f.key ?? f.name}:${f.type}${f.required ? "*" : ""}`)
        .join(", ") || "none",
  }));
  return outputValue(mapped, format, "kitsuden_list_datasets");
}

async function kitsudenDescribeCollection(
  args: ArgsOf<"kitsuden_describe_collection">,
  scopes: string[]
): Promise<string> {
  const collection = args.collection as string;
  const format = (args.format as RequestedFormat) || "auto";

  const [ds] = await bd().select().from(dataSets).where(eq(dataSets.slug, collection)).limit(1);
  if (ds) {
    requireDataset("kitsuden_describe_collection", scopes, ds);
    const output = {
      type: "dataset",
      id: ds.id,
      name: ds.name,
      slug: ds.slug,
      schema: ds.schema,
      policyJson: ds.policyJson,
    };
    return outputValue(output, format, "kitsuden_describe_collection");
  }

  const table = allowedNativeTable("kitsuden_describe_collection", scopes, collection, "schema");
  if (!table) {
    return `Collection not found: ${collection}`;
  }

  const columns =
    tableColumns(table) ??
    Object.entries(tableColumns(table) || {}).map(([name, col]: [string, any]) => ({
      name: col.name || name,
      type: col.dataType || col.columnType || "string",
      notNull: !!col.notNull,
      primary: !!col.primary,
    }));

  const output = { type: "native_table", name: collection, columns };
  return outputValue(output, format, "kitsuden_describe_collection");
}

async function kitsudenSystemStatus(): Promise<string> {
  try {
    const [{ count: datasetCount }] = await bd()
      .select({ count: sql`COUNT(*)` })
      .from(dataSets);
    const [{ count: entryCount }] = await bd()
      .select({ count: sql`COUNT(*)` })
      .from(dataEntries);
    const [{ count: konCount }] = await bd()
      .select({ count: sql`COUNT(*)` })
      .from(installedKons);
    const [{ count: actionCount }] = await bd()
      .select({ count: sql`COUNT(*)` })
      .from(actions);

    const status = {
      database: "connected",
      datasets: Number(datasetCount),
      entries: Number(entryCount),
      installedKons: Number(konCount),
      actions: Number(actionCount),
      activeModules: KON_REGISTRY.length,
      memory: {
        used: process.memoryUsage().heapUsed,
        total: process.memoryUsage().heapTotal,
      },
      uptime: process.uptime(),
    };
    return JSON.stringify(status);
  } catch (err: unknown) {
    return `System status failed: ${messageOf(err)}`;
  }
}

/**
 * Sanitizes a key for JSONB access.
 * Only allows alphanumeric identifiers with underscores and hyphens.
 */
function sanitizeJsonbKey(key: string): string | null {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) return null;
  return key;
}

/**
 * Looks up a schema table by name, case-insensitively.
 *
 * It was written FIVE times, identical, each with its `(mergedSchema as any)`
 * and its own null check. Five copies of a lookup by name is
 * how they end up diverging: it is enough that one adds an alias or normalizes differently.
 *
 * The name is chosen by an LLM, so resolution has to be by
 * matching against the schema's REAL keys and never by concatenation:
 * this way an invented name returns `null` instead of building a reference.
 */
/**
 * Accessors to the internals of a Drizzle table resolved at runtime.
 *
 * Drizzle stores its metadata in internal symbols and its public type does not
 * expose columns by index, so an `any` is needed here. The
 * difference from before is that there is now ONE, justified and in one place, instead
 * of six scattered around the file: if Drizzle changes these symbols, it gets fixed
 * here and no hunting is needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the block above
const guts = (table: PgTable): any => table as any;

/** The table's real name in the database. */
function tableNameValue(table: PgTable): string {
  return String(guts(table)[Symbol.for("drizzle:Name")] ?? "");
}

/** Column metadata, from the internal symbol or the `columns` object. */
function tableColumns(table: PgTable): unknown {
  const t = guts(table);
  return t[Symbol.for("drizzle:Columns")] ?? t.columns ?? {};
}

/**
 * `id` column. THROWS if it does not exist instead of returning `undefined`, which is
 * what happened before: an `eq(undefined, value)` produces broken SQL or, worse, a
 * condition that filters nothing in an UPDATE.
 */
function columnId(table: PgTable, operation: string): unknown {
  const col = guts(table).id;
  if (!col) throw new Error(`${operation}: the collection has no column 'id'`);
  return col;
}

function schemaTable(name: unknown): PgTable | null {
  if (typeof name !== "string" || name === "") return null;
  const key = Object.keys(mergedSchema).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const table = (mergedSchema as Record<string, unknown>)[key];
  // The merged schema also brings enums and relations; only tables are valid.
  return table && typeof table === "object" ? (table as PgTable) : null;
}

/**
 * ── NATIVE TABLES OVER MCP (security audit) ───────────────────────────────
 *
 * The collection tools fell through to ANY table of the merged schema
 * —`auth_users`, `auth_verifications`, `agent_identities`…— with only
 * `mcp:read`/`mcp:write`, and `/api/mcp` does not run inside the RLS transaction.
 * With the read-only preset an agent read a password-reset token
 * (better-auth stores it in plaintext) and took over the admin's account; with
 * `mcp:write` it wrote `scopes: ["admin"]` into its own row.
 *
 * Now:
 *   · READING or WRITING data of a native table requires the `admin` scope (the
 *     same as `/api/items` over REST). A normal agent works with datasets.
 *   · The tables in `FORBIDDEN_TABLES` (credentials, sessions, keys,
 *     secrets) are not touched over MCP with any scope, not even to describe them.
 *   · Those in `TABLES_WITHOUT_MCP_WRITE` can be read (with `admin`) but
 *     never written through here: they are the ones that grant or remove power from an agent or
 *     a person, and they are changed from their own screen, with its audit.
 *   · What is returned goes through `withoutSecretColumns`.
 */
const SCOPE_NATIVE_TABLES = "admin";

const TABLES_WITHOUT_MCP_WRITE = new Set([
  ...ADMIN_WRITE_TABLES,
  "agent_identities",
  "agent_proposals",
  "agent_proposal_files",
  "agent_audit_logs",
  "approval_settings",
  "actions",
  "data_sources",
  // The actions' code and its history, only through promotion.
  ...TABLES_ONLY_VIA_THEIR_ROUTE,
]);

// The same rule as GraphQL, inline relations and per-table queries: one place.
const forbiddenByMcp = isForbiddenNativeTable;

/**
 * The native table this tool can use, or throws. `usage`:
 *   schema  describe it (columns): the tool's scope is enough;
 *   read    its rows: also `admin`;
 *   write   also `admin` and it must not be in `TABLES_WITHOUT_MCP_WRITE`.
 */
function allowedNativeTable(
  toolName: string,
  scopes: string[],
  collection: unknown,
  usage: "schema" | "read" | "write"
): PgTable | null {
  const table = schemaTable(collection);
  if (!table) return null;
  const name = tableNameValue(table);
  if (forbiddenByMcp(name)) return null;
  assertToolScope(toolName, scopes);
  if (usage !== "schema" && !hasToolScope(scopes, SCOPE_NATIVE_TABLES)) {
    throw new Error(
      `Tool '${toolName}' on the native table '${name}' requires the '${SCOPE_NATIVE_TABLES}' scope. Agents work with datasets: use kitsuden_list_datasets.`
    );
  }
  if (usage === "write" && TABLES_WITHOUT_MCP_WRITE.has(name)) {
    throw new Error(`'${name}' cannot be written over MCP; use its admin screen.`);
  }
  return table;
}

async function kitsudenQueryCollection(
  args: ArgsOf<"kitsuden_query_collection">,
  scopes: string[]
): Promise<string> {
  const {
    collection,
    limit = 50,
    offset = 0,
    search,
    sort,
    where,
    format = "auto",
    untrusted_wrap,
  } = args;

  if (!collection) return "Missing: collection";

  const [ds] = await bd().select().from(dataSets).where(eq(dataSets.slug, collection)).limit(1);
  let results: any[];

  if (ds) {
    requireDataset("kitsuden_query_collection", scopes, ds);
    // The policy's `rlsRules`, as in REST, and without other people's drafts.
    const conditions = [
      whereVisibleToAgent(ds.id, ds) ?? eq(dataEntries.dataSetId, ds.id),
      readableRows(scopes),
    ];
    if (where && typeof where === "object") {
      for (const [k, v] of Object.entries(where)) {
        const safeKey = sanitizeJsonbKey(k);
        if (!safeKey) continue;
        conditions.push(sql`data->>${safeKey} = ${String(v)}`);
      }
    }
    results = await bd()
      .select()
      .from(dataEntries)
      .where(and(...conditions))
      .limit(Math.min(Number(limit) || 50, 1000))
      .offset(Number(offset) || 0);
  } else {
    const table = allowedNativeTable("kitsuden_query_collection", scopes, collection, "read");
    if (!table) return `Collection not found: ${collection}`;
    results = withoutSecretColumns(
      await bd()
        .select()
        .from(table)
        .limit(Math.min(Number(limit) || 50, 1000))
        .offset(Number(offset) || 0)
    ) as any[];
  }

  return outputValue(
    await withProvenance(results, untrusted_wrap, ds ? "dataset_entry" : `table:${collection}`),
    format,
    "kitsuden_query_collection"
  );
}

async function kitsudenCreateRecord(
  args: ArgsOf<"kitsuden_create_record">,
  callbacks: MCPExecutionCallbacks | undefined,
  scopes: string[]
): Promise<string> {
  const { collection, data, status = "published" } = args;
  if (!collection || !data) return "Missing: collection, data";

  const [ds] = await bd().select().from(dataSets).where(eq(dataSets.slug, collection)).limit(1);
  if (ds) {
    requireDataset("kitsuden_create_record", scopes, ds);
    // The owner is the agent's human SIGNER; `created_by_id`, the agent.
    const owner = inputOwner(data?.ownerId);
    const [record] = await bd()
      .insert(dataEntries)
      .values({
        dataSetId: ds.id,
        title: data?.title || data?.name || "Untitled",
        data: { ...(data || {}), ownerId: owner },
        status,
        ownerId: owner,
        createdById: actor().id || null,
      } as any)
      .returning();
    await callbacks?.onMutate?.();
    return `Created dataset record: ${record.id}`;
  }

  const table = allowedNativeTable("kitsuden_create_record", scopes, collection, "write");
  if (!table) return `Collection not found: ${collection}`;

  const result = (await bd()
    .insert(table as any)
    .values(data)
    .returning()) as any[];
  await callbacks?.onMutate?.();
  return `Created native record: ${result[0]?.id}`;
}

async function kitsudenUpdateRecord(
  args: ArgsOf<"kitsuden_update_record">,
  callbacks: MCPExecutionCallbacks | undefined,
  scopes: string[]
): Promise<string> {
  // Supports both the {collection, id, data} schema and the legacy {entryId, data, status}
  const legacyEntryId = args.entryId;
  const collection = args.collection;
  const recordId = args.id || legacyEntryId;
  const data = args.data;

  if (!recordId || !data) return "Missing: id (or entryId), data";

  if (legacyEntryId && !collection) {
    // Legacy MCP mode: entryId es un dataEntries.id
    const [existing] = await bd()
      .select()
      .from(dataEntries)
      .where(eq(dataEntries.id, recordId))
      .limit(1);
    if (!existing) return `Record not found: ${recordId}`;
    const ofDataset = await datasetById(existing.dataSetId);
    requireDataset("kitsuden_update_record", scopes, ofDataset);
    if (!(await editableRow(ofDataset, existing.dataSetId, recordId, "write", scopes))) {
      return `Record not found: ${recordId}`;
    }
    const mergedData = { ...(existing.data as any), ...data };
    const updates: Record<string, unknown> = { data: mergedData, updatedAt: new Date() };
    if (args.status) updates.status = args.status;
    const [updated] = await bd()
      .update(dataEntries)
      .set(updates)
      .where(eq(dataEntries.id, recordId))
      .returning();
    await callbacks?.onMutate?.();
    return `Updated dataset record: ${updated.id}`;
  }

  if (!collection) return "Missing: collection";

  const [ds] = await bd().select().from(dataSets).where(eq(dataSets.slug, collection)).limit(1);
  if (ds) {
    requireDataset("kitsuden_update_record", scopes, ds);
    // From THIS dataset: with the id of another dataset's entry, this one's scope
    // cannot be used to write to that one.
    const existing = await editableRow(ds, ds.id, recordId, "write", scopes);
    if (!existing) return `Record not found: ${recordId}`;
    const mergedData = { ...(existing.data as any), ...data };
    const [updated] = await bd()
      .update(dataEntries)
      .set({ data: mergedData, updatedAt: new Date() })
      .where(eq(dataEntries.id, recordId))
      .returning();
    await callbacks?.onMutate?.();
    return `Updated dataset record: ${updated.id}`;
  }

  const table = allowedNativeTable("kitsuden_update_record", scopes, collection, "write");
  if (!table) return `Collection not found: ${collection}`;

  const result = (await bd()
    .update(table)
    .set(data)
    .where(eq(columnId(table, "update_record") as never, recordId))
    .returning()) as Array<{ id?: string }>;
  await callbacks?.onMutate?.();
  return `Updated native record: ${result[0]?.id}`;
}

async function kitsudenDeleteRecord(
  args: ArgsOf<"kitsuden_delete_record">,
  callbacks: MCPExecutionCallbacks | undefined,
  scopes: string[]
): Promise<string> {
  // Supports {collection, id} and legacy {entryId}
  const legacyEntryId = args.entryId;
  const collection = args.collection;
  const recordId = args.id || legacyEntryId;

  if (!recordId) return "Missing: id (or entryId)";

  if (legacyEntryId && !collection) {
    const [existing] = await bd()
      .select({ dataSetId: dataEntries.dataSetId })
      .from(dataEntries)
      .where(eq(dataEntries.id, recordId))
      .limit(1);
    if (!existing) return `Record not found: ${recordId}`;
    const ofDataset = await datasetById(existing.dataSetId);
    requireDataset("kitsuden_delete_record", scopes, ofDataset);
    if (!(await editableRow(ofDataset, existing.dataSetId, recordId, "delete", scopes))) {
      return `Record not found: ${recordId}`;
    }
    const [deleted] = await bd()
      .delete(dataEntries)
      .where(eq(dataEntries.id, recordId))
      .returning({ id: dataEntries.id });
    if (!deleted) return `Record not found: ${recordId}`;
    await callbacks?.onMutate?.();
    return `Deleted dataset record: ${deleted.id}`;
  }

  if (!collection) return "Missing: collection";

  const [ds] = await bd().select().from(dataSets).where(eq(dataSets.slug, collection)).limit(1);
  if (ds) {
    requireDataset("kitsuden_delete_record", scopes, ds);
    if (!(await editableRow(ds, ds.id, recordId, "delete", scopes))) {
      return `Record not found: ${recordId}`;
    }
    const [deleted] = await bd()
      .delete(dataEntries)
      .where(and(eq(dataEntries.id, recordId), eq(dataEntries.dataSetId, ds.id)))
      .returning({ id: dataEntries.id });
    if (!deleted) return `Record not found: ${recordId}`;
    await callbacks?.onMutate?.();
    return `Deleted dataset record: ${deleted.id}`;
  }

  const table = allowedNativeTable("kitsuden_delete_record", scopes, collection, "write");
  if (!table) return `Collection not found: ${collection}`;

  const result = (await bd()
    .delete(table)
    .where(eq(columnId(table, "delete_record") as never, recordId))
    .returning({ id: columnId(table, "delete_record") as never })) as Array<{ id?: string }>;
  await callbacks?.onMutate?.();
  return `Deleted native record: ${result[0]?.id}`;
}

async function kitsudenQueryDataset(
  args: ArgsOf<"kitsuden_query_dataset">,
  scopes: string[]
): Promise<string> {
  const { datasetId, limit = 50, offset = 0, status, format = "auto", untrusted_wrap } = args;
  if (!datasetId) return "Missing: datasetId";

  const [dataset] = await bd().select().from(dataSets).where(eq(dataSets.id, datasetId)).limit(1);
  if (!dataset) return `Dataset not found: ${datasetId}`;
  requireDataset("kitsuden_query_dataset", scopes, dataset);

  // The policy's `rlsRules`, as in REST, and without other people's drafts.
  const conditions = [
    whereVisibleToAgent(datasetId, dataset) ?? eq(dataEntries.dataSetId, datasetId),
    readableRows(scopes),
  ];
  if (status) conditions.push(eq(dataEntries.status, status));

  const results = await bd()
    .select()
    .from(dataEntries)
    .where(and(...conditions))
    .limit(Math.min(Number(limit) || 50, 100))
    .offset(Number(offset) || 0);

  return outputValue(
    await withProvenance(results, untrusted_wrap, "dataset_entry"),
    format,
    "kitsuden_query_dataset"
  );
}

async function kitsudenInsertRecord(
  args: ArgsOf<"kitsuden_insert_record">,
  callbacks: MCPExecutionCallbacks | undefined,
  scopes: string[]
): Promise<string> {
  const { datasetId, data, status = "draft" } = args;
  if (!datasetId || !data) return "Missing: datasetId, data";
  const ds = await datasetById(datasetId);
  if (!ds.slug) return `Dataset not found: ${datasetId}`;
  requireDataset("kitsuden_insert_record", scopes, ds);

  // The owner is the agent's human SIGNER; `created_by_id`, the agent.
  const owner = inputOwner(data?.ownerId);
  const [newRecord] = await bd()
    .insert(dataEntries)
    .values({
      dataSetId: datasetId,
      title: data?.title || "Untitled",
      data: { ...(data || {}), ownerId: owner },
      status,
      ownerId: owner,
      createdById: actor().id || null,
    } as any)
    .returning();

  await callbacks?.onMutate?.();
  return `Record created: ${newRecord.id}`;
}

/** A dataset's slug by id (`""` if it does not exist: then no scope applies). */
/** A dataset's slug and policy by id (empty `slug` if it does not exist). */
async function datasetById(id: string): Promise<DatasetWithPolicy> {
  const [ds] = await bd()
    .select({ slug: dataSets.slug, policyJson: dataSets.policyJson })
    .from(dataSets)
    .where(eq(dataSets.id, id))
    .limit(1);
  return { slug: ds?.slug ?? "", policyJson: ds?.policyJson ?? null };
}

async function kitsudenCreateDataset(
  args: ArgsOf<"kitsuden_create_dataset">,
  callbacks?: MCPExecutionCallbacks
): Promise<string> {
  const { name, slug, fields, rlsEnabled = true, description } = args;
  if (!name || !slug || !fields) return "Missing: name, slug, fields";

  const policyJson = rlsEnabled
    ? {
        enableRLS: true,
        readAccess: "authenticated" as const,
        writeAccess: "authenticated" as const,
        rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
      }
    : undefined;

  const [newDataset] = await bd()
    .insert(dataSets)
    .values({
      name,
      slug,
      description: description || null,
      schema: { fields },
      policyJson,
    } as any)
    .returning();

  await callbacks?.onMutate?.();
  return `Dataset created: ${newDataset.id} (${newDataset.slug})`;
}

async function kitsudenInstallKon(
  args: ArgsOf<"kitsuden_install_kon">,
  callbacks?: MCPExecutionCallbacks
): Promise<string> {
  const { konId, source = "npm" } = args;
  if (!konId) return "Missing: konId";
  if (!["local", "npm", "marketplace"].includes(source))
    return "Invalid source. Must be: local, npm, marketplace";

  await bd()
    .insert(installedKons)
    .values({
      konId,
      name: konId,
      version: "latest",
      source,
      path: `kons/${konId}`,
      enabled: true,
    } as any)
    .returning();

  const [existingModule] = await bd().select().from(modules).where(eq(modules.key, konId)).limit(1);
  if (existingModule) {
    await bd().update(modules).set({ enabled: true }).where(eq(modules.key, konId));
  } else {
    await bd()
      .insert(modules)
      .values({ key: konId, name: konId, enabled: true } as any);
  }

  await callbacks?.onMutate?.();
  return `Kon ${konId} registered. Restart the API to activate.`;
}

async function kitsudenDefineAction(args: ArgsOf<"kitsuden_define_action">): Promise<string> {
  const { name, slug, type, trigger, triggerConfig, config } = args;
  if (!name || !slug || !type || !trigger) return "Missing: name, slug, type, trigger";
  if (!["code", "webhook_out", "webhook_in", "agent"].includes(type)) return "Invalid type";
  if (!["manual", "cron", "event", "http"].includes(trigger)) return "Invalid trigger";
  // An action's code only comes in through promotion_propose.
  if (type === "code" || bringsCode(config)) throw new CodeOutsidePromotion();
  // Only a person decides where an action may send customer data.
  if (changesCustomerDataPolicy({}, config))
    throw new CodeOutsidePromotion(CUSTOMER_DATA_HOSTS_MESSAGE);
  // A webhook_out target is checked when it is saved (and again when it is sent).
  if (type === "webhook_out") {
    const { webhookConfigUrlProblem } = await import("@/lib/actions/handlers/webhook-out-handler");
    const problem = await webhookConfigUrlProblem((config as { url?: unknown } | undefined)?.url);
    if (problem) return problem;
  }
  // An agent does not define an action that makes an agent with MORE
  // permissions act (its `config.agentId` would run with that agent's scopes).
  const agentId = (config as { agentId?: unknown } | undefined)?.agentId;
  if (type === "agent" || agentId !== undefined) {
    const { reasonNotToDefine } = await import("@/lib/actions/handlers/agent-handler");
    const reason = await reasonNotToDefine(agentId, actor().scopes);
    if (reason) throw new ToolPermission(reason);
  }

  const [newAction] = await bd()
    .insert(actions)
    .values({
      name,
      slug,
      type,
      trigger,
      triggerConfig: triggerConfig || {},
      config: config || {},
    } as any)
    .returning();

  // A cron action runs from now on, not after the next restart.
  if (newAction.trigger === "cron") {
    const { refreshCronJob } = await import("@/lib/cron-scheduler");
    refreshCronJob(newAction);
  }

  return `Action created: ${newAction.id} (${newAction.slug})`;
}

async function kitsudenEnableAuth(args: ArgsOf<"kitsuden_enable_auth">): Promise<string> {
  const { methods, requireEmailVerification = true } = args;
  if (!methods || !Array.isArray(methods) || methods.length === 0)
    return "Missing or invalid: methods";

  const [settings] = await bd().select().from(siteSettings).limit(1);
  const branding = (settings?.branding || {}) as Record<string, unknown>;
  const updatedBranding = {
    ...branding,
    authConfig: { methods, requireEmailVerification },
  };

  if (settings) {
    await bd()
      .update(siteSettings)
      .set({ branding: updatedBranding as any })
      .where(eq(siteSettings.id, settings.id));
  } else {
    await bd()
      .insert(siteSettings)
      .values({ branding: updatedBranding } as any);
  }

  return `Auth configured: ${methods.join(", ")}. Restart API to apply OAuth providers.`;
}

async function kitsudenDispatchWorker(args: ArgsOf<"kitsuden_dispatch_worker">): Promise<string> {
  const { queueName, jobName, payload } = args;
  if (!queueName || !jobName || !payload) return "Missing: queueName, jobName, payload";

  if (queueName === "email") {
    // Customer data the engine run read does not go to a third party by email
    // (docs/agents/egress.md); writing to the customer whose address was read is fine.
    const guard = actor().customerData;
    const problem = emailProblem(guard, payload);
    if (problem) {
      guard?.onBlock?.({ channel: "email", decision: "refused", ...problem.block });
      throw new Error(problem.message);
    }
    const job = await emailQueue.add(jobName, payload);
    return `Job dispatched: ${job?.id || "unknown"}`;
  }

  return `Unknown queue: ${queueName}. Available: email`;
}

async function kitsudenGenerateFrontendHook(
  args: ArgsOf<"kitsuden_generate_frontend_hook">
): Promise<string> {
  const { collection, framework = "react", type = "all" } = args;
  if (!collection) return "Missing: collection";
  if (!["react", "vue", "svelte"].includes(framework)) {
    return "Invalid framework. Must be: react, vue, svelte";
  }

  // Resolve collection schema
  const [ds] = await bd().select().from(dataSets).where(eq(dataSets.slug, collection)).limit(1);
  let columns: any[] = [];
  let kind: "dataset" | "native" = "native";
  let primaryKey = "id";

  if (ds) {
    // Its schema is what describe_collection shows: the same dataset check.
    requireDataset("kitsuden_generate_frontend_hook", actor().scopes, ds);
    kind = "dataset";
    columns = ((ds.schema as any)?.fields || []).map((f: any) => ({
      name: f.fieldName || f.name,
      type: f.fieldType || f.type,
      required: !!f.required,
    }));
    columns.unshift(
      { name: "id", type: "uuid", required: true, isPrimaryKey: true },
      { name: "title", type: "text", required: true },
      { name: "createdAt", type: "timestamp", required: true },
      { name: "updatedAt", type: "timestamp", required: true }
    );
  } else {
    const table = allowedNativeTable(
      "kitsuden_generate_frontend_hook",
      actor().scopes,
      collection,
      "schema"
    );
    if (!table) return `Collection not found: ${collection}`;

    const tableName = tableNameValue(table);
    const introspected = await introspectTable(tableName);
    columns =
      introspected?.columns.map((c) => ({
        name: c.name,
        type: c.type,
        required: !c.nullable,
        isPrimaryKey: c.isPrimaryKey,
        isRelation: c.isForeignKey,
      })) || [];
    primaryKey = introspected?.primaryKey[0] || "id";
  }

  const collectionInfo = {
    slug: collection,
    name: collection,
    kind,
    columns,
    primaryKey,
  };

  const genOptions = {
    collection: collectionInfo,
    framework: framework as "react" | "vue" | "svelte",
    type: type as "hook" | "component" | "form" | "types" | "all",
    baseUrl: "",
  };

  let files;
  switch (framework) {
    case "react":
      files = generateReact(genOptions);
      break;
    case "vue":
      files = generateVue(genOptions);
      break;
    case "svelte":
      files = generateSvelte(genOptions);
      break;
    default:
      return "Unsupported framework";
  }

  return files
    .map(
      (f) =>
        `// ════════════════════════════════════════\n// ${f.filename}\n// ════════════════════════════════════════\n\n${f.content}`
    )
    .join("\n\n");
}
