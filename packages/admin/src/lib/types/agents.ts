/**
 * Agent Types
 * Types for the AI agents system
 */

// ============== Base Types ==============

export type AgentStatus = "active" | "paused" | "error";
/** The API's `agent_trace_status` enum. There is no `completed`: a finished trace is `success`. */
export type TraceStatus = "pending" | "running" | "success" | "error" | "cancelled";
/** The API's `agent_trace_step_type` enum, plus the two the timeline also draws. */
export type StepType =
  | "llm_call"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "retrieval"
  | "memory_read"
  | "memory_write"
  | "user_input"
  | "system"
  | "error";

// ============== Agent ==============

export interface Agent {
  id: string;
  name: string;
  description?: string;
  identityId?: string;
  /** `custom`, `claude-desktop`…: what the API has instead of a model. */
  type?: string;
  /** Not a column: read from the prompt's `Model:` line when the agent has one. */
  model?: string;
  config?: Record<string, unknown>;
  /** Both derived from the API's `isActive` (services/agent-mappers.ts). */
  enabled: boolean;
  status: AgentStatus;
  tokenHash?: string;
  createdAt: string;
  updatedAt: string;
  // Aggregated data
  totalTraces?: number;
  totalTokens?: number;
  lastActiveAt?: string;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  identityId?: string;
  model: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  scopes?: string[];
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  identityId?: string;
  model?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  status?: AgentStatus;
}

// ============== Agent Identity ==============

export interface AgentIdentity {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

// ============== Agent Trace ==============

export interface AgentTrace {
  id: string;
  agentId: string;
  agentName?: string;
  sessionId?: string;
  status: TraceStatus;
  tokensIn?: number;
  tokensOut?: number;
  /** `tokensIn + tokensOut`: the API sends them per direction. */
  totalTokens: number;
  totalDurationMs: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Expanded
  steps?: AgentTraceStep[];
}

// ============== Agent Trace Step ==============

export interface AgentTraceStep {
  id: string;
  traceId: string;
  stepOrder?: number;
  stepType: StepType;
  content?: string | null;
  reasoning?: string | null;
  toolName?: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  errorMessage?: string | null;
  createdAt: string;
}

// ============== API Request/Response Types ==============

export interface CreateAgentResponse {
  agent: Agent;
  token: string;
}

export interface ListTracesResponse {
  traces: AgentTrace[];
  total: number;
  limit: number;
  offset: number;
}

export interface PlaygroundMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface PlaygroundRequest {
  messages: PlaygroundMessage[];
}

export interface PlaygroundResponse {
  message: string;
  traceId?: string;
  metadata?: {
    tokensIn: number;
    tokensOut: number;
    duration: number;
    toolCalls: string[];
  };
}

// ============== Component Props ==============

export interface TimelineProps {
  steps: AgentTraceStep[];
  class?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: {
    tokensIn?: number;
    tokensOut?: number;
    duration?: number;
    toolCalls?: string[];
  };
}

export interface ChatInterfaceProps {
  messages: ChatMessage[];
  loading?: boolean;
  agentName?: string;
  onSend: (message: string) => void;
}

// ============== Permissions, keys and quotas ==============

export interface AccessOperation {
  konId: string;
  kon: string;
  id: string;
  /** `kon:<kon>:<op>` */
  scope: string;
  method: string;
  path: string;
  summary: string;
  sensitive: boolean;
  cost: number;
  write: boolean;
  public: boolean;
}

export interface AccessCatalog {
  presets: { id: string; scopes: readonly string[] }[];
  broad: { scope: string; operations: string[]; datasets: string[] }[];
  kons: { konId: string; kon: string; operations: AccessOperation[] }[];
  legacyKons: { konId: string; kon: string; mountPath: string }[];
  datasets: { slug: string; name: string }[];
  datasetActions: ("read" | "write" | "delete")[];
}

/** granted: a scope opens it · denied: a denial closes it · open: no permission · policy: decided by the policy · none */
export type AccessState = "granted" | "denied" | "open" | "policy" | "none";

export interface AgentAccess {
  agentId: string;
  scopes: string[];
  grants: string[];
  denies: string[];
  broad: { scope: string; known: boolean }[];
  operations: (AccessOperation & { state: AccessState; by: string | null })[];
  datasets: ({ slug: string; name: string } & Record<
    "read" | "write" | "delete",
    { state: AccessState; by: string | null }
  >)[];
}

export interface AgentApiKey {
  id: string;
  name: string | null;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  rotatedFrom: string | null;
  status: "active" | "expiring" | "expired" | "revoked";
}

export interface AgentQuotaLimits {
  requestsPerMinute: number | null;
  writesPerDay: number | null;
  budgetUnitsPerDay: number | null;
}

export interface AgentQuotas {
  limits: AgentQuotaLimits;
  usage: {
    day: string;
    requestsThisMinute: number;
    writesToday: number;
    unitsToday: number;
    store: "valkey" | "postgres" | "memory";
  };
  /** Savings of the auto format versus compact JSON (null if migration 0052 is missing). */
  formatSavings?: AgentFormatSavings | null;
}

export interface AgentFormatSavingsSummary {
  responses: number;
  compacted: number;
  jsonBytes: number;
  sentBytes: number;
  savedBytes: number;
  jsonTokensEst: number;
  sentTokensEst: number;
  savedTokensEst: number;
  savedPercent: number;
}

export interface AgentFormatSavings {
  day: string;
  today: AgentFormatSavingsSummary;
  period: AgentFormatSavingsSummary & { days: number };
  daily: (AgentFormatSavingsSummary & { day: string })[];
}

export type UntrustedWrap = "none" | "delimiters" | "object";

/** MCP settings of an agent (routes/agent-permissions.ts). */
export interface AgentMcpSettings {
  settings: { toolset: string | null; untrustedWrap: UntrustedWrap };
  options: { toolsets: string[]; kons: string[]; untrustedWrap: UntrustedWrap[] };
}

/** An agent's human signer (routes/agent-permissions.ts). */
export interface AgentSponsor {
  sponsor: {
    userId: string;
    valid: boolean;
    reason: "not_found" | "not_staff" | null;
    name: string | null;
    email: string | null;
    role: string | null;
  } | null;
  candidates: { id: string; name: string; email: string; role: string }[];
}
