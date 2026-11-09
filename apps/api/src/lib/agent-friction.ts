/**
 * Agent friction — where agents get stuck with our tools
 * ============================================================================
 *
 * The idea comes from Harness² (Google Research): improve an agent without touching
 * the model, by learning from the DIFFERENCES between executions. We are not
 * the harness, but we see every call it makes to us: if agents invent the
 * same key, ask for ids that do not exist or hit a permission that is not
 * advertised well, the fix is on OUR side (the description, the operation's
 * guide —`guide` in the SDK—, the schema), and it improves all harnesses.
 *
 * What lives here is the pure part:
 *
 *   summarizeCall()   the JSON-RPC response of a `tools/call` → what is
 *                      stored in `agent_audit_logs.details`. ONLY the NAMES
 *                      of the arguments, never their values (they may carry
 *                      personal data or secrets).
 *   frictionReport()  audit rows → per tool: failures by
 *                      code, invented keys, rejected proposals and what
 *                      to change.
 *
 * The database query and the route are in `routes/agents.ts`
 * (`GET /api/admin/agents/friction`).
 *
 * The report says WHAT to look at; it rewrites nothing on its own. Changing the guide is a
 * decision for whoever maintains the kon.
 */

export interface SummarizedCall {
  success: boolean;
  /** The problem's `KITSUDEN_E_*`, if there was one. */
  code: string | null;
  /** Replay served by idempotency (it executed nothing). */
  repeated: boolean;
  /** It was held as a proposal awaiting a human. */
  proposal: boolean;
  /** Keys the agent sent that the tool does not know. */
  unknownKeys: string[];
  /** The NAMES of the arguments sent (never the values). */
  args: string[];
}

function object(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The JSON-RPC response of a `tools/call` → what is audited. */
export function summarizeCall(response: unknown, args: unknown): SummarizedCall {
  const r = object(response);
  const argsObject = Object.keys(object(args) ?? {}).sort();
  const error = object(r?.error);
  if (error) {
    const data = object(error.data);
    return {
      success: false,
      code: typeof data?.code === "string" ? data.code : null,
      repeated: false,
      proposal: false,
      unknownKeys: texts(data?.unknownKeys),
      args: argsObject,
    };
  }
  const result = object(r?.result);
  const sc = object(result?.structuredContent);
  const code = typeof sc?.code === "string" ? sc.code : null;
  return {
    success: result?.isError !== true,
    code,
    repeated: sc?.idempotentReplayed === true,
    proposal: code === "KITSUDEN_E_APPROVAL_REQUIRED",
    unknownKeys: texts(sc?.unknownKeys),
    args: argsObject,
  };
}

// ── The report ──────────────────────────────────────────────────────────────

/** An audited call (`action = 'tool_call'`, `details` from `summarizeCall`). */
export interface CallRow {
  tool: string;
  agentId: string | null;
  success: boolean;
  details: unknown;
}

export interface FrictionSignal {
  type:
    | "unknown-keys"
    | "validation"
    | "permission"
    | "not-found"
    | "conflict"
    | "rejections"
    | "no-guide";
  /** What to change, for whoever maintains the operation. */
  message: string;
}

export interface ToolFriction {
  tool: string;
  calls: number;
  failures: number;
  /** 0..1 */
  failureRate: number;
  agents: number;
  repeatedItems: number;
  proposals: number;
  rejectedProposals: number;
  byCode: Record<string, number>;
  /** Invented key → times. */
  madeUpKeys: Record<string, number>;
  hasGuide: boolean | null;
  signals: FrictionSignal[];
}

export interface ReportOptions {
  /** Tools with a declared `guide`; without this, a missing one is not judged. */
  withGuide?: ReadonlySet<string>;
  /** Minimum calls to judge a rate (5 by default). */
  minCalls?: number;
}

const WORRYING_RATE = 0.2;

function signals(f: ToolFriction, min: number): FrictionSignal[] {
  const s: FrictionSignal[] = [];
  const sample = f.calls >= min;
  const times = (code: string) => f.byCode[code] ?? 0;
  const ratio = (n: number) => (f.calls > 0 ? n / f.calls : 0);

  const invented = Object.entries(f.madeUpKeys)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);
  if (invented.length > 0) {
    s.push({
      type: "unknown-keys",
      message: `Agents send keys that do not exist: ${invented
        .map(([k, n]) => `'${k}' (${n})`)
        .join(", ")}. Add an example in guide.examples, or a trap with the correct name.`,
    });
  }
  const withoutKeys = times("KITSUDEN_E_VALIDATION") - invented.reduce((t, [, n]) => t + n, 0);
  if (sample && ratio(withoutKeys) >= WORRYING_RATE) {
    s.push({
      type: "validation",
      message: `${withoutKeys} de ${f.calls} calls fail validation. A complete example in guide.examples is usually enough; also check that the description states the formats (dates, ids).`,
    });
  }
  if (sample && ratio(times("KITSUDEN_E_FORBIDDEN")) >= WORRYING_RATE) {
    s.push({
      type: "permission",
      message:
        "It is often called without permission. If the permission depends on the resource (policy.inHandler) the tool is advertised to someone who then cannot use it: say so in guide.whenToUse.",
    });
  }
  if (sample && ratio(times("KITSUDEN_E_NOT_FOUND")) >= WORRYING_RATE) {
    s.push({
      type: "not-found",
      message:
        "They ask for ids that do not exist. Say in guide.before which operation each requested id comes from.",
    });
  }
  if (sample && ratio(times("KITSUDEN_E_CONFLICT")) >= WORRYING_RATE) {
    s.push({
      type: "conflict",
      message: "Frequent state conflicts (409): explain the correct order of calls in guide.traps.",
    });
  }
  if (f.rejectedProposals > 0 && f.rejectedProposals >= f.proposals / 2) {
    s.push({
      type: "rejections",
      message: `Humans rejected ${f.rejectedProposals} de ${f.proposals} proposals: the agent uses it when it should not. Clarify it in guide.whenToUse.`,
    });
  }
  if (f.hasGuide === false && s.length > 0) {
    s.push({ type: "no-guide", message: "This operation does not declare `guide` in the SDK." });
  }
  return s;
}

/**
 * Audit rows → friction per tool, from worst to best
 * (most failures first). `rejected`: tool → rejected proposals.
 */
export function frictionReport(
  rows: readonly CallRow[],
  rejectedItems: ReadonlyMap<string, number> = new Map(),
  options: ReportOptions = {}
): ToolFriction[] {
  const min = options.minCalls ?? 5;
  const byTool = new Map<string, ToolFriction & { _agents: Set<string> }>();
  const de = (tool: string) => {
    let f = byTool.get(tool);
    if (!f) {
      f = {
        tool,
        calls: 0,
        failures: 0,
        failureRate: 0,
        agents: 0,
        repeatedItems: 0,
        proposals: 0,
        rejectedProposals: 0,
        byCode: {},
        madeUpKeys: {},
        hasGuide: options.withGuide ? options.withGuide.has(tool) : null,
        signals: [],
        _agents: new Set(),
      };
      byTool.set(tool, f);
    }
    return f;
  };

  for (const row of rows) {
    const f = de(row.tool);
    const d = object(row.details);
    f.calls++;
    if (!row.success) f.failures++;
    if (row.agentId) f._agents.add(row.agentId);
    if (d?.repeated === true) f.repeatedItems++;
    if (d?.proposal === true) f.proposals++;
    const code = typeof d?.code === "string" ? d.code : null;
    if (code && !row.success) f.byCode[code] = (f.byCode[code] ?? 0) + 1;
    for (const k of texts(d?.unknownKeys)) f.madeUpKeys[k] = (f.madeUpKeys[k] ?? 0) + 1;
  }
  for (const [tool, n] of rejectedItems) de(tool).rejectedProposals += n;

  return [...byTool.values()]
    .map(({ _agents, ...f }) => {
      const ready = {
        ...f,
        agents: _agents.size,
        failureRate: f.calls > 0 ? f.failures / f.calls : 0,
      };
      return { ...ready, signals: signals(ready, min) };
    })
    .sort(
      (a, b) =>
        b.failures - a.failures ||
        b.rejectedProposals - a.rejectedProposals ||
        a.tool.localeCompare(b.tool)
    );
}
