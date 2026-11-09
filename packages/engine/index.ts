/**
 * @kitsuden/engine — The Unstoppable Motor (Level 1)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * This is the beating heart of Kitsuden. Nothing here can be disabled.
 * All higher layers (Core, Kons, Grimoires) depend on these exports.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Contents:
 *   - Auth (Better-Auth + Machine Auth / NHI)
 *   - Database (Drizzle ORM + Schema Merger)
 *   - Security (RLS Builder + Auth Guard + Permissions)
 *   - Worker Sandbox (Bun-based sandboxed function execution)
 *   - Real-time (WebSocket + Pub/Sub: Valkey or, without it, Postgres LISTEN/NOTIFY)
 *   - Queue (Postgres: transactional outbox + SKIP LOCKED)
 *   - Cache (Valkey or in-process memory)
 *   - Storage (S3/MinIO file layer)
 *   - Image Optimization (WebP pipeline)
 *   - TOON (AI token optimizer middleware)
 *   - Event System (EventEmitter + Function Dispatcher + Cron)
 *   - Kon Loader (Dynamic module mounting)
 */

// ── Auth ──
export { auth } from "../../apps/api/src/lib/auth";

// ── Database ──
export { db } from "../../apps/api/src/db";
// `buildMergedSchema` is NOT re-exported here. Deliberate, and costly to find out:
//
// `apps/api/src/db/index.ts` ends with `export const db = await
// getDbInstance()` — a top-level await — and that initialization does
// `await import("../lib/schema-merger")`. In turn, `schema-merger` imports
// `db` statically. The comment there says the dynamic import
// "breaks the cycle"; it only breaks it as long as `schema-merger` is not
// also a STATIC dependency of the same graph.
//
// This line was. With it, ESM links `schema-merger` and schedules its
// evaluation AFTER `db`: `db` is left waiting for `schema-merger`, and
// `schema-merger` waiting for its turn behind `db`. Permanent deadlock, with
// 0% CPU and not a single open connection — the process simply
// never got to listen, and `docker compose up` only said "unhealthy".
//
// It is removed instead of fixing the cycle because NOBODY used it: its only
// consumer, `apps/api/src/routes/graphql.ts`, imports it directly from
// `../lib/schema-merger`. It was extra public surface.
//
// The root cause is still alive: the top-level `await` in `db`. As long as
// it stays, any module that makes `schema-merger` statically reachable
// again from this index reopens the deadlock. There is a test that
// watches for it: tests/unit/engine-import-deadlock.test.ts

// ── Security ──
export {
  buildDrizzleWhere,
  buildDatasetWhere,
  createRLSFilter,
  checkReadAccess,
  checkWriteAccess,
} from "../../apps/api/src/lib/rls-builder";
export { withTransactionalRLS } from "../../apps/api/src/middleware/transactional-rls";
export { protectRoute, requireAdmin, requireScope } from "../../apps/api/src/middleware/auth-guard";

// ── Worker Sandbox ──
export { executeSandbox } from "../../apps/api/src/lib/worker-sandbox";

// ── Real-time ──
export { realtimeManager } from "../../apps/api/src/lib/realtime";

// ── Zod: the single version across the monorepo (pure in "@kitsuden/engine/zod") ──
export { z } from "./zod";

// ── Queue (Postgres, transactional outbox) ──
export { queue, PermanentError } from "./src/queue";
export {
  configureEffects,
  runEffect,
  EffectBusyError,
  type EffectOptions,
  type EffectStore,
} from "./src/effects";
export type {
  JobActor,
  QueueHandler,
  DispatchOptions,
  HandlerOptions,
  QueueJob,
} from "./src/queue";
export { emailQueue, setupWorkers } from "../../apps/api/src/lib/queue";

// ── Cache ──
export { cachedQuery, invalidateCache } from "../../apps/api/src/lib/cache";

// ── Valkey Connection ──
export {
  VALKEY_URL,
  valkeyConfigured,
  getValkeyClient,
  isValkeyAvailable,
  getPublisher,
  getSubscriber,
} from "../../apps/api/src/lib/valkey";

// ── Storage (S3/MinIO) ──
export {
  s3,
  BUCKET,
  PUBLIC_URL,
  generateS3Key,
  uploadFile,
  uploadBuffer,
  deleteFile,
  fileExists,
  getFile,
  generateSignedDownloadUrl,
} from "../../apps/api/src/lib/storage";

// ── Image Optimization ──
export { optimizeImage, getImageDimensions } from "../../apps/api/src/lib/image";

// ── TOON (AI Middleware) ──
export { toonMiddleware } from "../../apps/api/src/lib/toon";

// ── Event System ──
export { events as kitsudenEvents, hooks } from "../../apps/api/src/lib/events";
// NOTE: initFunctionDispatcher / initCronScheduler are NOT re-exported here.
// They are startup functions of the HOST (apps/api imports them directly from its
// modules); re-exporting them from the facade created the shared edge of the
// import mega-cycle (index → function-dispatcher → actions → handlers →
// agent-engine → agent-tools → index).

// ── Kon Loader ──
export { loadKons, loadModules } from "../../apps/api/src/lib/module-loader";

// ── Actions Layer (Unified HTTP + Events + Agents) ──
export {
  defineAction,
  defineTypedAction,
  initActions,
  shutdownActions,
  listDefinedActions,
  getAction,
  listMCPTools,
  executeMCPTool,
  parseTrigger,
  setTelemetryProvider,
  getTelemetryProvider,
} from "./src/actions";
export type {
  ActionDefinition,
  ActionContext,
  ActionResult,
  ActionRunFunction,
  ParsedTrigger,
  TriggerPrefix,
  HttpMethod,
  InputSchema,
  ActionsInitOptions,
  TelemetryProvider,
  TelemetryStepData,
} from "./src/actions";

// ── Kon System (Auto-API & MCP Generator) ──
export {
  defineKon,
  registerKon,
  getKon,
  listKons,
  initializeKons,
  createKonAction,
} from "./src/kon";
export type {
  KonOptions,
  Kon,
  GeneratedRoute,
  GeneratedTool,
  MCPTool,
  DrizzleModel,
  InferKonSelect,
  InferKonInsert,
} from "./src/kon";

// ── Query Engine (JSON to SQL with Auto-Join) ──
export {
  parseQuery,
  validateQuery,
  getAvailableRelations,
  registerDynamicRelation,
  fieldWhiteList,
  fieldBlackList,
} from "./src/query-parser";
export type { QueryOptions, QueryResult } from "./src/query-parser";

// ── Query Translator (JSON to SQL with Auto-Join) ──
export { queryTranslator, validateQueryTranslator, QueryTranslatorError } from "./src/query";
export type {
  QueryTranslatorOptions,
  QueryTranslatorResult,
  WhereFilter,
  FieldFilter,
  FilterOperator,
  LogicalOperator,
  OrderBy,
  RelationDef,
} from "./src/query";

// ── Kitsuden QL Engine (Prisma-style JSON to SQL Translator) ──
export {
  parseKitsudenQuery,
  validateKitsudenQuery,
  getAvailableRelations as getKitsudenRelations,
  registerDynamicRelation as registerKitsudenRelation,
  debugQuery,
  KitsudenQLError,
} from "./src/translator";
export type {
  KitsudenQueryOptions,
  KitsudenQueryResult,
  WhereFilter as KitsudenWhereFilter,
  FieldFilter as KitsudenFieldFilter,
  FilterOperator as KitsudenFilterOperator,
  LogicalOperator as KitsudenLogicalOperator,
} from "./src/translator";

// ── Batch Processor (ACID Transactions - The Titanium Wall) ──
export {
  BatchProcessor,
  createBatchProcessor,
  executeSingle,
  createWithChildren,
  BatchProcessorError,
} from "./src/batch";
export type {
  BatchOperation,
  BatchOperationResult,
  BatchResult,
  BatchOperationType,
} from "./src/batch";

// ── Validator Engine (Declarative Validation with If/Then) ──
export {
  validate,
  validateBatch,
  createValidator,
  composeSchemas,
  agentIdentitySchema,
  paginationSchema,
  idSchema,
  timestampSchema,
} from "./src/validator";
export type {
  ValidationRule,
  Condition,
  ValidationSchema,
  ValidationResult,
  ValidationError,
  ValidatorOptions,
} from "./src/validator";

// ── Batch API (ACID Transactions - The Titanium Wall) ──
export type {
  BatchAction,
  BatchApiOperation,
  BatchOptions,
  BatchApiOperationResult,
  BatchApiResult,
  BatchError,
} from "./src/batch-api";

// ── KITSUDEN Brain (Self-Aware Knowledge Layer) ──
export {
  initKitsudenBrain,
  shutdownKitsudenBrain,
  scanProjectKnowledge,
  getBrainIndex,
  getKnowledgeGraph,
  getBrainNeighborhood,
  addBrainNoteWithConnections,
  upsertBrainNote,
  listBrainNotes,
  getBrainNote,
  deleteBrainNote,
  createBrainConnection,
  listBrainConnections,
  searchSimilarBrainNotes,
  generateWiki,
  generateLlms,
  buildKnowledgeGraph,
  neighborhoodGraph,
  discoverConnections,
  scoreConnection,
  createLocalEmbeddingProvider,
  embedTextLocal,
  cosineSimilarity,
  // Second Brain (Karpathy): sources / author / operations / schema
  captureSource,
  listSources,
  getSource,
  deleteSource,
  hashContent,
  extractSignals,
  summarize,
  keywords,
  headings,
  links,
  suggestBacklinks,
  resolveAuthor,
  createInstructionAuthor,
  createApiAuthor,
  createCliAuthor,
  buildAuthorPrompt,
  capture,
  syncBrain,
  lint,
  digest,
  generateBrainSchemaDoc,
  // Agent memory with an owner, claims with evidence, graphify importer
  resolveEmbeddingProvider,
  createLexicalEmbeddingProvider,
  createHttpEmbeddingProvider,
  LEXICAL_EMBEDDING_KIND,
  actorFromUser,
  actorLabel,
  writeMemoryNote,
  getVisibleNote,
  toMemoryNote,
  listMemoryNotes,
  searchMemoryNotes,
  deleteMemoryNote,
  listNoteConnections,
  connectNotes,
  addClaim,
  listClaims,
  lintClaims,
  reverifyClaim,
  checkClaim,
  rangeProblem,
  exportOkf,
  parseGraphify,
  importGraphify,
  SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS,
  CONNECTION_ORIGINS,
} from "./src/brain";
// ── Cross-cutting: errors, authorization (policies/gates), validation ──
// They live in the engine so that the app and the kons (plugins) share the same layers.
export {
  AppError,
  ErrorCode,
  postgresInputError,
  messageOf,
  sqlstateOf,
  toErrorEnvelope,
  respondError,
} from "./src/errors";
export type { ErrorCodeValue, ErrorEnvelope } from "./src/errors";

// Database conditions that check instead of casting.
// `eqEnum` replaces the `eq(col, value as any)` that was repeated 25 times:
// with a value outside the enum, Postgres does not return zero rows — it fails.
export { writeCondition, eqEnum } from "./src/db-conditions";
export {
  scopeConcede,
  definePolicy,
  defineGate,
  can,
  authorize,
  policyMap,
  resetAuthz,
  requireGate,
  requirePolicy,
} from "./src/authz";
export type { AuthzUser, PolicyRule, GateRule } from "./src/authz";
// Agents in the kons' policies and RLS
export {
  effectiveActor,
  agentCan,
  agentCanInKon,
  isEffectiveAdmin,
  isAgent,
  isEffectiveStaff,
  actsAsUserIn,
} from "./src/effective-actor";
export type { EffectiveActor, WhoAsks } from "./src/effective-actor";
export { validateRequest, validated, parseOrThrow, isUuid } from "./src/validation";
export type { ValidationTarget } from "./src/validation";
export { searchUnknownFields, similarKey } from "./src/validation";
export type { UnknownField } from "./src/validation";
export { ROUTE_META, withRouteMeta, describeRoute, readRouteMeta } from "./src/route-meta";
// Kon SDK: declare operations once → REST + OpenAPI + MCP (docs/kons/README.md)
export {
  defineKonSdk,
  operationsRouter,
  operationsOf,
  grantsOperation,
  inertCtx,
  registerMountedOperations,
  mountedOperations,
  mountedOperationsVersion,
  forgetMountedOperations,
  routeOperation,
} from "./src/operations";
export type {
  SdkKonDefinition,
  OperationsKonMounted,
  RouteOperation,
  AnyOperation,
} from "./src/operations";
export {
  KONS_SDK_VERSION,
  defineOperation,
  dateSchema,
  uuidSchema,
  operationFineScope,
  toolName,
  scopesThatGrant,
  grantsByScopes,
} from "@kitsuden/shared";
export type {
  KonOperation,
  OperationContext,
  ValidatedInput,
  OperationPermission,
  OperationOutput,
} from "@kitsuden/shared";
export type { RouteMeta, RouteValidationMeta } from "./src/route-meta";

// ── Synced State (live state server↔panel↔graphic, replicant style) ──
export {
  defineSyncedState,
  getSyncedState,
  listSyncedStateKeys,
  setStateTransport,
  setStateStore,
  resetSyncedState,
  stateChannel,
  createMemoryStateStore,
  SyncedState,
} from "./src/state";
export type {
  StateTransport,
  StateStore,
  SyncedStateOptions,
  SyncedStateMessage,
  Unsubscribe,
} from "./src/state";

// ── Request-scoped DI (RLS tx + per-request services, Nest style) ──
export {
  runInRequestScope,
  useRequest,
  useUser,
  setRequestTx,
  clearRequestTx,
  provideRequestService,
  resolveExecutor,
} from "./src/request-scope";
export type { RequestScope } from "./src/request-scope";

// ── Per-request RLS: a transaction carrying who is asking (core and kons) ──
export {
  afterCommit,
  asSystem,
  withSavepoint,
  withLazyTransactions,
  rlsContextOf,
  theRequestDb,
  inRlsTransaction,
  setRlsContext,
  attemptSql,
  background,
  rlsTransaction,
} from "./src/rls-request";
export type {
  TransactionalConnection,
  LostConfirmation,
  RlsTransactionOptions,
  RlsUser,
} from "./src/rls-request";

// ── ORM sugar: chainable repository over Drizzle (respects RLS) ──
export { repo, isInvalidInputSyntax } from "./src/repository";
export type { Repository, RepositoryOptions, PaginatedResult } from "./src/repository";

// ── Interceptors (composable before/after/onError, Nest style) ──
export {
  applyInterceptors,
  timingInterceptor,
  responseEnvelope,
  cacheControl,
  maskFields,
} from "./src/interceptors";
export type { Interceptor, InterceptorContext } from "./src/interceptors";

export { buildSystemMap } from "./src/system-map";
export type {
  SystemMap,
  SystemMapNode,
  SystemMapEdge,
  SystemMapDatabase,
  SystemMapOptions,
  SystemNodeType,
} from "./src/system-map";
export type {
  BrainConfig,
  BrainIndex,
  BrainNote,
  BrainNoteInput,
  BrainNoteCategory,
  BrainNoteSource,
  BrainConnection,
  BrainConnectionInput,
  BrainScanResult,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
  EmbeddingProvider,
  ScannedEntity,
  // Second Brain
  BrainSource,
  BrainSourceInput,
  BrainSourceType,
  ExtractionResult,
  WikiAuthor,
  AuthorTask,
  AuthorResult,
  AuthorMode,
  CaptureResult,
  SyncResult,
  LintReport,
  DigestResult,
  BrainSchemaOptions,
  EmbeddingInfo,
  PluggableEmbeddingProvider,
  BrainActor,
  BrainVisibility,
  MemoryNote,
  MemoryConnection,
  MemoryClaim,
  ClaimRange,
  ClaimCheck,
  ClaimsLint,
  ConnectionOrigin,
  OkfFile,
  ParsedGraphify,
  GraphifyImportReport,
} from "./src/brain";

// ── Code Graph (Graphify + Serena + Sourcegraph as system functions) ──
export {
  indexFiles,
  indexRepo,
  findSymbol,
  references,
  outline,
  pathBetween,
  communities,
  searchCode,
  commitSearch,
  fileHistory,
  commitShow,
} from "./src/code-graph";

export type {
  SourceFileInput,
  CodeSymbol,
  CodeSymbolKind,
  CodeGraph,
  CodeGraphFile,
  CodeGraphEdge,
  CodeEdgeRelation,
  IndexRepoOptions,
  SymbolMatch,
  SymbolReferences,
  FileOutline,
  Community,
  CodeSearchHit,
  CodeSearchOptions,
  CommitInfo,
  CommitDetail,
  CommitSearchOptions,
} from "./src/code-graph";

// ── Code Graph: visualization, semantic editing and search by meaning ──
export {
  renderGraphHtml,
  renameSymbol,
  replaceSymbolBody,
  safeDeleteSymbol,
  insertBeforeSymbol,
  loadFiles as loadCodeFiles,
  buildSemanticIndex,
  semanticSearch,
} from "./src/code-graph";

export type {
  VisualizeOptions,
  FileEdit,
  EditResult,
  EditOptions,
  CodeEmbeddingProvider,
  SemanticHit,
  SemanticIndex,
  BuildIndexOptions,
} from "./src/code-graph";

// ── Mail (Mailables + drivers + test outbox + shared layout) ──
export {
  Mailer,
  mail,
  layout,
  heading,
  paragraph,
  button,
  panel,
  code as mailCode,
  table as mailTable,
  esc as mailEsc,
  htmlToText,
  logDriver,
  memoryDriver,
  smtpDriver,
  resendDriver,
  driverFromEnv,
  formatAddress,
  addressEmail,
} from "./src/mail";

export type {
  Address,
  Attachment,
  Envelope,
  Content,
  Mailable,
  MailContext,
  SentMessage,
  MailDriver,
  MailerOptions,
  SendResult,
  MemoryDriver,
} from "./src/mail";

// ── LLM: semantic cache + guaranteed structured output ──
export {
  SemanticCache,
  memoryStore as llmMemoryStore,
  cosine as cosineSimilarityVec,
  generateStructured,
  extractJson,
  toJsonSchema,
} from "./src/llm";

export type {
  CacheStore,
  EmbeddingProvider as LLMEmbeddingProvider,
  CachedResponse,
  SemanticCacheOptions,
  CacheHit,
  CacheStats,
  StructuredProvider,
  StructuredRequest,
  StructuredMode,
  StructuredResult,
  StructuredOptions,
} from "./src/llm";

// ── Brain: tree index (retrieval by reasoning, PageIndex style) ──
export {
  buildContentTree,
  retrieveFromTree,
  renderIndex as renderTreeIndex,
  readNode as readTreeNode,
  findNode as findTreeNode,
  pathOf as treePathOf,
} from "./src/brain";

export type {
  ContentTree,
  TreeNode,
  TreePath,
  BranchSelector,
  RetrieveOptions,
  RetrievedSection,
} from "./src/brain";

// ── Field → Zod compiler ──
// Single validation path for any field vocabulary in the repo:
// datasets, a kon's custom fields, or SQL columns.
export {
  normalizeField,
  normalizeFields,
  normalizeCondition,
  isFieldVisible,
  buildObjectValidator,
  buildFieldValidator,
  validateAgainstFields,
  extractOptionValues,
} from "./src/field-compiler";

export type { NormalizedField, FieldCondition } from "./src/field-compiler";

// ── Polymorphic links between entities of any kon ──
// The missing edge: a kon relates its own things to another's WITHOUT depending
// on it. The engine never knows a concrete table — the caller supplies the
// loaders. See src/links.ts for the two costs (no FK, and RLS that cannot
// follow the edge) and how they are paid.
export { link, unlink, unlinkAll, neighbors, resolveNeighbors } from "./src/links";
export type { EntityRef, LinkRow, LinkOptions, NeighborQuery } from "./src/links";

// ── HTTP contract for kons ──
// A kon cannot import from apps/api (plugin isolation), so the
// engine declares the MINIMAL shape of the Hono context that the host guarantees.
// Without this, every handler ends up with `(c as any).get("user")`.
export type { KonUser, KonVariables, KonEnv, KonRouteContext } from "./src/http";
export { requireUser } from "./src/http";

// ── DefineModel — one model → table, operations (REST/OpenAPI/MCP), RLS, panel ──
// The contract (and the migrations' SQL) lives in @kitsuden/shared; see docs/agents/models.md.
export {
  modelTable,
  modelOperations,
  defineModelsKon,
  registerModelPolicy,
  registerModelPolicies,
  operationModel,
  mountedModels,
} from "./src/models";
export type { ModelsKonDefinition, MountedModel, ModelTable } from "./src/models";
