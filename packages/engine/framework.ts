/**
 * @kitsuden/engine/framework — The PURE layers of the framework
 * ============================================================================
 *
 * Published as `kitsuden/framework`.
 *
 * WHY IT EXISTS: the engine index (`kitsuden/engine`) re-exports host
 * modules (db, auth, storage, queue…), so importing it STARTS the
 * database. That is fine inside the server, but unacceptable for the author
 * of a kon who only wants `repo`, `can` or `validateRequest`.
 *
 * This entry point exposes only the layers without infrastructure: it imports
 * in milliseconds, opens no connections and needs no DATABASE_URL.
 *
 *   import { definePolicy, can, validateRequest, AppError } from "kitsuden/framework";
 *
 * NOTE about `repo`: it lives in `kitsuden/engine` because it resolves the host's
 * default connection. From a kon always use the injected form
 * `repo(table, { db: ctx.db.instance })`, which is the one recommended by the
 * `kitsuden create-kon` generator.
 */

// ── Authorization (deny-by-default) ──
export {
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
} from "./src/effective-actor";
export type { EffectiveActor, WhoAsks } from "./src/effective-actor";

// ── Zod: the single version across the monorepo ──
export { z } from "./zod";

// ── Validation (FormRequest) ──
export { validateRequest, validated, parseOrThrow } from "./src/validation";

// ── Errors (uniform envelope) ──
export { AppError, ErrorCode, toErrorEnvelope, respondError } from "./src/errors";

// ── DI request-scoped ──
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

// ── Interceptors (onion model) ──
export {
  applyInterceptors,
  timingInterceptor,
  responseEnvelope,
  cacheControl,
  maskFields,
} from "./src/interceptors";
export type { Interceptor, InterceptorContext } from "./src/interceptors";

// ── Code Graph (deterministic, no AI) ──
export {
  indexFiles,
  indexRepo,
  findSymbol,
  references,
  outline,
  pathBetween,
  communities,
  searchCode,
  renderGraphHtml,
  renameSymbol,
  replaceSymbolBody,
  safeDeleteSymbol,
  insertBeforeSymbol,
  buildSemanticIndex,
  semanticSearch,
  commitSearch,
  fileHistory,
  commitShow,
} from "./src/code-graph";
export type {
  CodeGraph,
  CodeSymbol,
  SourceFileInput,
  EditResult,
  SemanticHit,
  CodeEmbeddingProvider,
} from "./src/code-graph";

// ── System Map ──
export { buildSystemMap } from "./src/system-map";

// ── Mail — a kon can define and register its own emails ──
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
  htmlToText,
  memoryDriver,
} from "./src/mail";
export type { Mailable, MailContext, SentMessage, Envelope, Content } from "./src/mail";

// ── LLM (pure: semantic cache and structured output) ──
export {
  SemanticCache,
  memoryStore as llmMemoryStore,
  generateStructured,
  extractJson,
} from "./src/llm";
export type { CacheStore, StructuredProvider, StructuredResult } from "./src/llm";

// ── Brain: tree index (deterministic, no AI to build) ──
export {
  buildContentTree,
  retrieveFromTree,
  renderIndex as renderTreeIndex,
  readNode as readTreeNode,
} from "./src/brain/content-tree";
export type {
  ContentTree,
  TreeNode,
  BranchSelector,
  RetrievedSection,
} from "./src/brain/content-tree";
