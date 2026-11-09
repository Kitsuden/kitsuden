/**
 * Is this installation ready to serve the internet?
 * ============================================================================
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * A production audit found three failures that share a shape: the
 * system started perfectly and failed later, in front of a user.
 *
 *   · `BETTER_AUTH_URL` written as localhost. OAuth callbacks and the
 *     origin check pointed at the machine of whoever opens the page:
 *     social login broke with no error on the server.
 *   · No mail transport. The Mailer falls back to the `log` driver on purpose
 *     —so that a local sign-up does not fail for lack of SMTP— and in production that
 *     means password recovery is printed to a console
 *     that nobody watches.
 *   · A short session secret.
 *
 * None gives an error on startup. That is why they are checked BEFORE starting, with
 * the same logic the application uses, and startup refuses to continue.
 *
 * ── PUBLIC MODE ONLY ───────────────────────────────────────────────────────
 *
 * Requiring https and a mail provider locally would force configuring
 * Resend just to open the panel on a laptop. Public mode is declared by the
 * TLS overlay (`KITSUDEN_PUBLIC=true`): an exposed installation has to
 * SAY SO, and from then on nothing is forgiven.
 *
 * ── NO SECRETS IN MESSAGES ─────────────────────────────────────────────────
 *
 * These messages end up in the container log. For the secret, the
 * length is stated, never the value; for the Resend key, not even that.
 */

/**
 * From the specific file, NOT from the package index.
 *
 * `@kitsuden/engine` on its own loads the whole engine —repository, routes,
 * policies— and in vitest it blew up with `withRouteMeta is not a function` before
 * reaching the first check. `drivers.ts` only imports types: loading it
 * opens no connections and leaves no live resources, which is what a
 * startup step needs in order to finish cleanly.
 */
import { driverFromEnv } from "@kitsuden/engine/src/mail/drivers";

import { placeholderSecrets } from "./placeholder-secrets";

export interface ConfigProblem {
  variable: string;
  reason: string;
}

type Environment = Record<string, string | undefined>;

const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isLocal(host: string): boolean {
  const h = host.toLowerCase();
  return HOSTS_LOCALES.has(h) || h.endsWith(".localhost");
}

function checkUrl(env: Environment, name: string, problems: ConfigProblem[]): void {
  const value = env[name];
  if (!value) {
    problems.push({ variable: name, reason: "is not defined" });
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push({ variable: name, reason: `is not a valid URL: «${value}»` });
    return;
  }

  if (url.protocol !== "https:") {
    problems.push({
      variable: name,
      reason: `uses ${url.protocol.replace(":", "")} and not https: the session cookie would travel in the clear`,
    });
  }

  if (isLocal(url.hostname)) {
    problems.push({
      variable: name,
      reason:
        `points to ${url.hostname}: OAuth callbacks and the origin ` +
        `check would go to the machine of whoever opens the page, not to this server`,
    });
  }
}

/** List of what prevents serving the internet. Empty = ready. */
export function publicConfigProblems(env: Environment = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  for (const name of ["BETTER_AUTH_URL", "ADMIN_URL", "APP_URL"]) {
    checkUrl(env, name, problems);
  }

  /**
   * ── THE ORIGINS LIST ────────────────────────────────────────────────────
   *
   * This is where the real deployment fails, and silently: the site loads fully and only
   * login and comments fail, which is exactly what nobody tests when
   * deploying. Four ways to get it wrong, all four silent:
   *
   *   1. Leaving it EMPTY: no site can talk to the API.
   *   2. Leaving the local development ports.
   *   3. Writing `http://` where the site is `https://`: they are different
   *      origins and the browser does not cross them.
   *   4. Writing a URL with a slash or path (`https://web.com/`): an origin is
   *      scheme + host + port, so that entry NEVER matches.
   *
   * And the fifth, the one that really happened: forgetting the main site.
   */
  const origins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    problems.push({
      variable: "ALLOWED_ORIGINS",
      reason:
        "is empty: no site could call the API with the session, so " +
        "login and comments would fail on all of them even though the pages load",
    });
  }

  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      problems.push({ variable: "ALLOWED_ORIGINS", reason: `«${origin}» is not a valid origin` });
      continue;
    }

    if (isLocal(url.hostname)) {
      problems.push({
        variable: "ALLOWED_ORIGINS",
        reason: `includes ${origin}: any page served from that machine could call the API with the user's session`,
      });
      continue;
    }

    if (url.protocol !== "https:") {
      problems.push({
        variable: "ALLOWED_ORIGINS",
        reason: `${origin} is not https: the browser treats it as a different origin from the site and the session would travel in the clear`,
      });
    }

    /**
     * An origin is scheme + host + port and NOTHING else. `https://web.com/` with
     * a slash looks the same and never matches: the check compares
     * exact strings against `Origin`, which the browser sends without a slash.
     */
    if (origin !== url.origin) {
      problems.push({
        variable: "ALLOWED_ORIGINS",
        reason: `«${origin}» has a slash or path: an origin is «${url.origin}» so it never matches`,
      });
    }
  }

  /**
   * And the main site has to be in the list.
   *
   * Only the fixed list (`cors-origins.ts`) counts: there are no longer subdomains that
   * are accepted by rule. It is the easiest thing to forget, because the site loads fully and
   * only login and comments fail.
   */
  const app = env.APP_URL;
  if (app && origins.length > 0) {
    try {
      const appOrigin = new URL(app).origin;
      if (!origins.includes(appOrigin)) {
        problems.push({
          variable: "ALLOWED_ORIGINS",
          reason:
            `does not include ${appOrigin}, which is APP_URL: the main site would be left ` +
            `without login or comments`,
        });
      }
    } catch {
      // A malformed `APP_URL` is already flagged by `checkUrl` above
    }
  }

  // The SAME resolution the Mailer uses. Reimplementing it here is how you
  // end up with a check that says «there is mail» while the app uses another driver.
  const driver = driverFromEnv(env).name;
  if (driver === "log" || driver === "memory") {
    problems.push({
      variable: "RESEND_API_KEY / SMTP_HOST",
      reason:
        `email would use the driver «${driver}»: email verification and the ` +
        `password recovery would reach nobody`,
    });
  }

  const sender = env.MAIL_FROM ?? "";
  const domain = (sender.split("@")[1] ?? "").replace(/>\s*$/, "").trim();
  if (!domain || isLocal(domain)) {
    problems.push({
      variable: "MAIL_FROM",
      reason:
        `«${sender || "(empty)"}» does not have a real domain: providers ` +
        `reject that sender or send it to spam`,
    });
  }

  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) {
    problems.push({
      variable: "BETTER_AUTH_SECRET",
      reason: `has ${secret.length} characters; at least 32 are needed`,
    });
  }

  for (const variable of placeholderSecrets(env)) {
    problems.push({
      variable,
      reason: "still holds a placeholder from an example file: generate a real value",
    });
  }

  // The vault's own key (security review 2026-11-03): see lib/secrets-key.ts.
  if (!env.KITSUDEN_SECRETS_KEY?.trim()) {
    problems.push({
      variable: "KITSUDEN_SECRETS_KEY",
      reason:
        "is not set: stored secrets would be encrypted with a key derived from BETTER_AUTH_SECRET. " +
        "Generate one (openssl rand -hex 32); an install with stored secrets re-encrypts them with " +
        "scripts/rekey-secrets.ts, or sets it to the current BETTER_AUTH_SECRET to keep them as they are",
    });
  }

  return problems;
}
