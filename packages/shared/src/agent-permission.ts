/**
 * Agent permissions — ONE reading of the scopes
 * ============================================================================
 *
 * An agent carries a list of scopes. There used to be three copies of
 * the rule that reads them (the API, the engine and the kon SDK) and a fourth
 * in the MCP tools. Now they all call here.
 *
 * ── WHAT CAN BE IN THE LIST ────────────────────────────────────────────────
 *
 *   broad     `admin`, `mcp:write`, `content:edit`, `crm:*`…  (the old ones)
 *   fine      `kon:blog:create-post`        one operation of the kon SDK
 *             `datasets:clients:read`        one dataset, one action
 *   wildcards `x:*`      everything that starts with `x:` (one or more segments)
 *             `*:y`      everything that ends in `:y`
 *             `a:*:c`    any one segment in the middle (`datasets:*:read`)
 *   deny      `!kon:crm:delete-contact`, `!datasets:clients:*`
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 *   1. What is granted is the UNION: it is enough for one scope to cover what
 *      is requested. A fine scope never takes anything away from a broad one.
 *   2. A denial (`!pattern`) BEATS any grant, `admin` included. It is the only
 *      way to take away: "the whole CRM except delete".
 *   3. `admin` / `admin:*` cover everything (except what is denied).
 *
 * Wildcards only EXPAND within what they already covered before: `*:*`, `*` and
 * any pattern made only of wildcards cover nothing (they did not before either).
 *
 * Public guide: docs/agents/permissions.md.
 */

/** Prefix of a denial. */
export const DENIAL_PREFIX = "!";

export function isDenial(scope: string): boolean {
  return scope.startsWith(DENIAL_PREFIX);
}

/** Separates grants and denials (the latter without the `!`). */
export function splitScopes(scopes: readonly string[] | undefined): {
  grants: string[];
  denials: string[];
} {
  const grants: string[] = [];
  const denials: string[] = [];
  for (const s of scopes ?? []) {
    if (typeof s !== "string" || !s) continue;
    if (isDenial(s)) denials.push(s.slice(DENIAL_PREFIX.length));
    else grants.push(s);
  }
  return { grants, denials };
}

/**
 * Does the PATTERN cover the required scope? Without the `admin` shortcut (that
 * is `scopeCovers`' job). It is what denials use.
 *
 *   exact                     `blog:read` covers `blog:read`
 *   first segment `*`         suffix: `*:read` covers `x:read` and `x:y:read`
 *   last segment `*`          prefix: `crm:*` covers `crm:a` and `crm:a:b`
 *   `*` in the middle         one segment: `datasets:*:read` covers
 *                             `datasets:clients:read`
 */
export function patternCovers(pattern: string, required: string): boolean {
  if (!pattern || !required) return false;
  if (pattern === required) return true;
  const parts = pattern.split(":");
  if (parts.length < 2 || parts.every((p) => p === "*")) return false;
  // Wildcard at the start: the usual rule (literal suffix).
  if (parts[0] === "*") return required.endsWith(pattern.slice(1));
  const req = required.split(":");
  const lastIsWildcard = parts[parts.length - 1] === "*";
  const fixedItems = lastIsWildcard ? parts.slice(0, -1) : parts;
  if (lastIsWildcard ? req.length <= fixedItems.length : req.length !== fixedItems.length)
    return false;
  for (let i = 0; i < fixedItems.length; i++) {
    if (fixedItems[i] === "*") {
      if (!req[i]) return false;
      continue;
    }
    if (fixedItems[i] !== req[i]) return false;
  }
  return true;
}

/** Does `granted` grant the scope `required`? `admin` covers everything. Without denials. */
export function scopeCovers(granted: string, required: string): boolean {
  if (isDenial(granted)) return false;
  if (granted === "admin" || granted === "admin:*") return true;
  return patternCovers(granted, required);
}

/** The denial in the list that covers any of `required`, or `null`. */
export function denialThatCovers(
  scopes: readonly string[] | undefined,
  requiredValues: readonly (string | null | undefined)[]
): string | null {
  const { denials } = splitScopes(scopes);
  if (denials.length === 0) return null;
  for (const d of denials) {
    for (const r of requiredValues) {
      if (r && patternCovers(d, r)) return `${DENIAL_PREFIX}${d}`;
    }
  }
  return null;
}

/** The granted scope that covers `required` (ignoring denials), or `null`. */
export function grantThatCovers(
  scopes: readonly string[] | undefined,
  required: string
): string | null {
  for (const s of scopes ?? []) {
    if (typeof s === "string" && scopeCovers(s, required)) return s;
  }
  return null;
}

/**
 * THE question: can these scopes do `required`? Union of grants, and a denial
 * that covers it always wins.
 */
export function concedeScope(scopes: readonly string[] | undefined, required: string): boolean {
  if (!scopes || scopes.length === 0) return false;
  if (denialThatCovers(scopes, [required])) return false;
  return grantThatCovers(scopes, required) !== null;
}

// ── Validating what is stored ───────────────────────────────────────────────

const SEGMENT = /^(?:\*|[a-z0-9_][a-z0-9_.-]*)$/;

/** Maximum scopes per agent: nobody reviews an agent with 500 permissions. */
export const MAX_SCOPES_PER_AGENT = 200;

/**
 * `null` if the scope can be stored; otherwise, the reason (in English: it is
 * read by whoever calls the API). Lowercase, digits, `_`, `-`, `.`, `*`;
 * segments separated by `:`; at most 5 segments and 200 characters.
 */
export function invalidScopeReason(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "must be a non-empty string";
  if (scope.length > 200) return "is longer than 200 characters";
  const deny = isDenial(scope);
  const body = deny ? scope.slice(1) : scope;
  const parts = body.split(":");
  if (parts.length > 5) return "has more than 5 segments";
  if (parts.some((p) => !SEGMENT.test(p))) {
    return "segments may only contain a-z, 0-9, '_', '-', '.' or be '*'";
  }
  if (parts.every((p) => p === "*")) return "a pattern made only of '*' grants nothing";
  if (deny && (body === "admin" || body === "admin:*")) {
    return "'!admin' is not allowed: remove 'admin' instead";
  }
  if (deny && parts.length < 2) return "a deny needs at least two segments (e.g. '!kon:crm:*')";
  return null;
}

/** Normalizes and validates a list: no duplicates, in order. Throws with the first reason. */
export function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) throw new Error("scopes must be an array of strings");
  const output: string[] = [];
  for (const raw of scopes) {
    const s = typeof raw === "string" ? raw.trim() : raw;
    const reason = invalidScopeReason(s);
    if (reason) throw new Error(`Invalid scope '${String(s)}': ${reason}`);
    const clean = s as string;
    if (!output.includes(clean)) output.push(clean);
  }
  if (output.length > MAX_SCOPES_PER_AGENT) {
    throw new Error(`An agent can have at most ${MAX_SCOPES_PER_AGENT} scopes`);
  }
  return output;
}

// ── Datasets ────────────────────────────────────────────────────────────────

export type DatasetAction = "read" | "write" | "delete";
export const DATASET_ACTIONS: readonly DatasetAction[] = ["read", "write", "delete"];

/** `datasets:<slug>:<action>`. */
export function datasetScope(slug: string, action: DatasetAction): string {
  return `datasets:${slug}:${action}`;
}

/**
 * What the SCOPES say about a specific dataset:
 *
 *   "denied"   a denial covers it: not even the dataset's policy opens it
 *                for this key;
 *   "granted"  a scope covers it (`datasets:<slug>:read`, `datasets:*:read`,
 *                `datasets:*`, `admin`…);
 *   null         the scopes say nothing: the policy (`policyJson`) decides.
 *
 * What is seen INSIDE the dataset is still filtered by `policyJson.rlsRules` and
 * Postgres RLS: the scope opens the dataset's door, not the rows.
 */
export function accessToDataset(
  scopes: readonly string[] | undefined,
  slug: string | null | undefined,
  action: DatasetAction
): "denied" | "granted" | null {
  if (!scopes || scopes.length === 0 || !slug) return null;
  const required = datasetScope(slug, action);
  if (denialThatCovers(scopes, [required])) return "denied";
  return grantThatCovers(scopes, required) ? "granted" : null;
}

/**
 * Can an agent whose scopes say nothing about THIS dataset write in it because
 * of the dataset's policy? A session passes `writeAccess: "authenticated"`, but
 * an agent key is not a session: a `datasets:*:read` key must not write. Same
 * rule as `kitsuden_agent_opens_by_policy(id, 'write')` (rls-policies.sql)
 * and as the MCP tools: `mcp:write`, a policy that lets a session read (or
 * `dataset:view`), and one that lets a session write (or `dataset-entry:create`).
 * Call it after `accessToDataset`, which settles grants and denies.
 */
export function agentWritesByPolicy(
  scopes: readonly string[] | undefined,
  policy: { readAccess?: unknown; writeAccess?: unknown } | null | undefined
): boolean {
  if (!concedeScope(scopes, "mcp:write")) return false;
  const canRead =
    policy?.readAccess === "public" ||
    policy?.readAccess === "authenticated" ||
    concedeScope(scopes, "dataset:view");
  return (
    canRead &&
    (policy?.writeAccess === "authenticated" || concedeScope(scopes, "dataset-entry:create"))
  );
}

// ── Panel presets ───────────────────────────────────────────────────────────

/**
 * The "broad" groups the panel offers. The text (name and what it grants)
 * lives in the panel's dictionaries; here only the list of scopes, which is what
 * gets stored. Choosing a preset REPLACES the agent's list.
 */
export const AGENT_PRESETS = [
  { id: "connect-only", scopes: ["mcp:connect"] },
  { id: "read-only", scopes: ["mcp:connect", "mcp:read", "datasets:*:read"] },
  {
    id: "content-editor",
    scopes: [
      "mcp:connect",
      "mcp:read",
      "content:edit",
      "kon:blog:*",
      "kon:blocks:*",
      "kon:media:*",
    ],
  },
  {
    id: "data-editor",
    scopes: ["mcp:connect", "mcp:read", "mcp:write", "datasets:*:read", "datasets:*:write"],
  },
  { id: "full-admin", scopes: ["admin"] },
] as const;

export type AgentPreset = (typeof AGENT_PRESETS)[number]["id"];

/**
 * The known broad scopes of the core (each kon's own, `<kon>:*`, are
 * added by the API with the mounted kons). The panel explains each one.
 */
export const BROAD_CORE_SCOPES = [
  "admin",
  "mcp:connect",
  "mcp:read",
  "mcp:write",
  "mcp:admin",
  "content:edit",
  "memory:read",
  "memory:write",
  "brain:read",
  "brain:write",
  "promotion:propose",
  "mail:send",
  "user:act",
  "kon:*",
  "datasets:*:read",
  "datasets:*:write",
  "datasets:*:delete",
] as const;

/**
 * ── AN AGENT KEY IS NOT AN ACCOUNT (an earlier audit) ──────────────────────
 *
 * Routes that only ask for "being authenticated" (commenting, signing up for a
 * tournament, saving a build…) accepted ANY agent, even if its key
 * only carried `datasets:x:read`. Now a key counts as a signed-in user
 * only with this scope (or `admin`). SDK operations with
 * `permission` still decide by their permission.
 */
export const SCOPE_ACT_AS_USER = "user:act";

export function agentActsAsUser(scopes: readonly string[] | undefined): boolean {
  return concedeScope(scopes, SCOPE_ACT_AS_USER);
}

/**
 * ── THE WHOLE KON: `<kon>:*` ───────────────────────────────
 *
 * The guide promises that `<kon>:*` gives "that whole kon" (docs/agents/permissions.md),
 * but only the SDK operations honored it: a kon's LEGACY routes
 * went through the prefix gates (`ADMIN_ONLY_ROUTES`), which only knew
 * `admin`, and through each kon's policies and RLS, which asked about the HUMAN
 * role. A `crm:*` agent got 403 "Insufficient role" when creating a
 * company; an `admin` one saw empty lists in dms, members and booking.
 *
 * Do these scopes open the ENTIRE kon `shortKon` (without `kon-`)? Yes with:
 *
 *   · `admin` / `admin:*`;
 *   · `<kon>:*` or `kon:<kon>:*`, LITERAL. `kon:*` does NOT: it means "every SDK
 *     operation of any kon" and is not widened to every kon's legacy routes.
 *
 * A denial that covers `<kon>:*` or `kon:<kon>:*` (`!crm:*`, `!kon:*`…)
 * wins, `admin` included. The same in SQL: `kitsuden_agent_opens_kon()`
 * (apps/api/src/db/agent-functions.sql); a test compares the two.
 */
export function opensWholeKon(scopes: readonly string[] | undefined, shortKon: string): boolean {
  if (!scopes || scopes.length === 0 || !shortKon) return false;
  const wide = [`${shortKon}:*`, `kon:${shortKon}:*`];
  if (denialThatCovers(scopes, wide)) return false;
  return scopes.some(
    (s) => typeof s === "string" && (s === "admin" || s === "admin:*" || wide.includes(s))
  );
}
