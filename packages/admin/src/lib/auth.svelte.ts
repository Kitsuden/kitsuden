import { t } from "$lib/i18n";
/**
 * Auth Store (Svelte 5 Runes)
 *
 * Manages session state for the Admin Panel.
 * Uses Better-Auth's cookie-based sessions via fetch.
 */

// In production (Docker): VITE_API_URL is "" — fetch uses relative URLs
// which nginx proxies to the API container internally. Same-origin cookies.
// In development: VITE_API_URL is "http://localhost:3001" (set in packages/admin/.env)
const API_URL = import.meta.env.VITE_API_URL ?? "";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: string;
  /** better-auth `twoFactor`: true once a TOTP code was confirmed. */
  twoFactorEnabled?: boolean;
}

// Svelte 5 Runes for state
let user = $state<AuthUser | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);
let checked = $state(false);
let initialized = $state(true); // Default to true to prevent flash of setup screen
let setupTokenRequired = $state(false);

// Getters for readonly access (cannot export derived directly)
export function getUser() {
  return user;
}
export function getLoading() {
  return loading;
}
export function getError() {
  return error;
}
export function getChecked() {
  return checked;
}
export function isLoggedIn() {
  return !!user;
}
export function isAdmin() {
  return user?.role === "admin";
}
/**
 * Who can use the panel: `admin` or `editor` (the API's «staff», see
 * apps/api/src/middleware/auth-guard.ts). The editor manages content —blog,
 * media, pages— and does not see the system part. Before, login only admitted
 * admin, so granting the editor role from Settings was useless.
 */
export function isStaff() {
  return user?.role === "admin" || user?.role === "editor";
}
export function isInitialized() {
  return initialized;
}
/** The API asks for the one-time token printed in its log (production, public mode). */
export function needsSetupToken() {
  return setupTokenRequired;
}

/**
 * Check if the system is initialized (has at least one administrator)
 */
export async function checkInit() {
  try {
    const res = await fetch(`${API_URL}/api/system/init-check`);
    const data = await res.json();
    if (data.initialized !== undefined) {
      initialized = data.initialized;
    }
    setupTokenRequired = data.setupTokenRequired === true;
  } catch {
    initialized = true; // Fallback assumption
  }
}

/**
 * Check current session (cookie-based)
 */
export async function checkSession() {
  loading = true;
  error = null;
  try {
    const res = await fetch(`${API_URL}/api/auth/get-session`, {
      credentials: "include",
    });
    if (!res.ok) {
      console.warn(`[auth] checkSession failed with status ${res.status}, clearing user`);
      user = null;
      return;
    }
    const data = await res.json();
    user = data?.user || null;
  } catch (err) {
    console.error(`[auth] checkSession error:`, err);
    user = null;
  } finally {
    loading = false;
    checked = true;
  }
}

/**
 * Sign in with email + password
 */
export async function signIn(email: string, password: string) {
  loading = true;
  error = null;
  try {
    const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      /**
       * The `code` is kept in addition to the text. With mandatory email
       * verification, «wrong password» and «you must confirm your email»
       * call for different things —the second, a button to resend the link—
       * and without the code the only option was comparing the English message.
       */
      const failure = new Error(
        body.message || body.error || t("auth.invalidCredentials")
      ) as Error & {
        code?: string;
      };
      failure.code = body.code;
      throw failure;
    }

    const data = await res.json();
    // Two-factor sign-in: no session yet, only a short-lived challenge cookie.
    // The caller asks for the code and calls `verifyTwoFactor`.
    if (data?.twoFactorRedirect) {
      return data as { twoFactorRedirect: true; twoFactorMethods?: string[] };
    }
    // Better-Auth sign-in response may not include additionalFields (e.g. role).
    // We set the user from sign-in response as a preliminary value.
    // The caller should follow up with checkSession() to get the full user.
    if (data?.user) {
      user = data.user;
    }
    return data;
  } catch (err: any) {
    error = err.message;
    throw err;
  } finally {
    loading = false;
  }
}

/**
 * Requests the email to reset the password.
 *
 * `redirectTo` is the panel root: with no session, the panel renders the login on
 * any route, and it is the login itself that recognizes the `?token=` with which
 * better-auth comes back. A separate `/reset-password` route would be hidden.
 *
 * «That account does not exist» is not distinguished from «sent»: saying so would allow
 * finding out which emails are registered by trying addresses.
 */
export async function requestPasswordReset(email: string) {
  const res = await fetch(`${API_URL}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, redirectTo: `${window.location.origin}/` }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || t("auth.couldNotRequestReset"));
  }
}

/** Sets the new password with the link's token. */
export async function resetPassword(token: string, newPassword: string) {
  const res = await fetch(`${API_URL}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token, newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || t("auth.couldNotChangePassword"));
  }
}

/** Resends the verification link to whoever could not log in for lacking it. */
export async function resendVerification(email: string) {
  const res = await fetch(`${API_URL}/api/auth/send-verification-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, callbackURL: `${window.location.origin}/` }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || t("auth.couldNotResendEmail"));
  }
}

/**
 * Second step of a two-factor sign-in: the code from the authenticator app or a
 * backup code. The challenge cookie set by `sign-in/email` identifies the user;
 * on success better-auth sets the session cookie and `checkSession` follows.
 */
export async function verifyTwoFactor(
  code: string,
  kind: "totp" | "backup",
  trustDevice = false
): Promise<void> {
  const path = kind === "totp" ? "verify-totp" : "verify-backup-code";
  const res = await fetch(`${API_URL}/api/auth/two-factor/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ code: code.trim(), trustDevice }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const failure = new Error(body.message || t("loginView.invalidCode")) as Error & {
      code?: string;
    };
    failure.code = body.code;
    throw failure;
  }
}

/**
 * Asks for a magic link. The answer is the same whether or not the address may
 * sign in (saying otherwise would reveal which emails are registered).
 *
 * `errorCallbackURL` carries `?login=magic-link` so the login can tell a failed
 * magic link from a failed password reset (both come back with `?error=`).
 */
export async function requestMagicLink(email: string) {
  const origin = window.location.origin;
  const res = await fetch(`${API_URL}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      email,
      callbackURL: `${origin}/`,
      errorCallbackURL: `${origin}/?login=magic-link`,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || t("auth.couldNotSendLink"));
  }
}

/** What `POST /two-factor/enable` returns: shown once, never again. */
export interface TwoFactorEnrolment {
  totpURI: string;
  backupCodes: string[];
}

async function twoFactorCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_URL}/api/auth/two-factor/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.code || String(res.status));
  return data as T;
}

/** An empty password is not sent: accounts created by magic link have none. */
const withPassword = (password: string) => (password ? { password } : {});

/** Starts TOTP enrolment: the secret and the backup codes come back once. */
export function enableTwoFactor(password: string) {
  return twoFactorCall<TwoFactorEnrolment>("enable", { ...withPassword(password), method: "totp" });
}

/** Confirms the enrolment with a first code; better-auth then turns 2FA on. */
export async function confirmTwoFactor(code: string) {
  await twoFactorCall("verify-totp", { code: code.trim() });
  await checkSession();
}

export async function disableTwoFactor(password: string) {
  await twoFactorCall("disable", withPassword(password));
  await checkSession();
}

export function regenerateBackupCodes(password: string) {
  return twoFactorCall<{ backupCodes: string[] }>("generate-backup-codes", withPassword(password));
}

export interface SocialProvider {
  id: string;
  label: string;
}

let socialProviders = $state<SocialProvider[]>([]);
export function getSocialProviders() {
  return socialProviders;
}

/** Sign-in options the server reports (`GET /api/system/auth-providers`). */
let magicLinkEnabled = $state(false);
let adminMfaRequired = $state(false);
export function hasMagicLink() {
  return magicLinkEnabled;
}
/**
 * `KITSUDEN_ADMIN_MFA=required` and this admin has no second factor: the API
 * answers 403 to everything but enrolment, so the panel shows only that.
 */
export function mustEnrolTwoFactor() {
  return adminMfaRequired && user?.role === "admin" && user?.twoFactorEnabled !== true;
}

/**
 * Asks the server WHICH OAuth providers are configured.
 *
 * It asks instead of having the list written in the client because a provider
 * button without credentials does not fail when pressed: it fails AFTER the
 * redirect, on a Discord or Google page that is no longer ours, with an
 * error that explains nothing.
 */
export async function loadSocialProviders() {
  try {
    const res = await fetch(`${API_URL}/api/system/auth-providers`);
    if (!res.ok) return;
    const data = await res.json();
    socialProviders = Array.isArray(data?.social) ? data.social : [];
    magicLinkEnabled = data?.magicLink === true;
    adminMfaRequired = data?.adminMfa === "required";
  } catch {
    socialProviders = [];
  }
}

/**
 * Sign in with a social provider.
 *
 * Returns nothing: `sign-in/social` responds with the authorization URL and the
 * browser leaves the site. On return, the callback sets the session cookie and
 * the normal startup (`checkSession`) decides whether that account may enter here.
 */
export async function signInWithProvider(providerId: string, callbackURL = "/") {
  loading = true;
  error = null;
  try {
    const res = await fetch(`${API_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ provider: providerId, callbackURL }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url) {
      throw new Error(data?.message || data?.error || t("auth.couldNotSignInWith", { providerId }));
    }

    window.location.href = data.url;
  } catch (err: any) {
    error = err.message;
    loading = false;
    throw err;
  }
}

/**
 * Sign out
 */
export async function signOut() {
  try {
    await fetch(`${API_URL}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // ignore
  }
  user = null;
}
