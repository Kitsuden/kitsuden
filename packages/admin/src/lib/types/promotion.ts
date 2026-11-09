/**
 * Code promotion: what `/api/approvals/promotion` returns
 * (apps/api/src/routes/promotion.ts). Guide: docs/agents/promotion.md.
 */

export type PromotionMode = "suggestion" | "turbo";

export type VersionStatus =
  | "awaiting_approval"
  | "approved"
  | "active"
  | "superseded"
  | "rolled_back"
  | "rejected"
  | "expired"
  | "failed";

export interface PromotionConfig {
  turboAllowed: boolean;
  watchMinutes: number;
  minExecutions: number;
  maxErrorRate: number;
}

export interface PromotionAgent {
  id: string;
  name: string;
  isActive: boolean;
  mode: PromotionMode;
  approvalMode: string;
  canPropose: boolean;
}

export interface PromotionSettings {
  config: PromotionConfig;
  updatedBy: string | null;
  updatedAt: string | null;
  approvalsEnabled: boolean;
  codeActionsEnabled: boolean;
  agents: PromotionAgent[];
}

export interface TestCaseResult {
  name: string;
  status: "passed" | "failed" | "errored";
  durationMs: number;
  exitReason: string;
  error: string | null;
  mismatches: string[];
  unmockedCalls: string[];
  logs: string;
}

export interface TestReport {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  fromTarget: number;
  durationMs: number;
  cases: TestCaseResult[];
}

export interface ScanFinding {
  rule: string;
  severity: "high" | "medium" | "low";
  line: number;
  message: string;
}

export interface ScanReport {
  passed: boolean;
  bytes: number;
  findings: ScanFinding[];
  apiCalls: { method: string; path: string | null; line: number }[];
  fetchHosts: string[];
  envVars: string[];
}

export interface CapabilityDiff {
  newTarget: boolean;
  scopesAdded: string[];
  scopesRemoved: string[];
  denialsRemoved: string[];
  denialsAdded: string[];
  hostsAdded: string[];
  hostsRemoved: string[];
  limitsIncreased: { field: string; before: number; after: number }[];
}

export interface PromotionDecision {
  route: "turbo" | "proposal";
  reasons: string[];
  mode: PromotionMode;
  turboAllowed: boolean;
  touches: string[];
  sensitiveCalls: { method: string; path: string; operation: string | null }[];
}

export interface CodeVersion {
  id: string;
  target: { kind: string; actionId: string | null; slug: string; name: string };
  versionNumber: number;
  origin: "agent" | "baseline" | "manual";
  status: VersionStatus;
  mode: PromotionMode;
  agentId: string | null;
  agentName?: string | null;
  sponsorUserId: string | null;
  sponsorName?: string | null;
  channel: string;
  description: string | null;
  contentHash: string;
  baseHash: string | null;
  parentVersionId: string | null;
  previousVersionId: string | null;
  capabilities: {
    scopes: string[];
    fetchAllow: string[];
    timeoutMs: number;
    memoryLimitMb: number;
    maxCalls: number;
  };
  testCount: number;
  testReport: TestReport | null;
  scanReport: ScanReport | null;
  capabilityDiff: CapabilityDiff | null;
  decision: PromotionDecision | null;
  proposal: { id: string; statusUrl: string } | null;
  activatedAt: string | null;
  activatedBy: string | null;
  activatedByName?: string | null;
  watchUntil: string | null;
  watch: {
    state?: string;
    executions?: number;
    errors?: number;
    minExecutions?: number;
    maxErrorRate?: number;
  } | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  rolledBackByName?: string | null;
  rollbackReason: string | null;
  activationError: string | null;
  createdAt: string;
  updatedAt: string;
  code?: string;
  tests?: unknown[];
}

export interface PromotionEvent {
  id: string;
  at: string;
  action: string;
  by: string | null;
  byName: string | null;
  success: boolean;
  details: Record<string, unknown> | null;
}

export interface CodeVersionDetail {
  version: CodeVersion & { code: string; tests: unknown[] };
  previous: (CodeVersion & { code: string }) | null;
  proposal: {
    id: string;
    status: string;
    decidedBy: string | null;
    decidedAt: string | null;
    comment: string | null;
    expiresAt: string;
    resultStatus: number | null;
    resultError: string | null;
  } | null;
  events: PromotionEvent[];
}
