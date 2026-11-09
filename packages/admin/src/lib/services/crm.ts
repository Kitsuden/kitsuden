/**
 * CRM Service
 * Typed API client for the CRM grimoire
 */

import type {
  CrmContact,
  CrmCompany,
  CrmPipeline,
  CrmPipelineStage,
  CrmDeal,
  CrmActivity,
  CRMStats,
  KanbanData,
  DealTimelineEntry,
  CrmEntityConfig,
} from "$views/crm/types";

// With VITE_API_URL (panel and API on different origins) a relative path went to the
// panel server and returned its index.html with a 404.
const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/crm`;

// ============== Companies ==============

export async function getCrmCompanies(params?: {
  organizationId?: string;
  industry?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ docs: CrmCompany[]; totalDocs: number }> {
  const query = new URLSearchParams();
  if (params?.organizationId) query.set("organizationId", params.organizationId);
  if (params?.industry) query.set("industry", params.industry);
  if (params?.search) query.set("search", params.search);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));

  const res = await fetch(`${API_BASE}/companies?${query}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmCompany(id: string): Promise<CrmCompany> {
  const res = await fetch(`${API_BASE}/companies/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCrmCompany(data: Partial<CrmCompany>): Promise<CrmCompany> {
  const res = await fetch(`${API_BASE}/companies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateCrmCompany(id: string, data: Partial<CrmCompany>): Promise<CrmCompany> {
  const res = await fetch(`${API_BASE}/companies/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteCrmCompany(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/companies/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Contacts ==============

export async function getCrmContacts(params?: {
  companyId?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ docs: CrmContact[]; totalDocs: number }> {
  const query = new URLSearchParams();
  if (params?.companyId) query.set("companyId", params.companyId);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));

  const res = await fetch(`${API_BASE}/contacts?${query}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmContact(id: string): Promise<CrmContact> {
  const res = await fetch(`${API_BASE}/contacts/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCrmContact(data: Partial<CrmContact>): Promise<CrmContact> {
  const res = await fetch(`${API_BASE}/contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateCrmContact(id: string, data: Partial<CrmContact>): Promise<CrmContact> {
  const res = await fetch(`${API_BASE}/contacts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteCrmContact(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/contacts/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Pipelines ==============

export async function getCrmPipelines(): Promise<CrmPipeline[]> {
  const res = await fetch(`${API_BASE}/pipelines`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmPipeline(
  id: string
): Promise<CrmPipeline & { stages: CrmPipelineStage[] }> {
  const res = await fetch(`${API_BASE}/pipelines/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCrmPipeline(data: Partial<CrmPipeline>): Promise<CrmPipeline> {
  const res = await fetch(`${API_BASE}/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateCrmPipeline(
  id: string,
  data: Partial<CrmPipeline>
): Promise<CrmPipeline> {
  const res = await fetch(`${API_BASE}/pipelines/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteCrmPipeline(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pipelines/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Deals ==============

export async function getCrmDeals(params?: {
  pipelineId?: string;
  stageId?: string;
  status?: string;
  contactId?: string;
  companyId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ docs: CrmDeal[]; totalDocs: number }> {
  const query = new URLSearchParams();
  if (params?.pipelineId) query.set("pipelineId", params.pipelineId);
  if (params?.stageId) query.set("stageId", params.stageId);
  if (params?.status) query.set("status", params.status);
  if (params?.contactId) query.set("contactId", params.contactId);
  if (params?.companyId) query.set("companyId", params.companyId);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));

  const res = await fetch(`${API_BASE}/deals?${query}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmDeal(id: string): Promise<CrmDeal> {
  const res = await fetch(`${API_BASE}/deals/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCrmDeal(data: Partial<CrmDeal>): Promise<CrmDeal> {
  const res = await fetch(`${API_BASE}/deals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateCrmDeal(id: string, data: Partial<CrmDeal>): Promise<CrmDeal> {
  const res = await fetch(`${API_BASE}/deals/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteCrmDeal(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/deals/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function moveCrmDeal(id: string, stageId: string): Promise<CrmDeal> {
  const res = await fetch(`${API_BASE}/deals/${id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ stageId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmDealTimeline(id: string): Promise<DealTimelineEntry[]> {
  const res = await fetch(`${API_BASE}/deals/${id}/timeline`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Activities ==============

export async function getCrmActivities(params?: {
  contactId?: string;
  companyId?: string;
  dealId?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<{ docs: CrmActivity[]; totalDocs: number }> {
  const query = new URLSearchParams();
  if (params?.contactId) query.set("contactId", params.contactId);
  if (params?.companyId) query.set("companyId", params.companyId);
  if (params?.dealId) query.set("dealId", params.dealId);
  if (params?.type) query.set("type", params.type);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));

  const res = await fetch(`${API_BASE}/activities?${query}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmActivity(id: string): Promise<CrmActivity> {
  const res = await fetch(`${API_BASE}/activities/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCrmActivity(data: Partial<CrmActivity>): Promise<CrmActivity> {
  const res = await fetch(`${API_BASE}/activities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateCrmActivity(
  id: string,
  data: Partial<CrmActivity>
): Promise<CrmActivity> {
  const res = await fetch(`${API_BASE}/activities/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function completeCrmActivity(id: string): Promise<CrmActivity> {
  const res = await fetch(`${API_BASE}/activities/${id}/complete`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteCrmActivity(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/activities/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Kanban & Stats ==============

export async function getCrmKanban(pipelineId: string): Promise<KanbanData> {
  const res = await fetch(`${API_BASE}/pipelines/${pipelineId}/kanban`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCrmStats(): Promise<CRMStats> {
  const res = await fetch(`${API_BASE}/stats`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Entity Configs ==============

export async function getCrmEntityConfigs(): Promise<CrmEntityConfig[]> {
  const res = await fetch(`${API_BASE}/entity-configs`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
