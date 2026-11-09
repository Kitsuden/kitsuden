/**
 * Brain Service
 * Service to interact with the KITSUDEN Brain API
 */

import type {
  BrainNote,
  BrainStatus,
  BrainWiki,
  KnowledgeGraph,
  BrainNeighborhood,
} from "$lib/types/brain";

const API = import.meta.env.VITE_API_URL ?? "";
const BASE = `${API}/api/brain`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getBrainStatus(): Promise<BrainStatus> {
  return fetchJson<BrainStatus>(`${BASE}/status`);
}

export async function getBrainGraph(): Promise<KnowledgeGraph> {
  return fetchJson<KnowledgeGraph>(`${BASE}/graph`);
}

export async function getBrainNotes(params: Record<string, string> = {}): Promise<BrainNote[]> {
  const query = new URLSearchParams(params);
  const url = `${BASE}/notes${query.toString() ? `?${query}` : ""}`;
  const data = await fetchJson<BrainNote[] | { docs?: BrainNote[] }>(url);
  return Array.isArray(data) ? data : (data.docs ?? []);
}

export async function getBrainNote(id: string): Promise<BrainNote> {
  return fetchJson<BrainNote>(`${BASE}/notes/${encodeURIComponent(id)}`);
}

export async function getBrainNeighborhood(id: string, depth = 1): Promise<BrainNeighborhood> {
  return fetchJson<BrainNeighborhood>(
    `${BASE}/graph/${encodeURIComponent(id)}/neighborhood?depth=${encodeURIComponent(depth)}`
  );
}

export async function triggerBrainScan(): Promise<{ message?: string; startedAt?: string }> {
  return fetchJson<{ message?: string; startedAt?: string }>(`${BASE}/scan`, {
    method: "POST",
  });
}

export async function getBrainLlmsTxt(): Promise<string> {
  const res = await fetch(`${BASE}/llms.txt`, { credentials: "include" });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || `HTTP ${res.status}`);
  }
  return res.text();
}

export async function getBrainWiki(): Promise<BrainWiki> {
  return fetchJson<BrainWiki>(`${BASE}/wiki`);
}
