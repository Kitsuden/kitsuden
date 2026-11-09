/**
 * Agile Service
 * Typed API client for the Agile grimoire
 */

// With VITE_API_URL (panel and API on different origins) a relative path went to the
// panel server and returned its index.html with a 404.
const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/agile`;

// ============== Types ==============

export interface AgileProject {
  id: string;
  key: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  isPublic: boolean;
  defaultIssueStateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgileState {
  id: string;
  projectId: string;
  name: string;
  color: string;
  group: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  order: number;
  isDefault: boolean;
  createdAt: string;
}

export interface AgileIssue {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description?: string;
  type: "story" | "task" | "bug" | "epic" | "subtask";
  priority: "low" | "medium" | "high" | "urgent";
  stateId: string;
  state?: AgileState;
  assigneeId?: string;
  cycleId?: string;
  moduleId?: string;
  parentId?: string;
  estimate?: number;
  dueDate?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgileCycle {
  id: string;
  projectId: string;
  name: string;
  number: number;
  startDate: string;
  endDate: string;
  status: "planned" | "active" | "completed";
  createdAt: string;
  updatedAt: string;
}

export interface AgileModule {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  color?: string;
  status: "planned" | "in_progress" | "paused" | "completed";
  targetDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgileIntake {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  submitterEmail: string;
  submitterName?: string;
  status: "pending" | "approved" | "declined" | "duplicate";
  issueId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgileComment {
  id: string;
  issueId: string;
  authorId: string;
  content: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

// ============== Projects ==============

export async function getAgileProjects(): Promise<AgileProject[]> {
  const res = await fetch(`${API_BASE}/projects`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getAgileProject(
  id: string
): Promise<AgileProject & { states: AgileState[] }> {
  const res = await fetch(`${API_BASE}/projects/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAgileProject(data: Partial<AgileProject>): Promise<AgileProject> {
  const res = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Issues ==============

export async function getAgileIssues(projectId: string): Promise<AgileIssue[]> {
  const res = await fetch(`${API_BASE}/${projectId}/issues`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getAgileIssue(key: string): Promise<AgileIssue> {
  const res = await fetch(`${API_BASE}/issues/${key}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAgileIssue(
  projectId: string,
  data: Partial<AgileIssue>
): Promise<AgileIssue> {
  const res = await fetch(`${API_BASE}/${projectId}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateAgileIssue(
  key: string,
  data: Partial<AgileIssue>
): Promise<AgileIssue> {
  const res = await fetch(`${API_BASE}/issues/${key}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getAgileIssueComments(key: string): Promise<AgileComment[]> {
  const res = await fetch(`${API_BASE}/issues/${key}/comments`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAgileIssueComment(key: string, content: string): Promise<AgileComment> {
  const res = await fetch(`${API_BASE}/issues/${key}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Intakes ==============

export async function getAgileIntakes(projectId: string): Promise<AgileIntake[]> {
  const res = await fetch(`${API_BASE}/${projectId}/intakes`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAgileIntake(
  projectId: string,
  data: Partial<AgileIntake>
): Promise<AgileIntake> {
  const res = await fetch(`${API_BASE}/${projectId}/intakes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function approveAgileIntake(intakeId: string): Promise<AgileIntake> {
  const res = await fetch(`${API_BASE}/intakes/${intakeId}/approve`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function declineAgileIntake(intakeId: string): Promise<AgileIntake> {
  const res = await fetch(`${API_BASE}/intakes/${intakeId}/decline`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function duplicateAgileIntake(intakeId: string): Promise<AgileIntake> {
  const res = await fetch(`${API_BASE}/intakes/${intakeId}/duplicate`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Cycles ==============

export async function getAgileCycles(projectId: string): Promise<AgileCycle[]> {
  const res = await fetch(`${API_BASE}/${projectId}/cycles`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAgileCycle(
  projectId: string,
  data: Partial<AgileCycle>
): Promise<AgileCycle> {
  const res = await fetch(`${API_BASE}/${projectId}/cycles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Modules ==============

export async function getAgileModules(projectId: string): Promise<AgileModule[]> {
  const res = await fetch(`${API_BASE}/${projectId}/modules`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAgileModule(
  projectId: string,
  data: Partial<AgileModule>
): Promise<AgileModule> {
  const res = await fetch(`${API_BASE}/${projectId}/modules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
