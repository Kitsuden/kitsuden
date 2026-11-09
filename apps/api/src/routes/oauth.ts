/**
 * OAuth 2.1 for MCP — HTTP routes
 * ============================================================================
 *
 * MCP Authorization, revision 2026-07-28. Guide: docs/agents/oauth.md.
 *
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728 (public)
 *   GET  /.well-known/oauth-authorization-server            RFC 8414 (public)
 *   POST /api/oauth/register                                RFC 7591 (public, limited)
 *   GET  /api/oauth/authorize                               code + PKCE S256 → panel
 *   POST /api/oauth/token                                   code / refresh (public, limited)
 *   POST /api/oauth/revoke                                  RFC 7009 (public)
 *
 *   Panel consent and connections: routes/oauth-panel.ts (SDK).
 *
 * The public endpoints respond with open CORS and no credentials
 * (`oauthCors`): browser MCP clients call them from their own origin.
 * `mcpChallenge` adds `WWW-Authenticate` to the 401/403s of /api/mcp.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { Hono } from "hono";

import { clientIp } from "../lib/client-ip";
import { logger } from "../lib/logger";
import {
  BASIC_SCOPES,
  dcrEnabled,
  cimdOn,
  issuer,
  recordLimit,
  tokenLimit,
  oauthEnabled,
  mcpResource,
  resourceMetadataUrl,
} from "../lib/oauth/config";
import {
  ErrorOAuth,
  authenticateClient,
  redeemCode,
  recentPendingClients,
  startAuthorization,
  refresh,
  registerClient,
  revokeToken,
} from "../lib/oauth/service";
import { rateLimit } from "../lib/rate-limiter";

export const oauthRoutes = new Hono();

const PUBLIC_ITEMS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/api/oauth/register",
  "/api/oauth/token",
  "/api/oauth/revoke",
];

const isPublic = (path: string) => PUBLIC_ITEMS.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * CORS of the PUBLIC OAuth endpoints: any origin, no cookies (they do not
 * use them: the client authenticates in the body or with Basic). It goes BEFORE the
 * global CORS, which only knows the origins of the panel and the websites.
 */
export function oauthCors(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isPublic(c.req.path)) return next();
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    await next();
    const headers = new Headers(c.res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.delete("Access-Control-Allow-Credentials");
    const res = c.res;
    c.res = undefined as unknown as Response;
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * `WWW-Authenticate` on the rejections of /api/mcp (MCP 2026-07-28, RFC 9728
 * §5.1 and RFC 6750 §3): on 401 the `resource_metadata` and the basic scopes
 * (`invalid_token` if a token was sent); on a 403 for scopes,
 * `insufficient_scope`.
 */
export function mcpChallenge(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    await next();
    if (!oauthEnabled()) return;
    const status = c.res.status;
    if (status !== 401 && status !== 403) return;
    const withToken = /^bearer\s+\S/i.test(c.req.header("authorization") ?? "");
    let value: string;
    if (status === 401) {
      value =
        `Bearer resource_metadata="${resourceMetadataUrl()}", scope="${BASIC_SCOPES.join(" ")}"` +
        (withToken ? `, error="invalid_token"` : "");
    } else {
      // Only the "missing mcp:connect" 403 is about scope; other 403s say nothing new.
      const text = await c.res
        .clone()
        .text()
        .catch(() => "");
      if (!/mcp:connect/.test(text)) return;
      value = `Bearer error="insufficient_scope", scope="mcp:connect", resource_metadata="${resourceMetadataUrl()}"`;
    }
    const headers = new Headers(c.res.headers);
    headers.set("WWW-Authenticate", value);
    const res = c.res;
    c.res = undefined as unknown as Response;
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** Everything off with KITSUDEN_OAUTH_ENABLED=false (or https missing in production). */
// By path, NOT with "*": this router is mounted at "/" and a "*" would stop the whole API.
const ifEnabled: MiddlewareHandler = async (c, next) => {
  if (!oauthEnabled())
    return c.json({ error: "not_found", error_description: "OAuth is disabled" }, 404);
  return next();
};
oauthRoutes.use("/api/oauth/*", ifEnabled);
oauthRoutes.use("/.well-known/oauth-protected-resource", ifEnabled);
oauthRoutes.use("/.well-known/oauth-protected-resource/*", ifEnabled);
oauthRoutes.use("/.well-known/oauth-authorization-server", ifEnabled);

// ── Metadata ─────────────────────────────────────────────────────────────────

function resourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...BASIC_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Kitsuden MCP",
    resource_documentation: `${issuer()}/llms.txt`,
  };
}

const withoutCache = (c: Context) => c.header("Cache-Control", "public, max-age=300");

oauthRoutes.get("/.well-known/oauth-protected-resource", (c) => {
  withoutCache(c);
  return c.json(resourceMetadata());
});
oauthRoutes.get("/.well-known/oauth-protected-resource/api/mcp", (c) => {
  withoutCache(c);
  return c.json(resourceMetadata());
});

oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  withoutCache(c);
  const base = issuer();
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    ...(dcrEnabled() ? { registration_endpoint: `${base}/api/oauth/register` } : {}),
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    scopes_supported: [...BASIC_SCOPES],
    client_id_metadata_document_supported: cimdOn(),
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/llms.txt`,
  });
});

// ── Errors in OAuth's shape ─────────────────────────────────────────────────

function errorOAuth(c: Context, e: unknown): Response {
  c.header("Cache-Control", "no-store");
  if (e instanceof ErrorOAuth) {
    if (e.status === 401 && /basic/i.test(c.req.header("authorization") ?? "")) {
      c.header("WWW-Authenticate", `Basic realm="${issuer()}"`);
    }
    return c.json({ error: e.error, error_description: e.description }, e.status as 400);
  }
  logger.error({ err: e, path: c.req.path }, "[oauth] unexpected error");
  return c.json({ error: "server_error", error_description: "Unexpected error" }, 500);
}

/** The parameters of an OAuth POST: form (the usual) or JSON. */
async function parameters(c: Context): Promise<Record<string, string>> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  let raw: Record<string, unknown> = {};
  if (type.includes("application/json")) {
    const j = await c.req.json().catch(() => null);
    if (j && typeof j === "object" && !Array.isArray(j)) raw = j as Record<string, unknown>;
  } else if (
    type.includes("application/x-www-form-urlencoded") ||
    type.includes("multipart/form-data")
  ) {
    raw = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  } else {
    throw new ErrorOAuth(
      "invalid_request",
      "Send the parameters as application/x-www-form-urlencoded"
    );
  }
  const output: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") output[k] = v;
  return output;
}

// ── Limits (per IP; they fail closed: with no counter, nothing is registered or issued) ──

const limit = (space: string, limit: () => number, timeWindow: number): MiddlewareHandler =>
  ((c: Context, next: Next) =>
    rateLimit({
      limit: limit(),
      window: timeWindow,
      space,
      failClosed: true,
      message: "Too many OAuth requests. Try again later.",
    })(c as never, next)) as MiddlewareHandler;

// ── Dynamic registration (RFC 7591; MCP 2026-07-28 keeps it for compatibility) ──

/** Cap on clients registered without consent in 24 h, per source network (/24, /48). */
const MAX_PENDING = () => Number(process.env.OAUTH_MAX_PENDING_CLIENTS) || 1000;

oauthRoutes.post("/api/oauth/register", limit("oauth-register", recordLimit, 3600), async (c) => {
  if (!dcrEnabled())
    return c.json(
      { error: "not_found", error_description: "Dynamic Client Registration is disabled" },
      404
    );
  c.header("Cache-Control", "no-store");
  try {
    if ((await recentPendingClients(clientIp(c) ?? null)) >= MAX_PENDING()) {
      c.header("Retry-After", "3600");
      return c.json(
        {
          error: "temporarily_unavailable",
          error_description: "Too many pending client registrations",
        },
        429
      );
    }
    const body = await c.req.json().catch(() => undefined);
    const registeredValue = await registerClient(body, clientIp(c) ?? null);
    return c.json(registeredValue, 201);
  } catch (e) {
    return errorOAuth(c, e);
  }
});

// ── Authorization ────────────────────────────────────────────────────────────

function errorScreen(c: Context, error: string, description: string): Response {
  // No redirect to a URI that could not be validated (MCP: open redirection).
  c.header("Cache-Control", "no-store");
  return c.json({ error, error_description: description }, 400);
}

oauthRoutes.get("/api/oauth/authorize", limit("oauth-authorize", tokenLimit, 60), async (c) => {
  try {
    const r = await startAuthorization(c.req.query());
    if (r.type === "screen") return errorScreen(c, r.error, r.description);
    c.header("Cache-Control", "no-store");
    return c.redirect(r.url, 302);
  } catch (e) {
    return errorOAuth(c, e);
  }
});

// ── Token ────────────────────────────────────────────────────────────────────

oauthRoutes.post("/api/oauth/token", limit("oauth-token", tokenLimit, 60), async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  try {
    const p = await parameters(c);
    // First the shape of the request (400), then who is making it (401)
    if (!p.grant_type) throw new ErrorOAuth("invalid_request", "grant_type is required");
    if (p.grant_type !== "authorization_code" && p.grant_type !== "refresh_token") {
      throw new ErrorOAuth(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported (no implicit, password or client_credentials)"
      );
    }
    const client = await authenticateClient(c.req.header("authorization"), p);
    if (p.grant_type === "authorization_code") return c.json(await redeemCode(client, p));
    if (p.grant_type === "refresh_token") return c.json(await refresh(client, p));
    throw new ErrorOAuth(
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported (no implicit, password or client_credentials)"
    );
  } catch (e) {
    return errorOAuth(c, e);
  }
});

oauthRoutes.post("/api/oauth/revoke", limit("oauth-revoke", tokenLimit, 60), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const p = await parameters(c);
    if (!p.token) throw new ErrorOAuth("invalid_request", "token is required");
    const client = await authenticateClient(c.req.header("authorization"), p);
    await revokeToken(client, p.token);
    return c.body(null, 200);
  } catch (e) {
    return errorOAuth(c, e);
  }
});

// ── Panel: consent and connections → routes/oauth-panel.ts (SDK) ─────────
