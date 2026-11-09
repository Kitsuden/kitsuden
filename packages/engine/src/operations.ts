/**
 * Kon SDK — the ENGINE: from the operations declaration to a router
 * ============================================================================
 *
 * The contract (types, names, scope resolution) lives in
 * `@kitsuden/shared` (`operations.ts`). Here is what executes it:
 *
 *   defineKonSdk({ id, …, operations })   → a normal `KonDefinition` whose
 *                                           `createRouter` is GENERATED.
 *
 * Each operation is mounted as ONE Hono route:
 *
 *   [requireAuth | optionalAuth]   according to `access` (those from the kon's context:
 *                                  the host decides how authentication works)
 *   → permission                   fine/broad scope ∪ roles ∪ policy, BEFORE
 *                                  reading the body (a 403 does not wait for a 422)
 *   → validation                   params, query and body with zod; extra fields
 *                                  in the body → 422 with `didYouMean`
 *   → handle(input, h)             returns the data (served with
 *                                  `output.status`) or a ready-made Response
 *
 * What this file does NOT do, because the host already does it for EVERY route
 * of a kon and so it is inherited for free: the per-request RLS transaction
 * (`mountKonRls`), idempotency (`Idempotency-Key`), errors in
 * problem+json and request limits.
 *
 * Rules for handlers (docs/kons/README.md, "Rules"):
 *   1. No `Promise.all` over the request's transaction: one
 *      connection, one query at a time. In series, or `ctx.db.background`
 *      for independent reads OUTSIDE the transaction (they run as
 *      the system: public data only).
 *   2. Do not swallow a SQL error inside the transaction: it leaves it aborted
 *      and everything after fails. Whatever may fail and you want to continue
 *      goes in a SAVEPOINT (`ctx.db.instance.transaction(fn)`).
 *   3. Long external calls (fetch, S3, mail) outside the
 *      transaction: before the first query or in `background`.
 */

import {
  KONS_SDK_VERSION,
  checkOperations,
  grantsByScopes,
  operationDenial,
  isRedirect,
  operationIdOf,
  type OperationContext,
  type ValidatedInput,
  type KonContext,
  type KonDefinition,
  type KonOperation,
  type OperationUser,
} from "@kitsuden/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { z, ZodTypeAny } from "zod";

import { can, type AuthzUser } from "./authz";
import { AppError, respondError } from "./errors";
import { flowResponse } from "./flows";
import type { TransactionalConnection, RlsUser } from "./rls-request";
import { withRouteMeta, type RouteValidationMeta } from "./route-meta";
import { searchUnknownFields, similarKey } from "./validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance boundary: each operation brings its own schemas
export type AnyOperation = KonOperation<any, any, any>;

/** What is passed to `defineKonSdk`: a KonDefinition without `createRouter`. */
export type SdkKonDefinition = Omit<KonDefinition, "createRouter" | "operations" | "sdk"> & {
  operations: AnyOperation[] | ((ctx: KonContext) => AnyOperation[]);
  /**
   * Routes the kon has not yet moved to the SDK (migration in parts). They are mounted
   * AFTER the operations and appear in the coverage's legacy list.
   */
  legacyRoutes?: (ctx: KonContext) => Hono;
};

// ── A context that does nothing (to LIST operations without starting up) ────

/**
 * A `KonContext` in which everything is another proxy: it can be destructured and
 * called with no effect. It lets OpenAPI, coverage and tests read
 * the declarations of an `operations(ctx)` factory with no database or host.
 * Handlers are NEVER executed with it.
 */
export function inertCtx(): KonContext {
  const proxyHandler: ProxyHandler<() => void> = {
    get(_t, property) {
      if (property === "then") return undefined; // it is not a promise
      if (property === Symbol.toPrimitive) return () => "[inert ctx]";
      if (property === Symbol.iterator) return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
  };
  const proxy: unknown = new Proxy(() => undefined, proxyHandler);
  return proxy as KonContext;
}

/** The operations of a definition (with the real context or an inert one). */
export function operationsOf(
  def: Pick<KonDefinition, "operations">,
  ctx: KonContext = inertCtx()
): AnyOperation[] {
  const source = def.operations;
  if (!source) return [];
  return typeof source === "function" ? source(ctx) : source;
}

// ── Permission ──────────────────────────────────────────────────────────────

function userOf(c: Context): OperationUser | null {
  return ((c.get as (k: string) => unknown)("user") as OperationUser | undefined) ?? null;
}

/**
 * Does the operation grant access to this user? Union of the `permission` paths
 * (see `OperationPermission` in shared). Without `permission`, yes.
 */
export async function grantsOperation(
  konId: string,
  op: AnyOperation,
  user: OperationUser | null,
  options: { resource?: unknown; action?: string; input?: ValidatedInput } = {}
): Promise<boolean> {
  const permission = op.permission;
  const scopes = Array.isArray(user?.scopes) ? user.scopes : undefined;
  // An agent denial beats everything: scopes, roles and policy.
  if (scopes && operationDenial(scopes, konId, op, options.input, options.resource)) {
    return false;
  }
  if (!permission) return true;
  if (scopes && grantsByScopes(scopes, konId, op, options.input, options.resource).granted) {
    return true;
  }
  if (permission.roles && typeof user?.role === "string" && permission.roles.includes(user.role)) {
    return true;
  }
  if (permission.policy) {
    return can(
      user as AuthzUser | null,
      options.action ?? permission.policy.action,
      options.resource ?? {},
      permission.policy.resource
    );
  }
  return false;
}

/**
 * Denial in the usual shape (`error` is TEXT: the panel, the webs and
 * Inti read it that way); the problem+json middleware adds `code`, `hint`…
 */
class Denied extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string
  ) {
    super(message);
  }
}

function deniedOne(c: Context, err: Denied): Response {
  return c.json(
    { error: err.status === 401 ? "Unauthorized" : "Forbidden", message: err.message },
    err.status
  );
}

function denialReason(konId: string, op: AnyOperation, action?: string): string {
  const pol = op.permission?.policy;
  return pol
    ? `Not authorized for '${action ?? pol.action}' on ${pol.resource}`
    : `Not authorized for '${operationIdOf(konId, op.id)}'`;
}

// ── Validation ──────────────────────────────────────────────────────────────

function formatIssues(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length ? issue.path.join(".") : "_";
    (out[path] ??= []).push(issue.message);
  }
  return out;
}

type Part = "param" | "query" | "json" | "form";

function validatePart(schema: ZodTypeAny, raw: unknown, part: Part, c?: Context): unknown {
  const r = schema.safeParse(raw);
  const strictItem = part === "json" || part === "form";
  const { unknownAll, ignored } = strictItem
    ? searchUnknownFields(schema, raw)
    : { unknownAll: [], ignored: [] };
  // Server-side ones (`id`, `createdAt`…) are ignored and this is stated: a client
  // sends them back when doing GET → PATCH (same as `validateRequest`).
  if (ignored.length > 0) c?.header("X-Kitsuden-Ignored-Fields", ignored.join(", "));
  if (r.success && unknownAll.length === 0) return r.data;

  const fields = r.success ? {} : formatIssues(r.error);
  for (const d of unknownAll) {
    const key = d.path ? `${d.path}.${d.key}` : d.key;
    const suggestion = d.didYouMean ?? similarKey(d.key, d.validKeys);
    (fields[key] ??= []).push(
      `Unknown field «${key}».${suggestion ? ` Did you mean «${suggestion}»?` : ""} Valid fields: ${
        d.validKeys.join(", ") || "(none)"
      }.`
    );
  }
  throw AppError.validation(r.success ? "Unknown fields in the request" : "Validation failed", {
    target: part,
    fields,
    ...(unknownAll.length > 0
      ? {
          unknownKeys: unknownAll,
          hint:
            "Kitsuden rejects fields it does not know instead of ignoring them: " +
            "a misnamed field would be lost without warning.",
        }
      : {}),
  });
}

async function readBody(c: Context, format: "json" | "multipart"): Promise<unknown> {
  if (format === "multipart") return c.req.parseBody({ all: true });
  // As text and not with `json()`: an empty body is `undefined` (the schema
  // decides whether it is optional), not an error. Hono keeps the text: a handler that
  // asks for `c.req.json()` again receives the same body.
  const text = await c.req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw AppError.badRequest("Invalid JSON body");
  }
}

/**
 * Where there is a null character (U+0000), or `null`. Postgres does not store it in
 * `text` (22021) or in `jsonb` (22P05, also in KEYS): without this, such
 * an input reached the query and came out as a 500 (found by
 * Schemathesis). The raw value is inspected, before the schema, so that operations
 * with `validatesHandler` are covered too.
 */
export function pathWithNullCharacter(value: unknown, path = "", depth = 0): string | null {
  if (typeof value === "string") return value.includes("\u0000") ? path || "_" : null;
  if (!value || typeof value !== "object" || depth > 64) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (key.includes("\u0000")) return here;
    const inside = pathWithNullCharacter(child, here, depth + 1);
    if (inside) return inside;
  }
  return null;
}

function rejectNullCharacter(raw: unknown, part: Part): void {
  const path = pathWithNullCharacter(raw);
  if (!path) return;
  throw AppError.validation("Validation failed", {
    target: part,
    fields: { [path]: ["The text cannot contain the null character (U+0000)."] },
  });
}

async function validateInput(c: Context, op: AnyOperation): Promise<ValidatedInput> {
  const e = op.input;
  const input: ValidatedInput = { params: undefined, query: undefined, body: undefined };
  if (!e) return input;
  rejectNullCharacter(c.req.param(), "param");
  rejectNullCharacter(c.req.queries(), "query");
  if (e.params) input.params = validatePart(e.params, c.req.param(), "param");
  if (e.query) input.query = validatePart(e.query, c.req.query(), "query");
  if (e.body) {
    const format = e.format ?? "json";
    const raw = await readBody(c, format);
    if (format === "json") rejectNullCharacter(raw, "json");
    // `validatesHandler`: inherited contract (its own 400); the SDK only publishes it.
    input.body = e.validatesHandler
      ? raw
      : validatePart(e.body, raw, format === "json" ? "json" : "form", c);
  }
  return input;
}

function validationMetadata(op: AnyOperation): RouteValidationMeta[] {
  const list: RouteValidationMeta[] = [];
  if (op.input?.params) list.push({ target: "param", schema: op.input.params });
  if (op.input?.query) list.push({ target: "query", schema: op.input.query });
  if (op.input?.body) {
    list.push({
      target: op.input.format === "multipart" ? "form" : "json",
      schema: op.input.body,
    });
  }
  return list;
}

// ── El router ───────────────────────────────────────────────────────────────

/** Runs an operation on the current request (what each route mounts). */
async function run(
  c: Context,
  konId: string,
  op: AnyOperation,
  ctx: KonContext
): Promise<Response> {
  const user = userOf(c);
  try {
    // Denied for this key: not even the public ones (the denial belongs to
    // the KEY; without it, what is public remains public).
    const denied = Array.isArray(user?.scopes) ? operationDenial(user.scopes, konId, op) : null;
    if (denied) {
      throw new Denied(403, `${denialReason(konId, op)} (denied by '${denied}')`);
    }
    if (op.permission && !op.permission.policy?.inHandler) {
      if (!(await grantsOperation(konId, op, user))) {
        throw new Denied(user ? 403 : 401, user ? denialReason(konId, op) : "Session required");
      }
    }

    const input = await validateInput(c, op);

    const h: OperationContext = {
      c,
      ctx,
      user,
      konId,
      operation: op,
      can: (resource, action) => grantsOperation(konId, op, user, { resource, action, input }),
      authorize: async (resource, action) => {
        if (await grantsOperation(konId, op, user, { resource, action, input })) return;
        throw new Denied(
          user ? 403 : 401,
          user ? denialReason(konId, op, action) : "Session required"
        );
      },
    };

    const result = await op.handle(input as never, h);
    if (result instanceof Response) return result;
    // A flow: each `yield` is an SSE event, each step in
    // its short RLS transaction with whoever asks (flows.ts).
    if (op.output.flow) {
      return flowResponse(c, result, {
        db: (ctx.db?.instance ?? null) as TransactionalConnection | null,
        user: user as RlsUser | null,
        schema: op.output.schema,
        where: `${konId}/${op.id}`,
        onFailure: (err) =>
          ctx.logger?.error?.(
            `[stream] ${konId}/${op.id}: ${String((err as Error)?.message ?? err)}`
          ),
      });
    }
    const status = op.output.status ?? 200;
    if (status === 204) return c.body(null, 204);
    // A redirect needs its `Location`: only the handler knows it.
    if (isRedirect(status))
      throw new Error(`${konId}/${op.id}: a redirect must return the Response (c.redirect)`);
    return c.json(result as never, status);
  } catch (err) {
    if (err instanceof Denied) return deniedOne(c, err);
    if (err instanceof AppError) return respondError(c, err);
    throw err;
  }
}

/**
 * The Hono router of a list of operations. They are registered in the declared
 * order: with overlapping paths (`/:id` and `/categories`) the first
 * one wins, just like with hand-written routes.
 */
export function operationsRouter(
  konId: string,
  operations: readonly AnyOperation[],
  ctx: KonContext
): Hono {
  checkOperations(konId, operations);
  const router = new Hono();
  for (const op of operations) {
    // Marks the request as an SDK operation: the host's `requireAuth`
    // does not apply the "a key is not an account" rule to it (the operation is
    // a declared contract and decides its `permission`; those that declare none,
    // such as a proposal's status, are meant for agents too).
    const before: MiddlewareHandler[] = [
      async (c, next) => {
        (c.set as (k: string, v: unknown) => void)("sdkOperation", true);
        await next();
      },
    ];
    // Those from the kon's context: the host decides how authentication works. A
    // test context may not provide `optionalAuth`: then it is omitted (the
    // host already identifies whoever asks on each request).
    const authentication =
      op.access === "session"
        ? ctx.auth.requireAuth
        : op.access === "optional"
          ? ctx.auth.optionalAuth
          : undefined;
    if (authentication) before.push(authentication);
    else if (op.access === "session") {
      throw new Error(`${konId}/${op.id}: the context does not provide auth.requireAuth`);
    }
    before.push(...(op.before ?? []));

    const routeHandler = withRouteMeta(async (c: Context) => run(c, konId, op, ctx), {
      summary: op.summary,
      description: op.description,
      operationId: operationIdOf(konId, op.id),
      tags: op.tags,
      validation: validationMetadata(op),
      operation: { konId, declaration: op },
    });
    // `on` with a list of handlers: Hono's overloads do not accept
    // spread, so it is called with the general signature.
    (router.on as (method: string, route: string, ...h: MiddlewareHandler[]) => Hono)(
      op.method,
      op.route,
      ...before,
      routeHandler as MiddlewareHandler
    );
  }
  return router;
}

/**
 * Declares a kon with the SDK. Returns a regular `KonDefinition` (the
 * loader mounts it like any modern kon) with `operations` and `sdk`.
 */
export function defineKonSdk(def: SdkKonDefinition): KonDefinition {
  const { legacyRoutes: legacyRoutes, ...rest } = def;
  return {
    ...rest,
    sdk: KONS_SDK_VERSION,
    operations: def.operations,
    createRouter: (ctx: KonContext) => {
      const router = operationsRouter(def.id, operationsOf(def, ctx), ctx);
      if (legacyRoutes) router.route("/", legacyRoutes(ctx));
      return router;
    },
  };
}

// ── What is mounted (read by MCP and coverage) ──────────────────────────────

export interface OperationsKonMounted {
  konId: string;
  /** No trailing slash: `/api/blog`. */
  mountPath: string;
  operations: AnyOperation[];
  router: Hono;
}

const mountedOnes = new Map<string, OperationsKonMounted>();
let version = 0;

/** Called by the kon loader after mounting an SDK kon. */
export function registerMountedOperations(
  konId: string,
  mountPath: string,
  operations: AnyOperation[],
  router: Hono
): void {
  mountedOnes.set(konId, { konId, mountPath: mountPath.replace(/\/+$/, ""), operations, router });
  version++;
}

export function mountedOperations(): OperationsKonMounted[] {
  return [...mountedOnes.values()];
}

/** Changes every time an SDK kon is mounted (to rebuild what is derived). */
export function mountedOperationsVersion(): number {
  return version;
}

// ── From a request to its operation (used by gates and quotas) ──────────────

export interface RouteOperation {
  konId: string;
  mountPath: string;
  op: AnyOperation;
}

let routeIndex: {
  version: number;
  list: { method: string; pattern: RegExp; input: RouteOperation }[];
} | null = null;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePattern(mountPath: string, route: string): RegExp {
  const complete = route === "/" ? mountPath : `${mountPath}${route}`;
  const body = complete
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : escapeRegex(seg)))
    .join("/");
  return new RegExp(`^${body}/?$`);
}

/**
 * Which SDK operation serves `METHOD path`? The first one that matches, in the
 * order in which they were mounted and declared (the same criterion as Hono). `null`
 * if the route is not from an operation (legacy routes, core…).
 */
export function routeOperation(method: string, path: string): RouteOperation | null {
  const version = mountedOperationsVersion();
  if (routeIndex?.version !== version) {
    const list: { method: string; pattern: RegExp; input: RouteOperation }[] = [];
    for (const { konId, mountPath, operations: operations } of mountedOperations()) {
      for (const op of operations) {
        list.push({
          method: op.method,
          pattern: routePattern(mountPath, op.route),
          input: { konId, mountPath, op },
        });
      }
    }
    routeIndex = { version, list };
  }
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const clean = path.replace(/\/{2,}/g, "/");
  for (const r of routeIndex.list) {
    if (r.method === m && r.pattern.test(clean)) return r.input;
  }
  return null;
}

/** For tests. */
export function forgetMountedOperations(): void {
  mountedOnes.clear();
  version++;
}
