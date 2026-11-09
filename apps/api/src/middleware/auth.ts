/**
 * Authentication Middleware
 *
 * Provides route protection and role-based access control for API routes.
 */

/**
 * From the module, NOT from the index of `@kitsuden/engine`.
 *
 * The engine index re-exports pieces of the API —among them the kon loader,
 * which imports this file—. Importing from there creates a cycle: this module
 * is evaluated while the engine is still loading, and `withRouteMeta` is
 * `undefined` on the line that calls it. `route-meta` imports nothing at
 * runtime, so from here no cycle is possible.
 */
import { withRouteMeta } from "@kitsuden/engine/src/route-meta";
import { createMiddleware } from "hono/factory";

import { auth } from "../lib/auth";

import { agentCanActAsUser, AGENT_WITHOUT_ACCOUNT_MESSAGE } from "./agent-as-user";

/**
 * The session, with a privileged role read from the database.
 *
 * The session cookie caches the user for 5 minutes. A demoted or deleted admin,
 * or one whose sessions were revoked, kept its role on every route guarded
 * here: the global middleware read it fresh, then these guards read the cache
 * again and put the old role back (security review 2026-11-03).
 */
async function currentSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (role === "admin" || role === "editor") {
    return auth.api.getSession({ headers, query: { disableCookieCache: true } });
  }
  return session;
}
// @ts-ignore - Type import used for JSDoc/context typing

/**
 * Middleware to require authentication
 * Injects user and session into context
 */
export const requireAuth = withRouteMeta(
  createMiddleware(async (c, next) => {
    /**
     * ── AN ALREADY AUTHENTICATED AGENT DOES NOT NEED A COOKIE ─────────────
     *
     * The global middleware of `index.ts` verifies `Bearer kitsuden_agent_*`
     * (argon2 hash, active agent, request limit) and leaves `agent` and
     * `user` in the context. But this only looked at the cookie session,
     * so ANY kon route answered 401 to an agent with a valid token.
     *
     * It is recognized only when `agent` is present, which only that
     * verification sets. Legacy `kitsuden_sk_*` keys do not leave `agent`, so
     * they gain access to nothing they did not have — they already passed their retirement date.
     */
    const agent = (c as unknown as { get(key: string): unknown }).get("agent");
    const user = (c as unknown as { get(key: string): unknown }).get("user");
    if (agent && user) {
      // Not just any key: see middleware/agent-as-user.ts
      if (!agentCanActAsUser(c)) {
        return c.json({ error: AGENT_WITHOUT_ACCOUNT_MESSAGE }, 403);
      }
      await next();
      return;
    }

    const session = await currentSession(c.req.raw.headers);

    if (!session) {
      return c.json({ error: "Unauthorized - Authentication required" }, 401);
    }

    // Inject user/session into context
    c.set("user", session.user);
    c.set("session", session.session);

    await next();
  }),
  { auth: "required" }
);

/**
 * Middleware factory to require specific roles
 * @param allowedRoles - Array of roles that are allowed to access the route
 */
export const requireRole = (allowedRoles: string[]) =>
  createMiddleware(async (c, next) => {
    const session = await currentSession(c.req.raw.headers);

    if (!session) {
      return c.json({ error: "Unauthorized - Authentication required" }, 401);
    }

    const user = session.user;
    const userRole = (user?.role as string) || "user";

    if (!allowedRoles.includes(userRole)) {
      return c.json(
        {
          error: "Forbidden - Insufficient permissions",
          required: allowedRoles,
          current: userRole,
        },
        403
      ) as unknown as Response;
    }

    // Inject user/session into context
    c.set("user", user);
    c.set("session", session.session);

    await next();
  });

/**
 * Optional auth middleware - sets user if available but doesn't reject
 */
export const optionalAuth = withRouteMeta(
  createMiddleware(async (c, next) => {
    const session = await currentSession(c.req.raw.headers);

    if (session) {
      c.set("user", session.user);
      c.set("session", session.session);
    }

    await next();
  }),
  { auth: "optional" }
);
