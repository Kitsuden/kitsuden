/**
 * One instance per PROCESS of the engine's request state
 * ============================================================================
 *
 * In production the API runs as a bundle (`bun build src/index.ts` → `dist/index.js`)
 * that carries its OWN copy of this engine, while the kons are loaded at runtime from
 * their sources and import `@kitsuden/engine`: a second copy. Each copy had its own
 * `AsyncLocalStorage` and `WeakMap`s, so what the core published for the request
 * (the RLS transaction, its user context) was invisible to the kon's copy.
 *
 * The visible symptom (2026-11-27): `PUT /api/builder/definitions` answered 500.
 * `repo()` from the kon recorded the change history with `asSystem()` from ITS copy,
 * which saw no request and did nothing; the INSERT into `record_changes` ran with the
 * user's context, RLS refused it, and with no savepoint the whole request was undone.
 * In the tests (sources, one copy) it never failed.
 *
 * `route-meta.ts` already solved the same thing for route metadata with `Symbol.for`.
 * This does it for the request state: whichever copy asks first creates it, and the
 * other finds it.
 */
export function sharedState<T>(name: string, create: () => T): T {
  const key = Symbol.for(`kitsuden.engine.${name}`);
  const registry = globalThis as unknown as Record<symbol, T | undefined>;
  return (registry[key] ??= create());
}
