import { Hono } from "hono";

/**
 * What the global middleware in `index.ts` leaves in the context and a kon
 * needs to read: who it is (session or agent) and the request id.
 */
export const HOST_VARIABLES = [
  "user",
  "session",
  "agent",
  "requestId",
  "userRoleIds",
  "userDepartmentId",
] as const;

const ENV_KEY = "__variablesDelHost";

/**
 * The kon's router, wrapped so that it sees the identity the API already resolved.
 *
 * `router.fetch(...)` is a NEW request cycle: its context starts empty.
 * A hot-activated kon saw neither `agent` nor `user`, so its
 * `requireAuth` looked up the cookie again… and an agent with `Bearer` (Inti
 * with `content:edit`) got a 401 on every write until the API was
 * restarted (found by the install agent). The variables travel in the
 * `env` of that call —together with the server's, which carries the socket IP
 * used by the limiter— and are restored before entering the kon.
 */
export function withHostContext(router: Hono): Hono {
  const wrappedItem = new Hono();
  wrappedItem.use("*", async (c, next) => {
    const vars = (c.env as Record<string, unknown> | undefined)?.[ENV_KEY] as
      Record<string, unknown> | undefined;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        if (v !== undefined) (c.set as (k: string, v: unknown) => void)(k, v);
      }
    }
    await next();
  });
  wrappedItem.route("/", router);
  return wrappedItem;
}

/** The `env` the kon is called with: the server's + the identity. */
export function envForTheKon(
  hostEnv: unknown,
  get: (k: string) => unknown
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const k of HOST_VARIABLES) vars[k] = get(k);
  return { ...((hostEnv as Record<string, unknown>) ?? {}), [ENV_KEY]: vars };
}
