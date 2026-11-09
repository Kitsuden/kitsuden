/**
 * HTTP contract for kons
 * ============================================================================
 *
 * A kon cannot import from `apps/api` — that is the plugin isolation rule. But
 * its routes need to know what is in the Hono context, or they end up doing
 * `(c as any).get("user")` in every handler, which turns off the checker right
 * where it is decided who you are.
 *
 * This declares the MINIMUM shape the host guarantees. It is the same pattern
 * as `SubscriptionLike` in kon-members: integration by SHAPE, not by import. The
 * host may put more things in the context; a kon can only count on this.
 */

import type { Context } from "hono";

import { AppError } from "./errors";

/**
 * The user as a kon sees it.
 *
 * Deliberately poor: `id` and little else. A kon that needs the full profile
 * must ask its repository for it, not assume it in the context —
 * what is there depends on which middleware ran before.
 */
export interface KonUser {
  id: string;
  email?: string;
  role?: string;
  name?: string | null;
}

/** What the host guarantees in each request's context. */
export type KonVariables = {
  /** `null` when the request is anonymous. It must always be checked. */
  user: KonUser | null;
  requestId?: string;
  traceId?: string;
  /** Transaction with RLS context, if the route goes through `withTransactionalRLS`. */
  tx?: unknown;
};

/** Hono environment for a kon router. */
export type KonEnv = { Variables: KonVariables };

/**
 * Typed context of a kon route.
 *
 * ```ts
 * const router = new Hono<KonEnv>();
 * router.get("/mine", (c) => {
 *   const user = c.get("user");   // typed, no cast
 *   ...
 * });
 * ```
 */
export type KonRouteContext = Context<KonEnv>;

/**
 * Returns the user, or cuts the request with 401.
 *
 * It exists because "this route requires authentication" lived ONLY in the
 * order of the middleware, and the checker cannot see that. The result was
 * `(c as any).get("user").id`: the `any` hid that `user` can be null, and
 * nobody checked it. If one day someone mounts the route without the
 * middleware, the failure is not a 401 — it is a `TypeError` with a server trace.
 *
 * With this the invariant is explicit, typed and fails the way it should.
 */
export function requireUser(c: KonRouteContext): KonUser {
  const user = c.get("user");
  if (!user) throw AppError.unauthenticated();
  return user;
}
