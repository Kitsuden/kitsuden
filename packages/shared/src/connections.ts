/**
 * Connections: the contract (docs/connections.md)
 * ============================================================================
 *
 * Accounts at other services (a person's Google or Microsoft 365 mailbox, the organization's Stripe or
 * Resend key), connected once in the core and used by every kon that needs one. A kon never sees a
 * token or a key: it asks `ctx.connections.client(...)` for a `fetch` that adds the credential itself and
 * only sends it, over https, to the provider's own hosts.
 *
 *   const google = await ctx.connections.client("kon-inbox", {
 *     provider: "google",
 *     ownerId: userId,                 // that person's own connection; omit for the organization's
 *     scopeSets: ["mail.read"],
 *     purpose: "sync mail",            // recorded, with the kon's id, every time the credential opens
 *   });
 *   const res = await google.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
 *
 * Like `ctx.secrets`, every method takes the calling kon's id first; the host binds it, and a kon that
 * passes another id is refused.
 */

/** A connection as every route and every kon sees it: never a credential. */
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

/** What a kon asks for. */
export interface ConnectionRequest {
  provider: string;
  /** A person's own connection; without it, the organization's. */
  ownerId?: string | null;
  /** One connection in particular (it must still match `provider` and the owner). */
  connectionId?: string;
  /** Named scope sets the connection must cover (`mail.read`). */
  scopeSets?: string[];
  /** Why the credential is opened, for the access log. Never a token. */
  purpose: string;
  /** The person the work is done for, if any. */
  actorUserId?: string | null;
}

export interface ConnectedClient {
  connection: PublicConnection;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** A provider a kon adds to the catalog (an API key service, typically). */
export interface ConnectionProviderDefinition {
  /** `stripe`, `resend`: lower case, the id stored on each connection. */
  id: string;
  name: string;
  authTypes: Array<"oauth" | "api_key">;
  /** Named scope sets a kon or a person may ask for. */
  scopeSets: Record<string, { description: string; scopes: string[] }>;
  /** Hosts the credential may be sent to (https only). */
  apiHosts: string[];
  /** How an API key goes on a request. Default `Authorization: Bearer <key>`; `encode` for anything else. */
  apiKeyHeader?: { name: string; prefix?: string; encode?: (key: string) => string };
}

export interface KonConnections {
  /** A client for the best active connection that matches; throws when none does. */
  client(konId: string, request: ConnectionRequest): Promise<ConnectedClient>;
  /**
   * Adds a provider to the catalog, owned by this kon. Google and Microsoft, and a provider another kon
   * registered, cannot be replaced.
   */
  registerProvider(konId: string, provider: ConnectionProviderDefinition): void;
  /** A connection as the CALLER of the current request may see it (row security), or `null`. */
  visible(konId: string, connectionId: string): Promise<PublicConnection | null>;
  /** Whether granted scopes cover the named sets of a provider. */
  covers(provider: string, grantedScopes: string[], scopeSets: string[]): boolean;
}

/** The events the core emits about connections. */
export const CONNECTION_EVENTS = {
  created: "connections:connection.created",
  expired: "connections:connection.expired",
  revoked: "connections:connection.revoked",
} as const;
