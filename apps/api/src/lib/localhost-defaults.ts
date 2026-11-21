/**
 * Production on localhost defaults: a loud warning, not a refusal
 * ============================================================================
 *
 * `config.ts` gives `BETTER_AUTH_URL`, `ADMIN_URL`, `WEB_URL` and
 * `ALLOWED_ORIGINS` localhost defaults so a laptop starts with no `.env`. In
 * production those defaults are almost always a forgotten variable: the panel
 * cannot call the API, OAuth callbacks and email links point at localhost.
 *
 * Public mode (`KITSUDEN_PUBLIC=true`) already refuses to start in that state
 * (`public-config.ts`). Outside it, a production build on a LAN or a laptop
 * may use localhost on purpose, so refusing would break those installs. The
 * failure is visible (things stop working), not a hole, so a warning that names
 * each variable is enough (security audit 2026-11-19, note H6).
 *
 * No dependencies: `config.ts` imports it before anything else is loaded.
 */

type Environment = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith(".localhost");
}

function pointsToLocalhost(value: string): boolean {
  try {
    return isLocalHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** The URL variables a production install should set to its real address. */
export const URL_VARIABLES = ["BETTER_AUTH_URL", "ADMIN_URL", "WEB_URL"] as const;

/**
 * One line per variable that, in production outside public mode, is unset (so
 * the localhost default applies) or points at localhost. Empty elsewhere.
 */
export function localhostDefaultWarnings(env: Environment = process.env): string[] {
  if (env.NODE_ENV !== "production" || env.KITSUDEN_PUBLIC === "true") return [];
  const warnings: string[] = [];

  for (const name of URL_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) warnings.push(`${name} is not set: the localhost default is in use`);
    else if (pointsToLocalhost(value)) warnings.push(`${name} points to localhost (${value})`);
  }

  const origins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    warnings.push("ALLOWED_ORIGINS is not set: only the localhost defaults may call the API");
  } else if (origins.every(pointsToLocalhost)) {
    warnings.push(`ALLOWED_ORIGINS lists only localhost origins (${origins.join(", ")})`);
  }

  return warnings;
}
