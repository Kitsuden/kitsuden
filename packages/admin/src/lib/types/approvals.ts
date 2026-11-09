/**
 * Human approval: what `/api/approvals` and
 * `/api/proposals` return (apps/api/src/routes/approvals.ts).
 */

export type ProposalStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "rejected"
  | "expired";
export type ApprovalMode = "inherit" | "propose" | "direct";
/** What `propose` holds: everything except read-only POSTs, or everything. */
export type ProposeRetention = "selective" | "strict";

export interface ProposalResult {
  status: number | null;
  contentType: string | null;
  body: unknown;
  error: string | null;
}

export interface Proposal {
  id: string;
  status: ProposalStatus;
  reason: "sensitive" | "propose_only";
  channel: "rest" | "mcp";
  method: string;
  path: string;
  tool: string | null;
  operation: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  comment: string | null;
  executedAt: string | null;
  statusUrl: string;
  agentId: string;
  agentName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  /** The agent's human signer (on proposing and, once executed, the one used). */
  sponsorUserId?: string | null;
  sponsorName?: string | null;
  result?: ProposalResult | null;
}

export interface DiffChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ProposalDiff {
  kind: "create" | "update" | "replace" | "delete" | "tool" | "promotion";
  changes?: DiffChange[];
  current?: unknown;
  proposed?: unknown;
  arguments?: unknown;
  currentUnavailable?: number | string;
  /** The code version and a summary of its path. */
  versionId?: string;
  versionNumber?: number;
  target?: { slug: string; name: string; actionId: string | null };
  decision?: { route: string; reasons: string[] } | null;
  tests?: { total: number; passed: number; failed: number; errored: number } | null;
  scan?: { passed: boolean } | null;
}

/** An image held from an upload (the bytes, via `proposalFileUrl`). */
export interface ProposalFile {
  id: string;
  field: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Agent data ledger: one field of a proposal that writes a record. */
export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
  change: "add" | "update" | "remove";
}

export interface FieldDiff {
  target: {
    kind: "create" | "update";
    shape: "entry" | "mcp-record" | "body";
    entity: string | null;
    rowId: string | null;
  };
  fields: FieldChange[];
  currentUnavailable?: number | string;
}

/** What the agent attached to a field (`_evidence`). */
export interface FieldEvidence {
  field: string;
  source: string;
  quote: string | null;
  confidence: number | null;
  retrievedAt: string | null;
}

export interface FieldDecision {
  field: string;
  decision: "accept" | "reject";
  edited: boolean;
  value?: unknown;
}

/** A later review of a decided proposal. */
export interface LedgerReview {
  id: string;
  proposalId: string;
  entity: string | null;
  rowId: string | null;
  fields: string[];
  note: string | null;
  dueAt: string;
  status: "scheduled" | "due" | "done" | "cancelled";
  scheduledBy: string;
  becameDueAt: string | null;
  doneBy: string | null;
  doneAt: string | null;
  doneComment: string | null;
  createdAt: string;
}

export interface ProposalDetail extends Proposal {
  /** Agent data ledger (docs/agents/ledger.md). */
  fieldDiff?: FieldDiff | null;
  evidence?: FieldEvidence[];
  fieldDecisions?: FieldDecision[] | null;
  reviews?: LedgerReview[];
  /** The images of a held upload; empty if it is not one or if they were already deleted. */
  files?: ProposalFile[];
  keyId: string | null;
  body: unknown;
  contentType: string | null;
  idempotencyKey: string | null;
  scopes: string[];
  diff: ProposalDiff | null;
  /** Second opinion of an injection classifier (never decides). */
  injectionCheck?: { label: string; score: number; checkedAt: string } | null;
  konId: string | null;
  operationId: string | null;
  canDecide?: boolean;
  cannotDecideReason?: string | null;
}

export interface LegacyRule {
  method: string;
  path: string;
  /** What an unattended run is told to do instead. */
  alternative?: string;
}

/** In an unattended run: hold the request (202) or refuse it with an alternative (403). */
export type UnattendedMode = "hold" | "deny";

export interface ApprovalConfig {
  /** The MASTER switch: when off, nobody asks for approval. */
  enabled: boolean;
  proposeRetention: ProposeRetention;
  ttlHours: number;
  operations: Record<string, boolean>;
  legacyRules: LegacyRule[];
  unattended?: UnattendedMode;
  unattendedAlternative?: string | null;
  alternatives?: Record<string, string>;
}

export interface ApprovalOperation {
  key: string;
  konId: string;
  kon: string;
  id: string;
  method: string;
  path: string;
  summary: string;
  default: boolean;
  override: boolean | null;
  sensitive: boolean;
  /** A POST that the kon declares read-only (selective holding does not hold it). */
  readOnly?: boolean;
}

export interface ApprovalTool {
  key: string;
  name: string;
  write: boolean;
  default: boolean;
  override: boolean | null;
  sensitive: boolean;
}

export interface ApprovalSettings {
  config: ApprovalConfig;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  modes: ApprovalMode[];
  retentions?: ProposeRetention[];
  operations: ApprovalOperation[];
  mcpTools: ApprovalTool[];
  agents: {
    id: string;
    name: string;
    mode: ApprovalMode;
    unattended?: UnattendedMode | null;
    unattendedAlternative?: string | null;
    isActive: boolean;
  }[];
  unattendedModes?: UnattendedMode[];
  defaultAlternative?: string;
}

export interface ApprovalAuditEvent {
  id: string;
  at: string;
  action: string;
  agentId: string | null;
  agentName: string | null;
  proposalId: string | null;
  resource: string | null;
  by: string | null;
  byName: string | null;
  success: boolean;
  details: Record<string, unknown>;
}
