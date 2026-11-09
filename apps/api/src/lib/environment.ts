/**
 * Which environment the process runs in, read AT RUNTIME.
 *
 * ── WHY NOT `process.env.NODE_ENV` ─────────────────────────────────────────
 *
 * The production image runs a bundle made with `bun build`, and Bun's
 * bundler REPLACES the literal expression `process.env.NODE_ENV`
 * with the value it had at compile time. In the Dockerfile's build
 * stage there is no `NODE_ENV`, so it gets frozen as "development":
 *
 *     if (process.env.NODE_ENV === "production") return protectRoute(c, next);
 *
 * came out in `dist/index.js` as `if (false) ;`. Seen on 2026-10-12 in the
 * production container: the GraphQL viewer was served without a session, the
 * SQL debugging endpoint was not closed, deferred kons returned the raw
 * message of 500 errors (SQL included) and better-auth trusted the
 * development origins (`localhost:3000/3001/5173/4321`). All with the
 * container declaring `NODE_ENV=production`.
 *
 * With the key in a variable the bundler cannot substitute anything: the
 * read always happens at runtime. It is locked in by `tests/unit/runtime-environment.test.ts`,
 * which also forbids writing `process.env.NODE_ENV` again in `apps/api/src`.
 */

const KEY = "NODE_ENV";

export type Environment = "development" | "production" | "test";

/** The value as is (or `undefined`), not normalized. */
export function rawNodeEnv(): string | undefined {
  return process.env[KEY];
}

/** Bounded to the three known values; anything else is development. */
export function currentEnvironment(): Environment {
  const value = rawNodeEnv();
  return value === "production" || value === "test" ? value : "development";
}

export const inProduction = (): boolean => rawNodeEnv() === "production";
export const inTesting = (): boolean => rawNodeEnv() === "test";
