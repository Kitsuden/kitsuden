/**
 * OAuth 2.1 tables for MCP (migration 0055_oauth_for_mcp.sql)
 * ============================================================================
 *
 * In their own file (not in schema-core.ts) so as not to touch the common schema:
 * only `lib/oauth/` uses them, with drizzle's query builder (they do not
 * need to be registered in the relational schema). See docs/agents/oauth.md.
 */
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { agentApiKeys, agentIdentities } from "./schema-core";

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    kind: text("kind").default("dcr").notNull(),
    clientName: text("client_name").notNull(),
    clientUri: text("client_uri"),
    logoUri: text("logo_uri"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().default([]).notNull(),
    grantTypes: jsonb("grant_types")
      .$type<string[]>()
      .default(["authorization_code", "refresh_token"])
      .notNull(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").default("none").notNull(),
    secretHash: text("secret_hash"),
    registeredIp: text("registered_ip"),
    metadataExpiresAt: timestamp("metadata_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("oauth_clients_created_at_idx").on(t.createdAt)]
);

export const oauthAuthorizationRequests = pgTable(
  "oauth_authorization_requests",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .references(() => oauthClients.id, { onDelete: "cascade" })
      .notNull(),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    requestedScopes: jsonb("requested_scopes").$type<string[]>().default([]).notNull(),
    resource: text("resource").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("oauth_authorization_requests_expires_idx").on(t.expiresAt)]
);

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .references(() => oauthClients.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id")
      .references(() => agentIdentities.id, { onDelete: "cascade" })
      .notNull(),
    keyId: text("key_id")
      .references(() => agentApiKeys.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    resource: text("resource").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    index("oauth_grants_agent_idx").on(t.agentId),
    index("oauth_grants_client_idx").on(t.clientId),
    index("oauth_grants_user_idx").on(t.userId),
    uniqueIndex("oauth_grants_key_idx").on(t.keyId),
  ]
);

export const oauthCodes = pgTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    grantId: text("grant_id")
      .references(() => oauthGrants.id, { onDelete: "cascade" })
      .notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    familyId: text("family_id"),
  },
  (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)]
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    grantId: text("grant_id")
      .references(() => oauthGrants.id, { onDelete: "cascade" })
      .notNull(),
    familyId: text("family_id").notNull(),
    clientId: text("client_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    resource: text("resource").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    familyExpiresAt: timestamp("family_expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("oauth_tokens_hash_idx").on(t.tokenHash),
    index("oauth_tokens_family_idx").on(t.familyId),
    index("oauth_tokens_grant_idx").on(t.grantId),
    index("oauth_tokens_expires_idx").on(t.expiresAt),
  ]
);
