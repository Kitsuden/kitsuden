/**
 * Who can call each API route — the table, versioned
 * ============================================================================
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * An audit found routes that had been born open
 * (`/api/items/authSessions` returned session tokens without login, functions
 * that executed code for any account). Nobody decided any of that: they
 * were mounted without a gate and nothing noticed. This table turns that around: EVERY mounted
 * route has to be here with its level, and
 * `scripts/authorization-matrix.ts` (run by
 * `tests/unit/authorization-matrix.test.ts`) mounts the real app, calls it with
 * six identities and fails if:
 *
 *   - a route appears that is not in the table (someone has to decide);
 *   - an identity that should not get in does (401/403 expected);
 *   - an identity that should get in stays out (the gate is excessive or a
 *     role is missing);
 *   - the table lists a route that no longer exists (it goes stale).
 *
 * ── THE LEVELS ─────────────────────────────────────────────────────────────
 *
 *   public     anonymous gets in. Every public WRITE is a
 *              conscious decision (sign-up, comments with their own check,
 *              subscription, signed webhooks…).
 *   user       a session is needed; any account (sign-up is open) gets in.
 *              Isolation between users (owner) is the handler's business.
 *   staff      `admin` or `editor`.
 *   content    `admin`, `editor` or an agent with `content:edit` (Inti).
 *   admin      `admin` only (or an agent with the `admin` scope).
 *   restricted none of the matrix's six identities gets in: the route
 *              asks for a role or scope they do not have (e.g. academy
 *              instructor, agent with `memory:*`). It is required that NONE of the
 *              five unprivileged ones pass; what admin does is not required.
 *   custom     custom expectation, written in `CUSTOM_EXPECTATION` with its
 *              reason (e.g. `GET /`: public summary for anonymous, and
 *              with credentials admin only).
 *   middleware `ALL` entries that Hono registers for `app.use()`: they are not a
 *              route, they are measured with the concrete route they protect.
 *
 * "Gets in" = the status is NOT 401 or 403 (it may be 400, 404, 422… with an
 * empty body and an id that does not exist: what is measured is the gate).
 */

import { readFileSync } from "node:fs";

export type Level =
  "public" | "user" | "staff" | "content" | "admin" | "restricted" | "custom" | "middleware";

type Identity =
  | "anonymous"
  | "user"
  | "editor"
  | "admin"
  | "agent"
  | "contentAgent"
  | "blogCreateAgent"
  | "datasetReadAgent"
  | "contentAgentMinusBlocks"
  | "adminAgent";

/**
 * An agent with `admin`. It gets into almost everything (nothing is required
 * of it outside its own scope), but in human approval it has to stay OUT:
 * an agent does not approve its proposals nor touch the configuration, whatever
 * scopes it carries. In `/api/proposals` (its status) it does get in.
 */
export const HUMANS_ONLY = [
  "/api/approvals",
  // OAuth for MCP (0055): consenting and managing connections is for humans
  "/api/oauth/consent",
  "/api/oauth/grants",
  // External MCP servers: an agent must not approve the tools it would be given
  "/api/admin/mcp-servers",
];

/**
 * Identities with FINE-GRAINED permissions (and one with a denial). They have no
 * column of their own in `EXPECTATION`: what is required of them is derived from the others.
 *
 *   blogCreateAgent          only `kon:blog:create-post`
 *   datasetReadAgent         only `datasets:<slug>:read` of a dataset of
 *                            the matrix (the `FINE_PROBES` probes measure it
 *                            against that real dataset)
 *   contentAgentMinusBlocks  `content:edit` + `!kon:blocks:*`
 *
 * Rules (see `expectationOf`):
 *   · the two fine-grained ones stay out of EVERY route where the agent without scopes
 *     has to stay out, except those in `ENTER_WITH_FINE_SCOPE`, where they
 *     MUST get in (and only those);
 *   · the one with the denial behaves like `contentAgent`, except on
 *     the operation routes of `kon-blocks`: there, always out (also the
 *     public ones: the denial belongs to the key).
 */
export const FINE_IDENTITIES = [
  "blogCreateAgent",
  "datasetReadAgent",
  "contentAgentMinusBlocks",
] as const;

/** The routes that a fine-grained scope OPENS (and that the matrix requires to be open). */
export const ENTER_WITH_FINE_SCOPE: Partial<Record<Identity, string[]>> = {
  blogCreateAgent: ["POST /api/blog"],
  datasetReadAgent: [],
};

/** The operation prefix that the denial of `contentAgentMinusBlocks` closes. */
export const DENIED_OPERATIONS: Partial<Record<Identity, string>> = {
  contentAgentMinusBlocks: "kon:blocks:",
};

/**
 * Must `id` get into a route of level `nivel`? `undefined` = not required.
 * `operation` is the fine-grained scope of the SDK operation that serves the route
 * (measured by the script), if there is one.
 */
export function expectationOf(
  id: Identity,
  level: Exclude<Level, "middleware">,
  key: string,
  operation?: string | null
): boolean | undefined {
  const base = level === "custom" ? OWN_EXPECTATION[key] : EXPECTATION[level];
  if (!base) return undefined;
  if (id === "blogCreateAgent" || id === "datasetReadAgent") {
    if (ENTER_WITH_FINE_SCOPE[id]?.includes(key)) return true;
    if (level === "custom") return undefined;
    return base.agent === false ? false : undefined;
  }
  if (id === "adminAgent") {
    const path = key.split(" ")[1] ?? "";
    if (HUMANS_ONLY.some((p) => path === p || path.startsWith(`${p}/`))) return false;
    if (level === "custom") return base.agent;
    return undefined;
  }
  if (id === "contentAgentMinusBlocks") {
    const prefix = DENIED_OPERATIONS[id];
    if (prefix && operation?.startsWith(prefix)) return false;
    if (level === "custom") return undefined;
    return base.contentAgent;
  }
  return base[id];
}

/**
 * Probes with a REAL resource (the table's routes are called with ids that do not
 * exist, and a 404 "gets in"): the script creates a private dataset and checks
 * the EXACT status that each identity must give. `:id` is the dataset's id.
 */
export const FINE_PROBES: {
  identity: Identity;
  method: string;
  path: string;
  body?: unknown;
  expected: number[];
  reason: string;
}[] = [
  {
    identity: "datasetReadAgent",
    method: "GET",
    path: "/api/datasets/:id/entries",
    expected: [200],
    reason: "datasets:<slug>:read opens the entries of THAT private dataset",
  },
  {
    identity: "datasetReadAgent",
    method: "GET",
    path: "/api/data-sets/:id/entries",
    expected: [200],
    reason: "also through the lite API",
  },
  {
    identity: "datasetReadAgent",
    method: "POST",
    path: "/api/datasets/:id/entries",
    body: { title: "no", data: {} },
    expected: [401, 403],
    reason: "reading is not writing",
  },
  {
    identity: "datasetReadAgent",
    method: "POST",
    path: "/api/data-sets/:id/entries",
    body: { title: "no", data: {} },
    expected: [401, 403],
    // Against a dataset open to sessions: tests/security-audit-2026-10-31.test.ts.
    reason: "reading is not writing, not through the lite API either",
  },
  {
    identity: "agent",
    method: "GET",
    path: "/api/datasets/:id/entries",
    // 403: /api/datasets/* goes through the
    // requireAuth of routes/datasets-query.ts, and a key without a datasets
    // scope does not act as a user (middleware/agent-as-user.ts). The
    // 403 is the same for any id: it does not leak whether the dataset exists either.
    expected: [403, 404],
    reason: "without the scope, the private dataset does not exist for it",
  },
  {
    identity: "blogCreateAgent",
    method: "GET",
    path: "/api/datasets/:id/entries",
    // 403: /api/datasets/* goes through the
    // requireAuth of routes/datasets-query.ts, and a key without a datasets
    // scope does not act as a user (middleware/agent-as-user.ts). The
    // 403 is the same for any id: it does not leak whether the dataset exists either.
    expected: [403, 404],
    reason: "a fine-grained scope of another kon does not open datasets",
  },
];

/** Who MUST get in and who MUST stay out at each level (`undefined` = not required). */
export const EXPECTATION: Record<
  Exclude<Level, "middleware" | "custom">,
  Partial<Record<Identity, boolean>>
> = {
  public: { anonymous: true, user: true, admin: true },
  user: { anonymous: false, user: true, editor: true, admin: true },
  staff: {
    anonymous: false,
    user: false,
    agent: false,
    contentAgent: false,
    editor: true,
    admin: true,
  },
  content: {
    anonymous: false,
    user: false,
    agent: false,
    editor: true,
    admin: true,
    contentAgent: true,
  },
  admin: {
    anonymous: false,
    user: false,
    editor: false,
    agent: false,
    contentAgent: false,
    admin: true,
  },
  restricted: {
    anonymous: false,
    user: false,
    editor: false,
    agent: false,
    contentAgent: false,
  },
};

/** Routes of level `own`: what is required of each identity and why. */
export const OWN_EXPECTATION: Record<string, Partial<Record<Identity, boolean>>> = {
  // observability.ts: without credentials, "the API is alive"; with a cookie or
  // Authorization, the counts and recent activity, admin only.
  "GET /": { anonymous: true, user: false, editor: false, admin: true },
  // Each AGENT records and reads ITS decisions (lib/agent-decisions.ts); a person,
  // even an admin, reads them through GET /api/v1/agent-decisions instead.
  "GET /api/agent/decisions": {
    anonymous: false,
    user: false,
    editor: false,
    admin: false,
    agent: true,
    contentAgent: true,
  },
  "POST /api/agent/decisions": {
    anonymous: false,
    user: false,
    editor: false,
    admin: false,
    agent: true,
    contentAgent: true,
  },
  // Each AGENT queries its proposals (others'
  // are 404 inside the route); the human team, all of them; an account
  // without a team role, none.
  "GET /api/proposals": {
    anonymous: false,
    user: false,
    editor: true,
    admin: true,
    agent: true,
    contentAgent: true,
  },
  "GET /api/proposals/:id": {
    anonymous: false,
    user: false,
    editor: true,
    admin: true,
    agent: true,
    contentAgent: true,
  },
  // B3 (2026-10-28): the same as the status, as an SSE flow.
  "GET /api/proposals/:id/events": {
    anonymous: false,
    user: false,
    editor: true,
    admin: true,
    agent: true,
    contentAgent: true,
  },
  // Activating a version. A human admin, yes (an
  // approved version that could not be activated). An AGENT, never on its own —
  // not even with `admin` (adminAgent inherits `agent: false`): only the execution
  // of its proposal approved by a human carries the process mark.
  "POST /api/promotion/versions/:id/activate": {
    anonymous: false,
    user: false,
    editor: false,
    admin: true,
    agent: false,
    contentAgent: false,
  },
};

/**
 * Writes that the matrix does NOT execute with an identity that has permission:
 * they touch the disk, the repository or the process. For them it is only checked
 * that whoever has NO permission stays out.
 */
export const DO_NOT_RUN_WITH_PERMISSION: string[] = [
  "POST /api/brain",
  "PUT /api/brain",
  "DELETE /api/brain",
  "POST /api/code-graph",
  "POST /api/modules",
  "PATCH /api/modules",
  "PUT /api/modules",
  "DELETE /api/modules",
  "POST /api/system",
  "PATCH /api/system",
  "PUT /api/system",
  "DELETE /api/system",
  "POST /api/functions",
  "POST /api/actions",
  "POST /api/sync",
  "POST /api/search/init",
  "POST /api/search/index",
  "POST /api/admin/vault",
  "POST /api/media",
  "DELETE /api/media",
  "POST /api/mail/test",
];

/** Placeholder value for each `:param` (same criterion as `scripts/smoke-routes.ts`). */
const FILLER: Record<string, string> = {
  id: "00000000-0000-0000-0000-000000000000",
  konId: "kon-blog",
  kon: "kon-blog",
  key: "kon-blog",
  table: "media",
  tableName: "media",
  collection: "media",
  slug: "does-not-exist",
  channel: "general",
};

export function specify(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => {
      if (seg === "*") return "x";
      if (!seg.startsWith(":")) return seg;
      const name = seg.slice(1).replace(/[?{].*$/, "");
      if (/\{[^}]*\\d/.test(seg) || /\{\[0-9\]/.test(seg)) return "1";
      return FILLER[name] ?? "00000000-0000-0000-0000-000000000000";
    })
    .join("/");
}

/**
 * The `METHOD /pattern` keys of Hono's table, without duplicates. The
 * `app.use()` calls that hang from everything (`/*`, `/api/*`) are left out: they belong to
 * nobody. The rest of the `ALL` entries are listed and classified as `middleware`.
 */
export function routeKeys(routes: { method: string; path: string }[]): string[] {
  return [
    ...new Set(
      routes
        .filter((r) => !(r.method === "ALL" && (r.path === "/*" || r.path === "/api/*")))
        .map((r) => `${r.method} ${r.path}`)
    ),
  ].sort();
}

const DENIED = new Set([401, 403]);

export function compareWithMatrix(
  measures: {
    key: string;
    statuses: Partial<Record<Identity, number>>;
    operation?: string | null;
  }[],
  matrix: Record<string, Level> = MATRIX
): string[] {
  const failures: string[] = [];
  const views = new Set<string>();
  for (const { key: key, statuses, operation: operation } of measures) {
    views.add(key);
    const level = matrix[key];
    if (!level) {
      failures.push(`${key}: UNCLASSIFIED route (add it to MATRIX with its level)`);
      continue;
    }
    if (level === "middleware") {
      if (!key.startsWith("ALL ")) failures.push(`${key}: only an ALL can be 'middleware'`);
      continue;
    }
    const expected = level === "custom" ? OWN_EXPECTATION[key] : EXPECTATION[level];
    if (!expected) {
      failures.push(`${key}: level 'custom' with no entry in CUSTOM_EXPECTATION`);
      continue;
    }
    const identities = [
      ...(Object.keys(expected) as Identity[]),
      ...FINE_IDENTITIES.filter((f) => !(f in expected)),
      ...(["adminAgent"] as const).filter((f) => !(f in expected)),
    ];
    for (const id of identities) {
      const shouldEnter = expectationOf(id, level, key, operation);
      if (shouldEnter === undefined) continue;
      const status = statuses[id];
      if (status === undefined) continue; // was not executed (DO_NOT_RUN_WITH_PERMISSION)
      const entered = !DENIED.has(status);
      if (entered !== shouldEnter) {
        failures.push(
          `${key} [${level}]: ${id} → ${status} (${shouldEnter ? "should have gotten in" : "should have stayed out"})`
        );
      }
    }
  }
  for (const key of Object.keys(matrix)) {
    if (!views.has(key))
      failures.push(`${key}: it is in MATRIX but is no longer mounted (delete it)`);
  }
  return failures;
}

// ════════════════════════════════════════════════════════════════════════════
// THE TABLE
// ════════════════════════════════════════════════════════════════════════════

const CORE_MATRIX: Record<string, Level> = {
  // ── own — see CUSTOM_EXPECTATION
  "GET /": "custom",
  "GET /api/proposals": "custom",
  // An agent's own decisions (routes/agent-decisions.ts): any agent, never a person.
  "GET /api/agent/decisions": "custom",
  "POST /api/agent/decisions": "custom",
  "GET /api/proposals/:id": "custom",
  "GET /api/proposals/:id/events": "custom",
  // ── OAuth 2.1 for MCP (routes/oauth.ts, docs/agents/oauth.md) ──
  // Public by the specification (MCP 2026-07-28): metadata, dynamic
  // registration (limited by IP, fails closed), authorization (only redirects
  // to the panel), token and revocation (they authenticate the CLIENT, not the session).
  "GET /.well-known/oauth-protected-resource": "public",
  "GET /.well-known/oauth-protected-resource/api/mcp": "public",
  "GET /.well-known/oauth-authorization-server": "public",
  "POST /api/oauth/register": "public",
  "GET /api/oauth/authorize": "public",
  "POST /api/oauth/token": "public",
  "POST /api/oauth/revoke": "public",
  // Consent and connections: human admin/editor (fresh role); no
  // agent (HUMANS_ONLY). An editor only sees and revokes their own (others' are 404).
  "GET /api/oauth/consent/:id": "staff",
  "POST /api/oauth/consent/:id": "staff",
  "GET /api/oauth/grants": "staff",
  "DELETE /api/oauth/grants/:id": "staff",
  // `WWW-Authenticate` on the 401/403 of /api/mcp, and the OAuth shutdown
  "ALL /api/mcp": "middleware",
  "ALL /api/oauth/*": "middleware",
  "ALL /.well-known/oauth-protected-resource": "middleware",
  "ALL /.well-known/oauth-protected-resource/*": "middleware",
  "ALL /.well-known/oauth-authorization-server": "middleware",
  // ── public (185) — Public (anonymous gets in). The WRITES here were reviewed one by one.

  "GET /api/auth/*": "public",

  "GET /api/data-sets": "public",
  "GET /api/data-sets/:id": "public",
  "GET /api/data-sets/:id/entries": "public",
  "GET /api/data-sets/:id/entries/:entryId": "public",
  "GET /api/data-sets/slug/:slug": "public",

  "GET /api/doc": "public",
  "GET /api/docs": "public",
  "GET /api/docs-legacy": "public",
  "GET /api/docs-legacy/modern": "public",
  "GET /api/docs-legacy/openapi.json": "public",
  "GET /api/docs-legacy/postman.json": "public",
  "GET /api/docs-legacy/sdk": "public",
  "GET /api/docs-legacy/swagger": "public",
  "GET /api/docs/:kon/openapi.json": "public",
  "GET /api/docs/kons": "public",
  "GET /api/docs/modern": "public",
  "GET /api/docs/openapi.json": "public",
  "GET /api/docs/operations": "public",
  "GET /api/docs/postman.json": "public",
  "GET /api/docs/sdk": "public",

  "GET /api/health": "public",
  "GET /api/health/pgtrgm": "public",
  "GET /api/health/pgvector": "public",
  "GET /api/kons/:konId/admin-asset/*": "public",
  "GET /api/kons/:konId/graphics/*": "public",
  "GET /api/llms.txt": "public",

  "GET /api/media/focal-point/:id": "public",
  "GET /api/media/preset/:id/:preset": "public",
  "GET /api/media/transform/:id": "public",

  "GET /api/page-builder/block-types": "public",
  "GET /api/page-builder/pages": "public",
  "GET /api/page-builder/pages/:id": "public",
  "GET /api/page-builder/render/:slug": "public",
  "GET /api/page-builder/templates": "public",

  "GET /api/search/suggestions": "public",
  "GET /api/settings": "public",
  "GET /api/settings/social-live": "public",

  "GET /api/swagger": "public",
  "GET /api/system/active-theme-config": "public",
  "GET /api/system/auth-providers": "public",
  "GET /api/system/grimoires": "public",
  "GET /api/system/grimoires/:id": "public",
  "GET /api/system/init-check": "public",
  "GET /api/system/theme-css/:themeId": "public",
  "GET /api/system/themes": "public",
  // API version and contracts (routes/version.ts), mounted after the metering
  "GET /api/version": "public",

  "GET /health": "public",
  "GET /live": "public",
  "GET /llms.txt": "public",
  "GET /media/*": "public",
  "GET /ready": "public",
  "GET /slo": "public",

  "POST /api/auth/*": "public",

  "POST /api/search": "public",

  // ── user (158) — Any account. Isolation between users is done by the handler (owner).

  "DELETE /api/datasets/:id/calculated-fields/:fieldId": "user",
  "DELETE /api/datasets/:id/entries/:entryId": "user",

  // Public on purpose: whoever receives a certificate checks its code without an
  // account (before, the router-wide requireAuth covered it).

  "GET /api/datasets": "user",
  "GET /api/datasets/:id": "user",
  "GET /api/datasets/:id/calculated-fields": "user",
  "GET /api/datasets/:id/calculated-fields/:fieldId": "user",
  "GET /api/datasets/:id/entries": "user",
  "GET /api/datasets/:id/entries/:entryId": "user",
  "GET /api/datasets/:id/entries/:entryId/snapshot": "user",
  "GET /api/datasets/:id/entries/:entryId/snapshots": "user",
  "GET /api/datasets/:id/relations": "user",
  "GET /api/datasets/:id/search": "user",
  "GET /api/datasets/slug/:slug": "user",

  "GET /api/graph": "user",
  "GET /api/graph/:table": "user",
  "GET /api/graph/:table/:id": "user",
  "GET /api/graph/:table/:id/:relation": "user",

  "GET /api/system/themes/:id/check": "user",

  "PATCH /api/data-sets/:id": "user",
  "PATCH /api/datasets/:id": "user",
  "PATCH /api/datasets/:id/calculated-fields/:fieldId": "user",
  "PATCH /api/datasets/:id/entries/:entryId": "user",

  "POST /api/data-sets/:id/entries": "user",
  "POST /api/datasets/:id/calculated-fields": "user",
  "POST /api/datasets/:id/compare": "user",
  "POST /api/datasets/:id/entries": "user",
  "POST /api/datasets/:id/entries/:entryId/compare": "user",
  "POST /api/datasets/:id/entries/:entryId/restore": "user",
  "POST /api/datasets/:id/entries/:entryId/snapshots": "user",
  "POST /api/datasets/:id/query": "user",

  // kon-ingest: both models are `owner` — any account, each one
  // with their own (RLS); an agent additionally needs `document:*` / `chunk:*`.

  // ── staff (94) — Team: admin or editor.
  // The approval inbox. HUMANS only (no agent, not even with
  // admin: humansOnly in routes/approvals.ts); configuring, admin only.
  "GET /api/approvals/proposals": "staff",
  // Model descriptors (defineModel) for the panel.
  "GET /api/models": "staff",
  "GET /api/approvals/proposals/count": "staff",
  "GET /api/approvals/proposals/:id": "staff",
  "GET /api/approvals/proposals/:id/files/:fileId": "staff",
  "POST /api/approvals/proposals/:id/approve": "staff",
  "POST /api/approvals/proposals/:id/reject": "staff",
  // Agent data ledger (lib/ledger.ts): later reviews and the evidence per field.
  "POST /api/approvals/proposals/:id/review": "staff",
  "GET /api/approvals/reviews": "staff",
  "POST /api/approvals/reviews/:id/done": "staff",
  "GET /api/approvals/evidence": "staff",
  "GET /api/approvals/settings": "staff",
  "GET /api/approvals/audit": "staff",
  "PUT /api/approvals/settings": "admin",
  "PUT /api/approvals/agents/:id/mode": "admin",
  // Unattended runs: hold or deny with an alternative (lib/approvals.ts). Human admin.
  "PUT /api/approvals/agents/:id/unattended": "admin",
  // The code promotion panel. HUMAN admin only (humansOnly
  // + requireAdminRole in routes/promotion.ts; adminAgent out by HUMANS_ONLY).
  "GET /api/approvals/promotion/settings": "admin",
  "PUT /api/approvals/promotion/settings": "admin",
  "PUT /api/approvals/promotion/agents/:id/mode": "admin",
  "GET /api/approvals/promotion/versions": "admin",
  "GET /api/approvals/promotion/versions/:id": "admin",
  "POST /api/approvals/promotion/versions/:id/approve": "admin",
  "POST /api/approvals/promotion/versions/:id/reject": "admin",
  "POST /api/approvals/promotion/versions/:id/rollback": "admin",
  "POST /api/approvals/promotion/versions/:id/activate": "admin",
  // The agent's part. Proposing requires `promotion:propose` (no
  // matrix identity has it except adminAgent, through `admin`): not even a human
  // admin proposes (they edit the action). Reading: the agent its own, the admin everything.
  "POST /api/promotion/drafts": "restricted",
  "GET /api/promotion/drafts": "admin",
  "GET /api/promotion/drafts/:id": "admin",
  "POST /api/promotion/versions/:id/activate": "custom",

  "DELETE /api/media/:id": "staff",
  "DELETE /api/media/cache/:id": "staff",

  "GET /api/datasets/:id/indexes/suggest": "staff",
  "GET /api/datasets/count": "staff",

  "GET /api/media": "staff",
  "GET /api/media/:id": "staff",
  "GET /api/media/count": "staff",
  "GET /api/media/folders": "staff",

  "GET /api/users/count": "staff",

  "PATCH /api/media/:id": "staff",

  "POST /api/data-sets": "staff",
  "POST /api/datasets": "staff",
  "POST /api/datasets/export": "staff",

  "POST /api/media/config": "staff",
  "POST /api/media/config/test-storage": "staff",
  "POST /api/media/focal-point/:id": "staff",
  "POST /api/media/folders": "staff",
  "POST /api/media/upload": "staff",

  // ── content (14) — Team or agent with `content:edit` (Inti).
  "DELETE /api/page-builder/blocks/:id": "content",
  "DELETE /api/page-builder/pages/:id": "content",

  "PATCH /api/page-builder/blocks/:id": "content",
  "PATCH /api/page-builder/pages/:id": "content",
  "POST /api/page-builder/blocks/:id/duplicate": "content",
  "POST /api/page-builder/pages": "content",
  "POST /api/page-builder/pages/:id/clone": "content",
  "POST /api/page-builder/pages/:pageId/blocks": "content",
  "POST /api/page-builder/pages/:pageId/blocks/reorder": "content",
  "POST /api/page-builder/pages/from-block": "content",
  "POST /api/page-builder/templates": "content",
  "POST /api/page-builder/templates/:id/use": "content",

  // ── admin (487) — Admin only.

  "DELETE /api/actions/:id": "admin",
  "DELETE /api/admin/agents/:id": "admin",
  "DELETE /api/admin/agents/:id/keys/:keyId": "admin",
  "DELETE /api/admin/data-sources/:id": "admin",
  "DELETE /api/admin/queue/:id": "admin",
  "DELETE /api/admin/rate-limits/:key": "admin",
  "DELETE /api/admin/secrets/:key": "admin",
  "DELETE /api/admin/vault/:collection": "admin",
  "DELETE /api/admin/vault/:collection/columns/:column": "admin",
  "DELETE /api/admin/vault/:collection/rows/:id": "admin",

  "DELETE /api/brain/notes/:id": "admin",

  "DELETE /api/datasets/:id": "admin",

  "DELETE /api/explorer/:collection/:id": "admin",
  "DELETE /api/explorer/:collection/views/:viewId": "admin",
  "DELETE /api/functions/:id": "admin",
  "DELETE /api/items/:collection/:id": "admin",
  "DELETE /api/keys/:id": "admin",
  "DELETE /api/modules/:key": "admin",

  "DELETE /api/system/active-theme": "admin",
  "DELETE /api/system/grimoires/:id": "admin",
  "DELETE /api/v1/agents/:id": "admin",
  "DELETE /api/v1/identities/:id": "admin",
  "GET /admin/activity": "admin",
  "GET /admin/logs": "admin",
  "GET /admin/metrics": "admin",
  "GET /admin/metrics/prometheus": "admin",
  "GET /admin/realtime": "admin",
  "GET /admin/slo": "admin",
  "GET /admin/stats": "admin",
  "GET /admin/telemetry/tools": "admin",
  "GET /admin/traces": "admin",
  "GET /admin/traces/:id": "admin",
  "GET /admin/traces/:id/steps": "admin",

  "GET /api/actions": "admin",
  "GET /api/actions/:id": "admin",
  "GET /api/actions/:id/executions": "admin",
  "GET /api/actions/stats/overview": "admin",
  "GET /api/admin/agents": "admin",
  "GET /api/admin/agents/:id": "admin",
  "GET /api/admin/agents/:id/chat/history": "admin",
  "GET /api/admin/agents/:id/logs": "admin",
  "GET /api/admin/agents/:id/notify": "admin",
  "GET /api/admin/agents/:id/stats": "admin",
  "GET /api/admin/agents/:id/traces": "admin",
  "GET /api/admin/agents/logs": "admin",
  "GET /api/admin/agents/traces/:traceId/steps": "admin",
  "GET /api/admin/data-sources": "admin",
  "GET /api/admin/data-sources/:id": "admin",
  "GET /api/admin/queue": "admin",
  // External MCP servers (lib/external-mcp.ts): human admins only
  // (requireAdminRole + humansOnly; adminAgent out by HUMANS_ONLY).
  "GET /api/admin/mcp-servers": "admin",
  "POST /api/admin/mcp-servers": "admin",
  "PATCH /api/admin/mcp-servers/:id": "admin",
  "DELETE /api/admin/mcp-servers/:id": "admin",
  "POST /api/admin/mcp-servers/:id/refresh": "admin",
  "GET /api/admin/mcp-servers/:id/tools": "admin",
  "POST /api/admin/mcp-servers/:id/tools/approve": "admin",
  "GET /api/admin/rate-limits": "admin",
  "GET /api/admin/requests": "admin",
  "GET /api/admin/requests/summary": "admin",
  "GET /api/admin/registry": "admin",
  "GET /api/admin/registry/:konId": "admin",
  "GET /api/admin/registry/:konId/schema/:table": "admin",
  "GET /api/admin/secrets": "admin",
  "GET /api/admin/vault": "admin",

  "GET /api/brain/graph": "admin",
  "GET /api/brain/graph/:id/neighborhood": "admin",
  "GET /api/brain/lint": "admin",
  "GET /api/brain/llms.txt": "admin",
  "GET /api/brain/notes": "admin",
  "GET /api/brain/notes/:id": "admin",
  "GET /api/brain/notes/:id/similar": "admin",
  "GET /api/brain/schema": "admin",
  "GET /api/brain/sources": "admin",
  "GET /api/brain/sources/:id": "admin",
  "GET /api/brain/status": "admin",
  "GET /api/brain/wiki": "admin",
  // Agent memory (2026-10-28): the team; an agent, with brain:read /
  // brain:write (or admin). Who sees which note is decided by RLS by owner.
  "GET /api/brain/memory/search": "staff",
  "GET /api/brain/memory/notes": "staff",
  "PUT /api/brain/memory/notes": "staff",
  "GET /api/brain/memory/notes/:id": "staff",
  "DELETE /api/brain/memory/notes/:id": "staff",
  "GET /api/brain/memory/notes/:id/connections": "staff",
  "POST /api/brain/memory/connections": "staff",
  "GET /api/brain/memory/claims": "staff",
  "POST /api/brain/memory/claims": "staff",
  "POST /api/brain/memory/claims/:id/verify": "staff",
  "POST /api/brain/memory/lint": "staff",
  "GET /api/brain/memory/export/okf": "staff",
  "POST /api/brain/memory/import/graphify": "staff",
  "GET /api/code-graph": "admin",
  "GET /api/code-graph/commit/:sha": "admin",
  "GET /api/code-graph/history": "admin",
  "GET /api/code-graph/outline": "admin",
  "GET /api/code-graph/path": "admin",
  "GET /api/code-graph/search": "admin",
  "GET /api/code-graph/semantic": "admin",
  "GET /api/code-graph/symbol/:name": "admin",
  "GET /api/code-graph/visualize": "admin",

  "GET /api/datasets/indexes/stats": "admin",

  "GET /api/explorer/:collection": "admin",
  "GET /api/explorer/:collection/options": "admin",
  "GET /api/explorer/:collection/views": "admin",
  "GET /api/explorer/discover/:konId": "admin",
  "GET /api/explorer/schema/:kon": "admin",
  "GET /api/explorer/schema/:kon/:table": "admin",
  "GET /api/explorer/schema/json/:table": "admin",
  "GET /api/explorer/tables": "admin",
  "GET /api/functions": "admin",
  "GET /api/functions/:id": "admin",
  "GET /api/functions/:id/executions": "admin",
  "GET /api/functions/cron/status": "admin",
  "GET /api/generate-code/:collection": "admin",
  "GET /api/generate-code/collections": "admin",
  "GET /api/graphql": "admin",
  "GET /api/graphql/schema": "admin",
  "GET /api/items/:collection": "admin",
  "GET /api/items/:collection/:id": "admin",
  "GET /api/keys": "admin",
  "GET /api/mail": "admin",
  "GET /api/map": "admin",
  "GET /api/media/config": "admin",
  "GET /api/modules": "admin",
  "GET /api/modules/:key": "admin",
  "GET /api/modules/:key/check": "admin",

  "GET /api/relations/:tableName": "admin",
  "GET /api/relations/:tableName/inlines/:parentId": "admin",
  "GET /api/relations/:tableName/inlines/config": "admin",
  "GET /api/runs": "admin",
  "GET /api/runs/:id": "admin",
  "GET /api/runs/stats": "admin",
  "GET /api/schema/search": "admin",
  "GET /api/schema/tables": "admin",
  "GET /api/schema/tables/:tableName": "admin",
  "GET /api/schema/tables/:tableName/admin-config": "admin",
  "GET /api/schema/tables/:tableName/related": "admin",
  "GET /api/search/stats": "admin",
  "GET /api/admin/system/status": "admin",
  "GET /api/admin/system/users": "admin",
  "PATCH /api/admin/system/users/:id/role": "admin",
  "GET /api/v1/agents": "admin",
  "GET /api/v1/agents/:id": "admin",
  "GET /api/v1/agents/:id/access": "admin",
  "GET /api/v1/agents/:id/keys": "admin",
  "GET /api/v1/agents/:id/quotas": "admin",
  "GET /api/v1/agents/:id/mcp-settings": "admin",
  "GET /api/v1/agents/:id/sponsor": "admin",
  "GET /api/v1/agent-access/catalog": "admin",
  "GET /api/v1/agent-friction": "admin",
  // What agents chose not to do (lib/agent-decisions.ts): admins read them all.
  "GET /api/v1/agent-decisions": "admin",
  // Versioned agents (lib/agent-versions.ts). Restoring is an agent write: people
  // only (index.ts blocks agents on /api/v1/agents writes).
  "GET /api/v1/agents/:id/versions": "admin",
  "GET /api/v1/agents/:id/versions/:version": "admin",
  "POST /api/v1/agents/:id/versions/:version/restore": "admin",
  "GET /api/v1/identities": "admin",
  "GET /api/v1/identities/:id": "admin",
  "GET /api/v1/traces": "admin",
  "GET /api/v1/traces/:id": "admin",
  "GET /api/v1/traces/:id/steps": "admin",
  "GET /metrics": "admin",
  "PATCH /api/actions/:id": "admin",
  "PATCH /api/admin/vault/:collection/rows/:id": "admin",

  "PATCH /api/explorer/:collection/:id": "admin",
  "PATCH /api/functions/:id": "admin",
  "PATCH /api/items/:collection/:id": "admin",
  "PATCH /api/modules/:key": "admin",

  "PATCH /api/settings": "admin",
  "PATCH /api/system/active-theme": "admin",
  "PATCH /api/v1/agents/:id": "admin",
  "PATCH /api/v1/identities/:id": "admin",

  "POST /api/actions": "admin",
  "POST /api/actions/:id/execute": "admin",
  "POST /api/admin/agents": "admin",
  "POST /api/admin/agents/:id/chat": "admin",
  "POST /api/admin/agents/:id/keys": "admin",
  "POST /api/admin/agents/:id/notify/rotate": "admin",
  "POST /api/admin/queue/:id/retry": "admin",
  "POST /api/admin/data-sources": "admin",
  "POST /api/admin/data-sources/:id/sync": "admin",
  "POST /api/admin/data-sources/test": "admin",
  "POST /api/admin/registry/refresh": "admin",
  "POST /api/admin/secrets": "admin",
  "POST /api/admin/secrets/:key/inject": "admin",
  "POST /api/admin/secrets/reload": "admin",
  "POST /api/admin/vault": "admin",
  "POST /api/admin/vault/:collection/columns": "admin",
  "POST /api/admin/vault/:collection/rows": "admin",

  "POST /api/brain/capture": "admin",
  "POST /api/brain/connections": "admin",
  "POST /api/brain/digest": "admin",
  "POST /api/brain/notes": "admin",
  "POST /api/brain/scan": "admin",
  "POST /api/brain/sources": "admin",
  "POST /api/brain/sync": "admin",
  "POST /api/brain/tree": "admin",
  "POST /api/brain/tree/retrieve": "admin",
  "POST /api/code-graph/edit/:op": "admin",

  "POST /api/datasets/:id/indexes/apply": "admin",
  "POST /api/datasets/batch": "admin",
  "POST /api/datasets/import": "admin",
  "POST /api/datasets/import/package": "admin",
  "POST /api/datasets/indexes/auto": "admin",
  "POST /api/datasets/indexes/report": "admin",
  "POST /api/datasets/query-debug/:tableName": "admin",
  "POST /api/datasets/query/:tableName": "admin",
  "POST /api/datasets/validate-query/:tableName": "admin",

  "POST /api/explorer/:collection": "admin",
  "POST /api/explorer/:collection/views": "admin",
  "POST /api/functions": "admin",
  "POST /api/functions/:id/execute": "admin",
  "POST /api/generate-code": "admin",
  "POST /api/graph/refresh": "admin",
  "POST /api/graphql": "admin",
  "POST /api/graphql/invalidate": "admin",
  "POST /api/items/:collection": "admin",
  "POST /api/items/:collection/query": "admin",
  "POST /api/keys": "admin",
  "POST /api/mail/preview": "admin",
  "POST /api/mail/test": "admin",
  "POST /api/modules/:key/recover": "admin",
  "POST /api/modules/:key/uninstall": "admin",

  "POST /api/relations/:tableName/inlines/:parentId": "admin",
  "POST /api/schema/refresh": "admin",
  "POST /api/search/index": "admin",
  "POST /api/search/init": "admin",
  "POST /api/sync/igdb/import/:igdbId": "admin",
  "POST /api/sync/igdb/search": "admin",
  "POST /api/sync/twitch/status": "admin",
  "POST /api/system/grimoire-state": "admin",
  "POST /api/system/setup": "restricted", // public, but with users already created it answers 403
  "POST /api/v1/agents": "admin",
  "POST /api/v1/agents/:id/playground": "admin",
  "POST /api/v1/agents/:id/token": "admin",
  "POST /api/v1/agents/:id/keys": "admin",
  "POST /api/v1/agents/:id/keys/:keyId/revoke": "admin",
  "POST /api/v1/agents/:id/keys/:keyId/rotate": "admin",
  "POST /api/v1/identities": "admin",

  "PUT /api/admin/agents/:id": "admin",
  "PUT /api/admin/agents/:id/notify": "admin",
  "PUT /api/admin/data-sources/:id": "admin",

  "PUT /api/v1/agents/:id/quotas": "admin",
  "PUT /api/v1/agents/:id/mcp-settings": "admin",
  "PUT /api/v1/agents/:id/sponsor": "admin",
  "PUT /api/v1/agents/:id/scopes": "admin",
  // ── restricted (15) — None of the six identities: own role or scope (instructor, agent with memory:*, guest token…).
  "DELETE /api/agent/memory/:id": "restricted",

  "GET /api/agent/memory": "restricted",
  "GET /api/agent/memory/:id": "restricted",
  "GET /api/agent/memory/key/:key": "restricted",
  "GET /api/agent/memory/stats": "restricted",

  "GET /api/mcp": "restricted",
  "GET /api/mcp/logs": "restricted",
  "POST /api/agent/memory": "restricted",
  "POST /api/agent/memory/cleanup": "restricted",
  "POST /api/agent/memory/search": "restricted",

  "POST /api/mcp": "restricted",
  "PUT /api/agent/memory/:id": "restricted",
  // ── middleware (52) — the RLS transaction that module-loader mounts in front of
  // each kon (`mountKonRls`, 2026-10-23): `app.use(base)` and `app.use(base/*)`.
  // It authorizes nothing; who gets through is decided by the concrete routes, which are measured.

  // RLS transaction of agent memory (mountKonRls, index.ts)
  "ALL /api/brain/memory": "middleware",
  "ALL /api/brain/memory/*": "middleware",
  // RLS transaction of code promotion (mountKonRls, index.ts)
  "ALL /api/promotion": "middleware",
  "ALL /api/promotion/*": "middleware",

  "ALL /api/datasets": "middleware",

  "ALL /api/media": "middleware",
  "ALL /api/media/*": "middleware",

  "ALL /api/page-builder": "middleware",
  "ALL /api/page-builder/*": "middleware",

  // ── middleware (77) — app.use() registered by prefix: measured with their concrete routes.

  "ALL /api/actions/*": "middleware",
  "ALL /api/admin/*": "middleware",
  "ALL /api/admin/agents/*": "middleware",
  "ALL /api/admin/data-sources/*": "middleware",
  "ALL /api/admin/registry/*": "middleware",
  "ALL /api/admin/vault/*": "middleware",
  "ALL /api/agent/memory/*": "middleware",
  "ALL /api/agent/decisions/*": "middleware",

  // Attempt limit for the room password (kon's rateLimits, fail-closed)

  "ALL /api/data-sets/:id/entries": "middleware",
  "ALL /api/data-sets/:slug/entries": "middleware",
  "ALL /api/datasets/*": "middleware",
  "ALL /api/datasets/:id/entries": "middleware",
  "ALL /api/datasets/:slug/entries": "middleware",

  // Request limits of kon-esports (kon's rateLimits, audit
  // 2026-10-25): they count; who gets in is decided by the concrete route.

  "ALL /api/explorer/*": "middleware",
  "ALL /api/functions/*": "middleware",
  "ALL /api/graph/*": "middleware",

  "ALL /api/items/*": "middleware",
  // `requireAdminRole` on the base route (fresh role)
  "ALL /api/keys": "middleware",
  "ALL /api/keys/*": "middleware",
  "ALL /api/mail/*": "middleware",
  "ALL /api/mcp/*": "middleware",
  // Transformation limit of kon-media
  "ALL /api/media/transform/:id": "middleware",

  "ALL /api/relations/*": "middleware",
  "ALL /api/runs/*": "middleware",
  "ALL /api/schema/*": "middleware",

  // `requireAdminRole` on the base route (fresh role)
  "ALL /api/admin/system": "middleware",
  "ALL /api/admin/system/*": "middleware",
  "ALL /api/auth/sign-up/*": "middleware",
  "ALL /api/datasets/batch": "middleware",
  "ALL /api/v1/*": "middleware",
};

/**
 * The kons' routes are classified in the kons repository
 * (`authorization-matrix.kons.json`). Point `KITSUDEN_KONS_MATRIX` at that file
 * to check an installation that has kons mounted.
 */
function konsMatrix(): Record<string, Level> {
  const file = process.env.KITSUDEN_KONS_MATRIX;
  return file ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Level>) : {};
}

export const MATRIX: Record<string, Level> = { ...CORE_MATRIX, ...konsMatrix() };
