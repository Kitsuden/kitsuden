/**
 * Kitsuden — Request-Scoped DI (the real debt versus NestJS)
 * ============================================================================
 *
 * NestJS offers "request-scoped providers": services that live for a single request.
 * In Kitsuden the de facto request-scoped services are the RLS `tx` and the
 * trace context. This formalizes them with AsyncLocalStorage, WITHOUT the weight of
 * decorators or reflection.
 *
 * The big DX + security benefit: `repo(table)` INSIDE a request automatically
 * uses the `tx` from withTransactionalRLS (RLS applied) without you having to
 * pass `{ db: c.get("tx") }` by hand. Outside a request, it uses the global db.
 *
 *   app.get("/posts", async (c) => {
 *     const posts = await repo(blogPosts).all();  // ← already runs under RLS
 *     return c.json(posts);
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";

// The scope is MUTABLE: it is created empty at the start of the request and later
// middlewares (e.g. withTransactionalRLS) enrich it (set tx).
export interface RequestScope {
  /** Active RLS transaction, if withTransactionalRLS set it. */
  tx?: unknown;
  /** Authenticated user of the request (optional). */
  user?: { id?: string; role?: string; scopes?: string[]; keyId?: string } | null;
  /** Correlation with the trace. */
  requestId?: string;
  traceId?: string;
  /** Extensible bag for own request-scoped services. */
  services?: Record<string, unknown>;
}

const als = new AsyncLocalStorage<RequestScope>();

/**
 * Key of `services` where the request's transaction leaves its measurements
 * (queries, ms in the database, rows written). It is read by the "glass box"
 * (glass-box.ts); it lives here to avoid a cycle with rls-request.
 */
export const DB_METRICS_SERVICE = "kitsuden.dbMeasures";

/** Runs `fn` with an active request scope. */
export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return als.run(scope, fn);
}

/** Returns the active scope (or undefined outside a request). */
export function useRequest(): RequestScope | undefined {
  return als.getStore();
}

/** Sets the RLS `tx` in the active scope (called by withTransactionalRLS). */
export function setRequestTx(tx: unknown): void {
  const scope = als.getStore();
  if (scope) scope.tx = tx;
}

/** Clears the scope's `tx` (when closing the transaction). */
export function clearRequestTx(): void {
  const scope = als.getStore();
  if (scope) scope.tx = undefined;
}

/** User of the active request (or null). */
export function useUser(): RequestScope["user"] {
  return als.getStore()?.user ?? null;
}

/**
 * Registers a request-scoped service under a key (Nest's provider pattern,
 * but explicit). It is instantiated once per request via the factory.
 */
export function provideRequestService<T>(key: string, factory: () => T): T {
  const scope = als.getStore();
  if (!scope) return factory(); // outside a request → ephemeral instance
  scope.services ??= {};
  if (!(key in scope.services)) {
    scope.services[key] = factory();
  }
  return scope.services[key] as T;
}

/**
 * Resolves the correct database executor: the RLS `tx` if we are
 * inside a transactional request, or `fallback` (the global db) if not.
 * Used by `repo()` to apply RLS automatically.
 */
export function resolveExecutor<T>(fallback: T): T {
  const scope = als.getStore();
  return (scope?.tx as T) ?? fallback;
}
