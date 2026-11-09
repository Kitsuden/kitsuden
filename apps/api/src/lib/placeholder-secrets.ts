/**
 * Secrets that were never replaced
 * ============================================================================
 *
 * The example files ship values such as `<GENERATE_A_SECURE_SECRET_MIN_32_CHARS>`
 * or `cambiame-en-produccion`. They are public, and they can be long enough to
 * pass a length check. No dependencies here: `config.ts` and `public-config.ts`
 * both use this before anything else has loaded.
 */

import { readEnv } from "@kitsuden/shared";

/** The variables that hold a secret and that the example files ship with a placeholder. */
export const SECRET_VARIABLES = [
  "BETTER_AUTH_SECRET",
  "KITSUDEN_SECRETS_KEY",
  "SITE_API_KEY",
  "APP_DB_PASSWORD",
] as const;

type Env = Record<string, string | undefined>;

export function isPlaceholderSecret(value: string): boolean {
  const v = value.trim();
  return v.startsWith("<") || /change[-_]?me|cambiame|generate/i.test(v);
}

/** The names (never the values) of the secrets that still hold a placeholder. */
export function placeholderSecrets(env: Env): string[] {
  return SECRET_VARIABLES.filter((name) => {
    const value = readEnv(name, env);
    return typeof value === "string" && value.trim() !== "" && isPlaceholderSecret(value);
  });
}

/** Production, or an installation that declares itself exposed to the internet. */
export function publicOrProduction(env: Env): boolean {
  return env["NODE_ENV"] === "production" || env["KITSUDEN_PUBLIC"] === "true";
}
