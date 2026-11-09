/**
 * Can strangers create accounts? (`KITSUDEN_SIGNUP=open|closed`)
 * ============================================================================
 *
 * `readAccess: "authenticated"` means "anyone with an account": with sign-up
 * open and no way to close it, that was anyone on the internet. Closed by default
 * in production: an agent backend has no public accounts unless its operator
 * says so. A site with public accounts sets `KITSUDEN_SIGNUP=open`.
 *
 * Unset, it is closed in production, with `KITSUDEN_PUBLIC=true`, and whenever
 * the API listens beyond loopback (security review 2026-11-03: a development API
 * on `0.0.0.0` took sign-ups from the whole network). Open only for a
 * development API on 127.0.0.1/::1, the default outside production.
 *
 * An unknown value counts as closed: a typo must not open registration.
 */

import { listensBeyondLoopback } from "./listen-host";
import { publicOrProduction } from "./placeholder-secrets";

type Env = Record<string, string | undefined>;

export function signUpClosed(env: Env = process.env): boolean {
  const mode = env["KITSUDEN_SIGNUP"]?.trim().toLowerCase();
  if (mode === "open") return false;
  if (mode === "closed") return true;
  if (mode) {
    console.warn(
      `[auth] KITSUDEN_SIGNUP must be "open" or "closed": treating "${mode}" as closed.`
    );
    return true;
  }
  return publicOrProduction(env) || listensBeyondLoopback(env);
}
