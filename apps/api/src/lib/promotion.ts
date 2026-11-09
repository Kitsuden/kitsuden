/**
 * Promotion of agent-written code — the execution
 * ============================================================================
 *
 * The contract (modes, factory configuration, capability diff, the decision
 * table) is in `@kitsuden/shared` (`promotion.ts`) and the scan in
 * `code-scan.ts`; the public guide in `docs/agents/promotion.md`. Here:
 *
 *   · the DRAFT: a `code_versions` row (the active version is never
 *     touched: activating is writing ANOTHER version into the action); resubmitting the same
 *     content returns the same row;
 *   · the TESTS in the QuickJS sandbox with `kitsuden.api` and `fetch`
 *     SIMULATED per case (they run even if `ENABLE_CODE_ACTIONS` is
 *     off: they do not leave here);
 *   · the local SCAN + the diff of what is declared against the active version +
 *     what it touches (secrets, users and roles, security configuration,
 *     sensitive operations per the approval classification);
 *   · the DECISION: `suggestion` → proposal in the approval inbox
 *     (`POST /api/promotion/versions/:id/activate`, which once approved
 *     is executed with the agent's identity and the approval's mark);
 *     `turbo` → immediate activation only if NO reason applies;
 *   · the monitored ACTIVATION and the ROLLBACK (automatic by error rate in the
 *     window, or manual), audited and notified.
 *
 * Everything that WRITES goes through the global connection (`db`, empty context = the
 * system): an agent never writes `code_versions` or `actions` by itself.
 * What an agent READS of its own goes through the request's RLS transaction
 * (routes/promotion.ts).
 */

import { createHash } from "node:crypto";

import {
  MAX_TESTS_PER_DRAFT,
  capabilitiesOf,
  concedeScope,
  decidePromotion,
  capabilitiesDiff,
  scanCode,
  mergePromotionConfig,
  readPromotionConfig,
  secretName,
  splitScopes,
  legacyHouseRule,
  operationFineScope,
  pathTouch,
  scopeTouch,
  type CodeCapabilities,
  type TestCase,
  type PromotionConfig,
  type PromotionDecision,
  type CapabilitiesDiff,
  type VersionStatus,
  type ScanFinding,
  type ScanReport,
  type PromotionMode,
  type MockResponse,
  type TestsSummary,
  type SensitiveTouch,
} from "@kitsuden/shared";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import { messageOf } from "../../../../packages/engine/src/errors";
import { routeOperation } from "../../../../packages/engine/src/operations";
import { db } from "../db";
import {
  actionExecutions,
  actions,
  agentIdentities,
  approvalSettings,
  codeVersions,
} from "../db/schema";
import { registerAgentAction, type AuditAction } from "../services/agent-audit";
import type { AgentAuthContext } from "../services/agent-auth";
import { sendAgentWebhook } from "../services/agent-webhooks";

import { observeCodeExecutions } from "./actions/engine";
import {
  createProposal,
  approvalsSnapshot,
  agentMode,
  proposalById,
  operationSensitivity,
} from "./approvals";
import { logger } from "./logger";
import {
  enabledCodeActions,
  executeSandbox,
  type MockFetchRequest,
  type SandboxResponse,
} from "./worker-sandbox";

export type Version = typeof codeVersions.$inferSelect;
type Action = typeof actions.$inferSelect;

export const PROMOTION_KON = "kon-promotion";
export const PROMOTION_ROUTE = "/api/promotion";
export const ACTIVATE_OPERATION = "activate-version";
export const SCOPE_PROMOTION = "promotion:propose";

/** Path stored by the inbox proposal (and executed when it is approved). */
export function activationPath(versionId: string): string {
  return `${PROMOTION_ROUTE}/versions/${versionId}/activate`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Errors with a status (routes translate them to problem+json)
// ═══════════════════════════════════════════════════════════════════════════

export class PromotionError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    message: string,
    readonly reason: string,
    readonly version?: Version
  ) {
    super(message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration (`code_promotion` row of approval_settings) and per-agent mode
// ═══════════════════════════════════════════════════════════════════════════

const ID_CONFIG = "code_promotion";

export async function readSavedConfig(): Promise<{
  config: PromotionConfig;
  updatedBy: string | null;
  updatedAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(approvalSettings)
    .where(eq(approvalSettings.id, ID_CONFIG))
    .limit(1);
  return {
    config: readPromotionConfig(row?.value),
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

async function audit(e: {
  agentId: string | null;
  keyId?: string | null;
  action: AuditAction;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  success?: boolean;
  errorMessage?: string;
}): Promise<void> {
  try {
    await registerAgentAction({
      agentId: e.agentId,
      keyId: e.keyId ?? undefined,
      action: e.action,
      resource: e.resource,
      resourceId: e.resourceId,
      details: e.details,
      success: e.success ?? true,
      errorMessage: e.errorMessage,
    });
  } catch (err) {
    logger.error({ err, action: e.action }, "[promotion] could not write the audit record");
    throw err;
  }
}

export async function savePromotionConfig(
  change: Partial<Record<keyof PromotionConfig, unknown>>,
  who: string
): Promise<{ before: PromotionConfig; after: PromotionConfig }> {
  const before = (await readSavedConfig()).config;
  const after = mergePromotionConfig(before, change); // throws with the reason
  await db
    .insert(approvalSettings)
    .values({ id: ID_CONFIG, value: after, updatedBy: who, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: approvalSettings.id,
      set: { value: after, updatedBy: who, updatedAt: new Date() },
    });
  await audit({
    agentId: null,
    action: "promotion_settings_changed",
    resource: "code_promotion",
    details: { by: who, before, after },
  });
  return { before, after };
}

export async function promotionModeOf(agentId: string): Promise<PromotionMode> {
  const [a] = await db
    .select({ mode: agentIdentities.promotionMode })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, agentId))
    .limit(1);
  return a?.mode === "turbo" ? "turbo" : "suggestion";
}

export async function savePromotionMode(
  agentId: string,
  mode: PromotionMode,
  who: string
): Promise<{ before: string; after: PromotionMode } | null> {
  const [a] = await db
    .select({ mode: agentIdentities.promotionMode })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, agentId))
    .limit(1);
  if (!a) return null;
  await db
    .update(agentIdentities)
    .set({ promotionMode: mode, updatedAt: new Date() })
    .where(eq(agentIdentities.id, agentId));
  await audit({
    agentId,
    action: "promotion_mode_changed",
    resource: "promotion_mode",
    details: { by: who, before: a.mode, after: mode },
  });
  return { before: a.mode, after: mode };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fingerprints
// ═══════════════════════════════════════════════════════════════════════════

/** JSON with sorted keys: the same input gives the same text. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function contentFingerprint(
  code: string,
  caps: CodeCapabilities,
  tests: TestCase[]
): string {
  return sha256(canonical({ code, capabilities: caps, tests }));
}

/** What runs NOW in the action (code + capabilities): the baseline a draft was tested against. */
export function actionFingerprint(action: Pick<Action, "config"> | null): string | null {
  if (!action) return null;
  const config = (action.config ?? {}) as Record<string, unknown>;
  return sha256(
    canonical({
      code: typeof config.code === "string" ? config.code : "",
      capabilities: capabilitiesOf(config),
    })
  );
}

/** The same fingerprint as `actionFingerprint`, for what writes a version into the action. */
function versionFingerprintInAction(v: Pick<Version, "code" | "capabilities">): string {
  return sha256(canonical({ code: v.code, capabilities: capabilitiesOf(v.capabilities) }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests in the sandbox (simulated API and fetch)
// ═══════════════════════════════════════════════════════════════════════════

export interface CaseResult {
  name: string;
  status: "passed" | "failed" | "errored";
  durationMs: number;
  exitReason: string;
  error: string | null;
  /** What did not match `expect` (in English: the agent reads it). */
  mismatches: string[];
  /** Calls from the code without a simulated response (they answered 404). */
  unmockedCalls: string[];
  logs: string;
}

export interface TestReport extends TestsSummary {
  cases: CaseResult[];
  /** Tests declared in the action that were added to those of the draft. */
  fromTarget: number;
  durationMs: number;
}

const TEST_BUDGET_MS = 60_000;
const MAX_TIME_PER_TEST_MS = 10_000;
const TESTS_AT_ONCE = 3;

function mockResponse(r: MockResponse | undefined, url: string): SandboxResponse | null {
  if (!r) return null;
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
  return {
    status: typeof r.status === "number" ? r.status : 200,
    headers: {
      "content-type": typeof r.body === "string" ? "text/plain" : "application/json",
      ...(r.headers ?? {}),
    },
    body,
    url,
  };
}

/** `{ a: 1 }` against `{ a: 1 }`: deep equality by canonical form. */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

async function runCase(
  code: string,
  caps: CodeCapabilities,
  scenario: TestCase
): Promise<CaseResult> {
  const withoutSimulating: string[] = [];
  const simulated = scenario.api ?? {};
  const fetchs = scenario.fetch ?? {};
  const api = async (method: string, path: string): Promise<SandboxResponse> => {
    const withoutQuery = path.split("?")[0]!;
    const r =
      mockResponse(simulated[`${method} ${path}`], path) ??
      mockResponse(simulated[`${method} ${withoutQuery}`], path);
    if (r) return r;
    withoutSimulating.push(`${method} ${path}`);
    return {
      status: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: `No simulated response for ${method} ${path} in this test` }),
      url: path,
    };
  };
  const mockFetch = async (p: MockFetchRequest): Promise<SandboxResponse> => {
    const r =
      mockResponse(fetchs[`${p.method} ${p.url}`], p.url) ??
      (p.method === "GET" ? mockResponse(fetchs[p.url], p.url) : null);
    if (r) return r;
    withoutSimulating.push(`${p.method} ${p.url}`);
    return { status: 404, headers: {}, body: "", url: p.url };
  };

  const r = await executeSandbox({
    code,
    payload: scenario.event ?? {},
    envVars: scenario.env ?? {},
    timeoutMs: Math.min(scenario.timeoutMs ?? caps.timeoutMs, MAX_TIME_PER_TEST_MS),
    memoryLimitMb: caps.memoryLimitMb,
    fetchAllow: caps.fetchAllow,
    maxCalls: caps.maxCalls,
    api,
    probe: { fetch: mockFetch },
  });

  const expected = scenario.expect ?? {};
  const failures: string[] = [];
  const shouldGoWell = expected.success ?? true;
  if (r.success !== shouldGoWell) {
    failures.push(
      shouldGoWell
        ? `expected success, got error: ${r.error ?? "unknown"}`
        : "expected an error, the code succeeded"
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(expected, "result") &&
    !deepEqual(r.result, expected.result)
  ) {
    failures.push(
      `result differs: expected ${canonical(expected.result).slice(0, 300)}, got ${canonical(r.result).slice(0, 300)}`
    );
  }
  if (
    expected.resultContains !== undefined &&
    !JSON.stringify(r.result ?? null).includes(expected.resultContains)
  ) {
    failures.push(`result does not contain ${JSON.stringify(expected.resultContains)}`);
  }
  if (expected.errorContains !== undefined && !(r.error ?? "").includes(expected.errorContains)) {
    failures.push(`error does not contain ${JSON.stringify(expected.errorContains)}`);
  }
  if (expected.logsContain !== undefined && !(r.logs ?? "").includes(expected.logsContain)) {
    failures.push(`logs do not contain ${JSON.stringify(expected.logsContain)}`);
  }
  // A timeout or a crashed interpreter is a test ERROR (not an expected failure).
  const erroredOut = r.exitReason === "timeout" || r.exitReason === "killed";
  return {
    name: scenario.name,
    status:
      erroredOut && !(expected.success === false)
        ? "errored"
        : failures.length
          ? "failed"
          : "passed",
    durationMs: r.durationMs,
    exitReason: r.exitReason,
    error: r.error,
    mismatches: failures,
    unmockedCalls: [...new Set(withoutSimulating)],
    logs: (r.logs ?? "").slice(0, 2000),
  };
}

/** The draft's tests + those the action declares (the draft's win by name). */
export function testsToRun(
  ofTheDraft: TestCase[],
  ofTheAction: unknown
): { cases: TestCase[]; ofTheAction: number } {
  const names = new Set(ofTheDraft.map((c) => c.name));
  const declaredMany = Array.isArray(ofTheAction)
    ? (ofTheAction as TestCase[]).filter(
        (c) => c && typeof c === "object" && typeof c.name === "string" && !names.has(c.name)
      )
    : [];
  const cases = [...ofTheDraft, ...declaredMany].slice(0, MAX_TESTS_PER_DRAFT * 2);
  return { cases, ofTheAction: Math.max(0, cases.length - ofTheDraft.length) };
}

export async function runTests(
  code: string,
  caps: CodeCapabilities,
  cases: TestCase[],
  ofTheAction = 0
): Promise<TestReport> {
  const start = Date.now();
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      const scenario = cases[i]!;
      if (Date.now() - start > TEST_BUDGET_MS) {
        results[i] = {
          name: scenario.name,
          status: "errored",
          durationMs: 0,
          exitReason: "skipped",
          error: `Not run: the ${TEST_BUDGET_MS / 1000} s test budget was used up`,
          mismatches: [],
          unmockedCalls: [],
          logs: "",
        };
        continue;
      }
      try {
        results[i] = await runCase(code, caps, scenario);
      } catch (err) {
        results[i] = {
          name: scenario.name,
          status: "errored",
          durationMs: 0,
          exitReason: "error",
          error: messageOf(err),
          mismatches: [],
          unmockedCalls: [],
          logs: "",
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TESTS_AT_ONCE, cases.length) }, worker));
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    errored: results.filter((r) => r.status === "errored").length,
    cases: results,
    fromTarget: ofTheAction,
    durationMs: Date.now() - start,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Scan + capabilities + what it touches
// ═══════════════════════════════════════════════════════════════════════════

export interface Analysis {
  scan: ScanReport;
  diff: CapabilitiesDiff;
  touches: SensitiveTouch[];
  /** Calls to sensitive operations (`METHOD path` → operation key or `legacy`). */
  sensitive: { method: string; path: string; operation: string | null }[];
  unclassifiedCall: boolean;
}

export async function parseDraft(p: {
  code: string;
  caps: CodeCapabilities;
  active: CodeCapabilities | null;
  activeCode: string | null;
  authorScopes: string[] | null;
}): Promise<Analysis> {
  const scan = scanCode(p.code, { fetchAllow: p.caps.fetchAllow });
  const findings: ScanFinding[] = [...scan.findings];

  // An agent does not declare for its code what it does not itself have.
  if (p.authorScopes) {
    const { grants } = splitScopes(p.caps.scopes);
    const foreign = grants.filter((s) => !concedeScope(p.authorScopes!, s));
    if (foreign.length) {
      findings.push({
        rule: "scope_beyond_author",
        severity: "medium",
        line: 1,
        message: `Declares scopes the submitting agent does not hold: ${foreign.join(", ")}`,
      });
    }
  }

  // Design decision 3: turbo only counts what is NEW. What
  // the active version already touched (a DELETE, a users path, a
  // secrets scope…) does not hold it back; what the draft ADDS does. The active one is the latest
  // version (also the `baseline` snapshot or a `manual` edit).
  const { config } = await approvalsSnapshot();
  const ofTheDraft = classifyTouches(scan, p.caps, config);
  const ofTheAsset =
    p.activeCode !== null
      ? classifyTouches(scanCode(p.activeCode), p.active ?? capabilitiesOf({}), config)
      : null;
  const touches = new Set<SensitiveTouch>();
  for (const [item, t] of ofTheDraft.touches) if (!ofTheAsset?.touches.has(item)) touches.add(t);
  const sensitive = ofTheDraft.sensitive.filter(
    (x) => !ofTheAsset?.sensitive.some((y) => y.key === x.key)
  );
  const unclassified = ofTheDraft.unclassified;

  const report: ScanReport = {
    ...scan,
    findings,
    passed: !findings.some((h) => h.severity === "high" || h.severity === "medium"),
  };
  return {
    scan: report,
    diff: capabilitiesDiff(p.active, p.caps),
    touches: [...touches].sort(),
    sensitive: sensitive.map(({ method, path, operation }) => ({ method, path, operation })),
    unclassifiedCall: unclassified,
  };
}

/**
 * What a piece of code touches (with its capabilities), as KEYS comparable across
 * versions: `scope:<s>`, `path:<METHOD> <path>`, `env:<VAR>` → the category;
 * and its sensitive calls with a key (the SDK operation, or method +
 * path in the legacy case).
 */
function classifyTouches(
  scan: ScanReport,
  caps: CodeCapabilities,
  config: Awaited<ReturnType<typeof approvalsSnapshot>>["config"]
): {
  touches: Map<string, SensitiveTouch>;
  sensitive: { method: string; path: string; operation: string | null; key: string }[];
  unclassified: boolean;
} {
  const touches = new Map<string, SensitiveTouch>();
  for (const s of caps.scopes) {
    const t = scopeTouch(s);
    if (t) touches.set(`scope:${s}`, t);
  }
  const sensitive: { method: string; path: string; operation: string | null; key: string }[] = [];
  let unclassified = false;
  for (const ll of scan.apiCalls) {
    if (ll.path === null || ll.method === "*") {
      unclassified = true;
      continue;
    }
    const path = ll.path.split("?")[0]!;
    const t = pathTouch(path);
    if (t) touches.set(`path:${ll.method} ${path}`, t);
    const ofRoute = routeOperation(ll.method, path);
    if (ofRoute) {
      const s = operationSensitivity(config, ofRoute.konId, ofRoute.op);
      if (s.sensitive) sensitive.push({ method: ll.method, path, operation: s.key, key: s.key });
    } else if (config.legacyRules.some((r) => legacyHouseRule(r, ll.method, path))) {
      sensitive.push({ method: ll.method, path, operation: null, key: `${ll.method} ${path}` });
    }
  }
  // Variables with a secret-like name (or a computed `env[x]`).
  for (const v of scan.envVars) if (v === "*" || secretName(v)) touches.set(`env:${v}`, "secrets");
  return { touches, sensitive, unclassified };
}

// ═══════════════════════════════════════════════════════════════════════════
// Proposing a draft
// ═══════════════════════════════════════════════════════════════════════════

export interface DraftInput {
  target: { actionId?: string; slug?: string; name?: string };
  code: string;
  scopes?: string[];
  fetchAllow?: string[];
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxCalls?: number;
  tests?: TestCase[];
  description?: string;
}

async function actionById(id: string): Promise<Action | null> {
  const [a] = await db.select().from(actions).where(eq(actions.id, id)).limit(1);
  return a ?? null;
}

async function actionBySlug(slug: string): Promise<Action | null> {
  const [a] = await db.select().from(actions).where(eq(actions.slug, slug)).limit(1);
  return a ?? null;
}

async function activeVersion(slug: string): Promise<Version | null> {
  const [v] = await db
    .select()
    .from(codeVersions)
    .where(and(eq(codeVersions.targetSlug, slug), eq(codeVersions.status, "active")))
    .limit(1);
  return v ?? null;
}

export async function versionById(id: string): Promise<Version | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [v] = await db.select().from(codeVersions).where(eq(codeVersions.id, id)).limit(1);
  return v ?? null;
}

async function nextNumber(slug: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(max(${codeVersions.versionNumber}), 0)::int` })
    .from(codeVersions)
    .where(eq(codeVersions.targetSlug, slug));
  return (r?.n ?? 0) + 1;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isUnique(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

export interface ProposalResult {
  version: Version;
  duplicate: boolean;
}

/**
 * The whole path of a draft (see the header). Throws `PromotionError`
 * with the HTTP status when the input is no good.
 */
export async function proposeDraft(
  agent: AgentAuthContext,
  input: DraftInput,
  channel: "rest" | "mcp" = "rest"
): Promise<ProposalResult> {
  // 1. The action: existing (by id or slug) or new (slug + name).
  let action: Action | null = null;
  if (input.target.actionId) {
    action = await actionById(input.target.actionId);
    if (!action) throw new PromotionError(404, "Action not found", "target_not_found");
  } else if (input.target.slug) {
    action = await actionBySlug(input.target.slug);
  } else {
    throw new PromotionError(
      422,
      "target needs actionId (an existing action) or slug (+ name for a new one)",
      "target_missing"
    );
  }
  if (action && action.type !== "code") {
    throw new PromotionError(
      422,
      `Action ${action.slug} is of type ${action.type}; only code actions can be promoted`,
      "target_not_code"
    );
  }
  const slug = action?.slug ?? input.target.slug!;
  if (!action) {
    if (!SLUG.test(slug) || slug.length > 200) {
      throw new PromotionError(
        422,
        "slug must be lowercase letters, digits and dashes (max 200)",
        "invalid_slug"
      );
    }
    if (!input.target.name?.trim()) {
      throw new PromotionError(422, "A new action needs target.name", "target_name_missing");
    }
  }
  const name = action?.name ?? input.target.name!.trim().slice(0, 200);

  // 2. What is declared and the tests; the content fingerprint.
  const caps = capabilitiesOf({
    scopes: input.scopes,
    fetchAllow: input.fetchAllow,
    timeoutMs: input.timeoutMs,
    memoryLimitMb: input.memoryLimitMb,
    maxCalls: input.maxCalls,
  });
  const tests = (input.tests ?? []).slice(0, MAX_TESTS_PER_DRAFT);
  const fingerprint = contentFingerprint(input.code, caps, tests);

  // 3. The same draft again: the same version (in whatever state it is).
  const [earlier] = await db
    .select()
    .from(codeVersions)
    .where(
      and(
        eq(codeVersions.agentId, agent.agentId),
        eq(codeVersions.targetSlug, slug),
        eq(codeVersions.contentHash, fingerprint)
      )
    )
    .limit(1);
  if (earlier) return { version: await syncWithProposal(earlier), duplicate: true };

  // 4. What it is compared against: the active version or, if the action never went through here, what runs now.
  const active = await activeVersion(slug);
  const actionConfig = (action?.config ?? {}) as Record<string, unknown>;
  const activeCaps: CodeCapabilities | null = active
    ? capabilitiesOf(active.capabilities)
    : action
      ? capabilitiesOf(actionConfig)
      : null;
  const activeCode =
    active?.code ?? (typeof actionConfig.code === "string" ? actionConfig.code : null);

  // 5. Tests, scan, decision.
  const { cases: cases, ofTheAction } = testsToRun(tests, actionConfig.tests);
  const testReport = await runTests(input.code, caps, cases, ofTheAction);
  const analysis = await parseDraft({
    code: input.code,
    caps,
    active: activeCaps,
    activeCode,
    authorScopes: agent.scopes ?? [],
  });
  const mode = await promotionModeOf(agent.agentId);
  const { config } = await readSavedConfig();
  const approvalState = await approvalsSnapshot();
  const decision: PromotionDecision = decidePromotion({
    mode,
    config,
    heldAgent:
      approvalState.config.enabled && agentMode(approvalState, agent.agentId) === "propose",
    diff: analysis.diff,
    tests: testReport,
    approvedScan: analysis.scan.passed,
    touches: analysis.touches,
    sensitiveOperation: analysis.sensitive.length > 0,
    unclassifiedCall: analysis.unclassifiedCall,
    targetWithVariables: hasEnvVars(action?.config),
  });
  const savedDecision = {
    ...decision,
    mode,
    turboAllowed: config.turboAllowed,
    touches: analysis.touches,
    sensitiveCalls: analysis.sensitive,
    decidedAt: new Date().toISOString(),
  };

  // 6. The row (next number; a race with another identical one = that one).
  let version: Version | undefined;
  for (let attempt = 0; attempt < 4 && !version; attempt++) {
    try {
      const [row] = await db
        .insert(codeVersions)
        .values({
          targetKind: "action",
          targetId: action?.id ?? null,
          targetSlug: slug,
          targetName: name,
          versionNumber: await nextNumber(slug),
          origin: "agent",
          agentId: agent.agentId,
          keyId: agent.keyId || null,
          sponsorUserId: agent.sponsor?.userId ?? null,
          channel,
          description: input.description?.slice(0, 2000) ?? null,
          code: input.code,
          capabilities: caps,
          tests,
          contentHash: fingerprint,
          baseHash: actionFingerprint(action),
          parentVersionId: active?.id ?? null,
          mode,
          status: decision.route === "turbo" ? "approved" : "awaiting_approval",
          testReport,
          scanReport: analysis.scan,
          capabilityDiff: analysis.diff,
          decision: savedDecision,
        })
        .returning();
      version = row;
    } catch (err) {
      if (!isUnique(err)) throw err;
      const [other] = await db
        .select()
        .from(codeVersions)
        .where(
          and(
            eq(codeVersions.agentId, agent.agentId),
            eq(codeVersions.targetSlug, slug),
            eq(codeVersions.contentHash, fingerprint)
          )
        )
        .limit(1);
      if (other) return { version: other, duplicate: true };
      // Otherwise, the version number clashed with another action in progress: another round.
    }
  }
  if (!version) throw new Error("Could not number the version");

  await audit({
    agentId: agent.agentId,
    keyId: agent.keyId,
    action: "promotion_submitted",
    resource: `action:${slug}`,
    resourceId: version.id,
    details: {
      versionNumber: version.versionNumber,
      contentHash: fingerprint,
      baseHash: version.baseHash,
      parentVersionId: version.parentVersionId,
      sponsor: version.sponsorUserId,
      channel,
      mode,
      route: decision.route,
      reasons: decision.reasons,
      tests: {
        total: testReport.total,
        passed: testReport.passed,
        failed: testReport.failed,
        errored: testReport.errored,
      },
      scan: {
        passed: analysis.scan.passed,
        findings: analysis.scan.findings.map((h) => `${h.severity}:${h.rule}`),
      },
    },
  });

  // 7. Turbo: it is activated right away. Otherwise: the inbox proposal.
  if (decision.route === "turbo") {
    try {
      const r = await activateVersion(version.id, { type: "turbo" });
      return { version: r, duplicate: false };
    } catch (err) {
      if (err instanceof PromotionError && err.version)
        return { version: err.version, duplicate: false };
      throw err;
    }
  }
  const { proposal } = await createProposal({
    agent,
    channel: "rest",
    method: "POST",
    path: activationPath(version.id),
    body: { contentHash: fingerprint },
    type: "application/json",
    fingerprint: sha256(`promotion:${version.id}:${fingerprint}`),
    idempotencyKey: null,
    reason: "sensitive",
    konId: PROMOTION_KON,
    operationId: ACTIVATE_OPERATION,
    key: operationFineScope(PROMOTION_KON, ACTIVATE_OPERATION),
    diff: inboxSummary(version),
  });
  const [withProposal] = await db
    .update(codeVersions)
    .set({ proposalId: proposal.id, updatedAt: new Date() })
    .where(eq(codeVersions.id, version.id))
    .returning();
  return { version: withProposal ?? version, duplicate: false };
}

/** What the approval inbox shows as the proposal's «diff» (without the code). */
export function inboxSummary(v: Version) {
  const tests = v.testReport as TestReport | null;
  const scan = v.scanReport as ScanReport | null;
  return {
    kind: "promotion",
    versionId: v.id,
    target: { slug: v.targetSlug, name: v.targetName, actionId: v.targetId },
    versionNumber: v.versionNumber,
    contentHash: v.contentHash,
    mode: v.mode,
    decision: v.decision,
    tests: tests
      ? { total: tests.total, passed: tests.passed, failed: tests.failed, errored: tests.errored }
      : null,
    scan: scan ? { passed: scan.passed, findings: scan.findings } : null,
    capabilityDiff: v.capabilityDiff,
    panel: `/approvals?tab=promotion&version=${v.id}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Proposal status → version status
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A version awaiting approval follows its proposal: rejected or
 * expired in the inbox → `rejected` / `expired`; failed without being activated →
 * `failed` (with the reason). Called on read (cheap: only those waiting).
 */
export async function syncWithProposal(v: Version): Promise<Version> {
  if (v.status !== "awaiting_approval" || !v.proposalId) return v;
  const p = await proposalById(v.proposalId);
  if (!p) return v;
  const pendingExpired = p.status === "pending" && p.expiresAt <= new Date();
  let status: VersionStatus | null = null;
  let error: string | null = null;
  if (p.status === "rejected") status = "rejected";
  else if (p.status === "expired" || pendingExpired) status = "expired";
  else if (p.status === "failed") {
    status = "failed";
    error = p.resultError ?? `proposal_failed (HTTP ${p.resultStatus ?? "?"})`;
  }
  if (!status) return v;
  const [updated] = await db
    .update(codeVersions)
    .set({ status, activationError: error, updatedAt: new Date() })
    .where(and(eq(codeVersions.id, v.id), eq(codeVersions.status, "awaiting_approval")))
    .returning();
  if (!updated) return (await versionById(v.id)) ?? v;
  if (status === "rejected") {
    await audit({
      agentId: v.agentId,
      action: "promotion_rejected",
      resource: `action:${v.targetSlug}`,
      resourceId: v.id,
      details: {
        by: p.decidedBy,
        comment: p.decisionComment,
        proposalId: p.id,
        contentHash: v.contentHash,
      },
    }).catch(() => undefined);
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════════════════════
// Activate
// ═══════════════════════════════════════════════════════════════════════════

export type WhoActivates =
  | { type: "turbo" }
  | { type: "approval"; proposalId: string; approvedBy: string; agentId: string }
  | { type: "human"; userId: string };

/** Does this action's `config` hold environment variables? (their real values reach the code) */
function hasEnvVars(config: unknown): boolean {
  const variables = (config as { envVars?: unknown } | null | undefined)?.envVars;
  return !!variables && typeof variables === "object" && Object.keys(variables).length > 0;
}

/** The action's `config` with the version's code and declarations (everything else, envVars included, stays). */
function configWithVersion(base: Record<string, unknown>, v: Version): Record<string, unknown> {
  const caps = capabilitiesOf(v.capabilities);
  return {
    ...base,
    code: v.code,
    scopes: caps.scopes,
    fetchAllow: caps.fetchAllow,
    timeoutMs: caps.timeoutMs,
    memoryLimitMb: caps.memoryLimitMb,
    maxCalls: caps.maxCalls,
    tests: v.tests,
    promotion: { versionId: v.id, versionNumber: v.versionNumber, contentHash: v.contentHash },
  };
}

const whoIs = (q: WhoActivates) =>
  q.type === "turbo" ? "turbo" : q.type === "approval" ? q.approvedBy : q.userId;

let negatives = new Map<string, number>();

/**
 * Activates the version (see the header). Returns the ACTIVE version, or throws
 * `PromotionError` (409) with the version as it ended up: `approved` if code
 * actions are off, `failed` if the action changed underneath.
 */
export async function activateVersion(id: string, who: WhoActivates): Promise<Version> {
  const v = await versionById(id);
  if (!v || v.origin !== "agent") throw new PromotionError(404, "Version not found", "not_found");

  const allowed =
    who.type === "approval"
      ? v.status === "awaiting_approval" &&
        v.proposalId === who.proposalId &&
        v.agentId === who.agentId
      : v.status === "approved";
  if (!allowed) {
    throw new PromotionError(
      409,
      who.type === "human" && v.status === "awaiting_approval"
        ? "This version is waiting for approval: approve its proposal instead"
        : `Version is ${v.status}`,
      "wrong_state",
      v
    );
  }

  const { config } = await readSavedConfig();

  // Without code actions it is not activated: it stays approved and says so.
  if (!enabledCodeActions()) {
    const [approved] = await db
      .update(codeVersions)
      .set({ status: "approved", activationError: "code_actions_disabled", updatedAt: new Date() })
      .where(eq(codeVersions.id, v.id))
      .returning();
    await audit({
      agentId: v.agentId,
      action: "promotion_activation_blocked",
      resource: `action:${v.targetSlug}`,
      resourceId: v.id,
      details: {
        by: whoIs(who),
        via: who.type,
        reason: "code_actions_disabled",
        contentHash: v.contentHash,
      },
      success: false,
      errorMessage: "code_actions_disabled",
    });
    throw new PromotionError(
      409,
      "Code actions are disabled on this server (ENABLE_CODE_ACTIONS): the version stays approved and an admin can activate it once they are enabled",
      "code_actions_disabled",
      approved
    );
  }

  const now = new Date();
  let result: { version: Version; previous: Version | null; actionId: string } | { stalled: true };
  result = await db.transaction(async (tx) => {
    // The action, locked: nobody changes it while the version is being switched.
    const [action] = await tx
      .select()
      .from(actions)
      .where(eq(actions.slug, v.targetSlug))
      .limit(1)
      .for("update");
    if (actionFingerprint(action ?? null) !== v.baseHash) return { stalled: true } as const;

    const [active] = await tx
      .select()
      .from(codeVersions)
      .where(and(eq(codeVersions.targetSlug, v.targetSlug), eq(codeVersions.status, "active")))
      .limit(1)
      .for("update");
    let previous: Version | null = active ?? null;
    // Someone edited the action by hand since the last activation: what runs
    // is no longer the active version. A snapshot is taken of what REALLY runs
    // (rolling back has to leave that, not a version that was no longer running).
    const derives = !!(
      active &&
      action &&
      versionFingerprintInAction(active) !== actionFingerprint(action)
    );
    if (derives) {
      await tx
        .update(codeVersions)
        .set({ status: "superseded", updatedAt: now })
        .where(eq(codeVersions.id, active!.id));
      previous = null;
    }
    if (!previous && action) {
      // First promoted version of an action that already existed (or one
      // edited by hand): the snapshot of what was running, so it can be returned to.
      const [n] = await tx
        .select({ n: sql<number>`coalesce(max(${codeVersions.versionNumber}), 0)::int` })
        .from(codeVersions)
        .where(eq(codeVersions.targetSlug, v.targetSlug));
      const actionConfig = (action.config ?? {}) as Record<string, unknown>;
      const [photo] = await tx
        .insert(codeVersions)
        .values({
          targetKind: "action",
          targetId: action.id,
          targetSlug: action.slug,
          targetName: action.name,
          versionNumber: (n?.n ?? 0) + 1,
          origin: "baseline",
          code: typeof actionConfig.code === "string" ? actionConfig.code : "",
          capabilities: capabilitiesOf(actionConfig),
          tests: Array.isArray(actionConfig.tests) ? actionConfig.tests : [],
          contentHash: actionFingerprint(action)!,
          mode: "suggestion",
          status: "active",
          activatedAt: action.createdAt,
          activatedBy: "baseline",
        })
        .returning();
      previous = photo!;
    }
    if (previous) {
      await tx
        .update(codeVersions)
        .set({ status: "superseded", updatedAt: now })
        .where(eq(codeVersions.id, previous.id));
    }

    let actionId: string;
    if (action) {
      await tx
        .update(actions)
        .set({
          config: configWithVersion((action.config ?? {}) as Record<string, unknown>, v),
          status: "active",
          errorCount: 0,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(actions.id, action.id));
      actionId = action.id;
    } else {
      const [next] = await tx
        .insert(actions)
        .values({
          name: v.targetName,
          slug: v.targetSlug,
          description: v.description,
          type: "code",
          trigger: "manual",
          triggerConfig: {},
          config: configWithVersion({}, v),
          status: "active",
          // Human responsible: whoever approved, or the agent's signer.
          createdById:
            who.type === "approval"
              ? who.approvedBy
              : who.type === "human"
                ? who.userId
                : v.sponsorUserId,
        })
        .returning();
      actionId = next!.id;
    }

    const [enabled] = await tx
      .update(codeVersions)
      .set({
        status: "active",
        targetId: actionId,
        activatedAt: now,
        activatedBy: whoIs(who),
        previousVersionId: previous?.id ?? null,
        activationError: null,
        watchUntil: new Date(now.getTime() + config.watchMinutes * 60_000),
        watch: {
          state: "watching",
          executions: 0,
          errors: 0,
          minExecutions: config.minExecutions,
          maxErrorRate: config.maxErrorRate,
          watchMinutes: config.watchMinutes,
        },
        updatedAt: now,
      })
      .where(eq(codeVersions.id, v.id))
      .returning();
    return { version: enabled!, previous, actionId };
  });

  if ("stalled" in result) {
    const [failed] = await db
      .update(codeVersions)
      .set({ status: "failed", activationError: "stale_base", updatedAt: new Date() })
      .where(eq(codeVersions.id, v.id))
      .returning();
    await audit({
      agentId: v.agentId,
      action: "promotion_activation_failed",
      resource: `action:${v.targetSlug}`,
      resourceId: v.id,
      details: {
        by: whoIs(who),
        via: who.type,
        reason: "stale_base",
        contentHash: v.contentHash,
        baseHash: v.baseHash,
      },
      success: false,
      errorMessage: "stale_base",
    });
    throw new PromotionError(
      409,
      "The action changed since this draft was tested (another version was activated or it was edited): submit the draft again",
      "stale_base",
      failed
    );
  }

  negatives.delete(result.actionId);
  await audit({
    agentId: v.agentId,
    keyId: v.keyId,
    action: "promotion_activated",
    resource: `action:${v.targetSlug}`,
    resourceId: v.id,
    details: {
      by: whoIs(who),
      via: who.type,
      proposalId: who.type === "approval" ? who.proposalId : v.proposalId,
      sponsor: v.sponsorUserId,
      versionNumber: v.versionNumber,
      contentHash: v.contentHash,
      previousVersionId: result.previous?.id ?? null,
      previousHash: result.previous?.contentHash ?? null,
      actionId: result.actionId,
      watchUntil: result.version.watchUntil,
    },
  });
  return result.version;
}

// ═══════════════════════════════════════════════════════════════════════════
// Manual edits by a person (design decision 2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A person (admin) changed an action's code via `/api/actions`: it is recorded
 * as the ACTIVE `manual` version, with the base (what ran before) and the previous
 * version, so that rollback, auditing and `stale_base` keep working.
 * If what ran before was not the active version (an SQL edit), a `baseline`
 * snapshot of that is saved first. No monitoring window: it is a
 * human decision; it can be rolled back by hand.
 */
export async function registerManualEdit(
  before: Pick<Action, "id" | "slug" | "name" | "config" | "createdAt"> | null,
  after: Pick<Action, "id" | "slug" | "name" | "config">,
  userId: string | null
): Promise<Version> {
  const now = new Date();
  const configAfter = (after.config ?? {}) as Record<string, unknown>;
  const caps = capabilitiesOf(configAfter);
  const code = typeof configAfter.code === "string" ? configAfter.code : "";
  const tests = (Array.isArray(configAfter.tests) ? configAfter.tests : []) as TestCase[];
  const r = await db.transaction(async (tx) => {
    const [action] = await tx
      .select()
      .from(actions)
      .where(eq(actions.id, after.id))
      .limit(1)
      .for("update");
    const [active] = await tx
      .select()
      .from(codeVersions)
      .where(and(eq(codeVersions.targetSlug, after.slug), eq(codeVersions.status, "active")))
      .limit(1)
      .for("update");
    const number = async () => {
      const [n] = await tx
        .select({ n: sql<number>`coalesce(max(${codeVersions.versionNumber}), 0)::int` })
        .from(codeVersions)
        .where(eq(codeVersions.targetSlug, after.slug));
      return (n?.n ?? 0) + 1;
    };
    const baseHash = actionFingerprint(before);
    let previous: Version | null = null;
    if (active && before && versionFingerprintInAction(active) === baseHash) {
      previous = active;
    } else if (before) {
      const configBefore = (before.config ?? {}) as Record<string, unknown>;
      const [photo] = await tx
        .insert(codeVersions)
        .values({
          targetKind: "action",
          targetId: before.id,
          targetSlug: before.slug,
          targetName: before.name,
          versionNumber: await number(),
          origin: "baseline",
          code: typeof configBefore.code === "string" ? configBefore.code : "",
          capabilities: capabilitiesOf(configBefore),
          tests: Array.isArray(configBefore.tests) ? configBefore.tests : [],
          contentHash: baseHash!,
          mode: "suggestion",
          status: "superseded",
          activatedAt: before.createdAt,
          activatedBy: "baseline",
        })
        .returning();
      previous = photo!;
    }
    if (active) {
      await tx
        .update(codeVersions)
        .set({ status: "superseded", updatedAt: now })
        .where(eq(codeVersions.id, active.id));
    }
    const [manual] = await tx
      .insert(codeVersions)
      .values({
        targetKind: "action",
        targetId: after.id,
        targetSlug: after.slug,
        targetName: after.name,
        versionNumber: await number(),
        origin: "manual",
        agentId: null,
        sponsorUserId: userId,
        channel: "rest",
        description: "Edited by hand (/api/actions)",
        code,
        capabilities: caps,
        tests,
        contentHash: contentFingerprint(code, caps, tests),
        baseHash,
        parentVersionId: active?.id ?? null,
        previousVersionId: previous?.id ?? null,
        mode: "suggestion",
        status: "active",
        activatedAt: now,
        activatedBy: userId ?? "manual",
      })
      .returning();
    // The active version's mark on the action (it does not change its fingerprint).
    if (action) {
      await tx
        .update(actions)
        .set({
          config: {
            ...((action.config ?? {}) as Record<string, unknown>),
            promotion: {
              versionId: manual!.id,
              versionNumber: manual!.versionNumber,
              contentHash: manual!.contentHash,
            },
          },
        })
        .where(eq(actions.id, action.id));
    }
    return { manual: manual!, previous };
  });
  negatives.delete(after.id);
  await audit({
    agentId: null,
    action: "promotion_manual_edit",
    resource: `action:${after.slug}`,
    resourceId: r.manual.id,
    details: {
      by: userId,
      versionNumber: r.manual.versionNumber,
      contentHash: r.manual.contentHash,
      baseHash: r.manual.baseHash,
      previousVersionId: r.previous?.id ?? null,
      previousHash: r.previous?.contentHash ?? null,
      actionId: after.id,
    },
  });
  return r.manual;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rollback
// ═══════════════════════════════════════════════════════════════════════════

export type WhoReturns =
  | { type: "auto"; stats: { executions: number; errors: number; rate: number } }
  | { type: "human"; userId: string };

/**
 * Leaves the action as it was before this version (the previous one becomes
 * the active one; if there was none, the action is paused). Only from the ACTIVE one.
 */
export async function goBack(id: string, reason: string, who: WhoReturns): Promise<Version> {
  const now = new Date();
  const r = await db.transaction(async (tx) => {
    const [v] = await tx
      .select()
      .from(codeVersions)
      .where(eq(codeVersions.id, id))
      .limit(1)
      .for("update");
    if (!v) return { error: new PromotionError(404, "Version not found", "not_found") };
    if (v.status !== "active" || v.origin === "baseline") {
      return {
        error: new PromotionError(
          409,
          `Only the active version can be rolled back (this one is ${v.status})`,
          "wrong_state",
          v
        ),
      };
    }
    const [previous] = v.previousVersionId
      ? await tx
          .select()
          .from(codeVersions)
          .where(eq(codeVersions.id, v.previousVersionId))
          .limit(1)
      : [];
    const [action] = v.targetId
      ? await tx.select().from(actions).where(eq(actions.id, v.targetId)).limit(1).for("update")
      : [];
    const [round] = await tx
      .update(codeVersions)
      .set({
        status: "rolled_back",
        rolledBackAt: now,
        rolledBackBy: who.type === "auto" ? "auto" : who.userId,
        rollbackReason: reason.slice(0, 2000),
        watch: {
          ...((v.watch ?? {}) as Record<string, unknown>),
          state: "rolled_back",
          ...(who.type === "auto" ? who.stats : {}),
        },
        updatedAt: now,
      })
      .where(eq(codeVersions.id, v.id))
      .returning();
    if (action) {
      const base = (action.config ?? {}) as Record<string, unknown>;
      if (previous) {
        const restored = configWithVersion(base, previous);
        await tx
          .update(actions)
          .set({
            config: restored,
            status: "active",
            errorCount: 0,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(actions.id, action.id));
        await tx
          .update(codeVersions)
          .set({ status: "active", updatedAt: now })
          .where(eq(codeVersions.id, previous.id));
      } else {
        // It was the first: there is nothing to go back to, the action stops running.
        await tx
          .update(actions)
          .set({ status: "paused", updatedAt: now })
          .where(eq(actions.id, action.id));
      }
    }
    return { version: round!, previous: previous ?? null };
  });
  if ("error" in r) throw r.error;

  negatives = new Map();
  const details = {
    by: who.type === "auto" ? null : who.userId,
    automatic: who.type === "auto",
    reason,
    ...(who.type === "auto" ? { stats: who.stats } : {}),
    fromVersion: r.version.versionNumber,
    fromHash: r.version.contentHash,
    toVersionId: r.previous?.id ?? null,
    toHash: r.previous?.contentHash ?? null,
    actionPaused: !r.previous,
  };
  await audit({
    agentId: r.version.agentId,
    action: "promotion_rolled_back",
    resource: `action:${r.version.targetSlug}`,
    resourceId: r.version.id,
    details,
    success: who.type !== "auto",
    errorMessage: who.type === "auto" ? reason : undefined,
  });
  logger.warn(
    { versionId: r.version.id, slug: r.version.targetSlug, ...details },
    "[promotion] rollback"
  );
  // The usual agent notification (AGENT_WEBHOOK_URL), if configured.
  void sendAgentWebhook({
    id: r.version.id,
    type: "promotion_rolled_back",
    timestamp: now.toISOString(),
    agent: { id: r.version.agentId ?? "", name: r.version.agentId ?? "" },
    details: { resource: `action:${r.version.targetSlug}`, ...details },
  }).catch(() => undefined);
  return r.version;
}

// ═══════════════════════════════════════════════════════════════════════════
// Monitoring
// ═══════════════════════════════════════════════════════════════════════════

const NEGATIVE_MS = 10_000;

async function evaluate(v: Version, close: boolean): Promise<void> {
  if (!v.targetId || !v.activatedAt) return;
  const w = (v.watch ?? {}) as { state?: string; minExecutions?: number; maxErrorRate?: number };
  if (w.state !== "watching") return;
  const [c] = await db
    .select({
      total: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${actionExecutions.status} in ('error', 'timeout'))::int`,
    })
    .from(actionExecutions)
    .where(
      and(
        eq(actionExecutions.actionId, v.targetId),
        sql`${actionExecutions.startedAt} >= ${v.activatedAt}`,
        inArray(actionExecutions.status, ["success", "error", "timeout"])
      )
    );
  const total = c?.total ?? 0;
  const errors = c?.errors ?? 0;
  const min = w.minExecutions ?? 3;
  const threshold = w.maxErrorRate ?? 0.5;
  const rate = total > 0 ? errors / total : 0;
  if (total >= min && rate >= threshold) {
    await goBack(
      v.id,
      `Automatic rollback: ${errors} of ${total} executions failed or timed out (${Math.round(rate * 100)}% >= ${Math.round(threshold * 100)}%) within the watch window`,
      { type: "auto", stats: { executions: total, errors, rate } }
    ).catch((err) => {
      if (!(err instanceof PromotionError)) throw err; // another rollback won: nothing to do
    });
    return;
  }
  const next = { ...w, executions: total, errors, ...(close ? { state: "passed" } : {}) };
  const [done] = await db
    .update(codeVersions)
    .set({ watch: next, ...(close ? { watchUntil: null } : {}), updatedAt: new Date() })
    .where(and(eq(codeVersions.id, v.id), eq(codeVersions.status, "active")))
    .returning({ id: codeVersions.id });
  if (close && done) {
    await audit({
      agentId: v.agentId,
      action: "promotion_watch_passed",
      resource: `action:${v.targetSlug}`,
      resourceId: v.id,
      details: { executions: total, errors, rate, contentHash: v.contentHash },
    }).catch(() => undefined);
  }
}

/**
 * After each execution of a `code` action (called by the actions engine):
 * if one of its versions is in its window, it recounts and, above the threshold,
 * rolls back. One indexed query; with no monitored version, the answer
 * is remembered for a few seconds.
 */
export async function watchAfterExecution(actionId: string): Promise<void> {
  const until = negatives.get(actionId);
  if (until && until > Date.now()) return;
  const [v] = await db
    .select()
    .from(codeVersions)
    .where(
      and(
        eq(codeVersions.targetId, actionId),
        eq(codeVersions.status, "active"),
        gt(codeVersions.watchUntil, new Date())
      )
    )
    .limit(1);
  if (!v) {
    negatives.set(actionId, Date.now() + NEGATIVE_MS);
    if (negatives.size > 5000) negatives = new Map();
    return;
  }
  await evaluate(v, false);
}

/** Closes the expired windows (and recounts the open ones, in case the executions happened in another process). */
export async function sweepWatches(): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(codeVersions)
    .where(and(eq(codeVersions.status, "active"), isNotNull(codeVersions.watchUntil)))
    .orderBy(desc(codeVersions.activatedAt))
    .limit(200);
  for (const v of rows) {
    try {
      await evaluate(v, v.watchUntil! <= now);
    } catch (err) {
      logger.error({ err, versionId: v.id }, "[promotion] could not evaluate monitoring");
    }
  }
  return rows.length;
}

// Every execution of a `code` action goes through here (actions engine).
observeCodeExecutions((actionId) => watchAfterExecution(actionId));

let sweep: ReturnType<typeof setInterval> | null = null;
export function startWatchesSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    sweepWatches().catch(() => undefined);
  }, 60_000);
  (sweep as { unref?: () => void }).unref?.();
}

/** For tests only. */
export function _forgetNegatives(): void {
  negatives = new Map();
}

// ═══════════════════════════════════════════════════════════════════════════
// Listings
// ═══════════════════════════════════════════════════════════════════════════

/** Versions of one action or of all, most recent first. `executor` = the connection (RLS or global). */
export async function listVersions(
  executor: typeof db,
  f: {
    agentId?: string | null;
    status?: string | null;
    slug?: string | null;
    limit?: number;
    offset?: number;
  }
): Promise<Version[]> {
  const conditions = [];
  if (f.agentId) conditions.push(eq(codeVersions.agentId, f.agentId));
  if (f.status) conditions.push(eq(codeVersions.status, f.status));
  if (f.slug) conditions.push(eq(codeVersions.targetSlug, f.slug));
  const rows = await executor
    .select()
    .from(codeVersions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(codeVersions.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 50, 1), 200))
    .offset(Math.max(f.offset ?? 0, 0));
  const out: Version[] = [];
  for (const v of rows) out.push(await syncWithProposal(v));
  return out;
}

/** The view of a version (the same for the agent and the panel; the code only in the detail). */
export function versionView(v: Version, withCode = false) {
  return {
    id: v.id,
    target: { kind: v.targetKind, actionId: v.targetId, slug: v.targetSlug, name: v.targetName },
    versionNumber: v.versionNumber,
    origin: v.origin,
    status: v.status as VersionStatus,
    mode: v.mode,
    agentId: v.agentId,
    sponsorUserId: v.sponsorUserId,
    channel: v.channel,
    description: v.description,
    contentHash: v.contentHash,
    baseHash: v.baseHash,
    parentVersionId: v.parentVersionId,
    previousVersionId: v.previousVersionId,
    capabilities: v.capabilities,
    testCount: Array.isArray(v.tests) ? v.tests.length : 0,
    testReport: v.testReport,
    scanReport: v.scanReport,
    capabilityDiff: v.capabilityDiff,
    decision: v.decision,
    proposal: v.proposalId
      ? { id: v.proposalId, statusUrl: `/api/proposals/${v.proposalId}` }
      : null,
    activatedAt: v.activatedAt,
    activatedBy: v.activatedBy,
    watchUntil: v.watchUntil,
    watch: v.watch,
    rolledBackAt: v.rolledBackAt,
    rolledBackBy: v.rolledBackBy,
    rollbackReason: v.rollbackReason,
    activationError: v.activationError,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    ...(withCode ? { code: v.code, tests: v.tests } : {}),
  };
}
