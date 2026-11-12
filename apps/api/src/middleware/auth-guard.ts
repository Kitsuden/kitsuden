import {
  opensWholeKon,
  grantsByScopes,
  operationDenial,
  denialThatCovers,
  konShortName,
} from "@kitsuden/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { routeOperation } from "../../../../packages/engine/src/operations";
import { auth } from "../lib/auth";
import { pathKon } from "../lib/kon-routes";

import { agentCanActAsUser, AGENT_WITHOUT_ACCOUNT_MESSAGE } from "./agent-as-user";

/**
 * Protect Route Middleware
 *
 * Supports both:
 * 1. Human authentication (Better-Auth cookies)
 * 2. Agent authentication (kitsuden_agent_ API keys)
 *
 * Priority: Agent > Human (for API routes that support both)
 */

export const protectRoute = createMiddleware(async (c, next) => {
  // 1. Check if already authenticated as agent (from main auth middleware)
  const agent = c.get("agent");
  if (agent) {
    // Authenticated in the global middleware; but a key is not an account
    // just by being one (see middleware/agent-as-user.ts)
    if (!agentCanActAsUser(c)) {
      return c.json({ error: "Forbidden", message: AGENT_WITHOUT_ACCOUNT_MESSAGE }, 403);
    }
    await next();
    return;
  }

  // 2. Check if already authenticated as user (from main auth middleware)
  const user = c.get("user");
  if (user) {
    // User is already authenticated
    await next();
    return;
  }

  // 3. Try Better-Auth session
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (session) {
    c.set("user", session.user);
    c.set("session", session.session);
    await next();
    return;
  }

  // 4. No authentication found
  return c.json(
    {
      error: "Unauthorized",
      message: "Valid session or agent API key required",
    },
    401
  );
});

/**
 * Require Admin Middleware
 * Checks for admin role (users) or appropriate scopes (agents)
 */
export const requireAdmin = createMiddleware(async (c, next) => {
  const user = c.get("user");
  const agent = c.get("agent");

  // Human admin
  if (user && (user.role as string) === "admin") {
    await next();
    return;
  }

  // Agent with admin scope
  if (agent && agent.scopes.includes("admin")) {
    await next();
    return;
  }

  return c.json(
    {
      error: "Forbidden",
      message: "Admin access required",
    },
    403
  );
});

/**
 * Require Scope Middleware (for agent-specific routes)
 */
export const requireScope = (scope: string) =>
  createMiddleware(async (c, next) => {
    const agent = c.get("agent");

    if (!agent) {
      return c.json(
        {
          error: "Forbidden",
          message: "Agent authentication required",
        },
        403
      );
    }

    if (!agent.scopes.includes(scope) && !agent.scopes.includes("admin")) {
      return c.json(
        {
          error: "Forbidden",
          message: `Scope '${scope}' required`,
          granted: agent.scopes,
        },
        403
      );
    }

    await next();
  });

/**
 * Requires one of these roles, wherever the middleware sits.
 *
 * `requireAdmin` looks at `c.get("user")`, which the global middleware of
 * `index.ts` sets. Routes mounted BEFORE that middleware (observability at
 * `/`, `/api/admin/rate-limits`, `/api/search`, `/api/system`) never have it,
 * so there `requireAdmin` would always deny and `requireAuth` only
 * asked for a session — of anyone, and sign-up is open. This resolves the session
 * on its own if needed.
 *
 * An agent passes only with the `admin` scope (same as `requireAdmin`).
 */
/**
 * FRESH role of the session, without better-auth's cookie cache.
 *
 * `session.cookieCache` (5 min) stores the user —with their role— signed in a
 * cookie, and `getSession` returns it without looking at the database. So whoever
 * had the admin role removed (or their sessions closed) kept getting into the
 * panel for up to 5 minutes. On routes with a role gate
 * the session is re-read from the database: an indexed query, only on panel
 * routes. Injectable for tests.
 */
type SessionRefresh = (headers: Headers) => Promise<{ role?: string } | null>;

let sessionRefresh: SessionRefresh = async (headers) => {
  const fresh = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  return (fresh?.user as { role?: string } | undefined) ?? null;
};

export function setSessionRefresh(fn: SessionRefresh): void {
  sessionRefresh = fn;
}

export function requireRole(roles: readonly string[], agentScope?: string) {
  return createMiddleware(async (c, next) => {
    const agent = c.get("agent") as { scopes?: string[] } | undefined;
    const passesByScope =
      agent?.scopes?.includes("admin") ||
      // EXACT match: no wildcards (`content:*`) and not another rule's scope.
      (agentScope !== undefined && agent?.scopes?.includes(agentScope));
    if (passesByScope) {
      // `admin` does not erase the agent's `!pattern` denials: if one covers
      // this route, 403 even though the gate is a role gate (security review 2026-11-04).
      const reason = routeDenial(agent?.scopes, c.req.method, c.req.path);
      if (reason) return denialResponse(c, reason);
      await next();
      return;
    }

    let user = c.get("user") as { role?: string } | null | undefined;
    if (!user) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) {
        c.set("user", session.user);
        c.set("session", session.session);
        user = session.user as { role?: string };
      }
    }

    if (!user) return c.json({ error: "Unauthorized", message: "Session required" }, 401);

    // A human-session user (not an agent, which authenticates on every
    // request against the database): their role, from the database and not from the cookie cache.
    if (!agent && c.get("session")) {
      const refreshed = await sessionRefresh(c.req.raw.headers);
      if (!refreshed) return c.json({ error: "Unauthorized", message: "Session required" }, 401);
      user = { ...user, role: refreshed.role };
    }

    if (!roles.includes(user.role ?? "")) {
      return c.json({ error: "Forbidden", message: "Insufficient role" }, 403);
    }
    await next();
  });
}

/** `admin` only. */
export const requireAdminRole = requireRole(["admin"]);
/** Whoever edits site content: `admin` or `editor` (the same as the kons' policies). */
export const requireStaff = requireRole(["admin", "editor"]);

export interface GateRule {
  /** `/api/items` covers `/api/items` and `/api/items/...`, not `/api/itemsx`. */
  prefix: string;
  /** Empty = all methods. */
  methods?: string[];
  /** If present, besides the prefix the path has to match this. */
  pattern?: RegExp;
  /**
   * `admin` by default. `session`: any account with a session (or an agent
   * that can act as a user here, see `agent-as-user.ts`); for kons that
   * authorize themselves with their policies and their RLS.
   */
  role?: "admin" | "staff" | "session";
  /**
   * An agent with THIS scope passes in addition to those of the role (and `admin`). Only
   * the rules that need it carry it: see `CONTENT_SCOPE`.
   */
  agentScope?: string;
  /**
   * `true`: the scope of the WHOLE kon (`<kon>:*`) does not open this rule. For
   * routes of a kon that read outside the kon (`/api/blog/source` returns a
   * row of ANY table): `blog:*` is the whole blog, not the whole database.
   */
  withoutKonScope?: boolean;
}

/**
 * The agent scope that edits site content WITHOUT being admin: the editorial
 * layer of game blocks and the builder's pages. It is what
 * Inti (`INTI_KITSUDEN_TOKEN`) uses to write. It opens NOTHING else: only the
 * `ADMIN_ONLY_ROUTES` rules that carry `agentScope` accept it.
 */
export const SCOPE_CONTENT = "content:edit";

const WRITE = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * What belongs to the PANEL and to nobody else.
 *
 * All of this was mounted with `requireAuth`/`protectRoute` (any account: sign-up
 * is open) or with nothing. Audit of 2026-10-12, checked against a
 * production deployment: `GET /api/items/authSessions` returned session tokens WITHOUT A SESSION,
 * `authAccounts` the password hashes, `PATCH /api/settings` and
 * `/api/modules` (including `DELETE ?purge=true`, which does DROP TABLE) asked
 * for nothing, `/api/functions`/`/api/actions` executed code on the
 * server for any user, and any account could rewrite, delete
 * or publish blog entries, pages, games or streamers. Neither the public
 * site nor the SDK use these routes to write; the panel comes in as admin.
 */
export const ADMIN_ONLY_ROUTES: GateRule[] = [
  // ── Core ──
  { prefix: "/api/items" },
  { prefix: "/api/modules" },
  { prefix: "/api/functions" },
  { prefix: "/api/actions" },
  { prefix: "/api/relations" },
  // What agents chose not to do: the team reads it (an editor, without the
  // agents they sponsor; routes/agent-permissions.ts). No agent: the operation
  // closes it. BEFORE the general one: the first match wins.
  { prefix: "/api/v1/agent-decisions", methods: ["GET"], role: "staff" },
  { prefix: "/api/v1" },
  { prefix: "/api/explorer" },
  // The change history of any table's rows (routes/record-history.ts), as the explorer.
  { prefix: "/api/history" },
  { prefix: "/api/generate-code" },
  { prefix: "/api/schema" },
  { prefix: "/api/map" },
  { prefix: "/api/code-graph" },
  // Agent memory (2026-10-28): SDK operations with owner and RLS. The
  // TEAM (admin, editor) gets in; an agent, only with the scopes of each
  // operation (brain:read / brain:write / kon:brain:<op>). BEFORE the general one:
  // the first match wins. The rest of /api/brain remains admin-only.
  { prefix: "/api/brain/memory", role: "staff" },
  { prefix: "/api/brain" },
  { prefix: "/api/sync" },
  { prefix: "/api/graphql" },
  { prefix: "/api/datasets/batch" },
  { prefix: "/api/settings", methods: WRITE },
  // Inbox and configuration of human approval. The team; the
  // configuration, admin only, and NO agent (not even with `admin`): the
  // routes themselves close it (`humansOnly`, routes/approvals.ts).
  { prefix: "/api/approvals", role: "staff" },
  // Model descriptors (defineModel) for the panel. The
  // routes of EACH model live under its kon and decide by their permission.
  { prefix: "/api/models", role: "staff" },
  // Code promotion. Human admin only; an agent, only with the
  // scopes of each operation (promotion:propose / kon:promotion:<op>). The
  // ACTIVATION, moreover, only from an approved proposal (routes/promotion.ts).
  { prefix: "/api/promotion" },

  // ── Site content (active kons): written by the team ──
  { prefix: "/api/blog", methods: WRITE, role: "staff" },
  {
    prefix: "/api/page-builder",
    methods: WRITE,
    role: "staff",
    agentScope: SCOPE_CONTENT,
  },
  { prefix: "/api/media", methods: WRITE, role: "staff" },
  // The editorial layer of a game's blocks (Inti). BEFORE the
  // general `/api/games` rule: the first match wins, and the general one does not accept
  // the content scope (with it you cannot change the slug or delete a game).
  {
    prefix: "/api/games",
    methods: ["PATCH"],
    pattern: /^\/api\/games\/[^/]+\/blocks\/[^/]+\/editorial\/?$/,
    role: "staff",
    agentScope: SCOPE_CONTENT,
  },
  {
    prefix: "/api/games",
    methods: ["PUT"],
    pattern: /^\/api\/games\/[^/]+\/blocks\/order\/?$/,
    role: "staff",
    agentScope: SCOPE_CONTENT,
  },
  { prefix: "/api/games", methods: WRITE, role: "staff" },
  { prefix: "/api/streamers", methods: WRITE, role: "staff" },
  { prefix: "/api/esports/pro-matches", methods: WRITE, role: "staff" },
  // Game definitions and simulator catalog (not each
  // user's decks and matches): PUT /games, POST /games/:slug/cards and /sync-catalog.
  {
    prefix: "/api/cardsim/games",
    methods: WRITE,
    pattern: /^\/api\/cardsim\/games(\/[^/]+\/(cards|sync-catalog))?\/?$/,
    role: "staff",
  },
  { prefix: "/api/autobattler/sets/import", role: "staff" },
  // The blog stores the whole source row (any table) and returns it here.
  { prefix: "/api/blog/source", role: "staff", withoutKonScope: true },

  // ── Internal kons (CRM, HR, bookings…) ──
  // Their routes treated "having an account" as "being on the team" (and some read
  // personal data without a session). Reviewed in the security round of
  // 2026-10-15 and measured with `scripts/authorization-matrix.ts --without-patches`:
  //   - conta, agile, dms, ocr-training, ocr and payments/portal authorize
  //     themselves (policies + their own RLS) and are no longer here;
  //   - the CRM has no per-organization isolation: it belongs to the whole team;
  //   - DMS files go to the PUBLIC store of /media with a
  //     permanent URL: admin only until the core has a private store.
  //   - bookings and directory (owner's decision, phase
  //     D fixes, 2026-10-25): open to anyone with a SESSION, and their policies
  //     and RLS decide. In booking each user books and sees THEIR bookings, and the team
  //     (admin + editor, decision of 2026-10-26) manages rooms and all
  //     bookings (only admin deletes rooms); in the directory each employee edits
  //     the PERSONAL fields of THEIR record (not position, department, manager…:
  //     kon-directory/directory.routes.ts, its personal-fields list, and the trigger
  //     of migration 0002) and admin manages the rest. An anonymous user gets 401:
  //     before this they reached neither of the two.
  //   In all of these, an agent with the scope of the WHOLE kon (`crm:*`,
  //   `kon:crm:*`) passes the gate of ITS kon: `openedKonByScope`.
  // Except `/api/crm/public/`: a website's forms and the client portal have no account behind them.
  // Those operations declare `access: "public"`, run narrow and are rate limited (kon-crm/crm.public.ts).
  { prefix: "/api/crm", role: "staff", pattern: /^\/api\/crm(?!\/public(\/|$))/ },
  { prefix: "/api/directory", role: "session" },
  { prefix: "/api/booking", role: "session" },
  {
    prefix: "/api/dms",
    pattern: /^\/api\/dms\/(versions\/[^/]+\/files|files\/[^/]+\/download)\/?$/,
  },
];

/** Those mounted before the global session middleware (see `requireRole`). */
export const EARLY_ADMIN_ONLY_ROUTES: GateRule[] = [
  { prefix: "/admin" },
  { prefix: "/api/admin/rate-limits" },
  { prefix: "/api/search/index" },
  { prefix: "/api/search/init" },
  // Except `POST /api/system/setup`: it creates the FIRST admin and only works with
  // zero users (the route checks it). With the gate in front, a
  // new installation could never be set up: 401 with nobody to
  // ask for a session (found by the authorization matrix, 2026-10-15).
  { prefix: "/api/system", methods: WRITE, pattern: /^\/api\/system(?!\/setup\/?$)/ },
];

export function coversPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The rule that applies to this request, if any. */
export function ruleFor(rules: readonly GateRule[], method: string, path: string): GateRule | null {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return null;
  const clean = path.replace(/\/{2,}/g, "/");
  return (
    rules.find(
      (r) =>
        coversPrefix(r.prefix, clean) &&
        (!r.methods || r.methods.includes(m)) &&
        (!r.pattern || r.pattern.test(clean))
    ) ?? null
  );
}

/**
 * Does an AGENT scope open the SDK operation that serves this request?
 * (Owner's decision: prefix gates accept fine-grained
 * permissions.) Only the operation it is: `kon:blog:create-post` opens
 * `POST /api/blog` and nothing else in the blog. Legacy routes (without an SDK
 * operation) keep their usual rule.
 */
export function operationOpenedByFineScope(
  scopes: readonly string[] | undefined,
  method: string,
  path: string
): boolean {
  if (!scopes?.length) return false;
  const ofRoute = routeOperation(method, path);
  if (!ofRoute) return false;
  return grantsByScopes(scopes, ofRoute.konId, ofRoute.op).granted;
}

/**
 * Do the AGENT's scopes open the WHOLE kon that serves this path? (Owner's
 * decision: `<kon>:*` grants the whole kon, including
 * its legacy routes.) Only ITS kon: `crm:*` opens /api/crm and nothing else; a core
 * route (/api/items, /api/v1…) belongs to no kon and is not opened this way.
 * The rule (literal `<kon>:*` / `kon:<kon>:*`, not `kon:*`; a denial
 * wins) is that of `opensWholeKon` in @kitsuden/shared.
 */
export function openedKonByScope(scopes: readonly string[] | undefined, path: string): boolean {
  if (!scopes?.length) return false;
  const kon = pathKon(path.replace(/\/{2,}/g, "/"));
  return kon !== null && opensWholeKon(scopes, konShortName(kon));
}

/**
 * `role: "session"`: an account with a session, or an agent that can act as a
 * user on THIS route (the rule of `agent-as-user.ts`: `user:act`,
 * `admin` or a scope of the kon). The rest is decided by the kon's policies.
 */
export const requireSession = createMiddleware(async (c, next) => {
  if (c.get("agent")) {
    if (!agentCanActAsUser(c)) {
      return c.json({ error: "Forbidden", message: AGENT_WITHOUT_ACCOUNT_MESSAGE }, 403);
    }
    await next();
    return;
  }
  if (!c.get("user")) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Unauthorized", message: "Session required" }, 401);
    c.set("user", session.user);
    c.set("session", session.session);
  }
  await next();
});

/** Applies the corresponding gate (admin, staff or session) and lets the rest through. */
export function adminGate(rules: readonly GateRule[]) {
  return createMiddleware(async (c, next) => {
    const rule = ruleFor(rules, c.req.method, c.req.path);
    if (!rule) return next();
    const agent = c.get("agent") as { scopes?: string[] } | undefined;
    if (agent && operationOpenedByFineScope(agent.scopes, c.req.method, c.req.path)) {
      c.set("agentOpenedByGate" as never, true as never);
      return next();
    }
    if (agent && !rule.withoutKonScope && openedKonByScope(agent.scopes, c.req.path)) {
      c.set("agentOpenedByGate" as never, true as never);
      return next();
    }
    if (rule.role === "session") return requireSession(c, next);
    if (rule.agentScope) {
      const roles = rule.role === "staff" ? ["admin", "editor"] : ["admin"];
      if (agent?.scopes?.includes(rule.agentScope)) {
        c.set("agentOpenedByGate" as never, true as never);
      }
      return requireRole(roles, rule.agentScope)(c, next);
    }
    return (rule.role === "staff" ? requireStaff : requireAdminRole)(c, next);
  });
}

/**
 * The AGENT's DENIALS (`!pattern`) on routes that do not check them
 * themselves. It goes after authentication and BEFORE the gates:
 *
 *   · a denied SDK operation (`!kon:blog:delete-post`,
 *     `!kon:blog:*`, `!blog:*`) → 403, even if it is public or the agent carries
 *     `admin` (the operation checks it too; this cuts before reading the
 *     body and covers the routes the operation does not reach);
 *   · a LEGACY route of a kon whose whole kon is denied (`!kon:crm:*`,
 *     `!crm:*`) → 403. A denial of ONE operation cannot close a
 *     legacy route: it is not known which operation it corresponds to.
 *
 * The rest (datasets, MCP tools) is decided by their own
 * checkpoints with the same rule from shared.
 */
export const agentDenials = createMiddleware(async (c, next) => {
  const agent = c.get("agent") as { scopes?: string[] } | undefined;
  const reason = routeDenial(agent?.scopes, c.req.method, c.req.path);
  if (!reason) return next();
  return denialResponse(c, reason);
});

/**
 * The `!pattern` denial of these scopes that closes this request, or `null`
 * (the rule of `agentDenials`; `requireRole` uses it too).
 */
export function routeDenial(
  scopes: readonly string[] | undefined,
  method: string,
  path: string
): string | null {
  if (!scopes?.some((s) => s.startsWith("!"))) return null;
  const ofRoute = routeOperation(method, path);
  if (ofRoute) return operationDenial(scopes, ofRoute.konId, ofRoute.op);
  const kon = pathKon(path);
  if (!kon) return null;
  const shortOne = konShortName(kon);
  // The operation wildcard "*" is only covered by a denial of the WHOLE kon.
  return denialThatCovers(scopes, [`kon:${shortOne}:*`, `${shortOne}:*`]);
}

function denialResponse(c: Context, reason: string): Response {
  return c.json(
    { error: "Forbidden", message: `Denied for this agent key by '${reason}'`, code: "FORBIDDEN" },
    403
  );
}

/**
 * Is an agent calling? An agent key (`agent` in the context), the synthetic
 * user it leaves (`role: "agent"`) or a legacy `kitsuden_sk_*` key
 * (`machine-…`, already retired). The same rule as `humansOnly`
 * (routes/approvals.ts).
 */
export function callerIsAgent(c: Context): boolean {
  const get = c.get as (k: string) => unknown;
  const user = get("user") as { id?: string; role?: string } | null | undefined;
  return !!get("agent") || user?.role === "agent" || !!user?.id?.startsWith("machine-");
}

/**
 * MANAGING agents (create, edit, delete, their scopes, keys, quotas, signer,
 * notifications, tokens, playground) is for people only.
 *
 * An agent with `admin` passed `requireRole` and could rewrite ITS scopes
 * (`PUT /api/v1/agents/<itself>/scopes {"scopes":["admin"]}`), erasing the
 * `!pattern` denials the operator trimmed it with, create another admin agent,
 * mint itself keys, or run another agent (with THAT agent's scopes) through
 * the playground. Reads stay open to whoever passes the gate (they grant
 * nothing); every write by an agent is a 403, whatever scopes it carries. The
 * global middleware in index.ts does the same by path; this one goes on each
 * router so it holds wherever the router is mounted.
 */
export const noAgentsInAgentManagement = createMiddleware(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (!callerIsAgent(c)) return next();
  return c.json(
    {
      error: "Forbidden",
      message:
        "Agents cannot manage agents (create, edit, scopes, keys, tokens, quotas, signer, notifications or playground): use the admin panel with a human admin session.",
      code: "FORBIDDEN",
    },
    403
  );
});
