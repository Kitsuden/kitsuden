/**
 * @kitsuden/sdk — Universal SDK for Kitsuden
 *
 * The official JavaScript/TypeScript SDK for Kitsuden BaaS.
 * CRUD in 3 lines of code. Edge-ready. Type-safe. Reads JSON and TOON.
 *
 * @example
 * ```typescript
 * import { KitsudenClient } from '@kitsuden/sdk';
 *
 * const kitsuden = new KitsudenClient({
 *   url: 'https://api.example.com',
 *   apiKey: 'kitsuden_agent_xxx'  // Agent NHI token (recommended)
 * });
 *
 * // CRUD via Explorer
 * const games = await kitsuden.from('games').list();
 * const game = await kitsuden.from('games').create({ title: 'New Game' });
 * await kitsuden.from('games').update(game.id, { status: 'published' });
 * await kitsuden.from('games').delete(game.id);
 *
 * // Modules
 * const modules = await kitsuden.modules.list();
 * await kitsuden.modules.toggle('academy');
 *
 * // Schema
 * const schema = await kitsuden.schema('games');
 *
 * // Smaller responses on the wire: the server picks compact JSON or TOON per
 * // response (whichever is shorter and decodes back to the same data). You
 * // still get plain objects back.
 * const lean = new KitsudenClient({ url: '...', apiKey: '...', format: 'auto' });
 * const sameData = await lean.from('games').list();
 * ```
 */

import { decodeToon } from "./toon";

export { decodeToon, encodeToon, ToonDecodeError } from "./toon";

// ═══════════════════════════════════════════════════════════════
// Typed client (generated from the API's OpenAPI 3.1: pnpm sdk:generate)
// ═══════════════════════════════════════════════════════════════

export {
  KitsudenApi,
  createKitsuden,
  expectOk,
  isProposalPending,
  provenanceOf,
  normalizeBaseUrl,
  type KitsudenApiOptions,
  type RawCall,
} from "./api/client";
export {
  KitsudenApiError,
  KitsudenNetworkError,
  KitsudenDecodeError,
  ProposalPendingError,
  isKitsudenError,
} from "./api/errors";
export { decodeTron, TronDecodeError } from "./api/tron";
export { decodeBody, parseProvenance, parseRetryAfter, DEFAULT_RETRY } from "./api/transport";
export { itemsOf } from "./api/pagination";
export { operationSchemas, toStandardSchema } from "./api/standard-schema";
export type { StandardIssue, StandardResult, StandardSchemaV1 } from "./api/standard-schema";
export type {
  CallOptions,
  Format,
  Ok,
  Operation,
  OperationInfo,
  Outcome,
  PageableOperation,
  PaginationInfo,
  Problem,
  Proposal,
  ProposalPending,
  ProposalStatus,
  ProvenanceSummary,
  RecordProvenance,
  RedirectResult,
  ResponseKind,
  ResponseMeta,
  RetryPolicy,
  StreamOperation,
} from "./api/types";
export * from "./generated/index";

// ═══════════════════════════════════════════════════════════════
// Types & Configuration
// ═══════════════════════════════════════════════════════════════

export interface KitsudenClientConfig {
  /** Base URL of your Kitsuden API (e.g., https://api.example.com) */
  url: string;
  /** API Key for authentication (Bearer token) */
  apiKey?: string;
  /**
   * Wire format: 'json' (default), 'toon', or 'auto' (the server sends compact
   * JSON or TOON, whichever is shorter for each response). The client always
   * decodes, so methods return the same objects in every mode.
   */
  format?: ClientFormat;
}

/** Wire formats this SDK can decode (TRON is not one: it would add a dependency). */
export type ClientFormat = "json" | "toon" | "auto";

/** The operators `GET /api/explorer/:table` understands (another one is a 400). */
export type FilterOp = "contains" | "equals" | "gt" | "lt" | "gte" | "lte";

/**
 * The list query of `GET /api/explorer/:table` (apps/api/src/lib/explorer-query.ts).
 * Every condition must hold (AND). A secret column (token, password, hash) cannot be
 * filtered or searched: the API answers 400, as for an unknown operator or column.
 */
export interface ListOptions {
  limit?: number;
  page?: number;
  sort?: string;
  dir?: "asc" | "desc";
  /** Text to find in any textual column (or only in `search_fields`), case-insensitive. */
  search?: string;
  /** Columns the search is limited to (at most 30). */
  search_fields?: string[];
  /**
   * One or more conditions per column: a value (equals) or `{ op: value }`, e.g.
   * `{ status: "draft", created_at: { gte: "2026-01-01" } }` sends
   * `filter[status]=draft&filter[created_at][gte]=2026-01-01`. At most 20 conditions.
   */
  filters?: Record<
    string,
    string | number | boolean | Partial<Record<FilterOp, string | number | boolean>>
  >;
  /** The older single filter, still honoured (combined with `filters` by AND). */
  filter_field?: string;
  filter_op?: FilterOp;
  filter_value?: string;
}

/** One change of a record, as the history routes return it (newest first). */
export interface RecordChange {
  id: string;
  action: "create" | "update" | "delete";
  /** ISO timestamp. */
  at: string;
  actor: { type: "user" | "agent" | "system"; id: string | null; name: string | null };
  /**
   * The fields that changed. A secret column is `{ field, redacted: true }` with no
   * values; a long value is cut to `{ truncated, bytes, preview }`.
   */
  changes: Array<{ field: string; before?: unknown; after?: unknown; redacted?: true }>;
  truncated: boolean;
  /** The approved proposal this write executed, and who approved it (a user id). */
  proposalId: string | null;
  approvedBy: string | null;
}

export interface RecordHistory {
  history: RecordChange[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  columns?: Array<{ field: string; type: string; editable: boolean }>;
}

export interface SchemaInfo {
  table: string;
  label: string;
  primaryKey: string;
  columns: Array<{
    name: string;
    type: string;
    editable: boolean;
    nullable: boolean;
    relatedTable?: string;
  }>;
}

export interface ModuleInfo {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  category: string;
  canToggle: boolean;
}

export interface OptionItem {
  value: string;
  label: string;
}

// ═══════════════════════════════════════════════════════════════
// TOON (the same codec the API uses: ./toon.ts is a byte-identical copy)
// ═══════════════════════════════════════════════════════════════

const TOON_MIME = "application/vnd.toon";
const AUTO_ACCEPT = 'application/vnd.kitsuden.auto; formats="json,toon"';

// ═══════════════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════════════

class HttpClient {
  private baseUrl: string;
  private apiKey?: string;
  private format: ClientFormat;

  constructor(config: KitsudenClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.format = config.format || "json";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    overrideFormat?: ClientFormat
  ): Promise<T> {
    const format = overrideFormat || this.format;
    let url = `${this.baseUrl}/api${path}`;

    // Add format=toon as query param for TOON mode
    if (format === "toon") {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}format=toon`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (format === "toon") {
      headers["Accept"] = TOON_MIME;
    } else if (format === "auto") {
      headers["Accept"] = AUTO_ACCEPT;
    }

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new KitsudenError(
        error.error || error.message || `Request failed: ${res.status}`,
        res.status
      );
    }

    // Handle 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    // Parse response based on content type
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes(TOON_MIME)) {
      const text = await res.text();
      return decodeToon(text) as T;
    }

    return res.json();
  }

  get<T>(path: string, format?: ClientFormat): Promise<T> {
    return this.request<T>("GET", path, undefined, format);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body, "json"); // Always JSON for writes
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body, "json");
  }

  del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path, undefined, "json");
  }
}

// ═══════════════════════════════════════════════════════════════
// Error Class
// ═══════════════════════════════════════════════════════════════

export class KitsudenError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "KitsudenError";
  }
}

// ═══════════════════════════════════════════════════════════════
// Table Reference — Explorer-based CRUD
// ═══════════════════════════════════════════════════════════════

export class TableRef<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private tableName: string,
    private client: HttpClient
  ) {}

  /**
   * List records with pagination, sorting, and filtering.
   * @example
   * const games = await kitsuden.from('games').list();
   * const filtered = await kitsuden.from('games').list({ limit: 10, sort: 'title', dir: 'asc' });
   * const found = await kitsuden.from('games').list({
   *   search: 'zelda',
   *   filters: { status: 'published', released_at: { gte: '2020-01-01' } },
   * });
   */
  async list(options: ListOptions = {}): Promise<ListResponse<T>> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.page) params.set("page", String(options.page));
    if (options.sort) params.set("sort", options.sort);
    if (options.dir) params.set("dir", options.dir);
    if (options.search) params.set("search", options.search);
    if (options.search_fields?.length) params.set("search_fields", options.search_fields.join(","));
    for (const [field, condition] of Object.entries(options.filters ?? {})) {
      if (condition !== null && typeof condition === "object") {
        for (const [op, value] of Object.entries(condition)) {
          if (value !== undefined) params.append(`filter[${field}][${op}]`, String(value));
        }
      } else if (condition !== undefined) params.append(`filter[${field}]`, String(condition));
    }
    if (options.filter_field) params.set("filter_field", options.filter_field);
    if (options.filter_op) params.set("filter_op", options.filter_op);
    if (options.filter_value) params.set("filter_value", options.filter_value);

    const query = params.toString();
    return this.client.get<ListResponse<T>>(
      `/explorer/${this.tableName}${query ? `?${query}` : ""}`
    );
  }

  /**
   * Get a single record by ID.
   * @example
   * const game = await kitsuden.from('games').get('uuid-123');
   */
  async get(id: string): Promise<T> {
    // Explorer doesn't have a single-record GET, so we use filter
    const result = await this.list({ filters: { id }, limit: 1 });
    const record = result.data?.[0];
    if (!record) throw new KitsudenError("Record not found", 404);
    return record;
  }

  /**
   * Create a new record.
   * @example
   * const newGame = await kitsuden.from('games').create({ title: 'New Game', slug: 'new-game' });
   */
  async create(data: Partial<T>): Promise<T> {
    return this.client.post<T>(`/explorer/${this.tableName}`, data);
  }

  /**
   * Update an existing record.
   * @example
   * await kitsuden.from('games').update('uuid-123', { status: 'published' });
   */
  async update(id: string, data: Partial<T>): Promise<T> {
    return this.client.patch<T>(`/explorer/${this.tableName}/${id}`, data);
  }

  /**
   * Delete a record.
   * @example
   * await kitsuden.from('games').delete('uuid-123');
   */
  async delete(id: string): Promise<void> {
    await this.client.del<void>(`/explorer/${this.tableName}/${id}`);
  }

  /**
   * Who created, changed or deleted a record, when, and which fields (newest first).
   * Writes are recorded from the moment the record history exists; a deleted record
   * keeps its history. Admin only (`GET /api/history/:table/:id`), like the explorer.
   * @example
   * const { history } = await kitsuden.from('games').history('uuid-123');
   */
  async history(
    id: string,
    page: { limit?: number; offset?: number } = {}
  ): Promise<RecordHistory> {
    const params = new URLSearchParams();
    if (page.limit) params.set("limit", String(page.limit));
    if (page.offset) params.set("offset", String(page.offset));
    const query = params.toString();
    return this.client.get<RecordHistory>(
      `/history/${this.tableName}/${encodeURIComponent(id)}${query ? `?${query}` : ""}`
    );
  }

  /**
   * Get dropdown options for this table (id → display name pairs).
   * Useful for FK resolution.
   * @example
   * const options = await kitsuden.from('platforms').options();
   */
  async options(): Promise<OptionItem[]> {
    const result = await this.client.get<{ options: OptionItem[] }>(
      `/explorer/${this.tableName}/options`
    );
    return result.options;
  }
}

// ═══════════════════════════════════════════════════════════════
// Collection Reference — DataSets API (backward compat)
// ═══════════════════════════════════════════════════════════════

export class CollectionRef<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private collectionName: string,
    private client: HttpClient
  ) {}

  async get(
    options: { limit?: number; page?: number; status?: string; sort?: string } = {}
  ): Promise<{ docs: T[]; totalDocs: number }> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.page) params.set("page", String(options.page));
    if (options.status) params.set("status", options.status);
    if (options.sort) params.set("sort", options.sort);
    const query = params.toString();
    return this.client.get<{ docs: T[]; totalDocs: number }>(
      `/datasets/${this.collectionName}/entries${query ? `?${query}` : ""}`
    );
  }

  async insert(data: Partial<T>): Promise<T> {
    return this.client.post<T>(`/datasets/slug/${this.collectionName}/entries`, data);
  }
}

// ═══════════════════════════════════════════════════════════════
// Modules API
// ═══════════════════════════════════════════════════════════════

class ModulesAPI {
  constructor(private client: HttpClient) {}

  /** List all modules with their status */
  async list(): Promise<ModuleInfo[]> {
    const result = await this.client.get<{ docs: ModuleInfo[] }>("/modules");
    return result.docs;
  }

  /** Toggle a module on/off */
  async toggle(key: string): Promise<ModuleInfo> {
    return this.client.post<ModuleInfo>(`/modules/${key}/toggle`, {});
  }

  /** Get modules that are currently enabled */
  async enabled(): Promise<ModuleInfo[]> {
    const all = await this.list();
    return all.filter((m) => m.enabled);
  }
}

// ═══════════════════════════════════════════════════════════════
// Main SDK Class
// ═══════════════════════════════════════════════════════════════

export class KitsudenClient {
  private httpClient: HttpClient;

  /** Module management API */
  public readonly modules: ModulesAPI;

  /** Graphify engine — automatic relational APIs (/api/graph) */
  public readonly graph: GraphAPI;

  /**
   * Create a new Kitsuden SDK client.
   *
   * @example
   * // JSON mode (default)
   * const kitsuden = new KitsudenClient({ url: 'http://localhost:3000', apiKey: 'kitsuden_agent_xxx' });
   *
   * // Smaller responses: the server picks compact JSON or TOON per response
   * const agent = new KitsudenClient({ url: 'http://localhost:3000', apiKey: 'kitsuden_agent_xxx', format: 'auto' });
   */
  constructor(config: KitsudenClientConfig) {
    this.httpClient = new HttpClient(config);
    this.modules = new ModulesAPI(this.httpClient);
    this.graph = new GraphAPI(this.httpClient);
  }

  /**
   * Access a table for CRUD operations via the Explorer API.
   * This is the primary way to interact with Kitsuden data.
   *
   * @example
   * const games = await kitsuden.from('games').list();
   * const newGame = await kitsuden.from('games').create({ title: 'Hi' });
   */
  from<T extends Record<string, unknown> = Record<string, unknown>>(table: string): TableRef<T> {
    return new TableRef<T>(table, this.httpClient);
  }

  /**
   * Get schema information for a table.
   * Returns column types, editability, and relation info.
   *
   * @example
   * const schema = await kitsuden.schema('games');
   * console.log(schema.columns); // [{ name: 'title', type: 'text', editable: true }, ...]
   */
  async schema(table: string): Promise<SchemaInfo> {
    return this.httpClient.get<SchemaInfo>(`/explorer/schema/kons/${table}`);
  }

  /**
   * List all available tables.
   *
   * @example
   * const tables = await kitsuden.tables();
   */
  async tables(): Promise<Array<{ key: string; label: string; icon: string; rowCount: number }>> {
    const result = await this.httpClient.get<{ tables: any[] }>("/explorer/tables");
    return result.tables;
  }

  /**
   * Access a dataset collection (backward compatibility).
   * For new code, use `.from()` instead.
   *
   * @deprecated Use `.from(table)` for Explorer API
   */
  collection<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string
  ): CollectionRef<T> {
    return new CollectionRef<T>(name, this.httpClient);
  }

  /**
   * Health check — verify the API is reachable.
   *
   * @example
   * const healthy = await kitsuden.ping();
   */
  async ping(): Promise<boolean> {
    try {
      await this.httpClient.get("/health");
      return true;
    } catch {
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Graph API (Graphify engine — KITSUDEN architecture §3)
// ═══════════════════════════════════════════════════════════════

export interface GraphInfo {
  tables: string[];
  edges: Array<{ from: string; fromColumn: string; to: string; toColumn: string }>;
}

export interface GraphListOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: "asc" | "desc";
  /** Equality filters column=value */
  filters?: Record<string, string>;
}

/**
 * Graphify engine — automatic relational endpoints.
 * JOINs are resolved on the server based on the real PostgreSQL FKs.
 *
 * @example
 * const projects = await kitsuden.graph.related('users', '1', 'projects');
 */
export class GraphAPI {
  constructor(private client: HttpClient) {}

  private query(options: GraphListOptions = {}): string {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.orderBy) params.set("orderBy", options.orderBy);
    if (options.order) params.set("order", options.order);
    for (const [k, v] of Object.entries(options.filters ?? {})) params.set(k, v);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  /** Full graph: exposed tables + FK relations */
  async info(): Promise<GraphInfo> {
    return this.client.get<GraphInfo>("/graph");
  }

  /** Paginated listing of a table */
  async list<T = Record<string, unknown>>(
    table: string,
    options: GraphListOptions = {}
  ): Promise<{ rows: T[]; limit: number; offset: number }> {
    return this.client.get(`/graph/${table}${this.query(options)}`);
  }

  /** Single record by primary key */
  async get<T = Record<string, unknown>>(table: string, id: string): Promise<{ row: T }> {
    return this.client.get(`/graph/${table}/${id}`);
  }

  /** Related rows — automatic JOIN (N:1, 1:N and N:M) */
  async related<T = Record<string, unknown>>(
    table: string,
    id: string,
    relation: string,
    options: GraphListOptions = {}
  ): Promise<{ kind: string; rows: T[]; limit: number; offset: number }> {
    return this.client.get(`/graph/${table}/${id}/${relation}${this.query(options)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Convenience Factory
// ═══════════════════════════════════════════════════════════════

/**
 * Create a Kitsuden client with a simple function call.
 *
 * @example
 * const kitsuden = createClient('http://localhost:3000', 'kitsuden_agent_xxx');
 * const lean = createClient('http://localhost:3000', 'kitsuden_agent_xxx', 'auto');
 */
export function createClient(
  url: string,
  apiKey?: string,
  format: ClientFormat = "json"
): KitsudenClient {
  return new KitsudenClient({ url, apiKey, format });
}

// ═══════════════════════════════════════════════════════════════
// Backward Compatibility
// ═══════════════════════════════════════════════════════════════

/** @deprecated Use KitsudenClient instead */
export const Kitsuden = KitsudenClient;

// ═══════════════════════════════════════════════════════════════
// Default Export
// ═══════════════════════════════════════════════════════════════

export default KitsudenClient;
