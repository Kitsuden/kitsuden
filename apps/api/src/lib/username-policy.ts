/**
 * Who may pick a username to sign in with? (`KITSUDEN_USERNAMES=staff|everyone`)
 * ============================================================================
 *
 * better-auth's `username` plugin (lib/auth.ts, migration 0096) lets an account
 * sign in with "admin" + password instead of its email. A username is set by the
 * signed-in user through `POST /api/auth/update-user { username }`, and the
 * plugin also accepts one in the sign-up body.
 *
 * `staff` (the default): only an admin or an editor may set their own username,
 * and a sign-up never carries one. On a site with public accounts this keeps a
 * stranger from taking "admin", "support" or the owner's name before the staff
 * does, and from signing up as something that reads like the panel's account.
 *
 * `everyone`: any signed-in account may set one, and a sign-up may carry one
 * (a frontend whose users sign in by name).
 *
 * Clearing a username (`username: null`) is always allowed: it only takes a
 * way to sign in away. An unknown value counts as `staff`: a typo must not
 * open it.
 */

type Env = Record<string, string | undefined>;

export type UsernamePolicy = "staff" | "everyone";

const STAFF_ROLES = new Set(["admin", "editor"]);

export function usernamePolicy(env: Env = process.env): UsernamePolicy {
  const mode = env["KITSUDEN_USERNAMES"]?.trim().toLowerCase();
  if (!mode || mode === "staff") return "staff";
  if (mode === "everyone") return "everyone";
  console.warn(
    `[auth] KITSUDEN_USERNAMES must be "staff" or "everyone": treating "${mode}" as staff.`
  );
  return "staff";
}

/**
 * The request tries to SET a username (a string). `null` or no field is not that.
 *
 * `displayUsername` counts too: on a sign-up with only `displayUsername`, the
 * plugin copies it into `username` in a hook of its own, and whether that hook
 * runs before or after ours depends on plugin order.
 */
export function setsUsername(body: unknown): boolean {
  const fields = body as { username?: unknown; displayUsername?: unknown } | null;
  return typeof fields?.username === "string" || typeof fields?.displayUsername === "string";
}

/**
 * Why this request may not set a username, or `null` when it may.
 *
 * `path` is better-auth's endpoint path (`/sign-up/email`, `/update-user`);
 * `role` is the signed-in user's role (undefined without a session).
 */
export function usernameRefusal(
  path: string,
  body: unknown,
  role: string | undefined,
  policy: UsernamePolicy
): "USERNAME_NOT_AT_SIGN_UP" | "USERNAME_STAFF_ONLY" | null {
  if (policy === "everyone" || !setsUsername(body)) return null;
  if (path === "/sign-up/email") return "USERNAME_NOT_AT_SIGN_UP";
  if (path === "/update-user" && !STAFF_ROLES.has(role ?? "")) return "USERNAME_STAFF_ONLY";
  return null;
}
