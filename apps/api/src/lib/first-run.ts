/**
 * The first administrator of an installation
 * ============================================================================
 *
 * A new install is reachable before its owner logs in (certificates show up in
 * Certificate Transparency logs within minutes, and scanners watch them), so
 * "whoever calls `POST /api/system/setup` first becomes admin" is a takeover. And
 * counting USERS let anyone lock the owner out with one public sign-up.
 *
 *   · Setup needs a one-time token, generated at boot while no admin exists and
 *     printed to the log: only who can read the log can use it. Mandatory in
 *     production, with `KITSUDEN_PUBLIC=true` and whenever the API listens on
 *     an address other than loopback (`HOST=0.0.0.0` in development is the whole
 *     network); optional only for a development API on 127.0.0.1/::1.
 *   · What counts is ADMINS, not users.
 *   · No public sign-up while there is no admin.
 *   · `pg_advisory_xact_lock` serialises setup: two calls cannot both win.
 *
 * The token lives in the memory of this process: a restart generates another
 * one, and with several replicas each one prints and accepts its own.
 *
 * Without a token (development API on loopback) any web page the developer has
 * open could still reach 127.0.0.1: a `text/plain` POST needs no CORS preflight,
 * and DNS rebinding sends the request under the attacker's host name. So the
 * tokenless path also needs a JSON body and loopback `Host` and `Origin`
 * headers (`tokenlessSetupRefusal`, hardening 2026-11-20).
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { count, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { authAccounts, authUsers } from "../db/schema-core";

import { auth } from "./auth";
import { isLoopbackHost, listensBeyondLoopback } from "./listen-host";
import { publicOrProduction } from "./placeholder-secrets";

type Env = Record<string, string | undefined>;

/** Any fixed number: the key of the advisory lock that serialises setup. */
const SETUP_LOCK_KEY = 7_315_002_681;

export function setupTokenRequired(env: Env = process.env): boolean {
  return publicOrProduction(env) || listensBeyondLoopback(env);
}

/**
 * The suites sign up with no admin in the test database. A test that checks the
 * gate turns it on with `KITSUDEN_TEST_SIGNUP_GATE=on`; it only ever closes more.
 */
function signUpGateActive(env: Env = process.env): boolean {
  return env["NODE_ENV"] !== "test" || env["KITSUDEN_TEST_SIGNUP_GATE"] === "on";
}

type Executor = Pick<typeof db, "select">;

export async function adminExists(executor: Executor = db): Promise<boolean> {
  const [row] = await executor
    .select({ value: count() })
    .from(authUsers)
    .where(eq(authUsers.role, "admin"));
  return (row?.value ?? 0) > 0;
}

// ── The token ───────────────────────────────────────────────────────────────

const hashOf = (token: string) => createHash("sha256").update(token).digest();

let tokenHash: Buffer | null = null;

/**
 * The panel address that opens the first-run form with the token already filled in. The token goes
 * in the fragment (`#setup-token=`): browsers never send a fragment to a server, so it reaches no
 * access log, proxy or `Referer`, and the panel removes it from the address bar once read.
 */
export function setupLink(token: string, env: Env = process.env): string | null {
  const panel = (env["ADMIN_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(panel)) return null;
  return `${panel}/#setup-token=${token}`;
}

/** Creates the token if there is none, and prints it. Returns it only when it is new. */
export function ensureSetupToken(): string | null {
  if (tokenHash) return null;
  const token = randomBytes(32).toString("base64url");
  tokenHash = hashOf(token);
  const line = "=".repeat(72);
  const link = setupLink(token);
  // `console`, not the logger: it must reach the log whatever LOG_LEVEL says.
  const how = link
    ? `  No administrator exists yet. To create the first one, open:\n\n    ${link}\n\n` +
      `  or paste this one-time setup token in the panel (or POST /api/system/setup):\n\n`
    : `  No administrator exists yet. To create the first one, use this\n` +
      `  one-time setup token in the panel or in POST /api/system/setup:\n\n`;
  console.warn(
    `\n${line}\n${how}` +
      `    ${token}\n\n` +
      `  ${setupTokenRequired() ? "It is required." : "It is optional only on a loopback development API."}` +
      ` A restart generates a new one.\n` +
      `  To see it again: docker compose logs kitsuden_api | grep -B4 -A6 "No administrator"\n${line}\n`
  );
  return token;
}

/** The host name of a `Host` header value or an origin URL, without port. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Why a setup request WITHOUT a token is refused, or `null` when it may go on:
 * a JSON body (a cross-site page cannot send one without a CORS preflight) and
 * `Host` and `Origin` (when sent) on loopback (DNS rebinding keeps the
 * attacker's host name in both).
 */
export function tokenlessSetupRefusal(request: Request): string | null {
  const headers = request.headers;
  const type = (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return "the body must be sent as application/json";
  // The Node server always has `Host`; an in-process `app.request` only has the URL.
  const host = headers.get("host");
  const hostName = host ? hostnameOf(host, false) : hostnameOf(request.url, true);
  if (!hostName || !isLoopbackHost(hostName))
    return "the request must be addressed to a loopback host";
  const origin = headers.get("origin");
  if (origin !== null) {
    const originName = hostnameOf(origin, true);
    if (!originName || !isLoopbackHost(originName))
      return "the request must come from a loopback origin";
  }
  return null;
}

export function setupTokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !tokenHash) return false;
  return timingSafeEqual(hashOf(candidate), tokenHash);
}

/** Once used it is gone. Exported for the tests, which need a token they can see. */
export function forgetSetupToken(): void {
  tokenHash = null;
}

/** At boot: announce the token if there is no admin. Never stops the boot. */
export async function announceSetupTokenAtBoot(): Promise<void> {
  try {
    if (!(await adminExists())) ensureSetupToken();
  } catch (err) {
    console.warn(`[setup] could not check for an administrator at boot: ${String(err)}`);
  }
}

// ── The public sign-up gate ─────────────────────────────────────────────────

/** Should `/api/auth/sign-up/*` be refused right now? A failed check refuses. */
export async function signUpRefused(): Promise<boolean> {
  if (!signUpGateActive()) return false;
  try {
    return !(await adminExists());
  } catch {
    return true;
  }
}

// ── Creating the account ────────────────────────────────────────────────────

export interface NewAccount {
  name: string;
  email: string;
  password: string;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A user with a password, written directly. `auth.api.signUpEmail` obeys
 * `disableSignUp`, and setup and the seed scripts have to work with sign-up closed.
 * Unverified and with the default role: the caller decides what else it gets.
 */
export async function insertCredentialUser(
  tx: Pick<Transaction, "insert">,
  account: NewAccount
): Promise<{ id: string; email: string; name: string }> {
  const context = await auth.$context;
  const email = account.email.trim().toLowerCase();
  const id = randomUUID();
  const password = await context.password.hash(account.password);
  await tx.insert(authUsers).values({ id, name: account.name, email });
  await tx.insert(authAccounts).values({
    id: randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password,
  });
  return { id, email, name: account.name };
}

export type SetupOutcome =
  | { ok: true; user: { id: string; email: string; name: string } }
  | { ok: false; status: 400 | 403 | 409; error: string; code: string };

const failure = (status: 400 | 403 | 409, error: string, code: string): SetupOutcome => ({
  ok: false,
  status,
  error,
  code,
});

/**
 * Creates the first administrator, or says why not. All of it inside one
 * transaction holding the lock: the second of two concurrent calls waits here and
 * then finds an admin.
 */
export async function createFirstAdmin(
  body: { name?: unknown; email?: unknown; password?: unknown; setupToken?: unknown } | null,
  promote: (tx: Transaction, userId: string) => Promise<void>,
  /** The HTTP request: its headers decide whether the tokenless path may be used. */
  request: Request
): Promise<SetupOutcome> {
  const outcome = await db.transaction(async (tx): Promise<SetupOutcome> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
    if (await adminExists(tx))
      return failure(403, "System already initialized", "ALREADY_INITIALIZED");

    // A token that was sent is always checked; only requiring one depends on the mode.
    const sentToken = body?.setupToken !== undefined && body.setupToken !== "";
    if (setupTokenRequired() || sentToken) {
      ensureSetupToken();
      if (!setupTokenMatches(body?.setupToken)) {
        return failure(
          403,
          "Invalid or missing setup token: read it in the API log",
          "INVALID_SETUP_TOKEN"
        );
      }
    } else {
      const refusal = tokenlessSetupRefusal(request);
      if (refusal) {
        return failure(
          403,
          `Setup without a token: ${refusal}. Or send the setup token from the API log`,
          "SETUP_REQUEST_REFUSED"
        );
      }
    }

    const { name, email, password } = body ?? {};
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return failure(400, "Missing required fields", "MISSING_FIELDS");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return failure(400, "Invalid email address", "INVALID_EMAIL");
    }
    const context = await auth.$context;
    const { minPasswordLength, maxPasswordLength } = context.password.config;
    if (password.length < minPasswordLength || password.length > maxPasswordLength) {
      return failure(
        400,
        `The password must have at least ${minPasswordLength} characters`,
        "INVALID_PASSWORD"
      );
    }
    const taken = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email.trim().toLowerCase()))
      .limit(1);
    if (taken.length > 0)
      return failure(409, "An account with this email already exists", "EMAIL_TAKEN");

    const user = await insertCredentialUser(tx, { name: name.trim(), email, password });
    await promote(tx, user.id);
    return { ok: true, user };
  });
  // After the COMMIT: if it had failed, the owner could still use the token.
  if (outcome.ok) forgetSetupToken();
  return outcome;
}
