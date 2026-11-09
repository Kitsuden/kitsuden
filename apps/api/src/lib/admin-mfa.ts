/**
 * Must administrators use two-factor sign-in? (`KITSUDEN_ADMIN_MFA=optional|required`)
 * ============================================================================
 *
 * `optional` (the default for now): anyone may enrol an authenticator app from
 * the panel (Settings → Security) and nobody is forced to.
 *
 * `required`: a session of an `admin` whose account has no confirmed TOTP gets
 * `403` on every route except better-auth's own (`/api/auth/*`, where enrolment
 * happens) and the few public ones the panel needs to draw itself. The panel
 * sees `reason: "MFA_REQUIRED"` and shows the enrolment screen instead of the
 * app. Nothing else changes: agents (`Bearer kitsuden_agent_*`) are not sessions
 * and keep working; editors and users are not affected.
 *
 * An unknown value counts as `required`: a typo must not switch protection off
 * (same rule as `KITSUDEN_SIGNUP`). The worst case of that rule is an admin who
 * has to enrol, which the gate itself lets them do.
 *
 * What a second factor covers: password sign-in (`/sign-in/email`) asks for the
 * code. Magic links are refused to accounts with two-factor enabled (lib/auth.ts).
 * OAuth sign-in (GitHub, Google…) does NOT ask for the code: better-auth's plugin
 * does not hook it; the provider's own MFA is what protects that path.
 */

import type { Context, Next } from "hono";

type Env = Record<string, string | undefined>;

export type AdminMfaMode = "optional" | "required";

export function adminMfaMode(env: Env = process.env): AdminMfaMode {
  const mode = env["KITSUDEN_ADMIN_MFA"]?.trim().toLowerCase();
  if (!mode || mode === "optional") return "optional";
  if (mode === "required") return "required";
  console.warn(
    `[auth] KITSUDEN_ADMIN_MFA must be "optional" or "required": treating "${mode}" as required.`
  );
  return "required";
}

/**
 * Routes an admin without a second factor can still reach: better-auth (sign-in,
 * sign-out, get-session, two-factor enrolment) and what the panel reads before
 * deciding what to render. Everything else is the admin's power, which waits.
 */
const OPEN_PREFIXES = ["/api/auth/"];
const OPEN_PATHS = new Set([
  "/api/system/init-check",
  "/api/system/auth-providers",
  "/api/health",
  "/health",
]);

export function mfaGateApplies(path: string): boolean {
  if (OPEN_PATHS.has(path)) return false;
  return !OPEN_PREFIXES.some((p) => path.startsWith(p));
}

/** The body of the refusal. `code` is the catalog's; `reason` is what the panel branches on. */
export const MFA_REQUIRED_BODY = {
  error:
    "Administrators must enable two-factor sign-in before using this installation. Open the panel and enrol an authenticator app.",
  code: "KITSUDEN_E_FORBIDDEN",
  reason: "MFA_REQUIRED",
  hint: "Sign in to the panel and enrol an authenticator app (Settings → Security), or use an agent key; KITSUDEN_ADMIN_MFA=required is set.",
} as const;

interface SessionLike {
  user?: { role?: string | null; twoFactorEnabled?: boolean | null } | null;
}

type GetSession = (headers: Headers, fresh: boolean) => Promise<SessionLike | null>;

/**
 * The gate. `getSession` is injected so the unit test does not need better-auth;
 * `index.ts` passes `auth.api.getSession`.
 *
 * Off (`optional`): one environment read, nothing else. On: requests without a
 * cookie pass untouched (agents, public reads); with a cookie, the session is
 * read and, for an admin, read again bypassing the 5-minute cookie cache, so
 * an admin who just disabled their second factor elsewhere is caught at once.
 */
export function adminMfaGate(getSession: GetSession, env: Env = process.env) {
  return async (c: Context, next: Next) => {
    if (adminMfaMode(env) !== "required") return next();
    if (!mfaGateApplies(c.req.path)) return next();
    if (!c.req.header("Cookie")) return next();

    let session = await getSession(c.req.raw.headers, false).catch(() => null);
    if (session?.user?.role !== "admin") return next();
    session = await getSession(c.req.raw.headers, true).catch(() => null);
    if (session?.user?.role !== "admin" || session.user.twoFactorEnabled === true) return next();

    return c.json(MFA_REQUIRED_BODY, 403);
  };
}
