/**
 * Kon SDK — the CONTRACT of an operation (version 1)
 * ============================================================================
 *
 * A kon declares its operations ONCE and the core generates from that
 * declaration:
 *
 *   - the REST route (with 422 problem+json validation, authorization by scope and
 *     by the kon's policy, idempotency and per-request RLS inherited);
 *   - the OpenAPI 3.1 operation with real schemas (zod → JSON Schema);
 *   - the MCP tool with the same schemas, which inherits the scopes and the
 *     `allowedTools` list of the agent's session.
 *
 * Only what is CONTRACT and pure lives here (types, names, permission
 * resolution): it is shared by the engine (which mounts the routes), the API (OpenAPI and
 * MCP), the panel (what each scope grants) and the coverage tests. The
 * execution engine lives in `@kitsuden/engine` (`defineKonSdk`).
 *
 * The contract version is published in `GET /api/version` as
 * `contracts["kon-sdk"]` (see `contracts.ts`). Adding an OPTIONAL field to the
 * declaration is compatible; renaming one, changing a default value that
 * changes behavior (e.g. `sensitive`) or the format of a tool name or of a
 * fine scope is NOT.
 *
 * Public guide: docs/kons/README.md.
 */

import type { Context, MiddlewareHandler } from "hono";
import { z, type ZodTypeAny } from "zod";

import { denialThatCovers, splitScopes, scopeCovers } from "./agent-permission";
import { isKitsudenErrorCode, type KitsudenErrorCode } from "./errors";
import type { KonContext } from "./kon-api";

export { scopeCovers };

/** Version of the kon SDK contract (integer: bumped only if something breaks). */
export const KONS_SDK_VERSION = 1;

export type OperationMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who can REACH the operation, before the policy:
 *
 *   public    no credential (the request may carry one and it is used if present).
 *   optional  same as `public`, but the operation looks at who it is (drafts
 *             for the team, for example). Documented that way in OpenAPI.
 *   session   a verified account or agent is required: without one, 401.
 */
export type OperationAccess = "public" | "optional" | "session";

/** The access values used before this format was translated. */
const LEGACY_OPERATION_ACCESS: Record<string, OperationAccess> = {
  public: "public",
  optional: "optional",
  session: "session",
};

/**
 * What is needed, besides reaching it, to execute the operation. It is a UNION:
 * it is enough for ONE of the routes to be satisfied.
 *
 *   1. The operation's fine scope: `kon:<kon>:<operation>` (and its wildcards
 *      `kon:<kon>:*`, `kon:*`), or the kon's broad one `<kon>:*`. Only agents
 *      carry them.
 *   2. One of `scopes` (broad, e.g. `content:edit`), with the usual
 *      wildcard rules (`resource:*`, `*:action`).
 *   3. `admin` / `admin:*`.
 *   4. The kon's policy (`definePolicy`): `can(user, action, resource,
 *      type)`, which also grants the scope `<type>:<action>`.
 *   5. `roles`: the account's role is in the list.
 *
 * A fine scope never TAKES AWAY what a broad one grants (everything is a union). The
 * only thing that takes away is an explicit DENIAL by the agent (`!kon:<kon>:<op>`,
 * `!<kon>:*`, `!datasets:<slug>:<action>`…), which beats everything above,
 * `admin` and roles included (see docs/agents/permissions.md).
 */
export interface OperationPermission {
  /** Broad scopes that also grant the operation. */
  scopes?: string[];
  /** The kon's policy. */
  policy?: {
    resource: string;
    action: string;
    /**
     * `true`: the policy needs the resource (the dataset, the entry…) and the
     * handler checks it with `h.authorize(resource)` after loading it. Without this,
     * it is checked BEFORE validating and executing, with an empty resource.
     */
    inHandler?: boolean;
  };
  /** Account roles that grant it (e.g. `["admin"]`). */
  roles?: string[];
  /**
   * The RESOURCE scope that also grants the operation (and that a
   * denial can take away): `datasets:<slug>:write`. It is computed from the
   * input and, in `policy.inHandler` operations, from the resource the
   * handler passes to `h.authorize(resource)`. Returning `null` = this request has no
   * resource scope.
   */
  resourceScope?: (input: ValidatedInput, resource?: unknown) => string | null;
}

/** How the successful response comes out. */
export interface OperationOutput {
  /**
   * HTTP success status (200 by default; 201 on create, 204 without a body). A
   * redirect (301, 302, 303, 307, 308) carries no body or schema: the
   * handler returns the `Response` with its `Location` (`c.redirect`).
   */
  status?: SuccessStatus | RedirectStatus;
  /** Body schema (for JSON). Required except with binary `type`, 204 or 3xx. */
  schema?: ZodTypeAny;
  /** `application/json` by default; `image/*`, `text/html`… for binary. */
  type?: string;
  description?: string;
  /**
   * Other success statuses with the SAME body, which the handler returns as a
   * ready-made `Response`: an upsert that responds 201 on create and 200 on rewrite.
   * They are only published (OpenAPI); without declaring them, Schemathesis considers the
   * status that is not listed to be broken (kon-tierlist). It can also carry
   * redirects: a read that sends an old slug to the new one with 308.
   */
  otherStatuses?: (200 | 201 | 202 | RedirectStatus)[];
  /**
   * A FLOW: `handle` returns an `AsyncIterable` (the
   * usual case, an `async function*`) and each value it `yield`s goes out as a
   * STANDARD Server-Sent Events event (`text/event-stream`), validated against
   * `schema`, which here is the schema of ONE event. On finishing, an `end` event; if the
   * generator throws, an `error` event with the problem+json. In the SDK the
   * operation returns a typed `AsyncIterable`; over MCP, the list of events.
   *
   * Each step of the generator runs in its own short RLS transaction, with
   * the asker: the flow does not hold a connection while it waits.
   */
  flow?: boolean;
}

export type SuccessStatus = 200 | 201 | 202 | 204;
/** Redirects an operation can declare (they are not errors: they carry no catalog code). */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;
export const REDIRECT_STATUSES: readonly RedirectStatus[] = [301, 302, 303, 307, 308];
export function isRedirect(status: number | undefined): status is RedirectStatus {
  return status !== undefined && (REDIRECT_STATUSES as readonly number[]).includes(status);
}

/** What comes in, in parts. Each part is a zod schema. */
export interface OperationInput {
  /** Path parameters (`:id`). All text; use `z.string()`/`z.coerce`. */
  params?: ZodTypeAny;
  /** Query string. Arrives as text: use `z.coerce.number()` and similar. */
  query?: ZodTypeAny;
  /** Body. JSON by default. */
  body?: ZodTypeAny;
  /** `multipart`: form with files (not exposed over MCP). */
  format?: "json" | "multipart";
  /**
   * Compatibility: the BODY is validated by the handler with this same schema and
   * it responds with its usual 400 (`{ error: "Validation failed", issues }`). The
   * SDK publishes it (OpenAPI, MCP) but does not validate it, and the handler receives the
   * body exactly as it arrived. Only for kons that already had that contract published;
   * a new one lets the SDK validate (422 problem+json).
   */
  validatesHandler?: boolean;
}

/** MCP exposure: yes by default; to exclude you must say why. */
export type OperationMcp =
  | true
  | { exclude: string }
  | {
      /** Tool name if the generated one will not do (rare). */
      name?: string;
    };

/**
 * Arguments of a generated MCP tool: path and query parameters are FLAT,
 * the whole body goes under `body` and the idempotency key
 * under `idempotency_key`. They are contract (an agent stores them).
 */
export const MCP_BODY_ARGUMENT = "body";
export const MCP_IDEMPOTENCY_ARGUMENT = "idempotency_key";

/**
 * Usage guide for agents: what the schema does NOT say. The schema says what
 * shape the input has; this says when to use the operation, where the ids it
 * asks for come from and how to get out of the typical errors.
 *
 * It exists because the agent's harness (Claude, Cursor, whichever) only sees what
 * the server tells it: a good guide here improves ALL the harnesses
 * that connect, without touching any of them. It is published in the MCP
 * tool's description (the short part), as the MCP resource `kitsuden://guide/<tool>`
 * (all of it) and in OpenAPI as `x-kitsuden-guide`.
 *
 * The examples are VALIDATED against the schemas when the operation is declared: an
 * example that does not validate teaches how to fail.
 */
export interface OperationGuide {
  /** When to use it, and when NOT to (which other operation applies then). */
  whenToUse?: string;
  /** What is needed beforehand: which operation each id it asks for comes from. */
  before?: string[];
  /**
   * Example arguments, shaped like the MCP tool: flat path and query
   * parameters, the body under `body`.
   */
  examples?: { title: string; args: Record<string, unknown> }[];
  /** Typical errors and how to get out of them. */
  traps?: { if: string; then: string }[];
}

/** The already validated input the handler receives. */
export interface ValidatedInput<P = unknown, Q = unknown, B = unknown> {
  params: P;
  query: Q;
  body: B;
}

/** User as the operations see them (account or agent). */
export interface OperationUser {
  id?: string;
  role?: string;
  scopes?: string[];
  [key: string]: unknown;
}

/** What the handler receives besides the input. */
export interface OperationContext {
  /**
   * Hono context of the request (headers, `c.json`, `c.body`…). The validated
   * (and typed) parameters are in `input.params`.
   */
  c: Context;
  /** The kon's context (the request's db, cache, events, storage…). */
  ctx: KonContext;
  /** Who is asking (`null` if nobody). */
  user: OperationUser | null;
  /**
   * Checks the operation's permission with the RESOURCE already loaded (for
   * `policy.inHandler`). Throws 401/403 (AppError) if not granted.
   */
  authorize(resource?: unknown, action?: string): Promise<void>;
  /** Same as `authorize` but returns the result instead of throwing. */
  can(resource?: unknown, action?: string): Promise<boolean>;
  konId: string;
  operation: KonOperation;
}

/** The handler's response: the data (served with `output.status`) or a ready-made Response. */
export type OperationResult = unknown;

/**
 * The declaration of an operation.
 *
 * Generics: the input schemas, so the handler receives the inferred
 * types without annotating them by hand.
 */
export interface KonOperation<
  P extends ZodTypeAny = ZodTypeAny,
  Q extends ZodTypeAny = ZodTypeAny,
  B extends ZodTypeAny = ZodTypeAny,
> {
  /** Stable, kebab-case, unique within the kon: `create-page`. It is contract. */
  id: string;
  method: OperationMethod;
  /** Relative to the kon's mount, with `:param`: `/pages/:id`. */
  route: string;
  /** One line for humans (OpenAPI `summary`). */
  summary: string;
  /** For humans and agents: what it does, when to use it, what it returns. */
  description: string;
  tags?: string[];
  input?: {
    params?: P;
    query?: Q;
    body?: B;
    format?: OperationInput["format"];
    validatesHandler?: boolean;
  };
  output: OperationOutput;
  access: OperationAccess;
  /** Without `permission`, `access` is enough. */
  permission?: OperationPermission;
  /**
   * A sensitive operation, requested by an agent, may end up as a
   * PROPOSAL awaiting a human. By default: `true` on DELETE,
   * `false` on everything else. Today it is only published (OpenAPI and MCP).
   */
  sensitive?: boolean;
  /**
   * A POST that changes nothing (validate, preview, compare, calculate):
   * the SELECTIVE retention of agents in `propose` does not hold it, and MCP
   * announces it with `readOnlyHint`. Only valid on POST (a GET already is one; PUT, PATCH
   * and DELETE write by definition). Default: `false`.
   */
  readOnly?: boolean;
  /**
   * Does repeating the same request leave the same state? By default, HTTP
   * semantics: GET/PUT/DELETE yes, POST/PATCH no. Non-idempotent ones accept
   * `Idempotency-Key` (REST) / `idempotency_key` (MCP).
   */
  idempotent?: boolean;
  /**
   * Errors the operation MAY return besides the automatic ones
   * (validation, authentication, permission, internal). Codes from the catalog.
   */
  errors?: KitsudenErrorCode[];
  /** MCP exposure (yes by default). */
  mcp?: OperationMcp;
  /** Usage guide for agents (see `OperationGuide`). Optional. */
  guide?: OperationGuide;
  /**
   * What it costs from the agent's daily budget (`budget_units_per_day`).
   * 1 by default; an expensive operation (export, reindex, generate) declares
   * more. Integer ≥ 0.
   */
  cost?: number;
  /**
   * Middleware that runs after authentication and BEFORE the permission,
   * validation and the handler (e.g. `bodyLimit` on an upload: it has to
   * cut off before the body is read). Escape hatch: normally it is not used.
   */
  before?: MiddlewareHandler[];
  handle(
    input: ValidatedInput<
      P extends ZodTypeAny ? z.output<P> : undefined,
      Q extends ZodTypeAny ? z.output<Q> : undefined,
      B extends ZodTypeAny ? z.output<B> : undefined
    >,
    h: OperationContext
  ): Promise<OperationResult> | OperationResult;
}

// ── Default values (they are contract) ──────────────────────────────────────

export function isSensitive(op: Pick<KonOperation, "method" | "sensitive">): boolean {
  return op.sensitive ?? op.method === "DELETE";
}

/** Changes nothing? GETs, and the POSTs that declare it. */
export function isReadOnly(op: Pick<KonOperation, "method" | "readOnly">): boolean {
  return op.method === "GET" || (op.method === "POST" && op.readOnly === true);
}

/** Budget units it consumes (1 by default). */
export function operationCost(op: Pick<KonOperation, "cost"> | null | undefined): number {
  const c = op?.cost;
  return typeof c === "number" && Number.isInteger(c) && c >= 0 ? c : 1;
}

export function isIdempotent(op: Pick<KonOperation, "method" | "idempotent">): boolean {
  return op.idempotent ?? (op.method === "GET" || op.method === "PUT" || op.method === "DELETE");
}

/** Reason for MCP exclusion, or `null` if it is exposed. */
export function exclusionMcp(op: Pick<KonOperation, "mcp" | "input">): string | null {
  if (op.mcp && typeof op.mcp === "object" && "exclude" in op.mcp) return op.mcp.exclude;
  return null;
}

/** The errors it can return, automatic ones included, without repeats. */
export function operationErrors(
  op: Pick<KonOperation, "access" | "permission" | "input" | "errors"> & {
    method?: OperationMethod;
  }
): KitsudenErrorCode[] {
  const list: KitsudenErrorCode[] = [];
  if (op.input?.params || op.input?.query || op.input?.body) {
    list.push("KITSUDEN_E_VALIDATION");
  }
  // 400: a body that is not JSON, or a value Postgres does not accept (malformed
  // uuid, number out of range) in params, query or body — `toErrorEnvelope`
  // translates it from the SQLSTATE (Schemathesis).
  if (op.input?.params || op.input?.query || op.input?.body) list.push("KITSUDEN_E_BAD_REQUEST");
  // 404: a path parameter names a resource, and it may not exist (or not be
  // visible to the caller). Every such operation can answer it (Schemathesis).
  if (op.input?.params) list.push("KITSUDEN_E_NOT_FOUND");
  if (op.access === "session" || op.permission) list.push("KITSUDEN_E_UNAUTHENTICATED");
  if (op.permission) list.push("KITSUDEN_E_FORBIDDEN");
  // Every non-GET operation announces `Idempotency-Key`; reusing a
  // key with another body responds 422 (idempotency middleware).
  if (op.method && op.method !== "GET") list.push("KITSUDEN_E_IDEMPOTENCY_KEY_REUSED");
  list.push(...(op.errors ?? []));
  // The global limiter (`/api/*`) responds 429 to any operation: without
  // declaring it, an agent does not know it must wait `retry_after` and retry
  // (found by Schemathesis).
  list.push("KITSUDEN_E_RATE_LIMITED");
  list.push("KITSUDEN_E_INTERNAL");
  return [...new Set(list)];
}

// ── Names (they are contract: an agent stores its tool's name) ──────────────

/** `kon-blog` → `blog`. */
export function konShortName(konId: string): string {
  return konId.replace(/^kon-/, "");
}

/** The fine scope of an operation: `kon:blog:create-post`. */
export function operationFineScope(konId: string, operationId: string): string {
  return `kon:${konShortName(konId)}:${operationId}`;
}

/**
 * Name of the MCP tool: `blog__create-post`. Only `[a-z0-9_-]`, as
 * MCP clients require, and at most 64 characters.
 */
export function toolName(konId: string, op: Pick<KonOperation, "id" | "mcp">): string {
  if (op.mcp && typeof op.mcp === "object" && "name" in op.mcp && op.mcp.name) {
    return op.mcp.name;
  }
  return `${konShortName(konId)}__${op.id}`.slice(0, 64);
}

/** The OpenAPI `operationId`: `blog.create-post`. */
export function operationIdOf(konId: string, operationId: string): string {
  return `${konShortName(konId)}.${operationId}`;
}

// ── Permissions: the resolution (prepared for agent permissions) ─────────────────────

/**
 * All the scopes that, on their own, grant the operation (what the agent permissions
 * panel will show as "these grant it: …"). The policy is not here:
 * it is decided with the user and the resource, not with a list.
 */
export function scopesThatGrant(
  konId: string,
  op: Pick<KonOperation, "id" | "permission">
): string[] {
  const shortOne = konShortName(konId);
  const list = [
    operationFineScope(konId, op.id),
    `${shortOne}:*`,
    ...(op.permission?.scopes ?? []),
  ];
  if (op.permission?.policy) {
    list.push(`${op.permission.policy.resource}:${op.permission.policy.action}`);
  }
  list.push("admin");
  return [...new Set(list)];
}

export interface GrantByScope {
  granted: boolean;
  /** The granted scope that opened it (for auditing). */
  by?: string;
  /** The denial that closed it, if there was one. */
  deniedBy?: string;
}

/**
 * What identifies the operation in front of a DENIAL: its fine scope, the
 * per-kon alias (`blog:create-post`, so that `!blog:*` also closes it) and
 * the resource scope if there is one.
 */
export function operationIdentities(
  konId: string,
  op: Pick<KonOperation, "id" | "permission">,
  input?: ValidatedInput,
  resource?: unknown
): string[] {
  const list = [operationFineScope(konId, op.id), `${konShortName(konId)}:${op.id}`];
  const ofResource = input ? op.permission?.resourceScope?.(input, resource) : null;
  if (ofResource) list.push(ofResource);
  return list;
}

/** The agent's denial that closes this operation, or `null`. */
export function operationDenial(
  grantedItems: readonly string[] | undefined,
  konId: string,
  op: Pick<KonOperation, "id" | "permission">,
  input?: ValidatedInput,
  resource?: unknown
): string | null {
  return denialThatCovers(grantedItems, operationIdentities(konId, op, input, resource));
}

/**
 * Do the agent's scopes open this operation? UNION: one is enough.
 *
 *   · `admin`, `admin:*`
 *   · the fine `kon:<kon>:<op>` and its wildcards (`kon:<kon>:*`, `kon:*`)
 *   · the kon's broad `<kon>:*`
 *   · the broad ones declared in `permission.scopes` (with wildcards)
 *   · the resource one returned by `permission.resourceScope(input, resource)`
 *
 * …unless a DENIAL by the agent covers the operation (its fine one, its alias
 * `<kon>:<op>` or its resource scope): then no, even if it carries `admin`.
 *
 * The POLICY scope (`<type>:<action>`) is granted by `can()` in the engine,
 * not by this: that way it is evaluated once and with the resource.
 */
export function grantsByScopes(
  grantedItems: readonly string[] | undefined,
  konId: string,
  op: Pick<KonOperation, "id" | "permission">,
  input?: ValidatedInput,
  resource?: unknown
): GrantByScope {
  if (!grantedItems || grantedItems.length === 0) return { granted: false };
  const deniedBy = operationDenial(grantedItems, konId, op, input, resource);
  if (deniedBy) return { granted: false, deniedBy };
  const requiredValues = [operationFineScope(konId, op.id), ...(op.permission?.scopes ?? [])];
  const ofResource = input && op.permission?.resourceScope?.(input, resource);
  if (ofResource) requiredValues.push(ofResource);
  const { grants } = splitScopes(grantedItems);
  for (const granted of grants) {
    if (granted === "admin" || granted === "admin:*") return { granted: true, by: granted };
    // `crm:*` grants the whole CRM kon (the "broad per kon").
    if (granted === `${konShortName(konId)}:*`) return { granted: true, by: granted };
    if (requiredValues.some((r) => scopeCovers(granted, r))) return { granted: true, by: granted };
  }
  return { granted: false };
}

/** The scope (without denials) that would open the operation, to show it. */
export function whyGranted(
  grantedItems: readonly string[] | undefined,
  konId: string,
  op: Pick<KonOperation, "id" | "permission">
): string | null {
  const r = grantsByScopes(grantedItems, konId, op);
  return r.granted ? (r.by ?? null) : null;
}

// ── Declaring ───────────────────────────────────────────────────────────────

const VALID_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Declares an operation. At definition time it checks what would later be a silent
 * failure: well-formed id, relative path, catalog errors, MCP
 * exclusion with a reason, JSON output with a schema.
 */
export function defineOperation<
  P extends ZodTypeAny = ZodTypeAny,
  Q extends ZodTypeAny = ZodTypeAny,
  B extends ZodTypeAny = ZodTypeAny,
>(declared: KonOperation<P, Q, B>): KonOperation<P, Q, B> {
  // Kons not migrated yet may still say `public`, `optional` or `session`.
  const op = { ...declared, access: LEGACY_OPERATION_ACCESS[declared.access] ?? declared.access };
  const where = `operation '${op.id}'`;
  if (!VALID_ID.test(op.id)) throw new Error(`${where}: the id must be kebab-case ([a-z0-9-])`);
  if (!op.route.startsWith("/")) throw new Error(`${where}: the path starts with '/'`);
  if (!op.summary?.trim() || !op.description?.trim()) {
    throw new Error(
      `${where}: a summary and description are required (humans and agents read them)`
    );
  }
  for (const code of op.errors ?? []) {
    if (!isKitsudenErrorCode(code)) throw new Error(`${where}: '${code}' is not in the catalog`);
  }
  const reason = exclusionMcp(op);
  if (reason !== null && !reason.trim()) {
    throw new Error(`${where}: excluding from MCP requires a reason`);
  }
  if (op.cost !== undefined && !(Number.isInteger(op.cost) && op.cost >= 0)) {
    throw new Error(`${where}: the cost is an integer ≥ 0`);
  }
  if (op.readOnly !== undefined && op.method !== "POST") {
    throw new Error(
      `${where}: readOnly only applies to POST (a GET already is one; ${op.method} writes)`
    );
  }
  if (op.readOnly && (op.sensitive || op.input?.format === "multipart")) {
    throw new Error(`${where}: a readOnly operation cannot be sensitive or receive files`);
  }
  if (op.output.flow) {
    if (!op.output.schema) throw new Error(`${where}: a flow needs the schema of each event`);
    if ((op.output.status ?? 200) !== 200 || op.output.otherStatuses?.length) {
      throw new Error(`${where}: a flow responds 200 (the events go inside)`);
    }
    if (op.output.type && op.output.type !== "text/event-stream") {
      throw new Error(`${where}: a flow is served as text/event-stream`);
    }
    if (op.method !== "GET" && op.method !== "POST") {
      throw new Error(`${where}: a flow is GET or POST`);
    }
  }
  const type = op.output.type ?? "application/json";
  const redirects = isRedirect(op.output.status);
  if (redirects && op.output.schema) {
    throw new Error(`${where}: a redirect has no body; remove output.schema`);
  }
  if (type.includes("json") && op.output.status !== 204 && !redirects && !op.output.schema) {
    throw new Error(`${where}: a JSON output needs its schema`);
  }
  for (const other of op.output.otherStatuses ?? []) {
    if (
      (![200, 201, 202].includes(other) && !isRedirect(other)) ||
      other === (op.output.status ?? 200)
    ) {
      throw new Error(
        `${where}: otherStatuses carries success statuses with a body (200, 201, 202) or redirects (3xx) different from output.status`
      );
    }
    if (op.output.status === 204 && !isRedirect(other)) {
      throw new Error(`${where}: otherStatuses share the output body; with 204 there is none`);
    }
  }
  if (op.input?.format === "multipart" && reason === null) {
    throw new Error(
      `${where}: a multipart body cannot be requested over MCP; exclude the operation with a reason`
    );
  }
  checkGuide(op, where);
  return op;
}

/** The `:param`s of a path, in order. */
export function routeParameters(route: string): string[] {
  return [...route.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
}

function firstFailure(schema: ZodTypeAny, value: unknown): string | null {
  const r = schema.safeParse(value);
  if (r.success) return null;
  const i = r.error.issues[0];
  return i ? `${i.path.join(".") || "(root)"}: ${i.message}` : "does not validate";
}

/**
 * The guide has to tell the truth: non-empty texts and every example valid
 * against the operation's schemas (path, query and body separately).
 */
function checkGuide(
  op: Pick<KonOperation, "guide" | "route" | "input" | "method" | "idempotent">,
  where: string
): void {
  const g = op.guide;
  if (!g) return;
  if (g.whenToUse !== undefined && !g.whenToUse.trim()) {
    throw new Error(`${where}: guide.whenToUse is empty`);
  }
  for (const t of g.traps ?? []) {
    if (!t.if.trim() || !t.then.trim()) throw new Error(`${where}: a guide pitfall is empty`);
  }
  const ofThePath = routeParameters(op.route);
  for (const ej of g.examples ?? []) {
    const de = `${where}: example «${ej.title}»`;
    const params: Record<string, unknown> = {};
    const query: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ej.args)) {
      if (key === MCP_BODY_ARGUMENT || key === MCP_IDEMPOTENCY_ARGUMENT) continue;
      if (ofThePath.includes(key)) params[key] = value;
      else query[key] = value;
    }
    for (const p of ofThePath) {
      if (params[p] === undefined) throw new Error(`${de}: missing '${p}' (path parameter)`);
    }
    if (Object.keys(query).length > 0 && !op.input?.query) {
      throw new Error(
        `${de}: the operation has no query and the example carries ${Object.keys(query).join(", ")}`
      );
    }
    if (MCP_BODY_ARGUMENT in ej.args && !op.input?.body) {
      throw new Error(`${de}: the operation has no body`);
    }
    if (MCP_IDEMPOTENCY_ARGUMENT in ej.args && isIdempotent(op)) {
      throw new Error(
        `${de}: the operation is already idempotent; remove ${MCP_IDEMPOTENCY_ARGUMENT}`
      );
    }
    const failures = [
      op.input?.params ? firstFailure(op.input.params, params) : null,
      op.input?.query ? firstFailure(op.input.query, query) : null,
      op.input?.body && MCP_BODY_ARGUMENT in ej.args
        ? firstFailure(op.input.body, ej.args[MCP_BODY_ARGUMENT])
        : null,
    ].filter(Boolean);
    if (failures.length > 0) throw new Error(`${de} does not validate: ${failures.join("; ")}`);
  }
}

/**
 * The short part of the guide, for the MCP tool's DESCRIPTION: it is the only thing
 * that all harnesses reliably show the model. The examples and
 * pitfalls go in the resource (they do not inflate `tools/list`).
 */
export function shortGuide(op: Pick<KonOperation, "guide">): string | null {
  const g = op.guide;
  if (!g) return null;
  const parts = [
    g.whenToUse ? `When to use: ${g.whenToUse}` : null,
    g.before?.length ? `Before: ${g.before.join("; ")}` : null,
    g.examples?.length || g.traps?.length
      ? "Examples and common mistakes: read the guide resource."
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Does `before` handle everything `after` would? Hono resolves in
 * registration order: `GET /:id` registered before `GET /categories` ends up with
 * "categories" as the id and the second one never runs, with no error.
 */
function overshadows(
  before: Pick<KonOperation, "method" | "route">,
  after: Pick<KonOperation, "method" | "route">
): boolean {
  if (before.method !== after.method) return false;
  const a = before.route.split("/").filter(Boolean);
  const b = after.route.split("/").filter(Boolean);
  if (a.length !== b.length || before.route === after.route) return false;
  let looser = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i]!.startsWith(":") && !b[i]!.startsWith(":")) {
      looser = true;
      continue;
    }
    return false;
  }
  return looser;
}

/**
 * Checks a kon's list of operations: no repeated ids or paths, and
 * no path shadowed by an earlier one (see `overshadows`). It throws when mounting the
 * kon, which is when it can still be fixed.
 */
export function checkOperations(konId: string, ops: readonly KonOperation[]): void {
  const ids = new Set<string>();
  const routes = new Set<string>();
  ops.forEach((op, i) => {
    const shadowing = ops.slice(0, i).find((previous) => overshadows(previous, op));
    if (shadowing) {
      throw new Error(
        `${konId}: ${op.method} ${op.route} is unreachable: ${shadowing.route} was declared earlier. Declare literal paths first.`
      );
    }
  });
  for (const op of ops) {
    if (ids.has(op.id)) throw new Error(`${konId}: operation '${op.id}' repeated`);
    ids.add(op.id);
    const key = `${op.method} ${op.route.replace(/:[^/]+/g, ":p")}`;
    if (routes.has(key)) throw new Error(`${konId}: two operations on ${op.method} ${op.route}`);
    routes.add(key);
  }
}

// ── Helper schemas ──────────────────────────────────────────────────────────

/**
 * A date in the INPUT: ISO 8601 text (what JSON sends) or `Date`, and the
 * handler always receives a `Date`. It exists because text that reached a Drizzle
 * `timestamp` column as is blew up with
 * `value.toISOString is not a function` (blog PATCH).
 */
export function dateSchema() {
  return z
    .union([
      z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date (ISO 8601)" }),
      z.date(),
    ])
    .transform((v) => (v instanceof Date ? v : new Date(v)));
}

/** A uuid `:id` in the parameters. */
export const uuidSchema = () => z.guid();
