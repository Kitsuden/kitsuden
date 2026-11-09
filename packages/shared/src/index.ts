export { SITE_CONFIG, BREAKPOINTS, NEON_COLORS } from "./constants";

// ═══════════════════════════════════════════════════════════════════════════
// KON API - Contracts for self-contained kons
// ═══════════════════════════════════════════════════════════════════════════

export { defineKon, createKonRouter, KonError, KonErrors, konSetting } from "./kon-api";

export type {
  KonCache,
  KonEvents,
  KonRealtime,
  KonAuth,
  KonStorage,
  KonDatabase,
  KonContext,
  KonRouterFactory,
  KonDefinition,
  KonRateLimit,
  // Agents run by a kon (`ctx.agents.run`)
  KonAgentRun,
  KonAgentEvent,
  KonAgentResult,
  // Content Publishing
  ContentTarget,
  ContentTargetInfo,
  KonContentPublishing,
  PromotionData,
  PromotionOptions,
  PromotionSource,
  PublishResult,
  // OpenAPI
  KonOpenApiSpec,
  KonOpenApiPath,
  KonOpenApiTag,
  OpenApiMethod,
} from "./kon-api";

// ═══════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES AND TYPES
// ═══════════════════════════════════════════════════════════════════════════

export {
  formatDate,
  truncate,
  buildCmsUrl,
  buildApiUrl,
  gameJsonLd,
  articleJsonLd,
  createPaginatedResponse,
} from "./utils";

export type {
  PageBlock,
  BlockEditorial,
  Game,
  BlogPost,
  DataSet,
  DataEntry,
  Platform,
  Tag,
  Streamer,
  SiteSettings,
  SEOMeta,
  MediaItem,
  PaginatedResponse,
} from "./types";

// The block contract's key names (0.9: English) and the bridge from the 0.8 (Spanish) ones.
export {
  COMMON_BLOCK_KEYS,
  BLOCK_KEYS_BY_TYPE,
  FIELD_KEYS,
  ITEM_KEYS,
  LINKED_DATASET_KEYS,
  LABEL_KEYS,
  BLOCK_VALUES_BY_TYPE,
  EDITORIAL_KEYS,
  readBlockData,
  readEditorial,
  findSpanishBlockKeys,
  findSpanishEditorialKeys,
  spanishKeysError,
} from "./block-keys";
export type { KeyRenames, SpanishKey } from "./block-keys";

// ═══════════════════════════════════════════════════════════════════════════
// KON PACKAGE — Contract for npm packages
// ═══════════════════════════════════════════════════════════════════════════

export type {
  KonPackage,
  KonPackageMinimal,
  KonDependencies,
  KonMountConfig,
  KonTableConfig,
  KonLifecycleHooks,
} from "./kon-package";

export { isValidKonPackage } from "./kon-package";

// Blocks → HTML. A single renderer for the API and the panel: if each
// had its own, the preview would stop being a preview.
export {
  renderBlocks,
  escapeHtml,
  safeUrl,
  embedUrl,
  STATIC_TYPES,
  INTERACTIVE_TYPES,
  type ContentBlock,
  type RenderOptions,
  type RenderResult,
} from "./render-blocks";

// ═══════════════════════════════════════════════════════════════════════════
// DECK ANALYSIS - The vocabulary, shared between the loader and the web
// ═══════════════════════════════════════════════════════════════════════════
// Both need it: the loader uses it to build the dataset's SCHEMA
// editorial and the web knows which fields to read and what to call them. Duplicated,
// adding a bar would leave it saved but undrawn on the other side.
export {
  DECK_BARS,
  SKILL_MEASURES,
  CARD_MEASURES,
  DECK_TYPES,
  GRADES,
  LEARNING_CURVES,
  CARD_ROLES,
  ENDURANCE_PHASES,
  GRADE_FACTORS,
  weightedScore,
  type AnalysisMeasure,
} from "./deck-analysis";

// ═══════════════════════════════════════════════════════════════════════════
// THE ZOD BRIDGE - Exports of the Unified Validation System
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Zod schemas
  FieldTypeSchema,
  RelationTypeSchema,
  RelationTargetSchema,
  RelationConfigSchema,
  SelectOptionSchema,
  FieldDefinitionSchema,
  DatasetPolicySchema,
  DatasetWorkflowSchema,
  DatasetDefinitionSchema,
  DatasetEntrySchema,
  CreateDatasetPayloadSchema,
  UpdateDatasetPayloadSchema,
  // Helpers
  validateDatasetDefinition,
  safeValidateDataset,
  generateFieldId,
  createEmptyField,
} from "./schemas";

export type {
  // Types inferred from Zod
  FieldType,
  RelationType,
  RelationTarget,
  RelationConfig,
  SelectOption,
  FieldDefinition,
  DatasetPolicy,
  DatasetWorkflow,
  DatasetDefinition,
  DatasetEntry,
  CreateDatasetPayload,
  UpdateDatasetPayload,
} from "./schemas";

// ═══════════════════════════════════════════════════════════════════════════
// RLS BUILDER - Row Level Security utilities for kons
// ═══════════════════════════════════════════════════════════════════════════

export {
  buildDrizzleWhere,
  buildDatasetWhere,
  checkReadAccess,
  checkWriteAccess,
  createRLSFilter,
  publishedOrOwn,
  publishedOrOwnQl,
} from "./rls-builder";

export type { RLSType, RLSRule, PolicyJson, RLSUser } from "./rls-builder";

// ── Framework-agnostic admin views ──
export {
  isValidElementName,
  isSafeAssetPath,
  isDeclaredAdminAsset,
  declaredViewSources,
  ADMIN_ASSET_DIR,
  isValidKonId,
  adminAssetUrl,
  resolveCustomView,
  descriptorFromView,
  createViewContext,
  CustomViewError,
} from "./admin-view";
export type { CustomViewDescriptor, ResolvedCustomView, AdminViewContext } from "./admin-view";

// ── Public contract of the Admin Registry ──
export {
  ADMIN_REGISTRY_VERSION,
  CONTRACT_HEADER,
  assertSupportedContract,
} from "./admin-registry-contract";
export type {
  AdminRegistryResponse,
  AdminRegistryKonResponse,
  AdminRegistryKon,
  AdminRegistryTable,
  AdminRegistryView,
} from "./admin-registry-contract";

// ── Single registry of field types ──
// Source of truth for: which types exist, how they validate, how they are indexed and
// which ones are offered in the admin palette.
export {
  FIELD_TYPES,
  FIELD_TYPE_NAMES,
  FIELD_TYPE_ALIASES,
  resolveFieldType,
  fieldTypeSpec,
  creatableFieldTypes,
  shouldIndexByDefault,
  shouldSearchByDefault,
} from "./field-types";
export type {
  FieldTypeName,
  FieldTypeSpec,
  FieldValueKind,
  FieldStringFormat,
} from "./field-types";
export type { FieldTypeAlias } from "./field-types";

export {
  readDatasetCatalog,
  datasetImageUrl,
  datasetNumber,
  DATASET_MAX_ROWS,
} from "./dataset-catalog";
export type {
  DatasetCatalog,
  /**
   * `DatasetEntry` is already exported by `./schemas` (the one inferred from zod), and re-exporting
   * both with the same name broke the build of the entire package:
   *
   *     src/index.ts(129,3): error TS2300: Duplicate identifier 'DatasetEntry'.
   *
   * Without `.d.ts`, anyone importing `@kitsuden/shared` silently gets `any` —that is
   * why the build script treats it as an error and not a warning—. It is disambiguated
   * here, in the barrel, without touching either module: nobody imported
   * this type by its short name yet.
   */
  DatasetEntry as DatasetCatalogEntry,
  DatasetField,
  DatasetReader,
} from "./dataset-catalog";

// ═══════════════════════════════════════════════════════════════════════════
// COMMENTS - what can be commented on, declared in one place
// ═══════════════════════════════════════════════════════════════════════════
export {
  COMMENTABLE_SUBJECTS,
  SUBJECT_TYPES,
  isSubjectType,
  commentableSubject,
} from "./comment-subjects";
export type { CommentableSubject, SubjectType } from "./comment-subjects";

// Public site addresses: everything path-based, games at /<game>/ and their wiki at /<game>/wiki/
export {
  RESERVED_SITE_SEGMENTS,
  readReservedSegments,
  invalidGameSlugReason,
  invalidWikiSlugReason,
  gameSlug,
} from "./public-site";

// Wiki links: the same rule for indexing (server) and drawing (frontend)
export { wikiPageSlug, extractWikiLinks, renderWikiLinks } from "./wiki-links";
export type { WikiLink } from "./wiki-links";
export { safeMarkdown } from "./render-blocks";
export { renderWikiPage } from "./wiki-links";
export { DEFAULT_PUBLIC_URL, effectivePublicUrl } from "./public-site";
export { DEFAULT_SITE_NAMES, effectiveSiteName } from "./public-site";

// Fields of a dataset with either shape of `schema`
export { schemaFields } from "./field-types";

// Customer/personal data marks on dataset fields and kon columns (docs/agents/egress.md)
export {
  SENSITIVITY_LEVELS,
  isSensitivity,
  markedDatasetFields,
  droppedSensitivity,
  konSensitivity,
} from "./sensitivity";
export type { Sensitivity } from "./sensitivity";

export { TIERS, BRACKETS, bracketByPosition } from "./tier-ranges";
export type { TierBracket } from "./tier-ranges";

export { LETTERS, TAGS, LEVELS, LEVELS_NOTE, minForLetter, metaLevels } from "./meta-levels";
export type { MetaLevel, GradableArchetype } from "./meta-levels";

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT VERSIONS — what GET /api/version publishes (Inti and other clients)
// ═══════════════════════════════════════════════════════════════════════════
export { CONTRACTS, SDKS, KITSUDEN_VERSION } from "./contracts";
export type { ContractName, VersionResponse } from "./contracts";

// ═══════════════════════════════════════════════════════════════════════════
// ERRORS - Stable catalog (RFC 9457) for the API, the MCP and the clients
// ═══════════════════════════════════════════════════════════════════════════

export {
  KITSUDEN_ERRORS,
  ERROR_DOCS,
  PROBLEM_JSON,
  isKitsudenErrorCode,
  errorDocsUrl,
  errorCodeForStatus,
  errorCodeFromLegacy,
  buildProblem,
  parseRetryAfter,
} from "./errors";
export type { ErrorCatalogEntry, KitsudenErrorCode, ProblemDetails } from "./errors";

// ═══════════════════════════════════════════════════════════════════════════
// KON SDK — the contract of an operation (docs/kons/README.md)
// ═══════════════════════════════════════════════════════════════════════════

export {
  KONS_SDK_VERSION,
  defineOperation,
  checkOperations,
  isSensitive,
  isReadOnly,
  isIdempotent,
  exclusionMcp,
  operationErrors,
  konShortName,
  operationFineScope,
  toolName,
  operationIdOf,
  scopeCovers,
  scopesThatGrant,
  grantsByScopes,
  operationCost,
  operationIdentities,
  operationDenial,
  whyGranted,
  dateSchema,
  uuidSchema,
  MCP_BODY_ARGUMENT,
  MCP_IDEMPOTENCY_ARGUMENT,
  routeParameters,
  shortGuide,
  isRedirect,
  REDIRECT_STATUSES,
} from "./operations";
export type {
  OperationGuide,
  OperationMethod,
  OperationAccess,
  OperationPermission,
  OperationOutput,
  OperationInput,
  OperationMcp,
  ValidatedInput,
  OperationUser,
  OperationContext,
  KonOperation,
  GrantByScope,
  SuccessStatus,
  RedirectStatus,
} from "./operations";

// ═══════════════════════════════════════════════════════════════════════════
// AGENT PERMISSIONS — broad + fine + denials (docs/agents/permissions.md)
// ═══════════════════════════════════════════════════════════════════════════

export {
  DENIAL_PREFIX,
  isDenial,
  splitScopes,
  patternCovers,
  denialThatCovers,
  grantThatCovers,
  concedeScope,
  agentActsAsUser,
  opensWholeKon,
  SCOPE_ACT_AS_USER,
  invalidScopeReason,
  normalizeScopes,
  MAX_SCOPES_PER_AGENT,
  DATASET_ACTIONS,
  datasetScope,
  accessToDataset,
  agentWritesByPolicy,
  AGENT_PRESETS,
  BROAD_CORE_SCOPES,
} from "./agent-permission";
export type { DatasetAction, AgentPreset } from "./agent-permission";

// ═══════════════════════════════════════════════════════════════════════════
// HUMAN APPROVAL — agent proposals (docs/agents/approvals.md)
// ═══════════════════════════════════════════════════════════════════════════

export {
  APPROVAL_MODES,
  isApprovalMode,
  PROPOSAL_RETENTIONS,
  isProposalRetention,
  DEFAULT_APPROVALS_CONFIG,
  TTL_MIN_HOURS,
  TTL_MAX_HOURS,
  PROPOSAL_STATUSES,
  isWriteMethod,
  decideApproval,
  patternRegex,
  legacyHouseRule,
  invalidRuleReason,
  mergeApprovalsConfig,
  readApprovalsConfig,
  mcpToolKey,
  defaultSensitiveMcpTool,
  UNATTENDED_MODES,
  isUnattendedMode,
  ALTERNATIVE_MAX,
  DEFAULT_UNATTENDED_ALTERNATIVE,
  decideUnattended,
  pickAlternative,
  invalidAlternativeReason,
} from "./approvals";
export type {
  UnattendedMode,
  ApprovalMode,
  ProposalRetention,
  LegacyApprovalRule,
  ApprovalsConfig,
  ProposalStatus,
  ProposalReason,
} from "./approvals";

// ═══════════════════════════════════════════════════════════════════════════
// HUMAN SIGNER OF AN AGENT (docs/agents/approvals.md)
// ═══════════════════════════════════════════════════════════════════════════

export { SIGNER_ROLES, canSign, agentSignature } from "./signer";
export type { AgentSigner, SignatureResolved } from "./signer";

// Validation patterns without ReDoS (earlier audit)
export { safePattern, testPattern, MAX_PATTERN_LENGTH, MAX_LENGTH_TO_TEST } from "./safe-pattern";

// ═══════════════════════════════════════════════════════════════════════════
// AGENT CODE PROMOTION (docs/agents/promotion.md)
// ═══════════════════════════════════════════════════════════════════════════

export {
  PROMOTION_MODES,
  isPromotionMode,
  DEFAULT_PROMOTION_CONFIG,
  PROMOTION_CONFIG_LIMITS,
  mergePromotionConfig,
  readPromotionConfig,
  VERSION_STATUSES,
  DEFAULT_CODE_LIMITS,
  capabilitiesOf,
  hostCovers,
  capabilitiesDiff,
  pathTouch,
  scopeTouch,
  secretName,
  FALLBACK_REASONS,
  decidePromotion,
  MAX_TESTS_PER_DRAFT,
  MAX_CODE_BYTES,
} from "./promotion";
export type {
  PromotionMode,
  PromotionConfig,
  VersionStatus,
  CodeCapabilities,
  CapabilitiesDiff,
  SensitiveTouch,
  FallbackReason,
  TestsSummary,
  DecisionInput,
  PromotionDecision,
  MockResponse,
  TestCase,
} from "./promotion";
export { scanCode, MAX_SCANNABLE_BYTES } from "./code-scan";
export type {
  FindingSeverity,
  ScanFinding,
  ApiCallInfo,
  ScanReport,
  ScanOptions,
} from "./code-scan";

// DefineModel (one model → table, migration, REST/MCP/OpenAPI, RLS, panel)
export * from "./models";
export * from "./models-sql";
export * from "./env";
