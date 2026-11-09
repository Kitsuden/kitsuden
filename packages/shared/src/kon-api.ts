/**
 * Kitsuden — Kon API (Contracts for Self-Contained Kons)
 *
 * This module defines the abstractions that let kons
 * be completely independent of the application core.
 *
 * Kons receive an injected context instead of importing
 * dependencies directly from apps/api/src/
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INJECTION FLOW:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. Module Loader (apps/api/src/lib/module-loader.ts)
 *      ↓ Creates context with all the dependencies
 *   2. KonContext (interface)
 *      ↓ Injected into each kon
 *   3. createKonRouter() (factory)
 *      ↓ Returns a configured Hono router
 *   4. Mounted at /api/{kon-id}
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * USAGE EXAMPLE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   // In a kon:
 *   export const kon = {
 *     id: "blog",
 *     createRouter: (ctx: KonContext) => {
 *       const router = new Hono();
 *
 *       router.get("/", async (c) => {
 *         const posts = await ctx.db.select().from(blogPosts);
 *         return c.json(posts);
 *       });
 *
 *       return router;
 *     }
 *   };
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ZodTypeAny } from "zod";

import type { KonOperation } from "./operations";

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCY TYPES (Abstractions)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cache abstraction for kons
 */
export interface KonCache {
  /** Get a value from the cache */
  get<T = any>(key: string): Promise<T | null>;
  /** Store a value in the cache with optional TTL (seconds) */
  set<T = any>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /** Invalidate cache by pattern (e.g. "blog:*") */
  invalidate(pattern: string): Promise<void>;
}

/**
 * Events abstraction for kons
 */
export interface KonEvents {
  /** Emit an event for workers/webhooks */
  emit(event: string, data: unknown): void;
  /** Listen for an event (for internal processing) */
  on(event: string, handler: (data: unknown) => void): void;
}

/**
 * Realtime abstraction for kons
 */
export interface KonRealtime {
  /** Broadcast a message to all connected clients */
  broadcast(channel: string, message: unknown): void;
  /** Send to a specific user */
  sendToUser(userId: string, message: unknown): void;
}

/**
 * Authentication abstraction for kons
 */
export interface KonAuth {
  /** Middleware that requires authentication */
  requireAuth: MiddlewareHandler;
  /** Middleware that requires specific roles */
  requireRole: (roles: string[]) => MiddlewareHandler;
  /** Optional middleware (sets the user if present) */
  optionalAuth: MiddlewareHandler;
  /** Get the current session of the request */
  getSession(headers: Headers): Promise<{ user: any; session: any } | null>;
  /**
   * Who those accounts are: only the PUBLIC part of each, nothing more.
   *
   * A kon cannot read `auth_users`: it belongs to the host, and the isolation
   * rule exists so that a kon does not depend on tables that are not its own.
   * But the blog needs to sign what it publishes, and it only stored the id: the
   * entry appeared with no author across the whole site.
   *
   * That is why it asks instead of reading. It returns `name` and `image` and NEVER
   * the email or the role: a byline needs no more, and what is not returned
   * cannot leak through a public response.
   *
   * Ids that do not exist simply do not appear in the map.
   */
  usersById(
    ids: string[]
  ): Promise<Map<string, { id: string; name: string; image: string | null }>>;
}

/**
 * Storage abstraction (S3/MinIO) for kons
 */
export interface KonStorage {
  /**
   * Store an object. It is the normal upload operation.
   *
   * Before, only the signed-URL ones existed, which let the BROWSER
   * upload straight to the bucket. When the file is already on the server —the case
   * of `POST /api/media/upload`— asking itself for a URL to forward it
   * is an extra round trip, and with local disk storage there is nobody to
   * sign anything for: that was why no upload worked.
   */
  put(
    key: string,
    content: Buffer,
    contentType: string
  ): Promise<{ key: string; url: string; bytes: number }>;
  /** Public URL of an already stored object. Synchronous: it queries nothing. */
  publicUrl(key: string): string;
  /**
   * Signed URL for the client to upload directly to the bucket.
   *
   * It only makes sense with S3/MinIO. With local storage it throws, instead of
   * returning an empty string that would blow up later and farther away.
   */
  getSignedUploadUrl(key: string, contentType: string, expiresIn?: number): Promise<string>;
  /** Generate a public/signed URL for download */
  getSignedDownloadUrl(key: string, expiresIn?: number): Promise<string>;
  /** Delete an object. It not existing is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Read a whole object; `null` if it does not exist. Works the same with local disk
   * and with S3 (locally, `getSignedDownloadUrl` is a relative path that the
   * server can neither request nor tell whether the file exists).
   */
  get(key: string): Promise<Buffer | null>;
  /**
   * Keys of all objects that start with `prefix` (empty if there are
   * none). Used by `DELETE /api/media/cache/:id` to delete the stored
   * transformations of an image: it used to call a `list` that
   * no store implemented and always responded 500.
   */
  list(prefix: string): Promise<string[]>;
}

/**
 * Database abstraction for kons
 *
 * NOTE: Instead of abstracting all of Drizzle, we provide
 * the direct instance since kons define their own schemas.
 */
/**
 * The Drizzle client a kon receives.
 *
 * WHY IT IS GENERIC
 *
 * `instance: any` is the widest-reaching `any` in the project: ALL kons
 * inherit it and from there typing switches off in cascade — every
 * `db.select()` returns `any` and that `any` propagates to the results.
 *
 * The real Drizzle type cannot be imported here: `@kitsuden/shared` is a
 * publishable package and must not drag in the ORM, and besides pnpm may resolve
 * drizzle-orm into different instances, so the imported type would not be
 * the same as the host's.
 *
 * The way out is a generic parameter with a permissive default. The default
 * keeps existing kons working, and whoever wants real typing
 * gets it back IN FULL by declaring their own type, as kon-conta and
 * kon-newsletter do:
 *
 * ```ts
 * import type { PgDatabase } from "drizzle-orm/pg-core";
 * import * as schema from "./mi.schema";
 * type MiDb = PgDatabase<any, typeof schema, any>;
 *
 * export function createRouter(ctx: KonContext<MiDb>) {
 *   const db = ctx.db.instance;      // ← fully typed, no casts
 * }
 * ```
 *
 * Migrating a kon is a local change: it does not touch the host or the other kons.
 */
export interface KonDatabase<TInstance = any> {
  /**
   * Drizzle instance OF THE REQUEST.
   *
   * Inside a kon route it is the RLS transaction the host opens
   * for each request (`app.current_user_id` / `app.current_user_role`
   * set with `set_config(..., true)`): Postgres applies the policies to everything
   * read or written through it. Outside a request (startup,
   * `onStartup`, background tasks) it is the system connection.
   *
   * `instance.transaction(fn)` inside a route opens a SAVEPOINT of that
   * same transaction: same user, same connection.
   */
  instance: TInstance;
  /**
   * Runs `fn` as the SYSTEM (no user or role) inside the
   * request's transaction, and restores the context when done.
   *
   * For what a route does on behalf of others and the asker's RLS
   * does not allow —recounting other people's votes, signing up an anonymous user, processing a
   * webhook—, and ONLY after having authorized the action in the application.
   * Outside a request it runs `fn` as is (it is already the system).
   *
   * Optional in the type so as not to break hosts or test doubles that do not
   * provide it; the Kitsuden host always does.
   */
  asSystem?<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` OUTSIDE the request's transaction, with the system connection.
   * For work that outlives the response: a `void task()`
   * that is launched and not awaited, a timer, a live session.
   *
   * It is needed because the request's transaction is committed on responding:
   * a query launched inside it and executed afterwards would go to a
   * connection that was already returned to the pool (and may be serving someone
   * else). Inside `fn`, `instance` always resolves to the global `db`.
   */
  background?<T>(fn: () => T): T;
  /** Helper to run raw SQL */
  execute(sql: string): Promise<unknown>;
  /** Check whether a table exists */
  tableExists(tableName: string): Promise<boolean>;
}

/**
 * Content Publishing abstraction for kons
 *
 * Lets data from any source be promoted to Content Targets
 * (Blog, Documentation, Shop, etc.) provided by primary kons.
 */

/** Data source for content promotion */
export type PromotionSource = {
  type: "dataset" | "kon";
  konId?: string;
  table?: string;
  recordId: string;
  data: Record<string, any>;
};

/** Content promotion options */
export interface PromotionOptions {
  title?: string;
  slug?: string;
  autoPublish?: boolean;
  scheduledAt?: Date;
  authorId?: string;
  targetConfig?: Record<string, any>;
}

/** Data to promote content to a target */
export interface PromotionData {
  source: PromotionSource;
  options: PromotionOptions;
}

/** Content publishing result */
export interface PublishResult {
  contentId: string;
  targetId: string;
  slug: string;
  url: string;
  status: string;
  createdAt: Date;
}

export interface ContentTargetInfo {
  id: string;
  name: string;
  konId: string;
  capabilities: {
    supportsSeo: boolean;
    supportsScheduling: boolean;
    supportsEditorial: boolean;
    supportsTaxonomy: boolean;
    supportsMedia: boolean;
  };
}

export interface ContentTarget {
  id: string;
  name: string;
  konId: string;
  capabilities: ContentTargetInfo["capabilities"];
  publish(data: PromotionData, ctx: KonContext): Promise<PublishResult>;
  getPublishedUrl(result: PublishResult): string;
  unpublish?(contentId: string, ctx: KonContext): Promise<void>;
  update?(contentId: string, data: Partial<PromotionData>, ctx: KonContext): Promise<PublishResult>;
  getStatus?(contentId: string, ctx: KonContext): Promise<string>;
}

export interface KonContentPublishing {
  /** Get all available targets */
  getAvailableTargets(): ContentTargetInfo[];

  /** Check whether a target is available */
  hasTarget(targetId: string): boolean;

  /**
   * Register a Content Target (used by primary kons)
   */
  register(target: ContentTarget): void;

  /**
   * Unregister a Content Target (used by primary kons)
   */
  unregister(targetId: string): void;

  /**
   * Promote content to a target
   * @throws Error if the target does not exist
   */
  promote(targetId: string, data: PromotionData): Promise<PublishResult>;

  /** Unpublish content */
  unpublish(targetId: string, contentId: string): Promise<void>;

  /** Get the public URL of promoted content */
  getPublishedUrl(targetId: string, result: PublishResult): string;
}

/**
 * Full context injected into each kon
 */
export interface KonContext<TDb = any> {
  /** Database (Drizzle). Generic: `KonContext<MyDb>` gives real types. */
  db: KonDatabase<TDb>;
  /** Cache (Valkey/Redis) */
  cache: KonCache;
  /** Event system */
  events: KonEvents;
  /** Realtime/WebSockets */
  realtime: KonRealtime;
  /** Authentication */
  auth: KonAuth;
  /** File storage */
  storage: KonStorage;
  /** Content Publishing API */
  contentPublishing: KonContentPublishing;
  /** Structured logger */
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
  /** Site configuration */
  config: {
    siteName: string;
    siteUrl: string;
    environment: "development" | "production" | "test";
  };

  /**
   * Settings the active grimoire declares for each kon (`konConfig` in
   * `grimoire.json`), indexed by kon id.
   *
   * It is what lets a grimoire have an OPINION without forking the kon: the
   * same `kon-broadcast` starts configured for fighting games in an FGC
   * grimoire and for something else in another. Without this, `konConfig` was only seen in the
   * admin panel and changed nobody's behavior.
   *
   * Optional on purpose: with no active grimoire, each kon uses its defaults.
   * A kon must NEVER require an entry to exist here.
   */
  konConfig?: Record<string, Record<string, unknown>>;

  /**
   * The PUBLIC site as configured in the panel (General settings
   * → Site URL), read live.
   *
   * It is NOT `config.siteUrl`: that one is used by kon-newsletter and kon-broadcast as
   * the API origin (`…/api/newsletter/portal.js`, the agent's `--url`), and
   * pointing it at the frontend would break them. This is the address the
   * visitor sees — the one the wikis' subdomains hang from, for example.
   *
   * Optional: a context without it (tests, tooling) must fall back to `SITE_URL`.
   */
  site?: {
    publicUrl(): Promise<string>;
  };

  /**
   * Runs a message through one of the core's agent identities: its model, its scopes, its allowed tools,
   * human approval and traces, exactly as from the panel. A kon cannot widen any of that: `allowedTools` and
   * `toolset` only NARROW what the agent already has (the intersection), never add to it.
   *
   * Optional: a host without an agent engine, or a test, leaves it undefined, and a kon must say so plainly
   * instead of failing.
   */
  agents?: {
    run(options: KonAgentRun): Promise<KonAgentResult>;
  };

  /**
   * Embeddings from the provider the core is configured with. `null` when there is no real provider:
   * a kon must not search with made-up vectors.
   */
  ai?: {
    embed(texts: string[]): Promise<number[][] | null>;
  };
}

export interface KonAgentRun {
  /** The core agent identity that answers. */
  agentId: string;
  message: string;
  /** Continues a conversation the engine already knows. */
  sessionId?: string;
  /** Earlier turns, oldest first, when the kon keeps the conversation itself. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Extra context for this turn only (what a search found), placed before the message. */
  context?: string;
  /** Only these tools, of those the agent may use. */
  allowedTools?: string[];
  /** Only the tools of these toolsets: `kon:<id>` or `kon:<id>/<set>`, comma-separated. */
  toolset?: string;
  /** Hears the run as it happens: text as it is written, each tool call, its result and any approval it waits for. */
  onEvent?: (event: KonAgentEvent) => void;
}

export type KonAgentEvent =
  | { type: "step-start" }
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool-result";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      pendingApproval?: { proposalId: string };
    }
  | { type: "step-finish" };

export interface KonAgentResult {
  response: string;
  sessionId: string;
  traceId: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Each tool it called, whether it worked, and the proposal a person must approve when it was held. */
  toolCalls: Array<{ name: string; ok: boolean; pendingApproval?: { proposalId: string } }>;
}

/**
 * Reads a setting the active grimoire declares for a kon.
 *
 * Returns `undefined` if there is no grimoire, if it does not configure that kon or if the
 * value is not of the expected type — the three cases mean the same to whoever
 * calls ("use your default") and telling them apart would only invite treating an absent
 * configuration as an error.
 *
 * The manifest is a JSON that whoever packages the grimoire can edit, so
 * the type is checked at runtime: a `gameProfile: 42` cannot slip through
 * to the point where an id is expected.
 */
export function konSetting<T extends string | number | boolean>(
  ctx: Pick<KonContext, "konConfig">,
  konId: string,
  key: string,
  kind: "string" | "number" | "boolean" = "string"
): T | undefined {
  const value = ctx.konConfig?.[konId]?.[key];
  return typeof value === kind ? (value as T) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORIES Y HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Type for the router-creating function.
 *
 * The `Env` is left open on purpose, and it is the only justified `any` in this
 * contract. A kon can type its own `Variables` —`new Hono<KonEnv>()`,
 * so that `c.get("user")` has a type instead of being cast— and the host only
 * needs to know that what it receives is a Hono router in order to mount it.
 *
 * Closing it to a parameterless `Hono` would force every kon to cast its router when
 * returning it, which is moving the `any` from a well-typed place to a worse one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance boundary: see above
export type KonRouterFactory = (ctx: KonContext) => Hono<any>;

/**
 * Request limit declared by a kon for one of its routes.
 *
 * The path is RELATIVE to the `mountPath`: a kon must not know where it ends up
 * mounted, and this way the limit follows the kon even if it is remounted elsewhere.
 */
export interface KonRateLimit {
  /** Sub-path relative to the mountPath. Supports Hono wildcards: "/webhook/*". */
  path: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window in seconds. */
  window: number;
  /** Message when exceeded. */
  message?: string;
  /**
   * Deny if the counter is unavailable (Valkey down).
   *
   * For a route that sends email or moves money, being left without a brake is worse
   * than rejecting the request. Defaults to `false`.
   */
  failClosed?: boolean;
}

/**
 * Full interface of a self-contained Kon
 */
export interface KonDefinition {
  /** Unique kon ID */
  id: string;
  /** Display name */
  name: string;
  /** Semver version */
  version: string;
  /** Description */
  description?: string;
  /** Icon (Lucide name) */
  icon?: string;

  /**
   * It is a primary kon that provides capabilities to the framework.
   * Examples: Blog (provides Content Target), Auth (provides authentication)
   */
  primary?: boolean;

  /**
   * Can be deactivated by the user.
   * Primary kons are typically optional.
   */
  optional?: boolean;

  /** Factory that creates the router with injected context */
  createRouter: KonRouterFactory;

  /** Tables it manages (for introspection) */
  tables?: string[];

  /**
   * Request limits for specific routes of this kon.
   *
   * The host applies a generous global limit (designed for reads), but only
   * the kon knows which of its routes are EXPENSIVE: those that send an email,
   * charge money, or trigger a heavy job. Before, that forced touching the host's
   * route map, which breaks isolation — a kon must not appear
   * in the `apps/api` code.
   *
   * They are declared here and the module-loader mounts them when hooking up the router.
   */
  rateLimits?: KonRateLimit[];

  /**
   * Named groups of this kon's operations, for agents: `{ sales: ["list-deals", "move-deal"] }`. An MCP
   * session or an agent asks for one as `kon:<id>/<name>` (`kon:crm/sales`) and sees only those tools.
   * A model chooses worse among a hundred tools than among ten; only the kon knows which go together.
   * They narrow, never grant: the agent still needs the scopes.
   */
  mcpToolsets?: Record<string, string[]>;

  /** Lifecycle hooks */
  hooks?: {
    /** Called when the kon is enabled */
    onEnable?: (ctx: KonContext) => Promise<void>;
    /** Called when the kon is disabled */
    onDisable?: (ctx: KonContext) => Promise<void>;
    /** Called on every startup (for migrations) */
    onStartup?: (ctx: KonContext) => Promise<void>;
  };

  /** Admin UI configuration */
  admin?: {
    /**
     * Category in the sidebar.
     *
     * This is the kon's DECLARATION, not the wire format: the registry
     * normalizes it with `mapCategory` before serving it, and `ADMIN_REGISTRY_VERSION`
     * still exposes its usual enum. That is why values can be added
     * here without bumping the contract version — `"tools"` travels as `"data"`
     * until the panel learns to draw its own section.
     */
    category?: "core" | "content" | "data" | "system" | "esports" | "tools";
    /** Available views */
    views?: Array<{
      id: string;
      /**
       * `element` is the recommended form for custom views: a framework-agnostic
       * Web Component, loaded at runtime from the kon's artifact.
       * `custom` remains for the Svelte legacy, which couples the
       * extension to the admin's internal framework.
       */
      type: "grid" | "kanban" | "calendar" | "custom" | "element";
      title: string;
      table?: string;
      /** `element` only: name of the custom element. It must contain a hyphen. */
      element?: string;
      /** `element` only: ESM bundle, relative to the root of the kon's package. */
      src?: string;
    }>;
  };

  /** Dependencies */
  dependencies?: {
    /** Required kon IDs */
    kons?: string[];
    /** Required core feature flags */
    core?: string[];
  };

  /** Mount point (default: /api/{id}) */
  mountPath?: string;

  /**
   * OpenAPI specification for auto-generated documentation.
   * When provided, endpoints will be documented at /api/docs/openapi.json
   */
  openApi?: KonOpenApiSpec;

  /**
   * Kon SDK (see `operations.ts` and docs/kons/README.md): the declared
   * operations. The REST route, the OpenAPI and the MCP tool come from them.
   * A fixed list or a factory that receives the kon's context.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance boundary: each operation has its own schemas
  operations?: KonOperation<any, any, any>[] | ((ctx: KonContext) => KonOperation<any, any, any>[]);

  /** Version of the SDK contract the kon uses (`KONS_SDK_VERSION`). */
  sdk?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// OPENAPI SUPPORT FOR KONS
// ═══════════════════════════════════════════════════════════════════════════

/** HTTP methods supported in OpenAPI paths */
export type OpenApiMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

/** OpenAPI path definition for a single endpoint */
export interface KonOpenApiPath {
  /** HTTP method */
  method: OpenApiMethod;
  /** Path relative to kon mount (e.g., "/posts" or "/posts/:id") */
  path: string;
  /** Short summary (e.g., "List all posts") */
  summary: string;
  /** Detailed description (supports Markdown) */
  description?: string;
  /** Operation ID for code generation (auto-generated if not provided) */
  operationId?: string;
  /** Tags for grouping in documentation */
  tags?: string[];
  /** Path parameters schema */
  params?: ZodTypeAny;
  /** Query parameters schema */
  query?: ZodTypeAny;
  /** Request body schema */
  body?: ZodTypeAny;
  /** Response schemas by status code */
  responses: Record<
    number,
    {
      description: string;
      schema: ZodTypeAny;
    }
  >;
  /** Whether authentication is required */
  requireAuth?: boolean;
  /** Rate limiting configuration */
  rateLimit?: {
    requests: number;
    window: string; // e.g., "1m", "15m", "1h"
  };
}

/** OpenAPI tag definition */
export interface KonOpenApiTag {
  /** Tag name */
  name: string;
  /** Tag description */
  description: string;
  /** External documentation URL */
  externalDocs?: {
    description?: string;
    url: string;
  };
}

/** Complete OpenAPI specification for a kon */
export interface KonOpenApiSpec {
  /** Tags used by this kon's endpoints */
  tags?: KonOpenApiTag[];
  /** Reusable schemas (registered as {konId}_{schemaName}) */
  schemas?: Record<string, ZodTypeAny>;
  /** Endpoint definitions */
  paths: KonOpenApiPath[];
  /** Webhook definitions */
  webhooks?: Record<
    string,
    {
      post: {
        summary: string;
        description?: string;
        requestBody: {
          content: {
            "application/json": {
              schema: ZodTypeAny;
            };
          };
        };
      };
    }
  >;
}

/**
 * Helper to create a kon with type safety
 */
export function defineKon(def: KonDefinition): KonDefinition {
  return def;
}

/**
 * Helper to create a router with context type inference
 */
export function createKonRouter(setup: (router: Hono, ctx: KonContext) => void): KonRouterFactory {
  return (ctx: KonContext) => {
    const router = new Hono();
    setup(router, ctx);
    return router;
  };
}

// PaginatedResponse and createPaginatedResponse are exported from ./utils

// ═══════════════════════════════════════════════════════════════════════════
// STANDARD ERRORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Standard error for kons
 */
export class KonError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "KonError";
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.details && { details: this.details }),
    };
  }
}

/**
 * Predefined common errors
 */
export const KonErrors = {
  notFound: (resource: string, id?: string) =>
    new KonError(`${resource} not found${id ? `: ${id}` : ""}`, "NOT_FOUND", 404),

  unauthorized: (message = "Unauthorized") => new KonError(message, "UNAUTHORIZED", 401),

  forbidden: (message = "Forbidden") => new KonError(message, "FORBIDDEN", 403),

  validation: (message: string, details?: Record<string, unknown>) =>
    new KonError(message, "VALIDATION_ERROR", 400, details),

  conflict: (message: string) => new KonError(message, "CONFLICT", 409),
} as const;
