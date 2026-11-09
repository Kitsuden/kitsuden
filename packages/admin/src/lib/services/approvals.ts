/**
 * Human approval: inbox, decisions, settings and audit.
 * The API is in apps/api/src/routes/approvals.ts; the guide in
 * docs/agents/approvals.md.
 */

import type {
  ApprovalAuditEvent,
  ApprovalConfig,
  ApprovalMode,
  ApprovalSettings,
  LedgerReview,
  Proposal,
  ProposalDetail,
  ProposalStatus,
  UnattendedMode,
} from "$lib/types/approvals";

/** Field by field and a later review (docs/agents/ledger.md). */
export interface DecisionExtra {
  fields?: { field: string; decision: "accept" | "reject"; value?: unknown }[];
  reviewAt?: string;
  reviewNote?: string;
}

const ROOT = import.meta.env.VITE_API_URL ?? "";
const BASE = `${ROOT}/api/approvals`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.detail || error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function listProposals(
  filter: { status?: ProposalStatus | ""; agentId?: string; limit?: number; offset?: number } = {}
): Promise<{ total: number; proposals: Proposal[] }> {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.agentId) q.set("agentId", filter.agentId);
  if (filter.limit) q.set("limit", String(filter.limit));
  if (filter.offset) q.set("offset", String(filter.offset));
  const qs = q.toString();
  return fetchJson(`${BASE}/proposals${qs ? `?${qs}` : ""}`);
}

export async function countPendingProposals(): Promise<number> {
  const r = await fetchJson<{ pending: number }>(`${BASE}/proposals/count`);
  return r.pending;
}

export function getProposal(id: string): Promise<ProposalDetail> {
  return fetchJson(`${BASE}/proposals/${id}`);
}

/**
 * The thumbnail of a held image, as a `blob:` URL (the route requires the
 * team's session and the API may be on another origin: a direct `<img src>`
 * does not always carry the cookie). Whoever requests it releases it with
 * `URL.revokeObjectURL`.
 */
export async function proposalFileUrl(proposalId: string, fileId: string): Promise<string> {
  const res = await fetch(`${BASE}/proposals/${proposalId}/files/${fileId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

export function approveProposal(
  id: string,
  comment?: string,
  extra: DecisionExtra = {}
): Promise<{ proposal: ProposalDetail }> {
  return fetchJson(`${BASE}/proposals/${id}/approve`, {
    method: "POST",
    ...json({ ...(comment ? { comment } : {}), ...extra }),
  });
}

export function rejectProposal(
  id: string,
  comment?: string,
  extra: Omit<DecisionExtra, "fields"> = {}
): Promise<{ proposal: ProposalDetail }> {
  return fetchJson(`${BASE}/proposals/${id}/reject`, {
    method: "POST",
    ...json({ ...(comment ? { comment } : {}), ...extra }),
  });
}

export function scheduleReview(
  proposalId: string,
  body: { reviewAt: string; note?: string; fields?: string[] }
): Promise<{ review: LedgerReview }> {
  return fetchJson(`${BASE}/proposals/${proposalId}/review`, { method: "POST", ...json(body) });
}

export function listReviews(
  filter: { status?: "due" | "scheduled" | "done" | "cancelled" | "all"; limit?: number } = {}
): Promise<{ total: number; due: number; reviews: LedgerReview[] }> {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.limit) q.set("limit", String(filter.limit));
  const qs = q.toString();
  return fetchJson(`${BASE}/reviews${qs ? `?${qs}` : ""}`);
}

export function closeReview(
  id: string,
  body: { comment?: string; cancel?: boolean } = {}
): Promise<{ review: LedgerReview }> {
  return fetchJson(`${BASE}/reviews/${id}/done`, { method: "POST", ...json(body) });
}

export function getApprovalSettings(): Promise<ApprovalSettings> {
  return fetchJson(`${BASE}/settings`);
}

/** Partial change; in `operations`, `null` goes back to what the kon declares. */
export function saveApprovalSettings(
  change: Partial<Omit<ApprovalConfig, "operations">> & {
    operations?: Record<string, boolean | null>;
  }
): Promise<ApprovalSettings> {
  return fetchJson(`${BASE}/settings`, { method: "PUT", ...json(change) });
}

export function setAgentApprovalMode(
  agentId: string,
  mode: ApprovalMode
): Promise<{ agentId: string; mode: ApprovalMode; previous: string }> {
  return fetchJson(`${BASE}/agents/${agentId}/mode`, { method: "PUT", ...json({ mode }) });
}

/** What this agent's unattended runs do with a request that would be held (null = global). */
export function setAgentUnattended(
  agentId: string,
  change: { mode?: UnattendedMode | null; alternative?: string | null }
): Promise<{ agentId: string; mode: UnattendedMode | null; alternative: string | null }> {
  return fetchJson(`${BASE}/agents/${agentId}/unattended`, { method: "PUT", ...json(change) });
}

export function listApprovalAudit(
  filter: { agentId?: string; proposalId?: string; limit?: number } = {}
): Promise<{ total: number; events: ApprovalAuditEvent[] }> {
  const q = new URLSearchParams();
  if (filter.agentId) q.set("agentId", filter.agentId);
  if (filter.proposalId) q.set("proposalId", filter.proposalId);
  if (filter.limit) q.set("limit", String(filter.limit));
  const qs = q.toString();
  return fetchJson(`${BASE}/audit${qs ? `?${qs}` : ""}`);
}
