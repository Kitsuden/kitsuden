/**
 * Code promotion: versions, decisions, rollback and
 * settings. The API is in apps/api/src/routes/promotion.ts; the guide in
 * docs/agents/promotion.md.
 */

import type {
  CodeVersion,
  CodeVersionDetail,
  PromotionConfig,
  PromotionMode,
  PromotionSettings,
  VersionStatus,
} from "$lib/types/promotion";

const ROOT = import.meta.env.VITE_API_URL ?? "";
const BASE = `${ROOT}/api/approvals/promotion`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    const detail = error?.error && typeof error.error === "object" ? error.error.message : null;
    throw new Error(
      detail ||
        error.message ||
        error.detail ||
        (typeof error.error === "string" ? error.error : "") ||
        `HTTP ${res.status}`
    );
  }
  return res.json();
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function getPromotionSettings(): Promise<PromotionSettings> {
  return fetchJson(`${BASE}/settings`);
}

export function savePromotionSettings(
  change: Partial<PromotionConfig>
): Promise<PromotionSettings> {
  return fetchJson(`${BASE}/settings`, { method: "PUT", ...json(change) });
}

export function setAgentPromotionMode(
  agentId: string,
  mode: PromotionMode
): Promise<{ agentId: string; mode: PromotionMode; previous: string }> {
  return fetchJson(`${BASE}/agents/${agentId}/mode`, { method: "PUT", ...json({ mode }) });
}

export function listCodeVersions(
  filter: { status?: VersionStatus | ""; slug?: string; agentId?: string; limit?: number } = {}
): Promise<{ versions: CodeVersion[] }> {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.slug) q.set("slug", filter.slug);
  if (filter.agentId) q.set("agentId", filter.agentId);
  if (filter.limit) q.set("limit", String(filter.limit));
  const qs = q.toString();
  return fetchJson(`${BASE}/versions${qs ? `?${qs}` : ""}`);
}

export function getCodeVersion(id: string): Promise<CodeVersionDetail> {
  return fetchJson(`${BASE}/versions/${id}`);
}

export function approveCodeVersion(id: string, comment?: string): Promise<CodeVersionDetail> {
  return fetchJson(`${BASE}/versions/${id}/approve`, {
    method: "POST",
    ...json(comment ? { comment } : {}),
  });
}

export function rejectCodeVersion(id: string, comment?: string): Promise<CodeVersionDetail> {
  return fetchJson(`${BASE}/versions/${id}/reject`, {
    method: "POST",
    ...json(comment ? { comment } : {}),
  });
}

export function rollbackCodeVersion(id: string, reason: string): Promise<CodeVersionDetail> {
  return fetchJson(`${BASE}/versions/${id}/rollback`, { method: "POST", ...json({ reason }) });
}

export function activateCodeVersion(id: string): Promise<CodeVersionDetail> {
  return fetchJson(`${BASE}/versions/${id}/activate`, { method: "POST" });
}
