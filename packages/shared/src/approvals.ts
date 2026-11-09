/**
 * Human approval of what agents request — the pure CONTRACT
 * ============================================================================
 *
 * A request from an AGENT that "needs approval" is not executed: it is stored
 * as a PROPOSAL and the API responds `202` with `KITSUDEN_E_APPROVAL_REQUIRED`,
 * the id and the URL where its status can be checked. A human on the team
 * approves it (and then it runs with the agent's identity, recording the
 * human) or rejects it (and it never runs). Humans never go through here.
 *
 * What the API, the panel and the tests share lives here: the types, the
 * default configuration (OFF: nothing changes until an admin turns it
 * on), the legacy route patterns and the DECISION TABLE. Execution is in
 * `apps/api/src/lib/approvals.ts`; the public guide in
 * `docs/agents/approvals.md`.
 *
 * ── THE DECISION (operation → agent → global) ─────────────────────────────
 *
 *   1. The OPERATION: is it sensitive? Whatever the admin said for that
 *      operation; if they said nothing, whatever the kon declares (`sensitive`,
 *      by default only DELETE); on a legacy route (no SDK), its method + pattern
 *      rules; on a core MCP tool, by default the delete ones.
 *   2. The GLOBAL is the MASTER SWITCH (owner decision):
 *      off, NO agent asks for approval, not even those
 *      in `propose`. The panel warns about it when turning it off.
 *   3. The AGENT (with the global on): `direct` → it is never asked for
 *      approval; `inherit` → its sensitive operations become a
 *      proposal; `propose` → also its writes, depending on the RETENTION:
 *        · `selective` (default): every write except the POSTs that the
 *          SDK operation declares `readOnly` (validate, compare…);
 *        · `strict`: every write (POST/PUT/PATCH/DELETE), no exceptions.
 *      Legacy routes (no SDK) declare nothing: they are held in both.
 *
 * With the global off (the default) the API behaves exactly as
 * before human approval.
 *
 * ── UNATTENDED RUNS (deny with an alternative) ────────────────────────────
 *
 * A proposal waits for a human. When nobody is waiting for the answer either
 * (a cron or event action, an agent run started by such a trigger, or an
 * agent that says so with `Kitsuden-Unattended: true`), the agent cannot act
 * on a 202 and the inbox fills with requests nobody asked for. In that case a
 * request that WOULD be held can be refused instead (`403
 * KITSUDEN_E_DENIED_UNATTENDED`) with an `alternative`: what to do instead.
 *
 *   · `unattended` (global, default `hold`): `hold` keeps the 202; `deny`
 *     refuses. Each agent can override it (`hold` | `deny`; NULL = global).
 *   · The alternative text: the operation's or the legacy rule's, else the
 *     agent's, else the global one, else `DEFAULT_UNATTENDED_ALTERNATIVE`.
 *
 * It never lets through what would be held: it only changes how it is refused.
 */

/** How human approval treats an agent. */
export type ApprovalMode = "inherit" | "propose" | "direct";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["inherit", "propose", "direct"];

export function isApprovalMode(v: unknown): v is ApprovalMode {
  return typeof v === "string" && (APPROVAL_MODES as readonly string[]).includes(v);
}

/** What `propose` mode holds back (see the header). */
export type ProposalRetention = "selective" | "strict";

export const PROPOSAL_RETENTIONS: readonly ProposalRetention[] = ["selective", "strict"];

export function isProposalRetention(v: unknown): v is ProposalRetention {
  return typeof v === "string" && (PROPOSAL_RETENTIONS as readonly string[]).includes(v);
}

/**
 * A rule for LEGACY ROUTES (those that are not SDK operations): method
 * (`*` = any) and path pattern. In the pattern, `*` is ONE segment and
 * `**` any remainder (`/api/**`, `/api/games/*\/blocks/**`).
 */
export interface LegacyApprovalRule {
  method: string;
  path: string;
  /** What an unattended run is told to do instead (see the header). */
  alternative?: string;
}

/** What happens, in an unattended run, to a request that would be held. */
export type UnattendedMode = "hold" | "deny";

export const UNATTENDED_MODES: readonly UnattendedMode[] = ["hold", "deny"];

export function isUnattendedMode(v: unknown): v is UnattendedMode {
  return typeof v === "string" && (UNATTENDED_MODES as readonly string[]).includes(v);
}

/** The longest alternative text (characters). */
export const ALTERNATIVE_MAX = 1000;

/** What an unattended run is told when nobody wrote anything more specific. */
export const DEFAULT_UNATTENDED_ALTERNATIVE =
  "Nobody is attending this run, so this request cannot wait for approval. Do not retry it now: " +
  "record what you wanted to do and why with the MCP tool kitsuden_record_decision (REST: POST " +
  "/api/agent/decisions) so a person can do it or approve it in an attended run.";

export interface ApprovalsConfig {
  /** The MASTER switch. Default: off (nobody asks for approval). */
  enabled: boolean;
  /** What `propose` mode holds back. Default: `selective`. */
  proposeRetention: ProposalRetention;
  /** How long a proposal lives undecided (hours). Default: 168 (7 days). */
  ttlHours: number;
  /**
   * What the admin changed per operation: key → sensitive or not. Keys
   * are the fine scope of the SDK operation (`kon:blog:delete-post`) or,
   * for MCP tools that are not SDK ones, `mcp:<name>`. No key =
   * whatever the operation declares.
   */
  operations: Record<string, boolean>;
  /** Legacy routes that count as sensitive. */
  legacyRules: LegacyApprovalRule[];
  /** In an unattended run: hold (202, the default) or deny with an alternative (403). */
  unattended: UnattendedMode;
  /** The global alternative text; `null` = `DEFAULT_UNATTENDED_ALTERNATIVE`. */
  unattendedAlternative: string | null;
  /** Alternative per operation key (the same keys as `operations`). */
  alternatives: Record<string, string>;
}

export const TTL_MIN_HOURS = 1;
export const TTL_MAX_HOURS = 24 * 30;

export const DEFAULT_APPROVALS_CONFIG: ApprovalsConfig = {
  enabled: false,
  proposeRetention: "selective",
  ttlHours: 168,
  operations: {},
  // Same as the SDK (only DELETE is sensitive by default), in legacy routes too.
  legacyRules: [{ method: "DELETE", path: "/api/**" }],
  unattended: "hold",
  unattendedAlternative: null,
  alternatives: {},
};

export type ProposalStatus =
  "pending" | "executing" | "executed" | "failed" | "rejected" | "expired";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "pending",
  "executing",
  "executed",
  "failed",
  "rejected",
  "expired",
];

/** Why a request ended up as a proposal. */
export type ProposalReason = "sensitive" | "propose_only";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * THE TABLE. `null` = runs now; otherwise, the reason for the proposal. With the
 * global OFF, always `null` (master switch). When on:
 *
 *   mode      sensitive   normal write                  POST readOnly   read
 *   direct    —           —                             —                  —
 *   propose   proposal    proposal                      strict ? proposal —
 *   inherit   proposal    —                             —                  —
 */
export function decideApproval(p: {
  mode: ApprovalMode;
  globalActive: boolean;
  sensitive: boolean;
  write: boolean;
  /** A POST of the SDK declared `readOnly`. */
  readOnly?: boolean;
  /** Default: `selective`. */
  retention?: ProposalRetention;
}): ProposalReason | null {
  if (!p.globalActive || p.mode === "direct") return null;
  if (p.sensitive) return "sensitive";
  if (p.mode !== "propose" || !p.write) return null;
  if (p.readOnly && (p.retention ?? "selective") === "selective") return null;
  return "propose_only";
}

/**
 * A request that `decideApproval` holds: in an unattended run, is it held or
 * denied? The agent's setting wins over the global one; attended, always held.
 */
export function decideUnattended(p: {
  unattended: boolean;
  global: UnattendedMode;
  agent?: UnattendedMode | null;
}): UnattendedMode {
  if (!p.unattended) return "hold";
  return p.agent ?? p.global;
}

/** The first alternative written, from the most specific to the default. */
export function pickAlternative(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return DEFAULT_UNATTENDED_ALTERNATIVE;
}

/** The reason an alternative text is not valid, or `null` (`null`/absent is valid). */
export function invalidAlternativeReason(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return "an alternative is a text";
  if (v.trim().length === 0) return "an alternative cannot be empty (use null for the default)";
  if (v.length > ALTERNATIVE_MAX) return `an alternative is at most ${ALTERNATIVE_MAX} characters`;
  return null;
}

const OPERATION_KEY = /^(kon:[a-z0-9-]+:[a-z0-9-]+|mcp:[A-Za-z0-9_.-]+)$/;

// ── Legacy route patterns ───────────────────────────────────────────────────

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern as a regular expression (`*` = one segment, `**` = the rest). */
export function patternRegex(pattern: string): RegExp {
  const parts = pattern.split("**").map((chunk) => chunk.split("*").map(escape).join("[^/]*"));
  return new RegExp(`^${parts.join(".*")}/?$`);
}

/** Does `METHOD path` match the rule? */
export function legacyHouseRule(rule: LegacyApprovalRule, method: string, path: string): boolean {
  const m = rule.method.trim().toUpperCase();
  if (m !== "*" && m !== method.toUpperCase()) return false;
  return patternRegex(rule.path.trim()).test(path.replace(/\/{2,}/g, "/"));
}

/** The reason a rule is not valid, or `null`. */
export function invalidRuleReason(rule: unknown): string | null {
  if (!rule || typeof rule !== "object") return "a rule is an object { method, path }";
  const { method, path, alternative } = rule as Record<string, unknown>;
  const alt = invalidAlternativeReason(alternative);
  if (alt) return alt;
  if (typeof method !== "string" || !/^(\*|GET|POST|PUT|PATCH|DELETE)$/i.test(method.trim())) {
    return "method must be *, GET, POST, PUT, PATCH or DELETE";
  }
  if (typeof path !== "string" || !path.trim().startsWith("/api/")) {
    return "path must start with /api/";
  }
  if (path.length > 300 || /\s/.test(path.trim()))
    return "path must be at most 300 characters, without spaces";
  return null;
}

/**
 * Validates and normalizes a partial configuration on top of another. Throws an
 * `Error` with the reason (the API returns it as 422).
 */
export function mergeApprovalsConfig(
  base: ApprovalsConfig,
  change: Partial<Record<keyof ApprovalsConfig, unknown>>
): ApprovalsConfig {
  const output: ApprovalsConfig = {
    enabled: base.enabled,
    proposeRetention: base.proposeRetention,
    ttlHours: base.ttlHours,
    operations: { ...base.operations },
    legacyRules: base.legacyRules.map((r) => ({ ...r })),
    unattended: base.unattended ?? "hold",
    unattendedAlternative: base.unattendedAlternative ?? null,
    alternatives: { ...(base.alternatives ?? {}) },
  };
  if (change.enabled !== undefined) {
    if (typeof change.enabled !== "boolean") throw new Error("enabled must be true or false");
    output.enabled = change.enabled;
  }
  if (change.proposeRetention !== undefined) {
    if (!isProposalRetention(change.proposeRetention)) {
      throw new Error("proposeRetention must be selective or strict");
    }
    output.proposeRetention = change.proposeRetention;
  }
  if (change.ttlHours !== undefined) {
    const n = change.ttlHours;
    if (typeof n !== "number" || !Number.isInteger(n) || n < TTL_MIN_HOURS || n > TTL_MAX_HOURS) {
      throw new Error(`ttlHours must be an integer between ${TTL_MIN_HOURS} and ${TTL_MAX_HOURS}`);
    }
    output.ttlHours = n;
  }
  if (change.operations !== undefined) {
    const ops = change.operations;
    if (!ops || typeof ops !== "object" || Array.isArray(ops)) {
      throw new Error("operations must be an object { key: true | false | null }");
    }
    for (const [key, value] of Object.entries(ops as Record<string, unknown>)) {
      if (!OPERATION_KEY.test(key)) {
        throw new Error(`'${key}' is not an operation key (kon:<kon>:<operation> or mcp:<tool>)`);
      }
      if (value === null) delete output.operations[key];
      else if (typeof value === "boolean") output.operations[key] = value;
      else throw new Error(`operations['${key}'] must be true, false or null (default)`);
    }
  }
  if (change.legacyRules !== undefined) {
    if (!Array.isArray(change.legacyRules)) throw new Error("legacyRules must be a list");
    if (change.legacyRules.length > 100) throw new Error("at most 100 legacy rules");
    output.legacyRules = change.legacyRules.map((r, i) => {
      const reason = invalidRuleReason(r);
      if (reason) throw new Error(`legacyRules[${i}]: ${reason}`);
      const { method, path, alternative } = r as LegacyApprovalRule;
      return {
        method: method.trim().toUpperCase(),
        path: path.trim(),
        ...(typeof alternative === "string" ? { alternative: alternative.trim() } : {}),
      };
    });
  }
  if (change.unattended !== undefined) {
    if (!isUnattendedMode(change.unattended)) throw new Error("unattended must be hold or deny");
    output.unattended = change.unattended;
  }
  if (change.unattendedAlternative !== undefined) {
    const reason = invalidAlternativeReason(change.unattendedAlternative);
    if (reason) throw new Error(`unattendedAlternative: ${reason}`);
    output.unattendedAlternative =
      typeof change.unattendedAlternative === "string" ? change.unattendedAlternative.trim() : null;
  }
  if (change.alternatives !== undefined) {
    const alts = change.alternatives;
    if (!alts || typeof alts !== "object" || Array.isArray(alts)) {
      throw new Error("alternatives must be an object { key: text | null }");
    }
    for (const [key, value] of Object.entries(alts as Record<string, unknown>)) {
      if (!OPERATION_KEY.test(key)) {
        throw new Error(`'${key}' is not an operation key (kon:<kon>:<operation> or mcp:<tool>)`);
      }
      if (value === null) {
        delete output.alternatives[key];
        continue;
      }
      const reason = invalidAlternativeReason(value);
      if (reason) throw new Error(`alternatives['${key}']: ${reason}`);
      output.alternatives[key] = (value as string).trim();
    }
    if (Object.keys(output.alternatives).length > 500) throw new Error("at most 500 alternatives");
  }
  return output;
}

/** What is stored in the database, read defensively (an old or half-written row breaks nothing). */
export function readApprovalsConfig(saved: unknown): ApprovalsConfig {
  if (!saved || typeof saved !== "object") return { ...DEFAULT_APPROVALS_CONFIG };
  try {
    return mergeApprovalsConfig(
      DEFAULT_APPROVALS_CONFIG,
      saved as Partial<Record<keyof ApprovalsConfig, unknown>>
    );
  } catch {
    return { ...DEFAULT_APPROVALS_CONFIG };
  }
}

/** Configuration key of an MCP tool that is not an SDK one. */
export function mcpToolKey(name: string): string {
  return `mcp:${name}`;
}

/**
 * Sensitive by default for the core MCP tools: those that delete
 * and the one that queues emails (it sends to any address on behalf of the site:
 * earlier audit).
 */
export function defaultSensitiveMcpTool(name: string): boolean {
  return /(^|_)delete(_|$)/.test(name) || name === "kitsuden_dispatch_worker";
}
