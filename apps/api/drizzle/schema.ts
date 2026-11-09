// @ts-nocheck
import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  real,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  unique,
  foreignKey,
  integer,
  date,
  vector,
  doublePrecision,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const academyCourseStatus = pgEnum("academy_course_status", [
  "draft",
  "published",
  "archived",
]);
export const academyEnrollmentStatus = pgEnum("academy_enrollment_status", [
  "enrolled",
  "in_progress",
  "completed",
]);
export const agentTraceStatus = pgEnum("agent_trace_status", [
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
]);
export const agentTraceStepType = pgEnum("agent_trace_step_type", [
  "llm_call",
  "tool_call",
  "tool_result",
  "thinking",
  "retrieval",
  "memory_read",
  "memory_write",
  "user_input",
  "system",
  "error",
]);
export const blogStatus = pgEnum("blog_status", ["draft", "published", "scheduled"]);
export const connectorType = pgEnum("connector_type", ["api", "database"]);
export const contentStatus = pgEnum("content_status", ["draft", "published", "archived"]);
export const documentStatus = pgEnum("document_status", ["DRAFT", "APPROVED"]);
export const executionStatus = pgEnum("execution_status", [
  "pending",
  "running",
  "success",
  "error",
  "timeout",
  "killed",
]);
export const functionStatus = pgEnum("function_status", ["active", "inactive", "error"]);
export const functionTrigger = pgEnum("function_trigger", [
  "on_entry_created",
  "on_entry_updated",
  "on_entry_deleted",
  "on_post_published",
  "cron",
  "manual",
  "webhook_incoming",
]);
export const reservationStatus = pgEnum("reservation_status", [
  "pending",
  "confirmed",
  "cancelled",
]);
export const streamerPlatform = pgEnum("streamer_platform", ["twitch", "youtube", "kick"]);
export const tagCategory = pgEnum("tag_category", ["genre", "feature", "topic", "series"]);
export const userRole = pgEnum("user_role", ["admin", "editor", "user"]);
export const versionStatus = pgEnum("version_status", ["active", "superseded"]);
export const webhookEvent = pgEnum("webhook_event", ["on_create", "on_update", "on_delete"]);

export const authVerifications = pgTable("auth_verifications", {
  id: text().primaryKey().notNull(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const formulas = pgTable("formulas", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  kpiName: varchar("kpi_name", { length: 200 }).notNull(),
  formulaType: varchar("formula_type", { length: 50 }).default("custom").notNull(),
  expression: text().notNull(),
  threshold: real().default(95),
  description: text(),
  enabled: boolean().default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const modules = pgTable("modules", {
  key: varchar({ length: 100 }).primaryKey().notNull(),
  name: varchar({ length: 200 }).notNull(),
  description: text(),
  icon: varchar({ length: 50 }),
  category: varchar({ length: 100 }),
  enabled: boolean().default(false).notNull(),
  grimoireId: varchar("grimoire_id", { length: 100 }),
  settings: jsonb().default({}),
  sidebarPath: varchar("sidebar_path", { length: 200 }),
  sidebarIcon: varchar("sidebar_icon", { length: 50 }),
  sidebarBadge: varchar("sidebar_badge", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const siteSettings = pgTable("site_settings", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  siteName: varchar("site_name", { length: 200 }).default("Kitsuden").notNull(),
  siteDescription: text("site_description"),
  siteUrl: text("site_url").default("http://localhost:4321").notNull(),
  branding: jsonb(),
  mainNav: jsonb("main_nav"),
  social: jsonb(),
  analytics: jsonb(),
  activeTheme: varchar("active_theme", { length: 100 }),
  footerText: text("footer_text"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const employeeProfile = pgTable(
  "employee_profile",
  {
    userId: text("user_id").primaryKey().notNull(),
    departamento: varchar({ length: 200 }),
    cargo: varchar({ length: 200 }),
    cellphone: varchar({ length: 30 }),
    directManager: varchar("jefe_directo", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("employee_profile_user_id_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops")
    ),
  ]
);

export const dataConnectors = pgTable(
  "data_connectors",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    type: connectorType().notNull(),
    config: jsonb().notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "string" }),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("connectors_type_idx").using("btree", table.type.asc().nullsLast().op("enum_ops")),
  ]
);

export const authUsers = pgTable(
  "auth_users",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text(),
    role: userRole().default("user").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [unique("auth_users_email_unique").on(table.email)]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    keyHash: text("key_hash").notNull(),
    hint: varchar({ length: 20 }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    createdById: text("created_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.createdById],
      foreignColumns: [authUsers.id],
      name: "api_keys_created_by_id_auth_users_id_fk",
    }).onDelete("cascade"),
  ]
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text().primaryKey().notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    scope: text(),
    password: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUsers.id],
      name: "auth_accounts_user_id_auth_users_id_fk",
    }).onDelete("cascade"),
  ]
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text().primaryKey().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    token: text().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUsers.id],
      name: "auth_sessions_user_id_auth_users_id_fk",
    }).onDelete("cascade"),
    unique("auth_sessions_token_unique").on(table.token),
  ]
);

export const blogPosts = pgTable(
  "blog_posts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: varchar({ length: 500 }).notNull(),
    slug: varchar({ length: 500 }).notNull(),
    content: jsonb(),
    excerpt: text(),
    status: blogStatus().default("draft").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    authorId: text("author_id").notNull(),
    featuredImageId: uuid("featured_image_id"),
    readingTime: integer("reading_time"),
    seoOverrides: jsonb("seo_overrides"),
    blocks: jsonb().default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // With the kon's name: the `blog_*_idx` indexes from 0000 were twins and kon-blog/0007 retires them
    index("blog_posts_published_idx").using(
      "btree",
      table.publishedAt.asc().nullsLast().op("timestamptz_ops")
    ),
    uniqueIndex("blog_posts_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    index("blog_posts_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
    foreignKey({
      columns: [table.authorId],
      foreignColumns: [authUsers.id],
      name: "blog_posts_author_id_auth_users_id_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.featuredImageId],
      foreignColumns: [media.id],
      name: "blog_posts_featured_image_id_media_id_fk",
    }).onDelete("set null"),
  ]
);

export const media = pgTable(
  "media",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    filename: varchar({ length: 500 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    s3Key: varchar("s3_key", { length: 1000 }).notNull(),
    url: text().notNull(),
    alt: varchar({ length: 500 }).default(""),
    caption: text(),
    width: integer(),
    height: integer(),
    size: integer(),
    uploadedById: text("uploaded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("media_s3key_idx").using("btree", table.s3Key.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.uploadedById],
      foreignColumns: [authUsers.id],
      name: "media_uploaded_by_id_auth_users_id_fk",
    }).onDelete("set null"),
  ]
);

export const blogPostsToGames = pgTable(
  "blog_posts_to_games",
  {
    postId: uuid("post_id").notNull(),
    gameId: uuid("game_id").notNull(),
  },
  (table) => [
    uniqueIndex("bg_unique").using(
      "btree",
      table.postId.asc().nullsLast().op("uuid_ops"),
      table.gameId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.postId],
      foreignColumns: [blogPosts.id],
      name: "blog_posts_to_games_post_id_blog_posts_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.gameId],
      foreignColumns: [games.id],
      name: "blog_posts_to_games_game_id_games_id_fk",
    }).onDelete("cascade"),
  ]
);

export const games = pgTable(
  "games",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: varchar({ length: 500 }).notNull(),
    slug: varchar({ length: 500 }).notNull(),
    subtitle: varchar({ length: 500 }),
    description: jsonb(),
    excerpt: text(),
    releaseDate: date("release_date"),
    status: contentStatus().default("draft").notNull(),
    developer: varchar({ length: 200 }),
    publisher: varchar({ length: 200 }),
    metacriticScore: integer("metacritic_score"),
    userRating: real("user_rating"),
    coverArtId: uuid("cover_art_id"),
    trailerUrl: text("trailer_url"),
    externalIds: jsonb("external_ids"),
    specs: jsonb(),
    screenshots: jsonb(),
    blocks: jsonb().default([]),
    isFeaturedOnHome: boolean("is_featured_on_home").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("games_metacritic_idx").using(
      "btree",
      table.metacriticScore.asc().nullsLast().op("int4_ops")
    ),
    index("games_release_idx").using("btree", table.releaseDate.asc().nullsLast().op("date_ops")),
    uniqueIndex("games_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    index("games_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
    foreignKey({
      columns: [table.coverArtId],
      foreignColumns: [media.id],
      name: "games_cover_art_id_media_id_fk",
    }).onDelete("set null"),
  ]
);

export const blogPostsToTags = pgTable(
  "blog_posts_to_tags",
  {
    postId: uuid("post_id").notNull(),
    tagId: uuid("tag_id").notNull(),
  },
  (table) => [
    uniqueIndex("bt_unique").using(
      "btree",
      table.postId.asc().nullsLast().op("uuid_ops"),
      table.tagId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.postId],
      foreignColumns: [blogPosts.id],
      name: "blog_posts_to_tags_post_id_blog_posts_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tags.id],
      name: "blog_posts_to_tags_tag_id_tags_id_fk",
    }).onDelete("cascade"),
  ]
);

export const tags = pgTable(
  "tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    slug: varchar({ length: 100 }).notNull(),
    color: varchar({ length: 7 }),
    category: tagCategory(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("tags_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
  ]
);

export const dataSets = pgTable(
  "data_sets",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    slug: varchar({ length: 200 }).notNull(),
    description: text(),
    gameId: uuid("game_id"),
    icon: varchar({ length: 10 }),
    schema: jsonb().notNull(),
    displayConfig: jsonb("display_config"),
    policyJson: jsonb("policy_json"),
    workflowJson: jsonb("workflow_json"),
    contentConfig: jsonb("content_config"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("datasets_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.gameId],
      foreignColumns: [games.id],
      name: "data_sets_game_id_games_id_fk",
    }).onDelete("cascade"),
  ]
);

export const dataEntries = pgTable(
  "data_entries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: varchar({ length: 500 }).notNull(),
    dataSetId: uuid("data_set_id").notNull(),
    ownerId: text("owner_id"),
    data: jsonb().notNull(),
    thumbnailId: uuid("thumbnail_id"),
    sortOrder: integer("sort_order").default(0),
    status: contentStatus().default("published").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("entries_dataset_idx").using("btree", table.dataSetId.asc().nullsLast().op("uuid_ops")),
    index("entries_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("text_ops")),
    index("entries_sort_idx").using("btree", table.sortOrder.asc().nullsLast().op("int4_ops")),
    foreignKey({
      columns: [table.dataSetId],
      foreignColumns: [dataSets.id],
      name: "data_entries_data_set_id_data_sets_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUsers.id],
      name: "data_entries_owner_id_auth_users_id_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.thumbnailId],
      foreignColumns: [media.id],
      name: "data_entries_thumbnail_id_media_id_fk",
    }).onDelete("set null"),
  ]
);

export const kitsudenFunctions = pgTable(
  "kitsuden_functions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    slug: varchar({ length: 200 }).notNull(),
    description: text(),
    code: text().notNull(),
    trigger: functionTrigger().notNull(),
    cronExpression: varchar("cron_expression", { length: 100 }),
    watchDatasetId: uuid("watch_dataset_id"),
    timeoutMs: integer("timeout_ms").default(5000).notNull(),
    memoryLimitMb: integer("memory_limit_mb").default(64).notNull(),
    status: functionStatus().default("active").notNull(),
    envVars: jsonb("env_vars").default({}),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    executionCount: integer("execution_count").default(0).notNull(),
    errorCount: integer("error_count").default(0).notNull(),
    createdById: text("created_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("pf_dataset_idx").using("btree", table.watchDatasetId.asc().nullsLast().op("uuid_ops")),
    uniqueIndex("pf_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    index("pf_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
    index("pf_trigger_idx").using("btree", table.trigger.asc().nullsLast().op("enum_ops")),
    foreignKey({
      columns: [table.watchDatasetId],
      foreignColumns: [dataSets.id],
      name: "kitsuden_functions_watch_dataset_id_data_sets_id_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.createdById],
      foreignColumns: [authUsers.id],
      name: "kitsuden_functions_created_by_id_auth_users_id_fk",
    }).onDelete("set null"),
  ]
);

export const functionExecutions = pgTable(
  "function_executions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    functionId: uuid("function_id").notNull(),
    status: executionStatus().default("pending").notNull(),
    triggerEvent: varchar("trigger_event", { length: 100 }),
    triggerPayload: jsonb("trigger_payload"),
    logs: text(),
    result: jsonb(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    memoryUsedBytes: integer("memory_used_bytes"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("fe_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
    index("fe_function_idx").using("btree", table.functionId.asc().nullsLast().op("uuid_ops")),
    index("fe_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
    foreignKey({
      columns: [table.functionId],
      foreignColumns: [kitsudenFunctions.id],
      name: "function_executions_function_id_kitsuden_functions_id_fk",
    }).onDelete("cascade"),
  ]
);

export const gameCollections = pgTable(
  "game_collections",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: varchar({ length: 200 }).notNull(),
    slug: varchar({ length: 200 }).notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("gc_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
  ]
);

export const gameCollectionEntries = pgTable(
  "game_collection_entries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    collectionId: uuid("collection_id").notNull(),
    gameId: uuid("game_id").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("gce_unique").using(
      "btree",
      table.collectionId.asc().nullsLast().op("uuid_ops"),
      table.gameId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.collectionId],
      foreignColumns: [gameCollections.id],
      name: "game_collection_entries_collection_id_game_collections_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.gameId],
      foreignColumns: [games.id],
      name: "game_collection_entries_game_id_games_id_fk",
    }).onDelete("cascade"),
  ]
);

export const gamesToPlatforms = pgTable(
  "games_to_platforms",
  {
    gameId: uuid("game_id").notNull(),
    platformId: uuid("platform_id").notNull(),
  },
  (table) => [
    uniqueIndex("gp_unique").using(
      "btree",
      table.gameId.asc().nullsLast().op("uuid_ops"),
      table.platformId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.gameId],
      foreignColumns: [games.id],
      name: "games_to_platforms_game_id_games_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.platformId],
      foreignColumns: [platforms.id],
      name: "games_to_platforms_platform_id_platforms_id_fk",
    }).onDelete("cascade"),
  ]
);

export const platforms = pgTable(
  "platforms",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    slug: varchar({ length: 100 }).notNull(),
    shortName: varchar("short_name", { length: 20 }),
    manufacturer: varchar({ length: 100 }),
    iconId: uuid("icon_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("platforms_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.iconId],
      foreignColumns: [media.id],
      name: "platforms_icon_id_media_id_fk",
    }).onDelete("set null"),
  ]
);

export const gamesToStreamers = pgTable(
  "games_to_streamers",
  {
    gameId: uuid("game_id").notNull(),
    streamerId: uuid("streamer_id").notNull(),
  },
  (table) => [
    uniqueIndex("gs_unique").using(
      "btree",
      table.gameId.asc().nullsLast().op("uuid_ops"),
      table.streamerId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.gameId],
      foreignColumns: [games.id],
      name: "games_to_streamers_game_id_games_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.streamerId],
      foreignColumns: [streamers.id],
      name: "games_to_streamers_streamer_id_streamers_id_fk",
    }).onDelete("cascade"),
  ]
);

export const streamers = pgTable(
  "streamers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    slug: varchar({ length: 200 }).notNull(),
    platform: streamerPlatform().notNull(),
    channelId: varchar("channel_id", { length: 200 }).notNull(),
    channelUrl: text("channel_url"),
    isLive: boolean("is_live").default(false),
    currentStreamTitle: text("current_stream_title"),
    viewerCount: integer("viewer_count").default(0),
    followerCount: integer("follower_count").default(0),
    avatarId: uuid("avatar_id"),
    thumbnailUrl: text("thumbnail_url"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("streamers_platform_idx").using("btree", table.platform.asc().nullsLast().op("enum_ops")),
    uniqueIndex("streamers_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.avatarId],
      foreignColumns: [media.id],
      name: "streamers_avatar_id_media_id_fk",
    }).onDelete("set null"),
  ]
);

export const gamesToTags = pgTable(
  "games_to_tags",
  {
    gameId: uuid("game_id").notNull(),
    tagId: uuid("tag_id").notNull(),
  },
  (table) => [
    uniqueIndex("gt_unique").using(
      "btree",
      table.gameId.asc().nullsLast().op("uuid_ops"),
      table.tagId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.gameId],
      foreignColumns: [games.id],
      name: "games_to_tags_game_id_games_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tags.id],
      name: "games_to_tags_tag_id_tags_id_fk",
    }).onDelete("cascade"),
  ]
);

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email: varchar({ length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    role: userRole().default("editor").notNull(),
    avatarId: uuid("avatar_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.avatarId],
      foreignColumns: [media.id],
      name: "users_avatar_id_media_id_fk",
    }).onDelete("set null"),
    unique("users_email_unique").on(table.email),
  ]
);

export const aiMemories = pgTable(
  "ai_memories",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    content: text().notNull(),
    embedding: vector({ dimensions: 1536 }),
    metadata: jsonb(),
    memoryType: varchar("memory_type", { length: 50 }).default("knowledge").notNull(),
    createdById: uuid("created_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("ai_memories_created_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("ai_memories_embedding_idx").using(
      "ivfflat",
      table.embedding.asc().nullsLast().op("vector_cosine_ops")
    ),
    index("ai_memories_type_idx").using("btree", table.memoryType.asc().nullsLast().op("text_ops")),
  ]
);

export const aiMemoryChunks = pgTable(
  "ai_memory_chunks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    memoryId: uuid("memory_id").notNull(),
    content: text().notNull(),
    embedding: vector({ dimensions: 1536 }),
    chunkIndex: integer("chunk_index").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    metadata: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ai_chunks_embedding_idx").using(
      "ivfflat",
      table.embedding.asc().nullsLast().op("vector_cosine_ops")
    ),
    index("ai_chunks_memory_idx").using("btree", table.memoryId.asc().nullsLast().op("uuid_ops")),
    foreignKey({
      columns: [table.memoryId],
      foreignColumns: [aiMemories.id],
      name: "ai_memory_chunks_memory_id_ai_memories_id_fk",
    }).onDelete("cascade"),
  ]
);

export const rooms = pgTable("rooms", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: varchar({ length: 200 }).notNull(),
  capacity: integer().default(1).notNull(),
});

export const reservations = pgTable(
  "reservations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    roomId: uuid("room_id").notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    startTime: timestamp("start_time", { withTimezone: true, mode: "string" }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true, mode: "string" }).notNull(),
    status: reservationStatus().default("confirmed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.roomId],
      foreignColumns: [rooms.id],
      name: "reservations_room_id_rooms_id_fk",
    }).onDelete("cascade"),
  ]
);

export const amenities = pgTable("amenities", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: varchar({ length: 200 }).notNull(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: varchar({ length: 300 }).notNull(),
    targetDepartment: varchar("target_department", { length: 200 }).notNull(),
    status: documentStatus().default("DRAFT").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("docs_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
  ]
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    documentId: uuid("document_id").notNull(),
    versionNumber: varchar("version_number", { length: 20 }).notNull(),
    fileUrl: text("file_url").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    versionStatus: versionStatus("version_status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("dv_active_idx").using(
      "btree",
      table.documentId.asc().nullsLast().op("bool_ops"),
      table.isActive.asc().nullsLast().op("bool_ops")
    ),
    index("dv_document_idx").using("btree", table.documentId.asc().nullsLast().op("uuid_ops")),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "document_versions_document_id_documents_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academyCourses = pgTable(
  "academy_courses",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: varchar({ length: 300 }).notNull(),
    slug: varchar({ length: 300 }).notNull(),
    description: text(),
    content: jsonb(),
    thumbnailUrl: text("thumbnail_url"),
    status: academyCourseStatus().default("draft").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ac_slug_idx").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    index("ac_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
  ]
);

export const academyEnrollments = pgTable(
  "academy_enrollments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    courseId: uuid("course_id").notNull(),
    status: academyEnrollmentStatus().default("enrolled").notNull(),
    topicsCompleted: integer("topics_completed").default(0).notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("ae_user_course_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.courseId.asc().nullsLast().op("text_ops")
    ),
    index("ae_user_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.courseId],
      foreignColumns: [academyCourses.id],
      name: "academy_enrollments_course_id_academy_courses_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academyQuizzes = pgTable(
  "academy_quizzes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    courseId: uuid("course_id").notNull(),
    title: varchar({ length: 300 }).notNull(),
    description: text(),
    passingScore: real("passing_score").default(70).notNull(),
    maxAttempts: integer("max_attempts").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("aq_course_idx").using("btree", table.courseId.asc().nullsLast().op("uuid_ops")),
    foreignKey({
      columns: [table.courseId],
      foreignColumns: [academyCourses.id],
      name: "academy_quizzes_course_id_academy_courses_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academyQuestions = pgTable(
  "academy_questions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    quizId: uuid("quiz_id").notNull(),
    questionText: text("question_text").notNull(),
    options: jsonb().notNull(),
    correctOptionIndex: integer("correct_option_index").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("aqq_quiz_idx").using("btree", table.quizId.asc().nullsLast().op("uuid_ops")),
    index("aqq_sort_idx").using(
      "btree",
      table.quizId.asc().nullsLast().op("int4_ops"),
      table.sortOrder.asc().nullsLast().op("int4_ops")
    ),
    foreignKey({
      columns: [table.quizId],
      foreignColumns: [academyQuizzes.id],
      name: "academy_questions_quiz_id_academy_quizzes_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academyQuizAttempts = pgTable(
  "academy_quiz_attempts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    quizId: uuid("quiz_id").notNull(),
    score: real().notNull(),
    passed: boolean().notNull(),
    totalQuestions: integer("total_questions").notNull(),
    correctAnswers: integer("correct_answers").notNull(),
    answers: jsonb().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("aqa_quiz_idx").using("btree", table.quizId.asc().nullsLast().op("uuid_ops")),
    index("aqa_user_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.quizId],
      foreignColumns: [academyQuizzes.id],
      name: "academy_quiz_attempts_quiz_id_academy_quizzes_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academySatisfactionSurveys = pgTable(
  "academy_satisfaction_surveys",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    courseId: uuid("course_id").notNull(),
    rating: integer().notNull(),
    comments: text(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ass_user_course_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
      table.courseId.asc().nullsLast().op("text_ops")
    ),
    foreignKey({
      columns: [table.courseId],
      foreignColumns: [academyCourses.id],
      name: "academy_satisfaction_surveys_course_id_academy_courses_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academyTopics = pgTable(
  "academy_topics",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    courseId: uuid("course_id").notNull(),
    title: varchar({ length: 300 }).notNull(),
    content: jsonb(),
    videoUrl: text("video_url"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("at_course_idx").using("btree", table.courseId.asc().nullsLast().op("uuid_ops")),
    index("at_sort_idx").using(
      "btree",
      table.courseId.asc().nullsLast().op("int4_ops"),
      table.sortOrder.asc().nullsLast().op("int4_ops")
    ),
    foreignKey({
      columns: [table.courseId],
      foreignColumns: [academyCourses.id],
      name: "academy_topics_course_id_academy_courses_id_fk",
    }).onDelete("cascade"),
  ]
);

export const academyUserProgress = pgTable(
  "academy_user_progress",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    topicId: uuid("topic_id").notNull(),
    courseId: uuid("course_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("aup_user_course_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
      table.courseId.asc().nullsLast().op("text_ops")
    ),
    uniqueIndex("aup_user_topic_idx").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
      table.topicId.asc().nullsLast().op("text_ops")
    ),
    foreignKey({
      columns: [table.topicId],
      foreignColumns: [academyTopics.id],
      name: "academy_user_progress_topic_id_academy_topics_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.courseId],
      foreignColumns: [academyCourses.id],
      name: "academy_user_progress_course_id_academy_courses_id_fk",
    }).onDelete("cascade"),
  ]
);

export const webhooksConfig = pgTable(
  "webhooks_config",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    datasetId: uuid("dataset_id").notNull(),
    event: webhookEvent().notNull(),
    targetUrl: text("target_url").notNull(),
    secret: varchar({ length: 255 }),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("wh_config_dataset_idx").using("btree", table.datasetId.asc().nullsLast().op("uuid_ops")),
    index("wh_config_event_idx").using("btree", table.event.asc().nullsLast().op("enum_ops")),
    foreignKey({
      columns: [table.datasetId],
      foreignColumns: [dataSets.id],
      name: "webhooks_config_dataset_id_data_sets_id_fk",
    }).onDelete("cascade"),
  ]
);

export const webhooksLog = pgTable(
  "webhooks_log",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    webhookId: uuid("webhook_id").notNull(),
    event: varchar({ length: 50 }).notNull(),
    payload: jsonb().notNull(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    success: boolean().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    index("wh_log_attempted_idx").using(
      "btree",
      table.attemptedAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("wh_log_webhook_idx").using("btree", table.webhookId.asc().nullsLast().op("uuid_ops")),
    foreignKey({
      columns: [table.webhookId],
      foreignColumns: [webhooksConfig.id],
      name: "webhooks_log_webhook_id_webhooks_config_id_fk",
    }).onDelete("cascade"),
  ]
);

export const contentMetadata = pgTable(
  "content_metadata",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entryId: uuid("entry_id").notNull(),
    slug: varchar({ length: 500 }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    seoMetadata: jsonb("seo_metadata"),
    featuredImageId: uuid("featured_image_id"),
    authorId: text("author_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("cm_entry_unique").using("btree", table.entryId.asc().nullsLast().op("uuid_ops")),
    index("cm_published_idx").using(
      "btree",
      table.publishedAt.asc().nullsLast().op("timestamptz_ops")
    ),
    uniqueIndex("cm_slug_unique").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    foreignKey({
      columns: [table.entryId],
      foreignColumns: [dataEntries.id],
      name: "content_metadata_entry_id_data_entries_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.featuredImageId],
      foreignColumns: [media.id],
      name: "content_metadata_featured_image_id_media_id_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.authorId],
      foreignColumns: [authUsers.id],
      name: "content_metadata_author_id_auth_users_id_fk",
    }).onDelete("set null"),
  ]
);

export const agentTraces = pgTable(
  "agent_traces",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    agentId: text("agent_id").notNull(),
    sessionId: text("session_id"),
    name: text(),
    input: jsonb(),
    output: jsonb(),
    totalDurationMs: integer("total_duration_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    estimatedCost: doublePrecision("estimated_cost"),
    status: agentTraceStatus().default("pending").notNull(),
    errorMessage: text("error_message"),
    metadata: jsonb().default({}),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_traces_agent_created_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.asc().nullsLast().op("text_ops")
    ),
    index("agent_traces_agent_id_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("text_ops")
    ),
    index("agent_traces_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("agent_traces_session_id_idx").using(
      "btree",
      table.sessionId.asc().nullsLast().op("text_ops")
    ),
    index("agent_traces_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
  ]
);

export const agentTraceSteps = pgTable(
  "agent_trace_steps",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    traceId: uuid("trace_id").notNull(),
    stepOrder: integer("step_order").default(0).notNull(),
    stepType: agentTraceStepType("step_type").notNull(),
    content: text(),
    reasoning: text(),
    toolName: text("tool_name"),
    toolInput: jsonb("tool_input"),
    toolOutput: jsonb("tool_output"),
    durationMs: integer("duration_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    errorMessage: text("error_message"),
    metadata: jsonb().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_trace_steps_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("agent_trace_steps_trace_id_idx").using(
      "btree",
      table.traceId.asc().nullsLast().op("uuid_ops")
    ),
    index("agent_trace_steps_trace_order_idx").using(
      "btree",
      table.traceId.asc().nullsLast().op("int4_ops"),
      table.stepOrder.asc().nullsLast().op("int4_ops")
    ),
    index("agent_trace_steps_type_idx").using(
      "btree",
      table.stepType.asc().nullsLast().op("enum_ops")
    ),
    foreignKey({
      columns: [table.traceId],
      foreignColumns: [agentTraces.id],
      name: "agent_trace_steps_trace_id_fk",
    }).onDelete("cascade"),
  ]
);

export const agentFeedback = pgTable(
  "agent_feedback",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    traceId: uuid("trace_id").notNull(),
    rating: integer(),
    comment: text(),
    providedBy: text("provided_by"),
    source: text().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_feedback_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("agent_feedback_rating_idx").using(
      "btree",
      table.rating.asc().nullsLast().op("int4_ops")
    ),
    index("agent_feedback_trace_id_idx").using(
      "btree",
      table.traceId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.traceId],
      foreignColumns: [agentTraces.id],
      name: "agent_feedback_trace_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.providedBy],
      foreignColumns: [authUsers.id],
      name: "agent_feedback_provided_by_fk",
    }).onDelete("set null"),
    unique("agent_feedback_trace_id_unique").on(table.traceId),
  ]
);

export const roomAmenities = pgTable(
  "room_amenities",
  {
    roomId: uuid("room_id").notNull(),
    amenityId: uuid("amenity_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.roomId],
      foreignColumns: [rooms.id],
      name: "room_amenities_room_id_rooms_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.amenityId],
      foreignColumns: [amenities.id],
      name: "room_amenities_amenity_id_amenities_id_fk",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.roomId, table.amenityId],
      name: "room_amenities_room_id_amenity_id_pk",
    }),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════
// Agent System Tables (NHI - Non-Human Identities)
// ═══════════════════════════════════════════════════════════════════════════

export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").default("custom").notNull(),
    scopes: jsonb("scopes").default([]),
    rateLimit: integer("rate_limit").default(60),
    capabilities: jsonb("capabilities").default([]),
    systemPrompt: text("system_prompt"),
    allowedTools: jsonb("allowed_tools").default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_identities_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
    index("agent_identities_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops")
    ),
  ]
);

export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: text("id").primaryKey().notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("agent_api_keys_agent_id_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("text_ops")
    ),
    uniqueIndex("agent_api_keys_hash_idx").using(
      "btree",
      table.keyHash.asc().nullsLast().op("text_ops")
    ),
    index("agent_api_keys_expires_at_idx").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops")
    ),
  ]
);

export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    memoryType: text("memory_type").default("short_term").notNull(),
    category: text("category").default("general").notNull(),
    key: text("key"),
    content: jsonb("content").notNull(),
    summary: text("summary"),
    importance: integer("importance").default(50),
    confidence: integer("confidence").default(80),
    source: text("source").default("agent"),
    relatedMemoryIds: jsonb("related_memory_ids").default([]),
    tags: jsonb("tags").default([]),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "string" }).defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "string" }),
    accessCount: integer("access_count").default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_memory_agent_type_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("text_ops"),
      table.memoryType.asc().nullsLast().op("text_ops")
    ),
    index("agent_memory_category_idx").using(
      "btree",
      table.category.asc().nullsLast().op("text_ops")
    ),
    index("agent_memory_key_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("text_ops"),
      table.key.asc().nullsLast().op("text_ops")
    ),
  ]
);

export const agentAuditLogs = pgTable(
  "agent_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    keyId: text("key_id"),
    action: text("action").notNull(),
    resource: text("resource"),
    resourceId: text("resource_id"),
    details: jsonb("details").default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    durationMs: integer("duration_ms"),
    success: boolean().default(true).notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_audit_agent_id_idx").using(
      "btree",
      table.agentId.asc().nullsLast().op("text_ops")
    ),
    index("agent_audit_created_at_idx").using(
      "btree",
      table.createdAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("agent_audit_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
  ]
);
