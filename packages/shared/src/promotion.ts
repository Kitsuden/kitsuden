/**
 * Promotion of agent-written code — the pure CONTRACT
 * ============================================================================
 *
 * An agent writes code for a `code` action (the QuickJS sandbox) and that
 * code only becomes ACTIVE through this path:
 *
 *   1. DRAFT      versioned: the active version is never edited in place;
 *   2. TESTS      in the sandbox, with the API and `fetch` MOCKED (the
 *                 draft's own plus those the action declares);
 *   3. SCAN       local and deterministic (`code-scan.ts`) + the diff of
 *                 what is DECLARED (scopes, hosts, limits) against the active one;
 *   4. DECISION   `suggestion` → always a proposal for a human (the human approval
 *                 inbox); `turbo` → it activates itself ONLY if everything
 *                 passes and none of `FALLBACK_REASONS` applies; otherwise, a proposal
 *                 with the reason. Turbo can never widen permissions;
 *   5. WATCH      after activating, a window that counts errors and timeouts
 *                 of the new version; above the threshold it returns
 *                 by itself to the previous one, writes it down and audits it.
 *
 * What the API, the panel and the tests share lives here: types, the
 * factory configuration (turbo OFF), the capabilities diff, the
 * classification of what touches secrets/users/security and the DECISION
 * TABLE. Execution is in `apps/api/src/lib/promotion.ts`; the public
 * guide in `docs/agents/promotion.md`.
 */

import { concedeScope, splitScopes } from "./agent-permission";

// ── Modes and configuration ─────────────────────────────────────────────────

/** How ONE agent's code is promoted (set by an admin; by default, `suggestion`). */
export type PromotionMode = "suggestion" | "turbo";

export const PROMOTION_MODES: readonly PromotionMode[] = ["suggestion", "turbo"];

export function isPromotionMode(v: unknown): v is PromotionMode {
  return typeof v === "string" && (PROMOTION_MODES as readonly string[]).includes(v);
}

export interface PromotionConfig {
  /** The global CAP: without this, no agent in `turbo` activates anything by itself. Default: no. */
  turboAllowed: boolean;
  /** Minutes a newly activated version is watched. */
  watchMinutes: number;
  /** Minimum executions before judging the error rate. */
  minExecutions: number;
  /** Error rate (errors + timeouts / executions) that triggers the rollback. */
  maxErrorRate: number;
}

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  turboAllowed: false,
  watchMinutes: 30,
  minExecutions: 3,
  maxErrorRate: 0.5,
};

export const PROMOTION_CONFIG_LIMITS = {
  watchMinutes: { min: 1, max: 24 * 60 },
  minExecutions: { min: 1, max: 1000 },
  maxErrorRate: { min: 0.01, max: 1 },
} as const;

/** Validates and merges a partial change. Throws `Error` with the reason (the API → 422). */
export function mergePromotionConfig(
  base: PromotionConfig,
  change: Partial<Record<keyof PromotionConfig, unknown>>
): PromotionConfig {
  const output: PromotionConfig = { ...base };
  if (change.turboAllowed !== undefined) {
    if (typeof change.turboAllowed !== "boolean")
      throw new Error("turboAllowed must be true or false");
    output.turboAllowed = change.turboAllowed;
  }
  for (const field of ["watchMinutes", "minExecutions"] as const) {
    const v = change[field];
    if (v === undefined) continue;
    const { min, max } = PROMOTION_CONFIG_LIMITS[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(`${field} must be an integer between ${min} and ${max}`);
    }
    output[field] = v;
  }
  if (change.maxErrorRate !== undefined) {
    const v = change.maxErrorRate;
    const { min, max } = PROMOTION_CONFIG_LIMITS.maxErrorRate;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`maxErrorRate must be a number between ${min} and ${max}`);
    }
    output.maxErrorRate = v;
  }
  return output;
}

/** What is stored, read defensively (an old or broken row = the factory default). */
export function readPromotionConfig(saved: unknown): PromotionConfig {
  if (!saved || typeof saved !== "object") return { ...DEFAULT_PROMOTION_CONFIG };
  try {
    return mergePromotionConfig(
      DEFAULT_PROMOTION_CONFIG,
      saved as Partial<Record<keyof PromotionConfig, unknown>>
    );
  } catch {
    return { ...DEFAULT_PROMOTION_CONFIG };
  }
}

// ── Versions ────────────────────────────────────────────────────────────────

/**
 *   awaiting_approval  proposal pending in the inbox
 *   approved           a human (or turbo) approved it but it could not be activated
 *                      (`ENABLE_CODE_ACTIONS` off): an admin activates it later
 *   active             the one that runs (one per action)
 *   superseded         it was the active one and another replaced it
 *   rolled_back        it was rolled back from (by itself or by hand)
 *   rejected | expired the proposal was rejected or lapsed
 *   failed             it could not be activated (the database changed underneath, the agent
 *                      lost the permission…): see `activationError`
 */
export type VersionStatus =
  | "awaiting_approval"
  | "approved"
  | "active"
  | "superseded"
  | "rolled_back"
  | "rejected"
  | "expired"
  | "failed";

export const VERSION_STATUSES: readonly VersionStatus[] = [
  "awaiting_approval",
  "approved",
  "active",
  "superseded",
  "rolled_back",
  "rejected",
  "expired",
  "failed",
];

// ── Declared capabilities ───────────────────────────────────────────────────

/** What the code DECLARES it needs (the only thing turbo compares). */
export interface CodeCapabilities {
  scopes: string[];
  fetchAllow: string[];
  timeoutMs: number;
  memoryLimitMb: number;
  maxCalls: number;
}

/** The same default values as the sandbox (`lib/worker-sandbox.ts`, `code-handler.ts`). */
export const DEFAULT_CODE_LIMITS = { timeoutMs: 5000, memoryLimitMb: 64, maxCalls: 50 } as const;

function textList(v: unknown, lowercase = false): string[] {
  if (!Array.isArray(v)) return [];
  const clean = v
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => (lowercase ? x.trim().toLowerCase() : x.trim()));
  return [...new Set(clean)].sort();
}

function integer(v: unknown, defaultValue: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : defaultValue;
}

/** From an action's (or a draft's) `config` to its capabilities, normalized and sorted. */
export function capabilitiesOf(config: unknown): CodeCapabilities {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return {
    scopes: textList(c.scopes),
    fetchAllow: textList(c.fetchAllow, true),
    timeoutMs: integer(c.timeoutMs, DEFAULT_CODE_LIMITS.timeoutMs),
    memoryLimitMb: integer(c.memoryLimitMb, DEFAULT_CODE_LIMITS.memoryLimitMb),
    maxCalls: integer(c.maxCalls, DEFAULT_CODE_LIMITS.maxCalls),
  };
}

/**
 * Does host pattern `p` cover everything `q` covers? Same semantics as the
 * sandbox allowlist (`a.com` exact, `*.a.com` = any subdomain).
 */
export function hostCovers(p: string, q: string): boolean {
  const a = p.toLowerCase();
  const b = q.toLowerCase();
  if (a === b) return true;
  if (!a.startsWith("*.")) return false;
  const suffix = a.slice(1); // ".a.com"
  const rest = b.startsWith("*.") ? b.slice(1) : `.${b}`;
  return rest.endsWith(suffix) && rest.length > suffix.length;
}

export interface CapabilitiesDiff {
  /** There is no active version: the draft creates the action (or it is the first to go through here). */
  newTarget: boolean;
  /** Scopes in the draft that the active one did NOT grant (counting their wildcards). */
  scopesAdded: string[];
  scopesRemoved: string[];
  /** Denials (`!x`) of the active one that the draft removes: that also widens. */
  denialsRemoved: string[];
  denialsAdded: string[];
  /** Hosts in the draft that the active one's list did not cover. */
  hostsAdded: string[];
  hostsRemoved: string[];
  /** Limits that go up (time, memory, host calls). */
  limitsIncreased: {
    field: "timeoutMs" | "memoryLimitMb" | "maxCalls";
    before: number;
    after: number;
  }[];
}

/** The diff of what is DECLARED. With no active version, everything in the draft is new. */
export function capabilitiesDiff(
  active: CodeCapabilities | null,
  draft: CodeCapabilities
): CapabilitiesDiff {
  const before = active ?? { scopes: [], fetchAllow: [], ...DEFAULT_CODE_LIMITS };
  const a = splitScopes(before.scopes);
  const b = splitScopes(draft.scopes);
  const scopesAdded = b.grants.filter((s) => !concedeScope(a.grants, s));
  const scopesRemoved = a.grants.filter((s) => !concedeScope(b.grants, s));
  const denialsRemoved = a.denials.filter((d) => !b.denials.includes(d)).map((d) => `!${d}`);
  const denialsAdded = b.denials.filter((d) => !a.denials.includes(d)).map((d) => `!${d}`);
  const hostsAdded = draft.fetchAllow.filter(
    (h) => !before.fetchAllow.some((p) => hostCovers(p, h))
  );
  const hostsRemoved = before.fetchAllow.filter(
    (h) => !draft.fetchAllow.some((p) => hostCovers(p, h))
  );
  const limitsIncreased: CapabilitiesDiff["limitsIncreased"] = [];
  for (const field of ["timeoutMs", "memoryLimitMb", "maxCalls"] as const) {
    if (draft[field] > before[field])
      limitsIncreased.push({ field, before: before[field], after: draft[field] });
  }
  return {
    newTarget: active === null,
    scopesAdded,
    scopesRemoved,
    denialsRemoved,
    denialsAdded,
    hostsAdded,
    hostsRemoved,
    limitsIncreased,
  };
}

// ── What touches secrets, users and roles, or security ─────────────────────

export type SensitiveTouch = "secrets" | "users_roles" | "security_config";

/** API prefixes (path) and what they touch. The first one that matches wins. */
const SENSITIVE_PATHS: { prefix: string; touch: SensitiveTouch }[] = [
  { prefix: "/api/admin/secrets", touch: "secrets" },
  { prefix: "/api/admin/vault", touch: "secrets" },
  { prefix: "/api/secrets", touch: "secrets" },
  { prefix: "/api/vault", touch: "secrets" },
  { prefix: "/api/keys", touch: "secrets" },
  { prefix: "/api/auth", touch: "users_roles" },
  { prefix: "/api/users", touch: "users_roles" },
  { prefix: "/api/admin/users", touch: "users_roles" },
  { prefix: "/api/admin/agents", touch: "users_roles" },
  { prefix: "/api/v1", touch: "users_roles" },
  { prefix: "/api/items/authUsers", touch: "users_roles" },
  { prefix: "/api/items/authSessions", touch: "users_roles" },
  { prefix: "/api/items/authAccounts", touch: "users_roles" },
  { prefix: "/api/approvals", touch: "security_config" },
  { prefix: "/api/proposals", touch: "security_config" },
  { prefix: "/api/promotion", touch: "security_config" },
  { prefix: "/api/settings", touch: "security_config" },
  { prefix: "/api/modules", touch: "security_config" },
  { prefix: "/api/system", touch: "security_config" },
  { prefix: "/api/sistema", touch: "security_config" }, // former (Spanish) path of /api/admin/system
  { prefix: "/api/admin", touch: "security_config" },
  { prefix: "/api/actions", touch: "security_config" },
  { prefix: "/api/functions", touch: "security_config" },
  { prefix: "/api/mcp", touch: "security_config" },
];

/** What does a call to this API path touch? `null` = none of that. */
export function pathTouch(path: string): SensitiveTouch | null {
  const clean = path.split("?")[0]!.replace(/\/{2,}/g, "/");
  for (const { prefix, touch: touch } of SENSITIVE_PATHS) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) return touch;
  }
  return null;
}

/** First segment of a scope (without `!`) and what it touches. */
const SENSITIVE_SCOPES: Record<string, SensitiveTouch> = {
  admin: "security_config",
  secrets: "secrets",
  secret: "secrets",
  vault: "secrets",
  keys: "secrets",
  auth: "users_roles",
  users: "users_roles",
  user: "users_roles",
  roles: "users_roles",
  agents: "users_roles",
  approvals: "security_config",
  promotion: "security_config",
  settings: "security_config",
  modules: "security_config",
  system: "security_config",
  security: "security_config",
};

/** What does a scope touch? `mcp:admin` and `admin:*` count as security configuration. */
export function scopeTouch(scope: string): SensitiveTouch | null {
  const s = scope.startsWith("!") ? scope.slice(1) : scope;
  if (s === "mcp:admin" || s === "kon:*" || s === "admin:*") return "security_config";
  const first = s.split(":")[0] ?? "";
  if (first === "kon") {
    const kon = s.split(":")[1] ?? "";
    return SENSITIVE_SCOPES[kon] ?? (kon === "vault" ? "secrets" : null);
  }
  return SENSITIVE_SCOPES[first] ?? null;
}

/** An environment variable name that looks like a secret (`STRIPE_KEY`, `apiToken`…). */
export function secretName(name: string): boolean {
  return /(secret|token|passw|pwd|api[_-]?key|private|credential|auth|_key$|^key$)/i.test(name);
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Why a draft was NOT activated by itself (or, in `suggestion`, what the human
 * should look at). They are contract: the agent and the panel read them.
 */
export type FallbackReason =
  | "suggestion_mode"
  | "turbo_disabled_globally"
  | "agent_held_for_approval"
  | "new_target"
  | "no_tests"
  | "tests_failed"
  | "tests_errored"
  | "scan_failed"
  | "scope_escalation"
  | "new_outbound_hosts"
  | "limits_increased"
  | "touches_secrets"
  | "target_has_env_vars"
  | "touches_users_or_roles"
  | "touches_security_config"
  | "sensitive_operation"
  | "unclassifiable_api_call";

export const FALLBACK_REASONS: readonly FallbackReason[] = [
  "suggestion_mode",
  "turbo_disabled_globally",
  "agent_held_for_approval",
  "new_target",
  "no_tests",
  "tests_failed",
  "tests_errored",
  "scan_failed",
  "scope_escalation",
  "new_outbound_hosts",
  "limits_increased",
  "touches_secrets",
  "target_has_env_vars",
  "touches_users_or_roles",
  "touches_security_config",
  "sensitive_operation",
  "unclassifiable_api_call",
];

export interface TestsSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
}

export interface DecisionInput {
  mode: PromotionMode;
  config: Pick<PromotionConfig, "turboAllowed">;
  /**
   * Human approval is on and the agent is in `propose`:
   * an admin wants to see EVERYTHING it writes, so turbo does not skip that.
   */
  heldAgent?: boolean;
  diff: CapabilitiesDiff;
  tests: TestsSummary;
  approvedScan: boolean;
  /** What the code or its scopes touch (without repeats). */
  touches: SensitiveTouch[];
  /** There is a call to a sensitive operation (the approval classification). */
  sensitiveOperation: boolean;
  /** There is an API call that cannot be classified (dynamic path, alias). */
  unclassifiedCall: boolean;
  /**
   * The target action has environment variables, and a new version receives
   * their real values on its next run. The scan is advice, not a proof that the
   * code leaves them alone, so these targets always wait for a human.
   */
  targetWithVariables?: boolean;
}

export interface PromotionDecision {
  /** `turbo` = activates now; `proposal` = waits for a human. */
  route: "turbo" | "proposal";
  /** ALL the reasons that apply, also in `suggestion` (what the human should look at). */
  reasons: FallbackReason[];
}

/**
 * THE TABLE. Turbo only if the agent is in `turbo`, the global cap
 * allows it and NO reason applies. Otherwise, a proposal with its reasons.
 */
export function decidePromotion(e: DecisionInput): PromotionDecision {
  const m: FallbackReason[] = [];
  if (e.mode !== "turbo") m.push("suggestion_mode");
  if (e.mode === "turbo" && !e.config.turboAllowed) m.push("turbo_disabled_globally");
  if (e.heldAgent) m.push("agent_held_for_approval");
  if (e.diff.newTarget) m.push("new_target");
  if (e.tests.total === 0) m.push("no_tests");
  if (e.tests.failed > 0) m.push("tests_failed");
  if (e.tests.errored > 0) m.push("tests_errored");
  if (!e.approvedScan) m.push("scan_failed");
  if (e.diff.scopesAdded.length > 0 || e.diff.denialsRemoved.length > 0) m.push("scope_escalation");
  if (e.diff.hostsAdded.length > 0) m.push("new_outbound_hosts");
  if (e.diff.limitsIncreased.length > 0) m.push("limits_increased");
  if (e.touches.includes("secrets")) m.push("touches_secrets");
  if (e.targetWithVariables) m.push("target_has_env_vars");
  if (e.touches.includes("users_roles")) m.push("touches_users_or_roles");
  if (e.touches.includes("security_config")) m.push("touches_security_config");
  if (e.sensitiveOperation) m.push("sensitive_operation");
  if (e.unclassifiedCall) m.push("unclassifiable_api_call");
  return { route: m.length === 0 ? "turbo" : "proposal", reasons: m };
}

// ── Test cases ──────────────────────────────────────────────────────────────

/** A mocked response for `kitsuden.api.*` or `fetch` inside a test. */
export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TestCase {
  name: string;
  /**
   * What the code receives as `event` (in production, `{ action, trigger,
   * event, request, timestamp }`).
   */
  event?: Record<string, unknown>;
  /** What the code receives as `env` (never the action's real values). */
  env?: Record<string, string>;
  /** `METHOD /api/path` → response. Anything not here responds 404 (and is noted). */
  api?: Record<string, MockResponse>;
  /** `METHOD https://host/path` (or just the URL, = GET) → response. */
  fetch?: Record<string, MockResponse>;
  expect: {
    /** Default: `true`. */
    success?: boolean;
    /** Deep equality with the returned value. */
    result?: unknown;
    /** The result's JSON contains this text. */
    resultContains?: string;
    errorContains?: string;
    logsContain?: string;
  };
  timeoutMs?: number;
}

export const MAX_TESTS_PER_DRAFT = 20;
export const MAX_CODE_BYTES = 256 * 1024;
