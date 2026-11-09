/**
 * Kitsuden - Hono API Server v0.9.0-beta (Actions Unification)
 *
 * Runtime: Bun + Hono
 * Auth: Better-Auth (cookie sessions)
 * Queue: Postgres (transactional outbox + SKIP LOCKED; lib/queue.ts)
 * Real-time: WebSocket + Pub/Sub (Valkey optional; without it, LISTEN/NOTIFY)
 * Actions: Unified Workers + Webhooks + Agents engine
 *
 * 3-Tier Architecture:
 *   - ENGINE (Tier 1): Auth, DB, Actions — always active (packages/engine/)
 *   - CORE   (Tier 2): Data Sets, Media, Connectors — switchable (packages/core/)
 *   - KONS (Tier 3): Business modules — loaded via module-loader (packages/kons/)
 *
 *   - actions table replaces kitsuden_functions + webhooks
 *   - ActionEngine handles all automation types
 *   - Legacy APIs maintained for backward compatibility
 */

import {
  initActions,
  initializeKons,
  defineAction,
  initKitsudenBrain,
  mail,
  messageOf,
} from "@kitsuden/engine";
import type { ServerWebSocket } from "bun";
import { eq, count, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";

// ── Configuration ──
import { registerMountedOperations } from "../../../packages/engine/src/operations";
import { staticConfig as kitsudenConfig } from "../kitsuden.config";

import { db } from "./db";
import {
  authUsers as user,
  siteSettings,
  apiKeys,
  media as mediaTable,
  dataSets as dataSetsTable,
} from "./db/schema-core";
import { initActionsEngine } from "./lib/actions";
import { adminMfaGate } from "./lib/admin-mfa";
import { generateAgentGuide } from "./lib/agent-guide";
import { agentQuotas } from "./lib/agent-quotas";
import {
  startProposalSweep,
  internalExecutionOf,
  executionAlreadyBilled,
  setApprovalsApp,
  approvalGate,
  directEvidence,
  agentUser,
} from "./lib/approvals";
import { auth } from "./lib/auth";
import { bodyLimit } from "./lib/body-limit";
import { clientIp } from "./lib/client-ip";
import { config, features, corsConfig } from "./lib/config";
import { incompleteCorsWarning, allowedOrigin } from "./lib/cors-origins";
import { registerCriticalFeatures } from "./lib/critical-features";
import { initCronScheduler } from "./lib/cron-scheduler";
import { availableKon } from "./lib/deferred-kons";
import { inProduction } from "./lib/environment";
import { toErrorEnvelope } from "./lib/errors";
import { fileBody, file } from "./lib/file";
import {
  adminExists,
  announceSetupTokenAtBoot,
  createFirstAdmin,
  ensureSetupToken,
  setupTokenRequired,
  signUpRefused,
} from "./lib/first-run";
import { initFunctionDispatcher } from "./lib/function-dispatcher";
import { defaultStores } from "./lib/idempotency-stores";
import { canSuggest, konRoutes, suggestRoutes } from "./lib/kon-routes";
import { listenHost } from "./lib/listen-host";
import { logger } from "./lib/logger";
import { configureModelEmbeddings } from "./lib/model-embeddings";
import { loadModules, createKonContext, getLoadReport, mountKonRls } from "./lib/module-loader";
import { startOAuthSweep } from "./lib/oauth/service";
import { poolExhaustedTo503 } from "./lib/pool-exhausted";
import { activateMiddlewareProfile } from "./lib/profile-middleware";
import { startWatchesSweep } from "./lib/promotion";
import { setupWorkers, emailQueue, queueStatus, shutdownQueues } from "./lib/queue";
import { realtimeManager, type WSClientData } from "./lib/realtime";
import { wireRealtimeAuthorization, bridgeEventsToRealtime } from "./lib/realtime-wiring";
import { verifyRlsConnection } from "./lib/rls-connection-guard";
import { accessLineWithoutSecrets, logPath } from "./lib/route-for-log";
import { sitePublicUrl } from "./lib/site-settings";
import {
  BASE_URL_LOCAL,
  MEDIA_CSP,
  mediaCache,
  checkStorage,
  localPathOf,
  usesS3,
} from "./lib/store";
import { toonMiddleware } from "./lib/toon";
import { toonProtocolMiddleware } from "./lib/toon-protocol";
import { startTraces, stopTraces, requestTraces } from "./lib/traces";
import { closeValkey, valkeyConfigured } from "./lib/valkey";
import { registerSystemMails } from "./mail/system-mails";
import {
  requireAdminRole,
  requireStaff,
  adminGate,
  agentDenials,
  ADMIN_ONLY_ROUTES,
  EARLY_ADMIN_ONLY_ROUTES,
} from "./middleware/auth-guard";
import { errorsWithoutDetail } from "./middleware/errors-without-detail";
import { idempotency } from "./middleware/idempotency";
import { httpProblems } from "./middleware/problems-http";
import { requestContextMiddleware, accessLogAndMetrics } from "./middleware/telemetry";
import { withTransactionalRLS } from "./middleware/transactional-rls";
import { enrichUserContext } from "./middleware/user-context";
import { requireOriginOnWrites } from "./middleware/write-origin";
import { actionsRoutes } from "./routes/actions";
import { adminRegistryRoutes } from "./routes/admin-registry";
import { systemAdminRoutes } from "./routes/admin-system";
import { agentDecisionsRoutes } from "./routes/agent-decisions";
import agentMemoryRoutes from "./routes/agent-memory";
import { agentNotificationsRoutes } from "./routes/agent-notifications";
import { agentPermissionsRoutes } from "./routes/agent-permissions";
import agentPlaygroundRoutes from "./routes/agent-playground";
import { EXTERNAL_MCP_ROUTE, externalMcpRoutes } from "./routes/mcp-servers";
import { queueRoutes } from "./routes/queue";
import { tracesRoutes } from "./routes/traces";
// ── A1: problem+json errors and Idempotency-Key (own block) ──

// ── Feature Flags ──

// ── Core Layer Routes (Tier 2) — Imported through packages/core/ ──
// NOTE: media-library and data-sets have been migrated to kons
// Legacy core imports removed — now provided by kons

// ── Engine Routes (Tier 1) — Always-on infrastructure ──
import agentRoutes from "./routes/agents";
import { apiKeysRoutes } from "./routes/api-keys";
import { brainRoutes } from "./routes/brain";
import {
  brainMemoryRoutes,
  memoryOperations,
  MEMORY_KON,
  MEMORY_ROUTE,
} from "./routes/brain-memory";
import { codeGraphRoutes } from "./routes/code-graph";
import { codegenRoutes } from "./routes/codegen";
import { settingsRoutes, syncRoutes, dataSetsRoutes as dataSetsLiteRoutes } from "./routes/crud";
import { explorerRoutes } from "./routes/data-explorer";
import dataSourcesRoutes from "./routes/data-sources";
import { docsRoutes } from "./routes/docs";
import { dynamicDocsRouter } from "./routes/docs-dynamic";
import { mailRoutes } from "./routes/mail";
import { runsRoutes } from "./routes/runs";
import { systemMapRoutes } from "./routes/system-map";
import { functionsRoutes } from "./routes/functions";
import { graphqlRoutes, invalidateGraphQLCache } from "./routes/graphql";
import { setKonAvailability, versionRoutes } from "./routes/version";
import { rpcSurface } from "./rpc";
import {
  authenticateAgent,
  isAgentCredential,
  rememberRequestAuthentication,
} from "./services/agent-auth";
import type { AgentAuthContext } from "./services/agent-auth";
import { initAgentTelemetry } from "./services/agent-telemetry";
import { loadSecretsIntoEnv } from "./services/secrets";
import { inlineRelationsRoutes } from "./routes/inline-relations";
import { mcpRoutes } from "./routes/mcp";
import { oauthCors, mcpChallenge, oauthRoutes } from "./routes/oauth";
import { oauthPanelRoutes } from "./routes/oauth-panel";
import { modulesRoutes } from "./routes/modules";
import konAssetsRoutes from "./routes/kon-assets";
import { schemaIntrospectionRoutes } from "./routes/schema-introspection";
import { systemRoutes } from "./routes/system";

// ── Module Loader ──

// ── Actions Layer Integration (Tier 1 DX) ──

// ── Typed Hono app ──
const app = new Hono<{
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
    requestId: string;
    agent?: AgentAuthContext;
    userRoleIds?: string[];
    userDepartmentId?: string | null;
  };
}>();

// Only for measuring (scripts/bench): with KITSUDEN_PROFILE_MIDDLEWARE=<file>
// each `app.use` is wrapped to record its own time. Off = nothing.
activateMiddlewareProfile(app);

// ══════════════════════════════════════════════
// ⚙️ GLOBAL MIDDLEWARE
// ══════════════════════════════════════════════

// OAuth for MCP (docs/agents/oauth.md): the PUBLIC OAuth endpoints
// (metadata, registration, token, revocation) with open CORS and no cookies, and
// `WWW-Authenticate` on the 401/403s of /api/mcp. Before the global CORS and
// authentication, to wrap their responses.
app.use("*", oauthCors());
app.use("/api/mcp", mcpChallenge());
app.use("/api/mcp/*", mcpChallenge());

// CORS — MUST be first middleware to handle OPTIONS preflight
// before rate limiter or any other middleware can reject the request
app.use(
  "*",
  cors({
    // Only the fixed list: there are no longer wiki or esports subdomains (see cors-origins)
    origin: allowedOrigin(corsConfig.origins),
    allowMethods: corsConfig.methods,
    allowHeaders: corsConfig.headers,
    credentials: corsConfig.credentials,
  })
);

/**
 * And a warning is logged at startup if the public site is missing from the list.
 *
 * Without this, the failure is discovered when someone tries to comment: the site
 * loads, the API answers everything public, and only calls with
 * credentials blow up. Better one ugly line at startup.
 */
void sitePublicUrl()
  .then((url) => {
    const warning = incompleteCorsWarning(corsConfig.origins, url);
    if (warning) logger.warn({ origins: corsConfig.origins }, `⚠️  ${warning}`);
  })
  .catch(() => {
    // Without a database it cannot be checked; startup continues
  });

// Trace context (W3C) + requestId — must go BEFORE everything so that
// AsyncLocalStorage is available in the rest of the pipeline (logs, metrics).
app.use("*", requestContextMiddleware());
// ── A1: all /api/* errors as application/problem+json (RFC 9457) ──
// OUTSIDE the exhausted pool and errorsWithoutDetail: it shapes their
// responses without changing what is shown. See middleware/problems-http.ts.
app.use("*", httpProblems());
// Postgres pool exhausted → 503 + Retry-After (even if a kon catches it and
// answers 500 on its own). Outside errorsWithoutDetail and onError.
app.use("*", poolExhaustedTo503());

// In production, 5xx responses do not show their internal detail (SQL, paths, stack) to
// anyone who is not admin. See middleware/errors-without-detail.ts.
app.use("*", errorsWithoutDetail(inProduction));

// Bounded request body (10 MB; file uploads carry their own limit).
// Ver lib/body-limit.ts.
app.use("/api/*", bodyLimit());

// ═══════════════════════════════════════════════
// CRITICAL FEATURES - Rate limiting, search & observability
// Global Valkey-based rate limiting, search engine and observability
// routes are mounted together by registerCriticalFeatures. This is placed
// before public routes so the global /api/* rate limiter runs before the
// auth/session middleware and protects all API routes registered later.
// ═══════════════════════════════════════════════
// CSRF: a write authenticated with the cookie must come from one of our
// origins (ALLOWED_ORIGINS + better-auth's) or from the same host. See
// middleware/write-origin.ts. Before everything that answers without
// calling `next()` (`/api/system`, `/api/admin/system`, `/api/search`, the rate-limit
// admin): there is no session yet at this point, so it looks at the cookie itself.
const writeOrigins = [
  ...new Set([
    ...corsConfig.origins,
    ...((auth.options as { trustedOrigins?: unknown }).trustedOrigins instanceof Array
      ? (auth.options as { trustedOrigins: string[] }).trustedOrigins
      : []),
  ]),
];
app.use(
  "*",
  requireOriginOnWrites(() => writeOrigins)
);

// `KITSUDEN_ADMIN_MFA=required`: an admin session without a confirmed second
// factor reaches only better-auth (where it enrols) and the panel's public reads.
// Before every other gate, so no route mounted early escapes it. Off by default:
// one environment read. See lib/admin-mfa.ts.
app.use(
  "*",
  adminMfaGate((headers, fresh) =>
    auth.api.getSession({ headers, ...(fresh ? { query: { disableCookieCache: true } } : {}) })
  )
);

// Panel routes mounted BEFORE the global session middleware
// (observability under `/admin/*`, limits, search index, `/api/system`):
// admin only. See EARLY_ADMIN_ONLY_ROUTES in middleware/auth-guard.ts.
app.use("*", adminGate(EARLY_ADMIN_ONLY_ROUTES));

registerCriticalFeatures(app);

// ═══════════════════════════════════════════════
// STRUCTURED ACCESS LOG + SLI METRICS
// Measures every request (status + latency → MetricsRegistry) and emits a
// structured access log already correlated with trace_id/span_id. See middleware/telemetry.ts.
// ═══════════════════════════════════════════════
app.use("*", accessLogAndMetrics());
// The "glass box": one trace per request in Postgres,
// in batches and with reads sampled. See lib/traces.ts.
app.use("*", requestTraces());
startTraces();

// ═══════════════════════════════════════════════
// DYNAMIC CORS - Configurable via env
// ═══════════════════════════════════════════════
// No tokens in the log: `GET /api/auth/reset-password/<token>` carries the
// secret in the path (see lib/route-for-log.ts).
app.use(
  "*",
  honoLogger((line: string, ...rest: string[]) =>
    console.log(accessLineWithoutSecrets(line), ...rest)
  )
);
app.use("*", timing());
/**
 * Security headers, with ONE exception: `/media`.
 *
 * `secureHeaders()` sets `Cross-Origin-Resource-Policy:
 * same-origin` by default, which is right for the API —its responses must not be
 * readable from another website— and WRONG for `/media`, which is public
 * content meant to be embedded by the public sites from their own
 * domain. With `same-origin`, the browser downloaded the image, received it
 * whole with a 200… and refused to paint it. No error appeared on the
 * page: just a blank gap.
 *
 * It happened when hosting card images in-house: the first five game sites
 * moved to `/media` were left without a single visible image. It also
 * explains any image uploaded from the panel that did not show up on
 * the public sites.
 *
 * It is not enough to set the header on the `/media` route: `secureHeaders`
 * writes its own AFTER the handler and would overwrite it. That is why the
 * configuration is chosen beforehand, by route.
 */
const safeHeaders = secureHeaders();
const mediaHeaders = secureHeaders({ crossOriginResourcePolicy: "cross-origin" });
app.use("*", (c, next) =>
  (c.req.path.startsWith(`${BASE_URL_LOCAL}/`) ? mediaHeaders : safeHeaders)(c, next)
);
app.use("/api/*", toonMiddleware());
app.use("/api/*", toonProtocolMiddleware());
// NOTE: CORS is mounted ABOVE (before rate limiter) to handle OPTIONS preflight correctly

// ══════════════════════════════════════════════
// 🔓 PUBLIC ROUTES (BEFORE AUTH)
// ══════════════════════════════════════════════

app.get("/api/system/init-check", async (c) => {
  try {
    const initialized = await adminExists();
    // A token can go missing while the API is up (the last admin was deleted).
    if (!initialized && setupTokenRequired()) ensureSetupToken();
    return c.json({ initialized, setupTokenRequired: !initialized && setupTokenRequired() });
  } catch (error: unknown) {
    // The detail goes to the log, not the body: this route is PUBLIC and prior to
    // authentication, and a Drizzle failure message carries the whole SQL
    // with table and column names.
    logger.error({ err: error }, "[init-check] failed checking users");
    return c.json({ initialized: true, setupTokenRequired: false });
  }
});

app.post("/api/system/setup", async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

    /**
     * Admin AND verified.
     *
     * With email verification mandatory, SetupView does `signIn` right
     * after: without marking `emailVerified` here, whoever installs the platform
     * would be locked out of their own instance in the first second, waiting for an
     * email that on a freshly made installation there is no way to send yet.
     *
     * Marking it widens nothing: whoever gets here has the token from the log and there is
     * no administrator, so they are the one setting up the installation.
     */
    const outcome = await createFirstAdmin(body, async (tx, userId) => {
      await tx.update(user).set({ role: "admin", emailVerified: true }).where(eq(user.id, userId));
    });
    if (!outcome.ok) return c.json({ error: outcome.error, code: outcome.code }, outcome.status);
    const { name, email } = outcome.user;
    console.log(`[setup] User ${email} promoted to admin`);

    const [settings] = await db.select().from(siteSettings).limit(1);
    if (!settings) {
      await db.insert(siteSettings).values({ siteName: "Kitsuden CMS" });
    }

    try {
      await emailQueue.add("system.welcome", { to: email, name } as any);
    } catch {}

    return c.json({ success: true, user: outcome.user });
  } catch (e: unknown) {
    // Same as init-check: public and no auth. It returned `e.message`, which on a
    // query failure is the full SQL PLUS the parameters — that is, the
    // schema and the email that had just been submitted, to whoever called.
    logger.error({ err: e }, "[setup] failed creating the first administrator");
    return c.json({ error: "Setup failed" }, 500);
  }
});

app.route("/api/system", systemRoutes);

// ── System: users and schema status ─────────────────────────────────────────
//
// What the PLATFORM administers and not a kon. It fills the gap left by the
// generic table viewer when it was retired: users and migration status
// belong to no kon and had no screen anywhere.
//
// Everything requires the `admin` role. See `routes/admin-system.ts`.
app.use("/api/admin/system", requireAdminRole);
app.use("/api/admin/system/*", requireAdminRole);
app.route("/api/admin/system", systemAdminRoutes);
// The path it had before (`/api/sistema`, Spanish); kept so existing clients keep working.
app.use("/api/sistema", requireAdminRole);
app.use("/api/sistema/*", requireAdminRole);

// ══════════════════════════════════════════════
// 🔐 AUTH & SESSION (Including Agent NHI)
// ══════════════════════════════════════════════

import { createHash } from "crypto";

/** Retirement of `kitsuden_sk_*` keys (announced in the `Sunset` header). */
const LEGACY_KEYS_END = Date.UTC(2026, 7, 1);

import { approvalsRoutes, proposalsRoutes } from "./routes/approvals";
import { modelsRoutes, MODELS_ROUTE } from "./routes/models";
import {
  PROMOTION_KON,
  PROMOTION_ROUTE,
  ADMIN_PROMOTION_ROUTE,
  promotionOperations,
  promotionAdminRoutes,
  promotionRoutes,
} from "./routes/promotion";

// Extend Hono context types - agent is now defined in app Variables type above

app.use("*", async (c, next) => {
  // An APPROVED proposal is executed by re-entering the app with
  // the agent identity set by the process itself in `env` (there is no
  // clear key to forward). It cannot be forged from the network: Bun only
  // passes `{ ip }`. See lib/approvals.ts.
  const internal = internalExecutionOf(c);
  if (internal) {
    c.set("agent", internal.agent);
    c.set("user", agentUser(internal.agent) as never);
    c.set("session", null);
    return next();
  }

  // Skip session extraction for Better-Auth endpoints to avoid conflicts
  if (c.req.path.startsWith("/api/auth/")) {
    return next();
  }

  const authHeader = c.req.header("Authorization");

  // 1. AGENT AUTH (NHI - Non-Human Identity) - NEW SYSTEM
  // Format: Bearer kitsuden_agent_xxxxx (the legacy grm_agent_* no longer: see
  // ACCEPTED_API_KEY_PREFIXES en services/agent-auth).
  // OAuth for MCP (0055): also `kitsuden_oat_*`, which is only valid on /api/mcp.
  if (authHeader?.startsWith("Bearer ") && isAgentCredential(authHeader.slice(7).trim())) {
    const rawToken = authHeader.replace("Bearer ", "").trim();

    const result = await authenticateAgent(rawToken, {
      // The real IP, not the raw header (spoofable)
      ipAddress: clientIp(c),
      userAgent: c.req.header("user-agent") || undefined,
      // The audience of an OAuth token (RFC 8707): checked against the path
      route: c.req.path,
    });

    if (result.success && result.context) {
      // `/api/mcp` reuses it instead of authenticating again (see agent-auth)
      rememberRequestAuthentication(c.req.raw, rawToken, result);
      // Set agent context
      c.set("agent", result.context);

      // Also set as user for compatibility with existing middleware
      c.set("user", {
        id: result.context.agentId,
        name: result.context.agentName,
        email: `agent@${result.context.agentId}.kitsuden.local`,
        image: null,
        role: "agent", // Not admin - granular permissions via scopes
        scopes: result.context.scopes,
        // Who signs what it creates (see @kitsuden/shared signer.ts)
        sponsor: result.context.sponsor ?? null,
      } as any);
      c.set("session", null);

      // Add rate limit headers
      c.header("X-Agent-Id", result.context.agentId);
      c.header("X-RateLimit-Limit", result.context.rateLimit.toString());

      return next();
    } else {
      // The key could not be CHECKED (the database did not answer: pool exhausted,
      // Postgres down): it still does not get in, but it is a retryable 503, not
      // a 401 telling the agent its key is not valid (measured with 200
      // connections, 2026-10-27).
      if (result.code === "AUTH_ERROR") {
        c.header("Retry-After", "5");
        return c.json(
          { error: "Authentication is temporarily unavailable", code: result.code },
          503
        );
      }
      return c.json(
        {
          error: result.error || "Agent authentication failed",
          code: result.code,
        },
        401
      );
    }
  }

  // 2. LEGACY Machine Auth (API Keys) - DEPRECATED
  // Migration: Use Agent NHI tokens (kitsuden_agent_*) instead.
  // Sunset date: 2026-08-01 — kitsuden_sk_* keys will stop working after this date.
  // The retirement date had passed and the code still accepted them — as a synthetic
  // ADMIN. Now it is enforced: 401 with the reason.
  if (authHeader?.startsWith("Bearer kitsuden_sk_") && Date.now() >= LEGACY_KEYS_END) {
    return c.json(
      {
        error: "Legacy API keys (kitsuden_sk_*) were retired on 2026-08-01",
        code: "LEGACY_KEY_RETIRED",
      },
      401
    );
  }
  if (authHeader?.startsWith("Bearer kitsuden_sk_")) {
    const rawToken = authHeader.replace("Bearer ", "").trim();
    const keyHash = createHash("sha256").update(rawToken).digest("hex");

    const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);

    if (apiKey) {
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return c.json({ error: "API Key expired" }, 401);
      }

      // Update lastUsedAt asynchronously (fire and forget)
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id))
        .execute()
        .catch(() => {});

      // Deprecation warnings
      logger.warn(
        { keyId: apiKey.id, path: logPath(c.req.path) },
        "[DEPRECATION] Legacy API key (kitsuden_sk_*) used. Migrate to Agent NHI (kitsuden_agent_*)."
      );
      c.header("Deprecation", "kitsuden_sk_*; kitsuden_agent_*");
      c.header("Sunset", "2026-08-01");

      // Inject synthetic Admin user
      c.set("user", {
        id: "machine-" + apiKey.id,
        name: apiKey.name,
        email: "machine@kitsuden.local",
        image: null,
        role: "admin",
      } as any);
      c.set("session", null);
      return next();
    }
  }

  // 3. Human Auth (Better-Auth Cookies)
  let s = await auth.api.getSession({ headers: c.req.raw.headers });
  // The session cookie caches the role for 5 minutes: a demoted admin kept what
  // its role opens on every route that trusts `user` (`/api/runs`, `/api/graph`,
  // the lite datasets). A privileged role is always read from the database.
  const cookieRole = (s?.user as { role?: string } | undefined)?.role;
  if (cookieRole === "admin" || cookieRole === "editor") {
    s = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    });
  }
  c.set("user", s?.user || null);
  c.set("session", s?.session || null);
  await next();
});

// Enrich user context with ACL fields (roles, department)
// Must run after auth middleware so that `user` is already populated
app.use("*", enrichUserContext);

// Panel surface (items, modules, functions, actions, explorer,
// GraphQL…): admin only. Before, any account —or none— was enough, and signup
// is open. See ADMIN_ONLY_ROUTES in middleware/auth-guard.ts.
// Per-agent quotas (minute, writes and daily budget; 429
// problem+json) and their `!pattern` denials, BEFORE the gates. See
// lib/agent-quotas.ts y docs/agents/permissions.md.
// What an approved proposal executes already paid its quota when it was proposed.
const quotas = agentQuotas();
// (Calls from the action sandbox DO pay: see executionAlreadyBilled.)
app.use("*", (c, next) => (executionAlreadyBilled(c) ? next() : quotas(c, next)));
app.use("*", agentDenials);
app.use("*", adminGate(ADMIN_ONLY_ROUTES));

// ── A1: Idempotency-Key on writes (POST/PUT/PATCH/DELETE of /api/*) ──
// After authentication (the key is per actor) and the gates; before the
// routes and kons. Valkey → fallback table → 503 (fail-closed). See
// middleware/idempotency.ts.
app.use(
  "/api/*",
  idempotency({
    stores: defaultStores,
    notify: (message, data) => logger.warn(data, message),
  })
);

// ── Human approval ──
// After idempotency (a retry with the same key gets the SAME
// proposal, the stored 202) and before the routes: the request of an agent
// that needs approval is not executed; it is held as a proposal (202). With everything
// off (the default) it queries nothing. See lib/approvals.ts and
// docs/agents/approvals.md.
app.use("/api/*", approvalGate());
// What is not held runs now: its `_evidence` (agent data ledger) stays with the row too.
app.use("/api/*", directEvidence());

// Without an administrator, an account created here would only lock the owner
// out of `/api/system/setup` or be taken for it. See lib/first-run.ts.
app.use("/api/auth/sign-up/*", async (c, next) => {
  if (await signUpRefused()) {
    return c.json(
      { error: "Create the first administrator before anyone signs up", code: "SETUP_REQUIRED" },
      403
    );
  }
  return next();
});

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Files uploaded in local mode.
//
// They were stored —when they were stored— and nobody served them: `/uploads/...`
// returned 404, so each file's public URL pointed nowhere.
// With S3 it is not needed, because the bucket serves them.
if (!usesS3) {
  // The prefix comes from the configuration, not hand-written: it is the same string
  // used to build the URLs stored in the database.
  app.get(`${BASE_URL_LOCAL}/*`, async (c) => {
    const key = c.req.path.slice(BASE_URL_LOCAL.length + 1);
    try {
      // `localPathOf` rejects any key that escapes the directory: without
      // that, `/uploads/../../etc/passwd` would be a valid path for `join`.
      const route = localPathOf(key);
      const medium = file(route);
      if (!(await medium.exists())) return c.notFound();
      // Under Bun, the BunFile (type and zero-copy send); under Node, a stream (G4).
      const { body: body, type: type } = fileBody(route);
      return new Response(body, {
        headers: {
          ...(type ? { "Content-Type": type } : {}),
          "Cache-Control": mediaCache(key),
          "Last-Modified": new Date(medium.lastModified).toUTCString(),
          /**
           * So that they can be READ, not just painted.
           *
           * `Cross-Origin-Resource-Policy: cross-origin` (above) lets the
           * site embed the image. It is not enough for it to be able to read it: without
           * `Access-Control-Allow-Origin`, the browser paints it and refuses to
           * let it into a canvas. It showed up when exporting a tier list as an
           * image: the capture came out with all 38 portraits blank and not a
           * single error in the page console.
           *
           * `*` and not a specific origin because these are public files and are
           * requested without credentials; with `*` it works for all four sites and for
           * anyone embedding one of our images, which is exactly what
           * `cross-origin` already allowed.
           */
          "Access-Control-Allow-Origin": "*",
          /**
           * A `/media` file never executes anything on the API's origin.
           *
           * They are served with the type of their extension: an `.svg` or `.html`
           * uploaded from the panel (or from any kon that stores files)
           * and opened directly would be JavaScript running on the SAME origin
           * as the API's session cookies. `sandbox` neutralizes it without
           * affecting `<img>`/`<video>` on the sites, which do not read this header.
           */
          "Content-Security-Policy": MEDIA_CSP,
        },
      });
    } catch {
      return c.notFound();
    }
  });
}

// ══════════════════════════════════════════════
// 🛡️ PROTECTED ROUTES
// ══════════════════════════════════════════════

/**
 * Home panel counts.
 *
 * The Dashboard asked for `/api/auth/users/count`, `/api/blog/posts/count`,
 * `/api/media/count` and `/api/datasets/count`, and NONE existed: the first
 * three gave 404 and the fourth matched `/api/datasets/:id` —with
 * id="count"— so it blew up with `invalid input syntax for type uuid` and
 * returned 500.
 *
 * The panel uses `Promise.allSettled` and paints a dash when something fails, so
 * the user saw four empty cards with no explanation. Only with the
 * console open could you discover that the routes did not exist.
 *
 * They are grouped here, over the core tables, instead of spread across each
 * kon: they are the admin front page figures, not anyone's domain.
 *
 * Team only (`admin`/`editor`): they reveal the size of the installation, and
 * "having a session" is not "being on the team" with open signup (2026-10-15).
 */
// `PgTable` and not a conditional type with `any`: all `count()` needs
// is a table, and saying so directly is shorter AND more precise. The previous
// version was `Parameters<typeof db.select>[0] extends never ? never : any`,
// that restricted nothing — it only disguised the `any` as an elaborate type.
const countValue = async (table: PgTable) => {
  const [row] = await db.select({ value: count() }).from(table);
  return row?.value ?? 0;
};

/**
 * `/api/users/count`, NOT `/api/auth/users/count`.
 *
 * Everything under `/api/auth/*` is handled by better-auth with a wildcard
 * registered further up, so a custom route in there never gets
 * executed: better-auth does not know it and answers 404. That is exactly what
 * happened on the first attempt.
 *
 * And even if it were registered earlier, it would still be a bad idea: that
 * namespace belongs to better-auth, and a version of it that added `users/count`
 * would collide silently. Counting users is not an authentication operation.
 */
app.get("/api/users/count", requireStaff, async (c) => c.json({ count: await countValue(user) }));

app.get("/api/media/count", requireStaff, async (c) =>
  c.json({ count: await countValue(mediaTable) })
);

app.get("/api/datasets/count", requireStaff, async (c) =>
  c.json({ count: await countValue(dataSetsTable) })
);

app.get("/api/blog/posts/count", requireStaff, async (c) => {
  // The blog is a kon: it may not be installed. A home panel cannot
  // fail because an optional kon is missing, so 0 is returned.
  try {
    const rows = await db.execute(`SELECT count(*)::int AS value FROM blog_posts` as never);
    const list = Array.isArray(rows)
      ? (rows as { value?: number }[])
      : ((rows as { rows?: { value?: number }[] }).rows ?? []);
    return c.json({ count: list[0]?.value ?? 0 });
  } catch {
    return c.json({ count: 0 });
  }
});

/**
 * The reason for a failure in the health checks, which are PUBLIC.
 *
 * In production only "unavailable" (the detail goes to the log): a connection
 * failure message carries the host, the database user or the whole query.
 */
function healthDetail(err: unknown): string {
  if (!inProduction()) return messageOf(err);
  logger.warn({ err }, "[health] check failed");
  return "unavailable";
}

/**
 * The storage check writes and deletes an object: the route is public, so
 * anonymous traffic must not drive storage writes. At most one per minute.
 */
let storeChecked: { until: number; status: Awaited<ReturnType<typeof checkStorage>> } | null = null;

async function checkStoreWithMemory() {
  if (storeChecked && storeChecked.until > Date.now()) return storeChecked.status;
  const status = await checkStorage();
  storeChecked = { until: Date.now() + 60_000, status };
  return status;
}

app.route("/api/version", versionRoutes);
app.get("/api/health", async (c) => {
  const checks: Record<string, { status: string; details?: unknown; error?: string }> = {};
  let overallStatus = "ok";

  // Database check
  try {
    const start = Date.now();
    await db.execute(sql`SELECT 1`);
    checks.database = {
      status: "ok",
      details: { responseTime: `${Date.now() - start}ms` },
    };
  } catch (err: unknown) {
    checks.database = { status: "error", error: healthDetail(err) };
    overallStatus = "degraded";
  }

  // Queue check (Postgres): pending, running and dead jobs across all queues.
  try {
    const queue = await queueStatus();
    const waiting = queue.totals.pending ?? 0;
    const active = queue.totals.running ?? 0;
    const dead = queue.totals.dead ?? 0;
    checks.queue = {
      // A dead job does not take the API down, but someone should look at it.
      status: dead > 0 ? "warning" : "ok",
      details: { worker: queue.worker, listen: queue.listens, waiting, active, dead },
    };
  } catch (err: unknown) {
    checks.queue = { status: "error", error: healthDetail(err) };
    overallStatus = "degraded";
  }

  // Realtime check
  try {
    const rtStats = realtimeManager.getStats();
    checks.realtime = { status: "ok", details: rtStats };
  } catch (err: unknown) {
    checks.realtime = { status: "error", error: healthDetail(err) };
  }

  // Memory usage
  const memory = process.memoryUsage();
  // Storage. It was not checked, and that is exactly the failure that slips through: the
  // container declared itself healthy while EVERY upload failed. The check
  // writes and deletes a test object, because the destination existing does not say
  // whether it can be written to.
  try {
    const store = await checkStoreWithMemory();
    checks.storage = {
      status: store.ok ? "ok" : "error",
      details: { provider: store.provider, detail: store.detail },
    };
    if (!store.ok) overallStatus = "degraded";
  } catch (err) {
    checks.storage = { status: "error", error: healthDetail(err) };
    overallStatus = "degraded";
  }

  checks.memory = {
    status: memory.heapUsed > 500 * 1024 * 1024 ? "warning" : "ok",
    details: {
      heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(memory.rss / 1024 / 1024)}MB`,
    },
  };

  // Uptime
  const uptime = process.uptime();

  c.status(overallStatus === "ok" ? 200 : 503);
  // In production, whoever is not an admin gets the verdict and nothing else:
  // storage paths, queue counts and memory are not for anonymous callers.
  const who = c.get("user") as { role?: string } | null | undefined;
  const agent = c.get("agent") as { scopes?: string[] } | undefined;
  const withDetail =
    !inProduction() || who?.role === "admin" || agent?.scopes?.includes("admin") === true;
  return c.json({
    status: overallStatus,
    service: "kitsuden-api",
    version: "0.9.0-beta",
    timestamp: new Date().toISOString(),
    ...(withDetail
      ? {
          environment: config.NODE_ENV,
          uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
          checks,
        }
      : {
          checks: Object.fromEntries(
            Object.entries(checks).map(([name, check]) => [name, { status: check.status }])
          ),
        }),
  });
});

// pgvector health check endpoint
app.get("/api/health/pgvector", async (c) => {
  try {
    const result = await db.execute(
      sql`SELECT 1 as installed FROM pg_extension WHERE extname = 'vector'`
    );
    const installed = result.rows.length > 0;
    return c.json({
      pgvector: installed,
      requiredFor: ["ai-memories"],
      message: installed
        ? "pgvector is installed and ready"
        : "pgvector is NOT installed. AI features will not work.",
    });
  } catch (err: unknown) {
    return c.json(
      {
        pgvector: false,
        error: healthDetail(err),
        message: "Could not check pgvector status. Database connection failed.",
      },
      500
    );
  }
});

// pg_trgm health check endpoint
app.get("/api/health/pgtrgm", async (c) => {
  try {
    const result = await db.execute(
      sql`SELECT 1 as installed FROM pg_extension WHERE extname = 'pg_trgm'`
    );
    const installed = result.rows.length > 0;
    return c.json({
      pgtrgm: installed,
      requiredFor: ["dataset-fulltext-search"],
      message: installed
        ? "pg_trgm is installed and ready"
        : "pg_trgm is NOT installed. Dataset full-text search will fall back to slow sequential scans.",
    });
  } catch (err: unknown) {
    return c.json(
      {
        pgtrgm: false,
        error: healthDetail(err),
        message: "Could not check pg_trgm status. Database connection failed.",
      },
      500
    );
  }
});

// ══════════════════════════════════════════════
// 🎛️ HEADLESS MODE
// ══════════════════════════════════════════════

if (features.headless) {
  app.all("/api/admin/*", (c) => {
    return c.json(
      {
        error: "Headless mode",
        message: "Admin API is disabled. This Kitsuden instance is running in headless BaaS mode.",
      },
      503
    );
  });
  console.log("  👻 Headless Mode → Admin routes disabled");
}

// `requireAdminRole` re-reads the role from the database (without the cookie's 5-minute cache):
// a demoted admin or one with revoked sessions was still admin here for up to
// 5 minutes and could create a permanent `admin` agent key
//. The same for /api/admin/system and /api/keys.
app.use("/api/admin/*", requireAdminRole);

// ══════════════════════════════════════════════
// ⚡ CORE LAYER — Tier 1: Switchable Infrastructure
// ══════════════════════════════════════════════

// Data Sets & Visualizer (ALWAYS ACTIVE — the foundation)
//
// RLS (Tier 2, Titanium Wall): mounted over ALL route variants of
// entries. Historically it only covered `/api/datasets/*` (no hyphen, the RPC
// surface) while the real routes live under `/api/data-sets` — a
// mismatch that left entries without an RLS transaction. We cover both.
//
// NOTE: the empty RLS context (anonymous user) is an escape hatch to full access
// in the Postgres policy, so this is defense in depth — the
// Tier 1 filtering by owner lives in the handlers (buildDatasetWhere).
app.use("/api/datasets/:id/entries", withTransactionalRLS());
app.use("/api/datasets/:slug/entries", withTransactionalRLS());
app.use("/api/data-sets/:id/entries", withTransactionalRLS());
app.use("/api/data-sets/:slug/entries", withTransactionalRLS());
// A path pattern without `/*` does not cover `/entries/:entryId`: the single
// entry read ran on the plain pool, without the second wall (security review
// 2026-11-03). The middleware does not nest, so overlapping mounts are harmless.
app.use("/api/datasets/:id/entries/*", withTransactionalRLS());
app.use("/api/data-sets/:id/entries/*", withTransactionalRLS());
app.use("/api/datasets/batch", withTransactionalRLS());
// Note: explorerRoutes are now provided by kon-datasets
// Only mount lite routes directly (as fallback if kon isn't loaded yet)
app.route("/api/data-sets", dataSetsLiteRoutes);
console.log("  📊 Core: Data Sets Lite Routes → ALWAYS ACTIVE");

// Query Engine & Batch Processor Routes (PHASE 2: The Magic of Data)
// /api/datasets is now mounted via rpcSurface (src/rpc.ts, Hono RPC)
// /api/items is now mounted via rpcSurface (src/rpc.ts, Hono RPC)
app.route("/api/generate-code", codegenRoutes);
console.log("  🔍 Core: Query Engine (Kitsuden QL) → ALWAYS ACTIVE");
console.log("  📦 Core: Batch Processor (ACID) → ALWAYS ACTIVE");
console.log("  🎨 Core: Code Generation → /api/generate-code");

// Media Library (toggleable) - now as kon
const isKonEnabled = (id: string) =>
  kitsudenConfig.core.find((g: any) => g.id === id)?.enabled ?? false;

if (isKonEnabled("kon-media")) {
  console.log("  🖼️  Core: Media Library → ENABLED (routes mounted by kon)");
} else {
  console.log("  🖼️  Core: Media Library → DISABLED");
}

// Note: Page Builder, Blog, Formulas are now Tier 3 Kons (Promote merged into Blog)
// loaded dynamically by the module-loader. Webhooks and Connectors are
// when their Kon / Core flags are enabled. See loadModules() below.

// Connectors (toggleable)
if (isKonEnabled("kon-connectors")) {
  console.log("  🔌 Core: Data Connectors → ENABLED");
} else {
  console.log("  🔌 Core: Data Connectors → DISABLED");
}

// ══════════════════════════════════════════════
// 🔧 ENGINE ROUTES
// ══════════════════════════════════════════════

app.route("/api/settings", settingsRoutes);
app.route("/api/modules", modulesRoutes);
// Admin artifacts of the kons (custom views, framework-agnostic).
app.route("/api/kons", konAssetsRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api/graphql", graphqlRoutes);
app.use("/api/graph/*", withTransactionalRLS());
console.log("  🕸️  Engine Graphify → /api/graph (auto relational APIs)");
app.route("/api/functions", functionsRoutes);
app.route("/api/actions", actionsRoutes);
app.use("/api/keys", requireAdminRole);
app.use("/api/keys/*", requireAdminRole);
app.route("/api/keys", apiKeysRoutes);
// OAuth 2.1 for MCP: /.well-known/oauth-* and /api/oauth/* (lib/oauth, docs/agents/oauth.md)
app.route("/", oauthRoutes);
app.route("/api/oauth", oauthPanelRoutes);
startOAuthSweep();
if (features.mcpEnabled) {
  app.route("/api/mcp", mcpRoutes);
  console.log("  🤖 MCP Server → ENABLED (/api/mcp)");
} else {
  console.log("  🤖 MCP Server → DISABLED");
}
app.route("/api/admin/registry", adminRegistryRoutes);
// The Postgres queue: count, "dead letter", retry and discard.
app.route("/api/admin/queue", queueRoutes);
// External MCP servers: fingerprints of their tools and the human review of
// changes (lib/external-mcp.ts). Human admins only; agents call approved tools
// through /api/mcp and the engine (lib/external-mcp-bridge.ts).
app.route(EXTERNAL_MCP_ROUTE, externalMcpRoutes);
// Logged requests: actor, kon, operation, database time, blocks.
app.route("/api/admin/requests", tracesRoutes);
// Agent identities, keys, scopes, quotas and sponsors are changed by humans
// only. An agent with the `admin` scope passed the admin gate and could mint a
// key for another agent (one set to `direct`, without approval) or widen its
// own scopes: approval mode held nothing (security review 2026-11-03).
// Reading stays as it was. Running the playground is refused too: it makes
// another agent act with THAT agent's scopes (security review 2026-11-04; each
// router also carries `noAgentsInAgentManagement`).
const AGENT_IDENTITY_ROUTE = /^\/api\/(?:admin\/agents|v1\/agents|v1\/identities)(?:\/|$)/;
app.use("*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const path = c.req.path.replace(/\/{2,}/g, "/");
  if (!AGENT_IDENTITY_ROUTE.test(path)) return next();
  const user = c.get("user") as { id?: string; role?: string } | null | undefined;
  if (c.get("agent") || user?.role === "agent" || user?.id?.startsWith("machine-")) {
    return c.json(
      {
        error: "Forbidden",
        message: "Agents cannot create, change or issue keys for agents: a person does that.",
      },
      403
    );
  }
  return next();
});
// B3: each agent's notification URL (signed webhook).
app.route("/api/admin/agents", agentNotificationsRoutes);
console.log("  🔑 Secrets Manager (Prefect-style) → /api/admin/secrets");
app.use("/api/admin/vault/*", withTransactionalRLS());
// Hono RPC surface (chained): graphify + secrets + vault — see src/rpc.ts
app.route("/", rpcSurface);
console.log(
  "  🗄️  KITSUDEN Vault →",
  process.env.KITSUDEN_VAULT_ENABLED === "true"
    ? "/api/admin/vault (ENABLED)"
    : "disabled (set KITSUDEN_VAULT_ENABLED=true)"
);
app.route("/api/admin/agents", agentRoutes);
// Permissions (broad + fine-grained + denials), keys and quotas of each
// agent for the panel. Under /api/v1: admin only (ADMIN_ONLY_ROUTES).
app.route("/api/v1", agentPermissionsRoutes);
// Inbox and configuration of human approval (team humans
// only) and the status of its proposals for each agent.
app.route("/api/approvals", approvalsRoutes);
app.route("/api/proposals", proposalsRoutes);
// The models (defineModel) of the mounted kons, for the panel.
app.route(MODELS_ROUTE, modelsRoutes);
setApprovalsApp((req, env) => app.fetch(req, env));
startProposalSweep();
// Promotion of agent code. The agent's operations
// (/api/promotion) run in the request's RLS transaction and are registered
// among the MOUNTED ones (MCP tools promotion_*; the /api/promotion gate
// opens them to promotion:propose); the panel ones (/api/approvals/promotion), human
// admins only. See lib/promotion.ts and docs/agents/promotion.md.
mountKonRls(app, PROMOTION_ROUTE);
app.route(PROMOTION_ROUTE, promotionRoutes);
registerMountedOperations(PROMOTION_KON, PROMOTION_ROUTE, promotionOperations, promotionRoutes);
app.route(ADMIN_PROMOTION_ROUTE, promotionAdminRoutes);
startWatchesSweep();
// /api/v1 (agents/traces/identities) is now mounted via rpcSurface (src/rpc.ts)
app.route("/api/admin/agents", agentPlaygroundRoutes);
app.route("/api/agent/memory", agentMemoryRoutes);
// What an agent chose NOT to do, and why: written by the agent itself, read
// by admins in the panel (lib/agent-decisions.ts, docs/agents/decisions.md).
app.route("/api/agent/decisions", agentDecisionsRoutes);
app.route("/api/admin/data-sources", dataSourcesRoutes);
app.route("/api/explorer", explorerRoutes);
// Agent memory (2026-10-28): SDK operations with owner and RLS, in
// the request's transaction. They are registered among the MOUNTED ones: from there come
// its MCP tools (brain_search, brain_read, brain_note_write…) and the
// /api/brain gate opens them to agents with brain:read / brain:write.
mountKonRls(app, MEMORY_ROUTE);
app.route(MEMORY_ROUTE, brainMemoryRoutes);
registerMountedOperations(MEMORY_KON, MEMORY_ROUTE, memoryOperations, brainMemoryRoutes);
app.route("/api/brain", brainRoutes);
console.log("  🧠 KITSUDEN Brain → /api/brain");
app.route("/api/map", systemMapRoutes);
console.log("  🗺️  System Map → /api/map");
app.route("/api/code-graph", codeGraphRoutes);
console.log("  🕸️  Code Graph → /api/code-graph");
app.route("/api/runs", runsRoutes);
console.log("  🔬 Run Inspector → /api/runs");
app.route("/api/mail", mailRoutes);
console.log("  ✉️  Mail → /api/mail");
app.route("/api/schema", schemaIntrospectionRoutes);
app.route("/api/relations", inlineRelationsRoutes);
console.log("  🎛️  Admin Registry → Auto-discovery enabled");
console.log("  🔍 Schema Introspection → DB reflection enabled");
console.log("  🔗 Inline Relations → Django-style inlines enabled");
// Note: platforms, tags, streamers, blog, formulas and other kons
// are loaded dynamically by loadModules() below. Do not add hardcoded routes here.

// ══════════════════════════════════════════════
// 📦 DYNAMIC MODULE ROUTES (Kons + Core modules)
// ══════════════════════════════════════════════

// Before serving a single request: check that the API's connection is not a
// superuser. Postgres ignores RLS for superusers, so with that account
// the policies are decorative and isolation between tenants does not exist —
// with no symptom at all. In production this STOPS startup; elsewhere, it warns.
//
// It goes here, after loading the kons, because by then all
// policies are applied and the database responds.
await verifyRlsConnection(db, { strict: config.NODE_ENV === "production" });

// Fresh install: the one-time token for the first administrator, in the log.
await announceSetupTokenAtBoot();

// ── The configuration seeds the database, and from then on the database rules ──
//
// `kitsuden.config.ts` says which kons come on BY DEFAULT; the `modules`
// table says what is on NOW. Before, both were read as if they were
// the same, and the file ended up overwriting what the user changed in the
// panel.
//
// Seeding here —before loading the kons— is what lets `loadKons()`
// read ONLY the database without breaking a new installation: by the time it runs, the database
// already knows what the file wanted. See `lib/seed-modules.ts`.
try {
  const { seedModules } = await import("./lib/seed-modules");
  const seeding = await seedModules();
  if (seeding.seeded.length > 0) {
    console.log(`  🌱 Seeded 'modules' from the configuration: ${seeding.seeded.join(", ")}`);
  }
} catch (err) {
  // Seeding failing CANNOT prevent startup: the API keeps serving with
  // whatever the database already has. But it says so loudly, because on a
  // NEW installation this means no kon will be loaded, and a startup with no kons
  // and no explanation is exactly the kind of silent failure being
  // hunted in this repo.
  console.error(
    `  ✗ Could not seed 'modules' from the configuration: ` +
      `${err instanceof Error ? err.message : err}
` +
      `    On a new installation this leaves the system with no kons. ` +
      `Run: bun run scripts/seed-modules.ts`
  );
}

await loadModules(app);

// `/api/version` only advertises the contracts whose kon really responds
// (loaded at startup or activated later): see routes/version.ts.
setKonAvailability((konId) => availableKon(konId, getLoadReport().loaded));

// Invalidate GraphQL cache after kons are loaded so new tables appear
invalidateGraphQLCache();

// ══════════════════════════════════════════════
// 🏰 GRIMOIRE LIFECYCLE — Seed & Activation
// ══════════════════════════════════════════════

const activeGrimoire =
  process.env.KITSUDEN_ACTIVE_GRIMOIRE || process.env.KITSUDEN_ACTIVE_THEME || null;
if (activeGrimoire) {
  try {
    const { activateGrimoire } = await import("./lib/grimoire-lifecycle");
    await activateGrimoire(activeGrimoire);
  } catch (err: unknown) {
    console.warn(`[Grimoire] Activation failed for ${activeGrimoire}:`, messageOf(err));
  }
}

// ══════════════════════════════════════════════
// 🪄 INITIALIZE AUTO-KONS
// ══════════════════════════════════════════════

const autoMcpProxy = {
  addTool: (toolDef: any) => {
    // Convert generated MCP tools directly to the unified Action engine
    defineAction({
      trigger: `agent.tool:${toolDef.name}`,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      run: async (ctx: any) => {
        // Execute the native handler for this Auto-Kon tool
        return toolDef.handler(ctx.payload, {
          agentId: ctx.agent?.agentId,
          agentName: ctx.agent?.agentName,
          scopes: ctx.agent?.scopes || [],
          preferToon: ctx.agent?.preferToon || false,
        });
      },
    });
  },
};

initializeKons(createKonContext(), app as any, autoMcpProxy);

// ══════════════════════════════════════════════
// 🚨 ERROR HANDLING
// ══════════════════════════════════════════════

app.notFound((c) => {
  logger.warn(
    {
      method: c.req.method,
      path: logPath(c.req.path),
      status: 404,
    },
    "Route not found"
  );

  /**
   * ── A BARE 404 TELLS AN AGENT NOTHING ──────────────────────────────────
   *
   * It does not distinguish "wrong method" from "path with a typo" from "that route
   * does not exist", and an agent retries blindly. For anything under `/api`
   * all three are answered: 405 with the valid methods if the path exists,
   * and otherwise, the most similar routes and where the full contract is.
   */
  if (c.req.path.startsWith("/api/")) {
    // Past its per-minute budget a client gets the 404 without suggestions (F3/F8).
    const { allow, didYouMean } = canSuggest(clientIp(c))
      ? suggestRoutes(c.req.method, c.req.path)
      : { allow: [] as string[], didYouMean: [] as { method: string; path: string }[] };

    if (allow.length > 0) {
      c.header("Allow", allow.join(", "));
      return c.json(
        {
          error: "Method not allowed",
          message: `${c.req.path} exists, but does not accept ${c.req.method}. Valid methods: ${allow.join(", ")}.`,
          path: logPath(c.req.path),
          method: c.req.method,
          allow,
          requestId: c.get("requestId"),
        },
        405
      );
    }

    return c.json(
      {
        error: "Not found",
        path: logPath(c.req.path),
        method: c.req.method,
        didYouMean,
        hint: features.swaggerEnabled
          ? "All kon routes are in GET /api/docs/openapi.json, " +
            "and the agent guide at GET /llms.txt."
          : "All kon routes are in the agent guide: GET /llms.txt.",
        requestId: c.get("requestId"),
      },
      404
    );
  }

  return c.json(
    {
      error: "Not found",
      path: logPath(c.req.path),
      requestId: c.get("requestId"),
    },
    404
  );
});

app.onError((err, c) => {
  const isDevelopment = config.NODE_ENV === "development";
  const { envelope, status } = toErrorEnvelope(err, {
    requestId: c.get("requestId"),
    traceId: c.get("traceId"),
    isDev: isDevelopment,
  });

  // Structured log (5xx = error, 4xx = warn). Already correlated by the mixin.
  const logFields = {
    method: c.req.method,
    path: logPath(c.req.path),
    status,
    code: envelope.error.code,
    error: err instanceof Error ? messageOf(err) : String(err),
    stack: isDevelopment && err instanceof Error ? err.stack : undefined,
  };
  if (status >= 500) logger.error(logFields, `Unhandled error: ${logFields.error}`);
  else logger.warn(logFields, `Handled error: ${envelope.error.code}`);

  return c.json(envelope, status as 500);
});

// ═══════════════════════════════════════════════════════════════════════════
// 📚 API DOCUMENTATION (Swagger + Scalar)
// ═══════════════════════════════════════════════════════════════════════════

// Mount docs routes (dynamic OpenAPI from kons)
// `ENABLE_SWAGGER=false` turns the documentation off (it was read in config and nobody
// looked at it: the documentation was always mounted).
if (features.swaggerEnabled) app.route("/api/docs", dynamicDocsRouter);

/**
 * Agent guide. At the root because that is where an agent looks for it by
 * convention, and under `/api` because that is where the standalone MCP knows to call.
 * It is generated on every request: routes come from the mounted router, so it
 * cannot fall behind what the API serves.
 */
const serveGuideForAgents = (c: Context) =>
  c.text(
    generateAgentGuide({
      baseUrl: `${new URL(c.req.url).origin}/api`,
      routes: konRoutes(),
      publishedContract: features.swaggerEnabled,
    }),
    200,
    { "content-type": "text/markdown; charset=utf-8" }
  );
app.get("/llms.txt", serveGuideForAgents);
app.get("/api/llms.txt", serveGuideForAgents);

// Also mount legacy docs for compatibility
if (features.swaggerEnabled) app.route("/api/docs-legacy", docsRoutes);

// With the documentation off, these redirects would lead to a 404.
if (features.swaggerEnabled) {
  // Redirect legacy /api/swagger to new docs
  app.get("/api/swagger", (c) => c.redirect("/api/docs"));

  // Also redirect /api/doc (OpenAPI JSON spec) to new endpoint
  app.get("/api/doc", (c) => c.redirect("/api/docs/openapi.json"));

  console.log("  📚 API Documentation → /api/docs (Swagger UI)");
  console.log("  📚 API Reference (Modern) → /api/docs/modern (Scalar)");
  console.log("  📚 OpenAPI Spec → /api/docs/openapi.json");
} else {
  console.log("  📚 API Documentation → OFF (ENABLE_SWAGGER=false); agent guide at /llms.txt");
}

// ══════════════════════════════════════════════
// 🚀 SERVER START
// ══════════════════════════════════════════════

const port = Number(process.env.PORT) || 3001;
const hostname = listenHost();

// Semantic search of models: the embeddings provider.
configureModelEmbeddings();

// Initialize workers (non-blocking)
setupWorkers().catch((err) => {
  console.error("Worker startup failed (non-fatal):", messageOf(err));
});

// Initialize real-time manager
// Per-channel authorization + per-row filtering BEFORE accepting subscriptions:
// without this, realtime is deny-by-default (admin only), never open.
// System emails + translations. Kons register theirs in their
// startup hook (mail.register), without touching the host.
registerSystemMails(mail);

wireRealtimeAuthorization();
bridgeEventsToRealtime();
realtimeManager.initialize().catch((err) => {
  console.error("Real-time init failed (non-fatal):", messageOf(err));
});

// ══════════════════════════════════════════════
// 🌐 BUN SERVER WITH WEBSOCKET SUPPORT
// ══════════════════════════════════════════════

/**
 * Generate unique client ID.
 */
function generateClientId(): string {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extract session from WebSocket upgrade request.
 *
 * Without the cookie's 5-minute cache: a socket lives far longer than a
 * request, and with the cache an account just demoted or revoked opened the
 * channel with its old role. The session id and expiry are kept too: the
 * realtime manager re-reads the session on subscribe and every minute, and
 * closes the socket when it no longer holds (lib/realtime.ts).
 */
async function getSessionFromRequest(req: Request): Promise<{
  userId: string | null;
  userRole: string | null;
  sessionId: string | null;
  sessionExpiresAt: number | null;
}> {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
      query: { disableCookieCache: true },
    });
    const userId = session?.user?.id || null;
    const expiresAt = session?.session?.expiresAt
      ? new Date(session.session.expiresAt).getTime()
      : NaN;
    return {
      userId,
      userRole: ((session?.user as { role?: string } | undefined)?.role as string) || null,
      sessionId: userId ? session?.session?.id || null : null,
      sessionExpiresAt: userId && Number.isFinite(expiresAt) ? expiresAt : null,
    };
  } catch {
    return { userId: null, userRole: null, sessionId: null, sessionExpiresAt: null };
  }
}

// Initialize Kitsuden Workers dispatcher (event listeners)
initFunctionDispatcher();

// Initialize Actions Engine (unified workers + webhooks)
initActionsEngine();

// Initialize DX Actions Layer (Tier 1)
initActions({
  hono: app as any,
  mcp: true,
});

// Initialize Agent Telemetry (Step 2: Observability)
initAgentTelemetry();

// Initialize KITSUDEN Brain (self-aware knowledge layer)
const brainEnabled = process.env.KITSUDEN_BRAIN_ENABLED !== "false";
if (brainEnabled) {
  initKitsudenBrain(db, {
    watch: process.env.KITSUDEN_BRAIN_WATCH === "true",
    debounceMs: Number(process.env.KITSUDEN_BRAIN_DEBOUNCE_MS ?? 3000),
  });
  console.log(
    "  🧠 KITSUDEN Brain watcher →",
    process.env.KITSUDEN_BRAIN_WATCH === "true"
      ? "ENABLED"
      : "disabled (set KITSUDEN_BRAIN_WATCH=true to enable)"
  );
}

// Initialize Secrets Manager (Prefect-style hot injection into process.env)
loadSecretsIntoEnv()
  .then((n) => {
    if (n > 0) console.log(`  🔑 Secrets Manager → ${n} secret(s) hot-injected into process.env`);
  })
  .catch(() => {});

// Initialize Cron Scheduler (loads active cron jobs from DB)
initCronScheduler().catch((err) => {
  console.warn(`  ⏰ Cron Scheduler init warning: ${messageOf(err)}`);
});

console.log(`
╔══════════════════════════════════════════════════╗
║   ⚡ Kitsuden API v0.9.0-beta (Actions)       ║
║   Runtime: Bun + Hono                          ║
║   Auth: Better-Auth 🔐                         ║
║   Queue: Postgres (outbox) 🐘                  ║
║   Real-time: WebSocket + ${valkeyConfigured() ? "Valkey 📡           " : "LISTEN/NOTIFY 📡    "} ║
║   Actions: Unified Engine ⚡                    ║
║   GraphQL: /api/graphql 📊                    ║
║   Docs: /api/docs (Swagger) 📚                ║
║   API Ref: /api/docs/modern (Scalar) 📖       ║
║   RLS: The Titanium Wall 🛡️                    ║
║   Port: ${port}                                  ║
╚══════════════════════════════════════════════════╝
`);

// Orderly shutdown: the queue worker finishes what it has in progress (whatever
// does not finish is recovered by the sweep when its lease expires).
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([shutdownQueues(), stopTraces(), closeValkey()]).finally(() =>
      process.exit(0)
    );
  });
}

export { app };

// ── Hono RPC (KITSUDEN architecture §7) ──
// The client initializes: `import { hc } from "hono/client";` +
// `const client = hc<AppType>("http://localhost:3001");`
// to get a typed SDK without generating intermediate files.
export type AppType = typeof app;

// Deep RPC type (routers migrated to chained syntax) — see src/rpc.ts
export type { KitsudenRpcType } from "./rpc";

export default {
  port,
  hostname,
  fetch: async (req: Request, server: any): Promise<Response> => {
    const url = new URL(req.url);

    // WebSocket upgrade for /api/realtime
    if (url.pathname === "/api/realtime") {
      // The browser sends cookies in a WebSocket handshake even if
      // another site opens it (there is no CORS for WebSockets). Without checking `Origin`,
      // any page could open the channel with the visitor's session.
      // Non-browser clients do not send `Origin` and carry on as before.
      const origin = req.headers.get("origin");
      if (origin && !corsConfig.origins.includes(origin)) {
        return new Response("Origin not allowed", { status: 403 });
      }
      const session = await getSessionFromRequest(req);
      const clientId = generateClientId();

      const upgraded = server.upgrade(req, {
        data: {
          clientId,
          userId: session.userId,
          // Without the role, the channel authorizer saw EVERYONE as having no role:
          // an admin could not subscribe to what their policy lets them see.
          userRole: session.userRole,
          sessionId: session.sessionId,
          sessionExpiresAt: session.sessionExpiresAt,
        } satisfies WSClientData,
      });

      if (upgraded) {
        return undefined as any; // Bun handles the upgrade
      }

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // MCP's SSE (`GET /api/mcp`) is a long-lived connection that only sends a
    // keepalive every 30 s, and Bun by default cuts anything idle for 10 s
    // (`idleTimeout`): the session died after 10 s and the agent's next
    // `POST` received "Invalid or expired session" (found by the human approval
    // walkthrough: an agent that proposes and then queries). No limit for
    // that request; the session still expires after an hour of inactivity.
    if (url.pathname === "/api/mcp" && req.method === "GET") {
      (server as { timeout?: (r: Request, s: number) => void }).timeout?.(req, 0);
    }

    // Regular HTTP request → Hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },

  websocket: {
    // Protocol frames are JSON of a few dozen bytes; Bun's default (16 MB) only
    // lets an anonymous client burn CPU in JSON.parse.
    maxPayloadLength: 64 * 1024,

    open(ws: ServerWebSocket<WSClientData>) {
      const { clientId, userId, userRole, sessionId, sessionExpiresAt } = ws.data;
      realtimeManager.addClient(clientId, ws, userId, userRole ?? null, {
        id: sessionId ?? null,
        expiresAt: sessionExpiresAt ?? null,
      });

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: "connected",
          clientId,
          userId,
          timestamp: Date.now(),
        })
      );
    },

    message(ws: ServerWebSocket<WSClientData>, message: string | Buffer) {
      const { clientId } = ws.data;
      // A frame that breaks does not take the process down: handleMessage
      // already validates, this is the last net.
      try {
        const raw = typeof message === "string" ? message : message.toString();
        realtimeManager.handleMessage(clientId, raw);
      } catch (err) {
        console.error(`[WS Error] ${clientId}:`, messageOf(err));
      }
    },

    close(ws: ServerWebSocket<WSClientData>) {
      const { clientId } = ws.data;
      realtimeManager.removeClient(clientId);
    },

    error(ws: ServerWebSocket<WSClientData>, error: Error) {
      console.error(`[WS Error] ${ws.data.clientId}:`, messageOf(error));
    },
  },
};
