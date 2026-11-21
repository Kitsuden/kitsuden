/**
 * Mounted routes that are NOT yet kons SDK operations
 * ============================================================================
 *
 * Checked by `apps/api/scripts/operations-coverage.ts`: every mounted
 * route (the `MATRIX` table) is an operation declared with
 * `defineOperation` —with its OpenAPI 3.1 of real schemas and its MCP
 * tool or its exclusion reason— or it is HERE.
 *
 * This list can ONLY SHRINK. Common reason for all its entries: they are routes
 * written by hand before the SDK: they appear in the OpenAPI by
 * discovery (without an output schema) and are not MCP tools. When a
 * route moves to the SDK, it is removed from here (or regenerated:
 * `UPDATE_LEGACY_ROUTES=1`, see the test). A NEW route is not added here:
 * it is declared with the SDK (docs/kons/README.md).
 */

/**
 * The scope name of each legacy CORE route, so an agent's `!` denial can close it
 * (hardening 2026-11-21).
 *
 * `routeDenial` (middleware/auth-guard.ts) matches a denial against an SDK
 * operation or against a whole kon. A legacy core route is neither, so before
 * this no denial could close one: `["admin", "!core:secrets:*"]` still wrote
 * secrets. Each area below gets the name `core:<area>:<access>`, where
 * `<access>` is `read` for GET and HEAD and `write` for any other method:
 *
 *   `!core:secrets:*`   closes /api/admin/secrets
 *   `!core:keys:write`  closes POST and DELETE /api/keys, and leaves GET open
 *   `!core:*:write`     closes every write to a legacy core route
 *   `!core:*`           closes every legacy core route
 *
 * These names only DENY. Granting `core:secrets:read` opens nothing: the
 * route's own gate (role, `admin`) decides as before. The routes of a mounted
 * kon are not looked up here; their denial is `!<kon>:*`.
 *
 * Above `LEGACY_ROUTES` on purpose: the regeneration in
 * tests/unit/operation-coverage.test.ts keeps everything before that list.
 * tests/unit/security-hardening-2026-11-21-legacy-route-denials.test.ts checks
 * that every route of the list below has a name. The longest prefix wins.
 *
 * `/api/mcp` is the exception to read/write: every MCP message is a POST, so
 * its name is `core:mcp:connect` whatever the method, and `!core:*:write` does
 * not cut an agent off MCP. `!core:mcp:*` (or `!core:*`) does.
 */
export const LEGACY_CORE_SCOPE_AREAS: readonly {
  prefix: string;
  area: string;
  /** A fixed access instead of read/write by method. */
  access?: string;
}[] = [
  { prefix: "/admin/traces", area: "traces" },
  { prefix: "/admin", area: "observability" },
  { prefix: "/api/actions", area: "actions" },
  { prefix: "/api/admin/agents", area: "agents" },
  { prefix: "/api/admin/data-sources", area: "data-sources" },
  { prefix: "/api/admin/rate-limits", area: "rate-limits" },
  { prefix: "/api/admin/registry", area: "registry" },
  { prefix: "/api/admin/secrets", area: "secrets" },
  { prefix: "/api/admin/system", area: "users" },
  { prefix: "/api/admin/vault", area: "vault" },
  { prefix: "/api/agent/decisions", area: "agent-decisions" },
  { prefix: "/api/agent/memory", area: "agent-memory" },
  { prefix: "/api/auth", area: "auth" },
  { prefix: "/api/brain", area: "brain" },
  { prefix: "/api/code-graph", area: "code-graph" },
  { prefix: "/api/data-sets", area: "datasets" },
  { prefix: "/api/datasets", area: "datasets" },
  { prefix: "/api/doc", area: "docs" },
  { prefix: "/api/docs", area: "docs" },
  { prefix: "/api/docs-legacy", area: "docs" },
  { prefix: "/api/explorer", area: "explorer" },
  { prefix: "/api/functions", area: "functions" },
  { prefix: "/api/generate-code", area: "codegen" },
  { prefix: "/api/graph", area: "graph" },
  { prefix: "/api/graphql", area: "graphql" },
  { prefix: "/api/health", area: "health" },
  { prefix: "/api/items", area: "items" },
  { prefix: "/api/keys", area: "keys" },
  { prefix: "/api/kons", area: "kon-assets" },
  { prefix: "/api/llms.txt", area: "docs" },
  { prefix: "/api/mail", area: "mail" },
  { prefix: "/api/map", area: "map" },
  { prefix: "/api/mcp", area: "mcp", access: "connect" },
  { prefix: "/api/media", area: "media" },
  { prefix: "/api/modules", area: "modules" },
  { prefix: "/api/relations", area: "relations" },
  { prefix: "/api/runs", area: "runs" },
  { prefix: "/api/schema", area: "schema" },
  { prefix: "/api/search", area: "search" },
  { prefix: "/api/settings", area: "settings" },
  { prefix: "/api/swagger", area: "docs" },
  { prefix: "/api/sync", area: "sync" },
  { prefix: "/api/system", area: "system" },
  { prefix: "/api/users", area: "users" },
  { prefix: "/api/v1/agents", area: "agents" },
  { prefix: "/api/v1/identities", area: "agents" },
  { prefix: "/api/v1/traces", area: "traces" },
  { prefix: "/api/version", area: "health" },
  { prefix: "/health", area: "health" },
  { prefix: "/live", area: "health" },
  { prefix: "/llms.txt", area: "docs" },
  { prefix: "/media", area: "media" },
  { prefix: "/metrics", area: "observability" },
  { prefix: "/ready", area: "health" },
  { prefix: "/slo", area: "observability" },
];

/** `read` for GET, HEAD and OPTIONS, `write` for every other method. */
function accessOf(method: string): "read" | "write" {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/**
 * The scope name of the legacy core route that serves this request
 * (`core:<area>:<read|write>`), or `null` when no area covers the path. `/`
 * alone is `core:health:read`. The caller looks at kon paths first.
 */
export function legacyCoreScope(method: string, path: string): string | null {
  const clean = path.replace(/\/{2,}/g, "/");
  if (clean === "/") return `core:health:${accessOf(method)}`;
  let best: (typeof LEGACY_CORE_SCOPE_AREAS)[number] | null = null;
  for (const a of LEGACY_CORE_SCOPE_AREAS) {
    if (clean !== a.prefix && !clean.startsWith(`${a.prefix}/`)) continue;
    if (!best || a.prefix.length > best.prefix.length) best = a;
  }
  return best ? `core:${best.area}:${best.access ?? accessOf(method)}` : null;
}

export const LEGACY_ROUTES: readonly string[] = [
  "DELETE /api/actions/:id",
  "DELETE /api/admin/agents/:id",
  "DELETE /api/admin/agents/:id/keys/:keyId",
  "DELETE /api/admin/data-sources/:id",
  "DELETE /api/admin/rate-limits/:key",
  "DELETE /api/admin/secrets/:key",
  "DELETE /api/admin/vault/:collection",
  "DELETE /api/admin/vault/:collection/columns/:column",
  "DELETE /api/admin/vault/:collection/rows/:id",
  "DELETE /api/agent/memory/:id",
  "DELETE /api/brain/notes/:id",
  "DELETE /api/explorer/:collection/:id",
  "DELETE /api/explorer/:collection/views/:viewId",
  "DELETE /api/functions/:id",
  "DELETE /api/items/:collection/:id",
  "DELETE /api/keys/:id",
  "DELETE /api/modules/:key",
  "DELETE /api/system/active-theme",
  "DELETE /api/system/grimoires/:id",
  "DELETE /api/v1/agents/:id",
  "DELETE /api/v1/identities/:id",
  "GET /",
  "GET /admin/activity",
  "GET /admin/logs",
  "GET /admin/metrics",
  "GET /admin/metrics/prometheus",
  "GET /admin/realtime",
  "GET /admin/slo",
  "GET /admin/stats",
  "GET /admin/telemetry/tools",
  "GET /admin/traces",
  "GET /admin/traces/:id",
  "GET /admin/traces/:id/steps",
  "GET /api/actions",
  "GET /api/actions/:id",
  "GET /api/actions/:id/executions",
  "GET /api/actions/stats/overview",
  "GET /api/admin/agents",
  "GET /api/admin/agents/:id",
  "GET /api/admin/agents/:id/chat/history",
  "GET /api/admin/agents/:id/logs",
  "GET /api/admin/agents/:id/stats",
  "GET /api/admin/agents/:id/traces",
  "GET /api/admin/agents/logs",
  "GET /api/admin/agents/traces/:traceId/steps",
  "GET /api/admin/data-sources",
  "GET /api/admin/data-sources/:id",
  "GET /api/admin/rate-limits",
  "GET /api/admin/registry",
  "GET /api/admin/registry/:konId",
  "GET /api/admin/registry/:konId/schema/:table",
  "GET /api/admin/secrets",
  "GET /api/admin/system/status",
  "GET /api/admin/system/users",
  "GET /api/admin/vault",
  "GET /api/agent/decisions",
  "GET /api/agent/memory",
  "GET /api/agent/memory/:id",
  "GET /api/agent/memory/key/:key",
  "GET /api/agent/memory/stats",
  "GET /api/auth/*",
  "GET /api/brain/graph",
  "GET /api/brain/graph/:id/neighborhood",
  "GET /api/brain/lint",
  "GET /api/brain/llms.txt",
  "GET /api/brain/notes",
  "GET /api/brain/notes/:id",
  "GET /api/brain/notes/:id/similar",
  "GET /api/brain/schema",
  "GET /api/brain/sources",
  "GET /api/brain/sources/:id",
  "GET /api/brain/status",
  "GET /api/brain/wiki",
  "GET /api/code-graph",
  "GET /api/code-graph/commit/:sha",
  "GET /api/code-graph/history",
  "GET /api/code-graph/outline",
  "GET /api/code-graph/path",
  "GET /api/code-graph/search",
  "GET /api/code-graph/semantic",
  "GET /api/code-graph/symbol/:name",
  "GET /api/code-graph/visualize",
  "GET /api/data-sets",
  "GET /api/data-sets/:id",
  "GET /api/data-sets/:id/entries",
  "GET /api/data-sets/:id/entries/:entryId",
  "GET /api/data-sets/slug/:slug",
  "GET /api/datasets/:id/relations",
  "GET /api/datasets/count",
  "GET /api/doc",
  "GET /api/docs",
  "GET /api/docs-legacy",
  "GET /api/docs-legacy/openapi.json",
  "GET /api/docs-legacy/postman.json",
  "GET /api/docs-legacy/sdk",
  "GET /api/docs-legacy/swagger",
  "GET /api/docs/:kon/openapi.json",
  "GET /api/docs/assets/:asset/:file",
  "GET /api/docs/kons",
  "GET /api/docs/modern",
  "GET /api/docs/openapi.json",
  "GET /api/docs/operations",
  "GET /api/docs/postman.json",
  "GET /api/docs/sdk",
  "GET /api/explorer/:collection",
  "GET /api/explorer/:collection/options",
  "GET /api/explorer/:collection/views",
  "GET /api/explorer/discover/:konId",
  "GET /api/explorer/schema/:kon",
  "GET /api/explorer/schema/:kon/:table",
  "GET /api/explorer/schema/json/:table",
  "GET /api/explorer/tables",
  "GET /api/functions",
  "GET /api/functions/:id",
  "GET /api/functions/:id/executions",
  "GET /api/functions/cron/status",
  "GET /api/generate-code/:collection",
  "GET /api/generate-code/collections",
  "GET /api/graph",
  "GET /api/graph/:table",
  "GET /api/graph/:table/:id",
  "GET /api/graph/:table/:id/:relation",
  "GET /api/graphql",
  "GET /api/graphql/schema",
  "GET /api/health",
  "GET /api/health/pgtrgm",
  "GET /api/health/pgvector",
  "GET /api/items/:collection",
  "GET /api/items/:collection/:id",
  "GET /api/keys",
  "GET /api/kons/:konId/admin-asset/*",
  "GET /api/kons/:konId/graphics/*",
  "GET /api/llms.txt",
  "GET /api/mail",
  "GET /api/map",
  "GET /api/mcp",
  "GET /api/mcp/logs",
  "GET /api/media/count",
  "GET /api/modules",
  "GET /api/modules/:key",
  "GET /api/modules/:key/check",
  "GET /api/relations/:tableName",
  "GET /api/relations/:tableName/inlines/:parentId",
  "GET /api/relations/:tableName/inlines/config",
  "GET /api/runs",
  "GET /api/runs/:id",
  "GET /api/runs/stats",
  "GET /api/schema/search",
  "GET /api/schema/tables",
  "GET /api/schema/tables/:tableName",
  "GET /api/schema/tables/:tableName/admin-config",
  "GET /api/schema/tables/:tableName/related",
  "GET /api/search/stats",
  "GET /api/search/suggestions",
  "GET /api/settings",
  "GET /api/settings/social-live",
  "GET /api/swagger",
  "GET /api/system/active-theme-config",
  "GET /api/system/auth-providers",
  "GET /api/system/grimoires",
  "GET /api/system/grimoires/:id",
  "GET /api/system/init-check",
  "GET /api/system/theme-css/:themeId",
  "GET /api/system/themes",
  "GET /api/system/themes/:id/check",
  "GET /api/users/count",
  "GET /api/v1/agents",
  "GET /api/v1/agents/:id",
  "GET /api/v1/identities",
  "GET /api/v1/identities/:id",
  "GET /api/v1/traces",
  "GET /api/v1/traces/:id",
  "GET /api/v1/traces/:id/steps",
  "GET /api/version",
  "GET /health",
  "GET /live",
  "GET /llms.txt",
  "GET /media/*",
  "GET /metrics",
  "GET /ready",
  "GET /slo",
  "PATCH /api/actions/:id",
  "PATCH /api/admin/system/users/:id/role",
  "PATCH /api/admin/vault/:collection/rows/:id",
  "PATCH /api/data-sets/:id",
  "PATCH /api/explorer/:collection/:id",
  "PATCH /api/functions/:id",
  "PATCH /api/items/:collection/:id",
  "PATCH /api/modules/:key",
  "PATCH /api/settings",
  "PATCH /api/system/active-theme",
  "PATCH /api/v1/agents/:id",
  "PATCH /api/v1/identities/:id",
  "POST /api/actions",
  "POST /api/actions/:id/execute",
  "POST /api/admin/agents",
  "POST /api/admin/agents/:id/chat",
  "POST /api/admin/agents/:id/keys",
  "POST /api/admin/data-sources",
  "POST /api/admin/data-sources/:id/sync",
  "POST /api/admin/data-sources/test",
  "POST /api/admin/registry/refresh",
  "POST /api/admin/secrets",
  "POST /api/admin/secrets/:key/inject",
  "POST /api/admin/secrets/reload",
  "POST /api/admin/vault",
  "POST /api/admin/vault/:collection/columns",
  "POST /api/admin/vault/:collection/rows",
  "POST /api/agent/decisions",
  "POST /api/agent/memory",
  "POST /api/agent/memory/cleanup",
  "POST /api/agent/memory/search",
  "POST /api/auth/*",
  "POST /api/brain/capture",
  "POST /api/brain/connections",
  "POST /api/brain/digest",
  "POST /api/brain/notes",
  "POST /api/brain/scan",
  "POST /api/brain/sources",
  "POST /api/brain/sync",
  "POST /api/brain/tree",
  "POST /api/brain/tree/retrieve",
  "POST /api/code-graph/edit/:op",
  "POST /api/data-sets",
  "POST /api/data-sets/:id/entries",
  "POST /api/datasets/:id/query",
  "POST /api/datasets/batch",
  "POST /api/datasets/query-debug/:tableName",
  "POST /api/datasets/query/:tableName",
  "POST /api/datasets/validate-query/:tableName",
  "POST /api/explorer/:collection",
  "POST /api/explorer/:collection/views",
  "POST /api/functions",
  "POST /api/functions/:id/execute",
  "POST /api/generate-code",
  "POST /api/graph/refresh",
  "POST /api/graphql",
  "POST /api/graphql/invalidate",
  "POST /api/items/:collection",
  "POST /api/items/:collection/query",
  "POST /api/keys",
  "POST /api/mail/preview",
  "POST /api/mail/test",
  "POST /api/mcp",
  "POST /api/modules/:key/recover",
  "POST /api/modules/:key/uninstall",
  "POST /api/relations/:tableName/inlines/:parentId",
  "POST /api/schema/refresh",
  "POST /api/search",
  "POST /api/search/index",
  "POST /api/search/init",
  "POST /api/sync/igdb/import/:igdbId",
  "POST /api/sync/igdb/search",
  "POST /api/sync/twitch/status",
  "POST /api/system/grimoire-state",
  "POST /api/system/setup",
  "POST /api/v1/agents",
  "POST /api/v1/agents/:id/playground",
  "POST /api/v1/agents/:id/token",
  "POST /api/v1/identities",
  "PUT /api/admin/agents/:id",
  "PUT /api/admin/data-sources/:id",
  "PUT /api/agent/memory/:id",
];

/** It can only go DOWN. Raising it is deciding that a new route is born without a contract. */
// 263 (+2, 2026-11-04): `GET|POST /api/agent/decisions`, an agent's own decisions
// (lib/agent-decisions.ts). Like `/api/agent/memory`, any agent key writes its own
// rows with any scope; as an SDK operation every agent would need a new scope
// (the MCP twin, kitsuden_record_decision, asks for none). Move both together.
export const LEGACY_ROUTES_CAP = 263;
