/**
 * OAuth for MCP — URIs, PKCE and scopes (pure functions)
 * ============================================================================
 *
 * Redirects (MCP 2026-07-28, «Communication Security» and «Open
 * Redirection»; OAuth 2.1 §2.3.1 and §8.4.2):
 *
 *   · https, or http to a loopback address (`localhost`,
 *     `127.0.0.1`, `[::1]`), or a native-app custom scheme shaped like a reversed
 *     domain (`cursor://…`, RFC 8252 §7.1; turned off with
 *     KITSUDEN_OAUTH_CUSTOM_SCHEMES=false) are REGISTERED. Never with a fragment, never
 *     `javascript:`/`data:`/`file:`.
 *   · they are COMPARED exactly, character by character. The only exception is that of
 *     OAuth 2.1 §8.4.2: on http loopback the PORT may change (native
 *     apps open a free one on each attempt).
 */

import { createHash, timingSafeEqual } from "crypto";

import { isLoopback, allowedOwnSchemas, mcpResource } from "./config";

const FORBIDDEN_SCHEMAS = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "about:",
  "blob:",
  "ftp:",
  "ws:",
  "wss:",
  // System handlers that open or run things on the machine of whoever follows
  // the link (Follina used `ms-msdt:`). No MCP client uses them.
  "search-ms:",
  "search:",
  "shell:",
  "mk:",
  "mhtml:",
  "jar:",
  "intent:",
  "smb:",
  "nfs:",
  "ldap:",
  "ldaps:",
  "res:",
  "its:",
  "hcp:",
  "telnet:",
  "ssh:",
  "tel:",
  "sms:",
  "mailto:",
]);

/** `ms-msdt:`, `ms-officecmd:`, `ms-word:`… — every Windows handler is out. */
const FORBIDDEN_SCHEMA_PREFIXES = ["ms-"];

/** `null` if the redirect URI can be registered; otherwise, the reason. */
export function invalidRedirectReason(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri || uri.length > 2000)
    return "must be a non-empty string up to 2000 characters";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "is not an absolute URI";
  }
  if (u.hash || uri.includes("#")) return "must not contain a fragment";
  if (u.username || u.password) return "must not contain credentials";
  if (u.protocol === "https:") return u.hostname ? null : "needs a host";
  if (u.protocol === "http:") {
    return isLoopback(u.hostname)
      ? null
      : "http is only allowed for loopback (localhost, 127.0.0.1, [::1]); use https";
  }
  if (
    FORBIDDEN_SCHEMAS.has(u.protocol) ||
    FORBIDDEN_SCHEMA_PREFIXES.some((p) => u.protocol.startsWith(p))
  ) {
    return `scheme '${u.protocol}' is not allowed`;
  }
  // Native-app custom scheme (RFC 8252 §7.1). A reversed
  // domain (`com.example.app`) is recommended, but real clients use their
  // name (`cursor://`, `vscode://`): any of 3+ characters is accepted
  // that is not on the forbidden list.
  const schema = u.protocol.slice(0, -1);
  if (!allowedOwnSchemas()) return "only https or loopback http redirect URIs are accepted";
  if (!/^[a-z][a-z0-9+.-]{2,}$/.test(schema))
    return "custom schemes need at least 3 characters (e.g. com.example.app)";
  return null;
}

/**
 * Does the requested redirect match any registered one? Exact; on http loopback
 * the port may differ (OAuth 2.1 §8.4.2).
 */
export function redirectMatches(registeredItems: readonly string[], requested: string): boolean {
  if (registeredItems.includes(requested)) return true;
  let p: URL;
  try {
    p = new URL(requested);
  } catch {
    return false;
  }
  if (p.protocol !== "http:" || !isLoopback(p.hostname) || p.hash) return false;
  return registeredItems.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === "http:" &&
        u.hostname === p.hostname &&
        u.pathname === p.pathname &&
        u.search === p.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  });
}

/**
 * May an /authorize error be returned with a 302 to this redirect? Only if it
 * is trustworthy (RFC 9700 §4.11): loopback http (it goes back to the machine
 * of whoever follows the link) or a client a human already approved
 * (`consented`). Otherwise the error is shown on screen.
 */
export function errorMayRedirect(redirectUri: string, consented: boolean): boolean {
  if (consented) return true;
  try {
    const u = new URL(redirectUri);
    return u.protocol === "http:" && isLoopback(u.hostname);
  } catch {
    return false;
  }
}

export const MAX_RESOURCE_LENGTH = 2000;

/**
 * Strips trailing slashes with a loop: `/\/+$/` backtracks quadratically on
 * `/////…x` (`new URL` keeps repeated slashes in the path).
 */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return path.slice(0, end);
}

/**
 * Is `request` this server's resource? MCP: the client sends the canonical
 * URI; uppercase in scheme and host, and the trailing slash are accepted.
 * Absent → `null` (the caller decides the default resource).
 */
export function requestedResource(
  request: unknown
): { ok: true; resource: string } | { ok: false } | null {
  if (request === undefined || request === null || request === "") return null;
  // A legitimate resource is never longer than 2000 characters; more is junk or an attack.
  if (typeof request !== "string" || request.length > MAX_RESOURCE_LENGTH) return { ok: false };
  try {
    const u = new URL(request);
    if (u.hash) return { ok: false };
    const normal =
      `${u.protocol}//${u.host}${withoutTrailingSlashes(u.pathname)}${u.search}`.toLowerCase();
    const our = mcpResource().toLowerCase();
    return normal === our ? { ok: true, resource: mcpResource() } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// ── PKCE (RFC 7636, S256 only) ───────────────────────────────────────────────

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function validChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE.test(challenge);
}

export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier)) return false;
  const calculated = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(calculated);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Scopes (RFC 6749 §3.3: space-separated) ─────────────────────────────────

const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** The scopes of a `scope` parameter, without duplicates or `offline_access`. `null` if the format is invalid. */
export function readScopes(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string" || value.length > 4000) return null;
  const output: string[] = [];
  for (const s of value.split(" ").filter(Boolean)) {
    if (!SCOPE_TOKEN.test(s)) return null;
    if (s === "offline_access") continue;
    if (!output.includes(s)) output.push(s);
  }
  return output.length > 200 ? null : output;
}

export function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
