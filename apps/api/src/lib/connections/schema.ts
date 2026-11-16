import { connConnections, connOauthStates } from "../../db/schema-core";

export { connConnections, connOauthStates };

/**
 * Connections to third-party accounts (the tables are in db/schema-core.ts, migration 0082)
 * ============================================================================
 *
 * `conn_connections`: one connected account (a Google mailbox, a Microsoft 365 tenant, an API key). The
 * credential is a `SealedSecret` in `credentials`, sealed with the installation's secrets key (lib/kon-secrets.ts); nothing
 * here, and no route, holds or returns it readable. Row security: a person sees their own `user`
 * connections, an admin the `organization` ones, and the system all (migration 0082).
 *
 * `conn_oauth_states`: one OAuth round trip in flight, ten minutes at most. The `state` is stored hashed,
 * the PKCE verifier sealed.
 */

/** What `ctx.secrets.seal` returns (Kitsuden's `SealedSecret`). */
export interface SealedValue {
  v: 1;
  kon: string;
  valueEncrypted: string;
  iv: string;
  authTag: string;
}

export type ConnectionRow = typeof connConnections.$inferSelect;

/** A connection as every route and every other kon sees it: no credential, ever. */
export interface PublicConnection {
  id: string;
  provider: string;
  scope: "user" | "organization";
  ownerId: string | null;
  authType: "oauth" | "api_key";
  label: string;
  accountId: string | null;
  accountEmail: string | null;
  grantedScopes: string[];
  status: "active" | "expired" | "revoked" | "error";
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

export function publicConnection(row: ConnectionRow): PublicConnection {
  return {
    id: row.id,
    provider: row.provider,
    scope: row.scope,
    ownerId: row.ownerId ?? null,
    authType: row.authType,
    label: row.label,
    accountId: row.accountId ?? null,
    accountEmail: row.accountEmail ?? null,
    grantedScopes: row.grantedScopes ?? [],
    status: row.status,
    expiresAt: iso(row.expiresAt),
    lastRefreshedAt: iso(row.lastRefreshedAt),
    lastUsedAt: iso(row.lastUsedAt),
    lastError: row.lastError ?? null,
    createdAt: iso(row.createdAt)!,
  };
}
