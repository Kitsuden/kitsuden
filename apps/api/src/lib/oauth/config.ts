/**
 * OAuth 2.1 for MCP — configuration
 * ============================================================================
 *
 * Implements MCP authorization, revision **2026-07-28**
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
 * OAuth 2.1 with Protected Resource Metadata (RFC 9728), Authorization Server
 * Metadata (RFC 8414), Client ID Metadata Documents (preferred) and Dynamic
 * Client Registration (RFC 7591, kept for compatibility), code +
 * PKCE S256, resource indicators (RFC 8707), `iss` in the response (RFC 9207)
 * and revocation (RFC 7009). Guide: docs/agents/oauth.md.
 *
 * Everything is read from the environment ON EACH CALL (not at import): tests change
 * the values and startup does not depend on load order.
 *
 *   OAUTH_ISSUER_URL            Public URL of the API, without a path («https://api.example.com»).
 *                               It is the `issuer` and the base of the resource `<issuer>/api/mcp`.
 *                               Defaults to BETTER_AUTH_URL. In production it MUST be https.
 *   KITSUDEN_OAUTH_ENABLED      `false` turns everything off (metadata 404, endpoints 404).
 *   OAUTH_ACCESS_TOKEN_TTL      seconds (default 900; 60–3600).
 *   OAUTH_REFRESH_TOKEN_TTL     seconds of each refresh (default 30 days).
 *   OAUTH_FAMILY_MAX_TTL        maximum lifetime of a refresh family (90 days).
 *   KITSUDEN_OAUTH_CIMD         `false` turns off Client ID Metadata Documents.
 *   KITSUDEN_OAUTH_CIMD_ALLOWED_HOSTS  list of allowed hosts (empty = any public one).
 *   KITSUDEN_OAUTH_DCR          `false` turns off dynamic registration.
 *   KITSUDEN_OAUTH_CUSTOM_SCHEMES `false` rejects custom schemes (`cursor://…`).
 *   OAUTH_REGISTER_LIMIT        registrations per IP and hour (30).
 *   OAUTH_TOKEN_LIMIT           token requests per IP and minute (60).
 */

import { inProduction } from "../environment";

export const ACCESS_PREFIX = "kitsuden_oat_";
export const REFRESH_PREFIX = "kitsuden_ort_";
export const CLIENT_PREFIX = "kc_";
export const CLIENT_SECRET_PREFIX = "kcs_";

/** The minimum to work (RFC 9728 `scopes_supported`; consent may grant more). */
export const BASIC_SCOPES = ["mcp:connect", "mcp:read", "mcp:write"] as const;

/** Path of the protected MCP endpoint. */
export const MCP_ROUTE = "/api/mcp";

function number(name: string, defaultValue: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function off(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "false";
}

/** The issuer: origin only (scheme + host + port), no trailing slash. */
export function issuer(): string {
  const raw =
    process.env.OAUTH_ISSUER_URL ||
    process.env.BETTER_AUTH_URL ||
    `http://localhost:${process.env.PORT || 3000}`;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return `http://localhost:${process.env.PORT || 3000}`;
  }
}

/** The protected resource (RFC 8707 / 9728): the MCP endpoint. */
export function mcpResource(): string {
  return `${issuer()}${MCP_ROUTE}`;
}

/** URL of the resource metadata announced in `WWW-Authenticate`. */
export function resourceMetadataUrl(): string {
  return `${issuer()}/.well-known/oauth-protected-resource${MCP_ROUTE}`;
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/**
 * Is it on? Off with KITSUDEN_OAUTH_ENABLED=false, and in production
 * if the issuer is not https (MCP requires HTTPS across the whole authorization
 * server): better not to offer it than to offer it over http.
 */
export function oauthEnabled(): boolean {
  if (off("KITSUDEN_OAUTH_ENABLED")) return false;
  const u = new URL(issuer());
  if (inProduction() && u.protocol !== "https:" && !isLoopback(u.hostname)) return false;
  return true;
}

export const accessTtl = () => number("OAUTH_ACCESS_TOKEN_TTL", 900, 60, 3600);
export const refreshTtl = () => number("OAUTH_REFRESH_TOKEN_TTL", 30 * 86_400, 3600, 90 * 86_400);
export const familyTtl = () => number("OAUTH_FAMILY_MAX_TTL", 90 * 86_400, 3600, 365 * 86_400);
export const CODE_TTL_S = 60;
export const REQUEST_TTL_S = 600;

export const cimdOn = () => !off("KITSUDEN_OAUTH_CIMD");
export const dcrEnabled = () => !off("KITSUDEN_OAUTH_DCR");
export const allowedOwnSchemas = () => !off("KITSUDEN_OAUTH_CUSTOM_SCHEMES");
export const recordLimit = () => number("OAUTH_REGISTER_LIMIT", 30, 1, 10_000);
export const tokenLimit = () => number("OAUTH_TOKEN_LIMIT", 60, 1, 100_000);

export function allowedCimdHosts(): string[] {
  return (process.env.KITSUDEN_OAUTH_CIMD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** The panel's consent screen. */
export function consentUrl(requestId: string): string {
  const panel = (process.env.ADMIN_URL || "http://localhost:5173").replace(/\/+$/, "");
  return `${panel}/oauth/consent?request=${encodeURIComponent(requestId)}`;
}

/**
 * The PROTOCOL routes: their shape is fixed by the specification (
 * `application/x-www-form-urlencoded` forms, 302 redirects, RFC 6749 §5.2
 * `{ error, error_description }` errors, `.well-known` documents),
 * not by the kons SDK. apps/api/scripts/operations-coverage.ts accepts them
 * without `defineOperation` because they are HERE; they are neither legacy nor MCP tools. They are
 * served in routes/oauth.ts.
 */
export const OAUTH_PROTOCOL_ROUTES: readonly string[] = [
  "GET /.well-known/oauth-protected-resource",
  "GET /.well-known/oauth-protected-resource/api/mcp",
  "GET /.well-known/oauth-authorization-server",
  "POST /api/oauth/register",
  "GET /api/oauth/authorize",
  "POST /api/oauth/token",
  "POST /api/oauth/revoke",
];
