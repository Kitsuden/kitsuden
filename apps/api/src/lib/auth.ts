/**
 * Better-Auth Configuration
 *
 * Initializes Better-Auth with the Drizzle adapter (PostgreSQL),
 * credentials provider, and session-based authentication.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, twoFactor } from "better-auth/plugins";

import { db } from "../db";
import {
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  authTwoFactors,
} from "../db/schema";

import { PROXY_RANGES } from "./client-ip";
import { inProduction } from "./environment";
import { setLinkTarget } from "./link-target";
import { magicLinkRefusal } from "./magic-link-policy";
import { signUpClosed } from "./signup-mode";

// Build trusted origins dynamically from environment
function buildTrustedOrigins(): string[] {
  const origins = new Set<string>();

  // Always trust the API itself
  const authUrl = process.env.BETTER_AUTH_URL || "http://localhost:3001";
  origins.add(authUrl);

  // Admin panel
  const adminUrl = process.env.ADMIN_URL || "http://localhost:5173";
  origins.add(adminUrl);

  // Web frontend (if configured)
  const webUrl = process.env.WEB_URL || "http://localhost:4321";
  origins.add(webUrl);

  // ALLOWED_ORIGINS from config (comma-separated)
  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  if (allowedOrigins) {
    allowedOrigins.split(",").forEach((o) => origins.add(o.trim()));
  }

  // Common dev ports as fallbacks
  if (!inProduction()) {
    origins.add("http://localhost:3000");
    origins.add("http://localhost:3001");
    origins.add("http://localhost:5173");
    origins.add("http://localhost:4321");
    // The same machine, but another origin for the browser.
    origins.add("http://127.0.0.1:3000");
    origins.add("http://127.0.0.1:3001");
    origins.add("http://127.0.0.1:5173");
    origins.add("http://127.0.0.1:4321");
  }

  return Array.from(origins).filter(Boolean);
}

/**
 * Trusted origins, computed once: used by `trustedOrigins` and also by
 * `setLinkTarget`, which decides where an email link returns to.
 */
const TRUSTED_ORIGINS = buildTrustedOrigins();
const PANEL_URL = process.env.ADMIN_URL || "http://localhost:5173";

/** `KITSUDEN_SIGNUP`: can strangers create accounts? (see signup-mode.ts) */
const SIGN_UP_CLOSED = signUpClosed();

/** Minutes a magic link stays valid. Single use either way. */
export const MAGIC_LINK_MINUTES = 10;

/** The destinations a magic link may carry besides `callbackURL` (see link-target.ts). */
const MAGIC_LINK_TARGETS = ["newUserCallbackURL", "errorCallbackURL"] as const;

/** The magic link's verify path, as better-auth's endpoint context names it. */
const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";

/** No admin yet: no account may be created (first-run.ts). Lazy: first-run imports this file. */
async function firstRunRefuses(): Promise<boolean> {
  const { signUpRefused } = await import("./first-run");
  return signUpRefused();
}

// Better-Auth plugin context types
interface AuthContext {
  path: string;
  response?: {
    user?: {
      id: string;
      email: string;
      name?: string;
    };
  };
}

/**
 * Queues a system email and leaves a trace if it COULD NOT be done.
 *
 * `emailQueue.add` returns `null` when Valkey does not respond: it discards the
 * job and only writes a warning. For a verification or a reset that is
 * an email that never arrives without anyone finding out, so here it is logged
 * as an ERROR.
 *
 * It does not throw: better-auth runs these sends after responding, and an
 * uncaught rejection there does not reach the user, it only takes the process down.
 *
 * Dynamic imports for the same reason as the event hook below: the
 * queue and the logger cannot be loaded before the auth configuration.
 *
 * The recipient is deliberately not logged: it is personal data, and the email
 * name is enough to know what failed.
 */
async function enqueueEmail(
  name: string,
  data: { to: string } & Record<string, unknown>
): Promise<void> {
  const { emailQueue } = await import("./queue");
  const job = await emailQueue.add(name, data as never);
  if (!job) {
    const { logger } = await import("./logger");
    logger.error(
      { email: name },
      `[auth] could not enqueue «${name}»: the recipient will not receive it`
    );
  }
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: authUsers,
      session: authSessions,
      account: authAccounts,
      verification: authVerifications,
      twoFactor: authTwoFactors,
    },
  }),

  /**
   * A magic link must not open a session for an account with two-factor sign-in.
   *
   * `sendMagicLink` already refuses to send one to such an account, but a link
   * sent BEFORE the user enrolled is still valid for its few minutes. The verify
   * endpoint creates the session through here: returning `false` makes
   * better-auth redirect to the error page (`failed_to_create_session`) with no
   * session and no cookie.
   */
  databaseHooks: {
    session: {
      create: {
        before: async (session, context) => {
          if (context?.path !== MAGIC_LINK_VERIFY_PATH) return;
          const found = await context.context.internalAdapter.findUserById(session.userId);
          if ((found as { twoFactorEnabled?: boolean } | null)?.twoFactorEnabled) return false;
        },
      },
    },
  },

  // Base path matches the Hono mount point
  basePath: "/api/auth",

  // Without a base URL, better-auth builds the links it emails (password reset,
  // verification) from the request's Host header: `Host: evil.tld` on a reset
  // request would send the victim a link to evil.tld carrying the token. In
  // production the URL is fixed; development keeps localhost and 127.0.0.1
  // working (security review 2026-11-03).
  ...(inProduction() ? { baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3001" } : {}),

  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },

  // Auth providers
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    disableSignUp: SIGN_UP_CLOSED,

    /**
     * Password sign-in is not allowed until the email is confirmed.
     *
     * Before, anyone could sign up with another person's address and
     * sign in with it. NOTE: this is NOT what closes the account takeover via
     * OAuth linking (GHSA-g38m-r43w-p2q7). That advisory expressly says
     * that requiring verification does not mitigate it; it is closed by better-auth
     * version ≥1.6.11. This is separate hygiene.
     *
     * The first administrator comes out already verified from the signup at
     * `/api/system/setup`: otherwise, whoever installs would be locked out.
     */
    requireEmailVerification: true,

    /**
     * Resetting the password closes all open sessions.
     *
     * Whoever resets a password usually does so because they suspect someone
     * else knows it. Leaving their sessions alive means leaving them in.
     */
    revokeSessionsOnPasswordReset: true,

    /**
     * The `system.password-recovery` template existed and nothing sent it:
     * password recovery was written and disconnected.
     */
    sendResetPassword: async ({ user, url }) => {
      await enqueueEmail("system.password-recovery", {
        to: user.email,
        resetUrl: setLinkTarget(url, PANEL_URL, TRUSTED_ORIGINS),
        expiresIn: 60,
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    // After clicking the link, signed in: asking for the password again right
    // after proving the email is yours only adds a step.
    autoSignInAfterVerification: true,
    /**
     * The link returns to the PANEL. better-auth sets `callbackURL=/` when the signup
     * brings no destination, and `/` resolved against the API: whoever confirmed their
     * email ended up on a JSON. See `link-target.ts`, which also prevents
     * the link from pointing to a domain outside `trustedOrigins`.
     */
    sendVerificationEmail: async ({ user, url }) => {
      await enqueueEmail("system.email-verification", {
        to: user.email,
        verifyUrl: setLinkTarget(url, PANEL_URL, TRUSTED_ORIGINS),
        name: user.name ?? undefined,
        expiresIn: 60,
      });
    },
  },

  /**
   * Account linking.
   *
   * It is left on —signing in with Google to an account created with email is what
   * people expect— and with no trusted providers. A trusted
   * provider links even if it has NOT verified the email, and Discord delivers
   * unverified addresses (see its block above).
   *
   * The other half of the fix is the version: since 1.6.11 better-auth also requires
   * the LOCAL user to have a verified email before linking
   * (`requireLocalEmailVerified`, on by default). It is not written here
   * because that option is already marked deprecated: in the next minor the
   * check becomes unconditional. There is a test that fails if
   * someone sets it to `false`.
   */
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [],
    },
  },

  // Social & Enterprise OAuth Providers (conditional)
  socialProviders: {
    ...(process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET && {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          disableImplicitSignUp: SIGN_UP_CLOSED,
        },
      }),
    ...(process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET && {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          disableImplicitSignUp: SIGN_UP_CLOSED,
        },
      }),
    ...(process.env.AZURE_AD_CLIENT_ID &&
      process.env.AZURE_AD_CLIENT_SECRET && {
        microsoft: {
          clientId: process.env.AZURE_AD_CLIENT_ID,
          clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
          tenantId: process.env.AZURE_AD_TENANT_ID || "common",
          disableImplicitSignUp: SIGN_UP_CLOSED,
        },
      }),
    /**
     * Discord — the real identity of the esports audience.
     *
     * A tournament is organized on a Discord server, not in a form: if
     * registering requires creating another account with a password, half of the people
     * drop off there. With this the flow is one button, and what arrives already carries the
     * name they are known by in the bracket.
     *
     * `identify` gives id, username and avatar; `email` is what lets us recognize
     * someone who was already registered another way. Both are requested because without
     * email there is no way to link accounts or to announce a schedule
     * change — and Discord only delivers it if explicitly requested.
     *
     * NOTE: Discord delivers the email UNVERIFIED when the account has not
     * confirmed it. Better-Auth reflects that in `emailVerified`; do not treat it as
     * proof of identity for linking accounts automatically.
     */
    ...(process.env.DISCORD_CLIENT_ID &&
      process.env.DISCORD_CLIENT_SECRET && {
        discord: {
          clientId: process.env.DISCORD_CLIENT_ID,
          clientSecret: process.env.DISCORD_CLIENT_SECRET,
          scope: ["identify", "email"],
          disableImplicitSignUp: SIGN_UP_CLOSED,
        },
      }),
  },

  // User fields
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false,
      },
    },
  },

  // Trusted origins — built dynamically from environment
  trustedOrigins: TRUSTED_ORIGINS,

  /**
   * Where better-auth gets the IP for its attempt limit (3 every 10 s on
   * `/sign-in`, `/sign-up`…; active in production only).
   *
   * Without `trustedProxies`, better-auth only accepts an `x-forwarded-for` with ONE
   * entry and, if it carries more, it ends up with no IP and does NOT limit. Behind Caddy →
   * the panel's nginx → API the header arrives with two (client, Caddy): the login
   * brute-force limit was off exactly in production. With
   * the private ranges as trusted proxies it walks the chain from right
   * to left and takes the first public IP: the visitor's, not whatever
   * the client wrote in front. Same rule as `client-ip.ts`.
   */
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      trustedProxies: PROXY_RANGES,
    },
  },

  // Lifecycle Hooks — Emit events for Workers/Functions to react to
  plugins: [
    /**
     * Two-factor sign-in: TOTP (authenticator app) plus single-use backup codes.
     *
     * `/sign-in/email` answers `{ twoFactorRedirect: true }` for an enrolled
     * account and sets a short-lived signed cookie; the session only exists after
     * `/two-factor/verify-totp` or `/two-factor/verify-backup-code`. The secret
     * and the backup codes are stored encrypted with BETTER_AUTH_SECRET
     * (`auth_two_factors`, migration 0072).
     *
     * `allowPasswordless`: an account created by magic link has no password, and
     * without this it could never enrol. Accounts WITH a password must still
     * give it to enable, disable or read the secret again.
     *
     * No email/SMS OTP: a code sent by email is the same factor as the password
     * reset link. Whether admins must enrol: `KITSUDEN_ADMIN_MFA` (admin-mfa.ts).
     */
    twoFactor({
      issuer: process.env.APP_NAME || "Kitsuden",
      allowPasswordless: true,
    }),

    /**
     * Magic links: sign-in by a single-use link sent by email.
     *
     * `storeToken: "hashed"`: what sits in `auth_verifications` is a hash, so a
     * leaked database row does not sign anyone in. `disableSignUp` follows
     * `KITSUDEN_SIGNUP`: with sign-up closed a link never creates an account.
     * Who gets a link at all: lib/magic-link-policy.ts.
     */
    magicLink({
      expiresIn: MAGIC_LINK_MINUTES * 60,
      storeToken: "hashed",
      disableSignUp: SIGN_UP_CLOSED,
      sendMagicLink: async ({ email, url }, ctx) => {
        const found = ctx ? await ctx.context.internalAdapter.findUserByEmail(email) : null;
        const refusal = await magicLinkRefusal(
          found?.user as { twoFactorEnabled?: boolean } | undefined,
          { signUpClosed: SIGN_UP_CLOSED, firstRunRefuses }
        );
        if (refusal) {
          const { logger } = await import("./logger");
          logger.info({ reason: refusal }, "[auth] magic link not sent");
          return;
        }
        await enqueueEmail("system.magic-link", {
          to: email,
          url: setLinkTarget(url, PANEL_URL, TRUSTED_ORIGINS, MAGIC_LINK_TARGETS),
          expiresIn: MAGIC_LINK_MINUTES,
        });
      },
    }),

    {
      id: "kitsuden-hooks",
      hooks: {
        after: [
          {
            matcher: (context: AuthContext) => context.path === "/sign-up/email",
            handler: async (ctx: AuthContext) => {
              try {
                if (ctx.response?.user) {
                  const { hooks } = await import("./events");
                  hooks.emit("auth:register", ctx.response.user);
                }
              } catch {
                // Emitting the event is auxiliary: its failing cannot bring down the signup.
              }

              // Returning an object is NOT optional, even if we contribute nothing.
              //
              // better-auth's `runAfterHooks` does `if (result.headers)` on
              // whatever the handler returns, without first checking that it exists. With
              // `undefined` that blows up with
              //
              //     undefined is not an object (evaluating 'result.headers')
              //
              // and since this hook only fires on `/sign-up/email`, the effect
              // was that EVERY signup returned 500 — including the first
              // administrator's, which is the one that makes the installation usable. And it
              // did so after writing to the database: user, credential and
              // session created correctly, and an error anyway.
              //
              // The empty object leaves `result.headers` undefined, which is
              // falsy, and better-auth carries on without touching headers.
              return {};
            },
          } as unknown as {
            matcher: (context: unknown) => boolean;
            handler: (ctx: unknown) => Promise<Record<string, never>>;
          },
        ],
      },
    },
  ],
});

export type Session = typeof auth.$Infer.Session;
