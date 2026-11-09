/**
 * A request's route, fit for the log: with no tokens inside.
 * ============================================================================
 *
 * An earlier audit. There are routes whose PATH carries a one-time secret:
 * `GET /api/auth/reset-password/<token>` (better-auth, the link in the recovery
 * email), invitations and confirmations from kons. The access log
 * (`hono/logger` and the structured access-log in `telemetry.ts`)
 * wrote the path as is, so whoever read the logs (or the system
 * they are shipped to) had VALID reset tokens during their hour
 * of validity.
 *
 * What is masked:
 *   - the segment that follows a name announcing a secret
 *     (`reset-password`, `token`, `verify`, `confirm`, `invite`, `magic-link`…);
 *   - any opaque segment of 32+ characters that is not a UUID (UUIDs
 *     are row ids and are wanted in the log).
 *   - the whole query string (the `?token=` of email verification).
 */

const ANNOUNCE_SECRET = new Set([
  "reset-password",
  "token",
  "tokens",
  "verify",
  "verify-email",
  "confirm",
  "invite",
  "invites",
  "invitation",
  "magic-link",
  "unsubscribe",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function logPath(route: string): string {
  const [path] = route.split("?");
  const withQuery = path !== route;
  const segments = (path ?? "").split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const previous = segments[i - 1]?.toLowerCase();
    if (seg && previous && ANNOUNCE_SECRET.has(previous)) {
      segments[i] = "***";
    } else if (seg.length >= 32 && !UUID.test(seg) && /^[A-Za-z0-9_.~%-]+$/.test(seg)) {
      segments[i] = "***";
    }
  }
  return segments.join("/") + (withQuery ? "?***" : "");
}

/** For `hono/logger`: receives the already formatted line (`<-- GET /route`). */
export function accessLineWithoutSecrets(line: string): string {
  return line.replace(/(\s)(\/\S*)/g, (_, space: string, route: string) => space + logPath(route));
}
