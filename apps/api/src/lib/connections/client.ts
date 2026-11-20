/**
 * What a kon gets: a client, never a token
 * ============================================================================
 *
 * `fetch` adds the credential itself, refreshes it first when it is about to run out, and refuses any URL
 * whose host is not on the provider's list (providers.ts): a URL built from data (a link in an email, a
 * webhook payload) can never carry the credential elsewhere. The credential is a local of `fetch`; it is
 * not on the client object, not in an error, not in a log.
 *
 * The connection is looked up and used as the system (a kon calls this from a worker, without a request),
 * so the kon is responsible for asking for the right `ownerId`; the owner always counts, a `connectionId`
 * included.
 *
 * A 401 from the provider is answered once with a forced refresh and a retry; a second 401 marks the
 * connection `error` and is returned to the caller as is.
 */

import type { ConnectedClient, ConnectionRequest } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { connectionFetch, isPrivateHostAllowed } from "./network";
import { providerOf } from "./providers";
import { connConnections, publicConnection, type ConnectionRow } from "./schema";
import {
  ConnectionError,
  findConnection,
  openCredential,
  refreshConnection,
  type Credential,
  type Db,
  type Fetch,
  type Secrets,
} from "./service";

function authorize(row: ConnectionRow, credential: Credential, headers: Headers): void {
  if (row.authType === "api_key") {
    const provider = providerOf(row.provider);
    const header = provider?.apiKeyHeader ?? { name: "authorization", prefix: "Bearer " };
    const key = credential.apiKey ?? "";
    headers.set(header.name, header.encode ? header.encode(key) : `${header.prefix ?? ""}${key}`);
    return;
  }
  headers.set("authorization", `Bearer ${credential.accessToken ?? ""}`);
}

/**
 * Whether the credential may be sent to this URL: on one of the provider's hosts, over https. `http:` only
 * for a host the operator named in `CONNECTIONS_PRIVATE_HOSTS` (network.ts).
 */
export function allowedUrl(providerId: string, url: string): boolean {
  const provider = providerOf(providerId);
  if (!provider) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const secure =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isPrivateHostAllowed(parsed.hostname));
  return (
    secure && !parsed.username && !parsed.password && provider.apiHosts.includes(parsed.hostname)
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname || "that address";
  } catch {
    return "that address";
  }
}

/**
 * A client for the best connection that matches. `request.purpose` already names the kon (`kon-inbox:
 * sync mail`): it is what the access log shows.
 */
export async function clientFor(
  db: Db,
  secrets: Secrets | null,
  request: ConnectionRequest,
  // Pinned to the checked addresses; private ones only for CONNECTIONS_PRIVATE_HOSTS (network.ts).
  network: Fetch = connectionFetch
): Promise<ConnectedClient> {
  if (!secrets)
    throw new ConnectionError(
      "This Kitsuden cannot open credentials (no secrets key)",
      503,
      "SECRETS_UNAVAILABLE"
    );
  let row = await findConnection(db, request);
  if (!row) {
    throw new ConnectionError(
      `No ${request.provider} connection${request.ownerId ? " of that person" : " of the organization"} covers ${(request.scopeSets ?? []).join(", ") || "this"}`,
      404,
      "NO_CONNECTION"
    );
  }
  if (row.status !== "active") {
    throw new ConnectionError(
      `The ${row.provider} connection is ${row.status}: it must be connected again`,
      409,
      `CONNECTION_${row.status.toUpperCase()}`
    );
  }

  const send = async (
    url: string,
    init: RequestInit | undefined,
    force: boolean
  ): Promise<Response> => {
    if (row!.authType === "oauth") {
      const r = await refreshConnection(db, secrets, row!, {
        fetch: network,
        force,
        actorUserId: request.actorUserId ?? null,
      });
      row = r.connection;
      if (row.status !== "active") {
        throw new ConnectionError(
          `The ${row.provider} connection expired: it must be connected again`,
          409,
          "CONNECTION_EXPIRED"
        );
      }
    }
    const credential = await openCredential(
      secrets,
      row!,
      request.purpose,
      request.actorUserId ?? null
    );
    const headers = new Headers(init?.headers);
    authorize(row!, credential, headers);
    return network(url, { ...init, headers, redirect: "manual" });
  };

  return {
    connection: publicConnection(row),
    async fetch(url, init) {
      if (!allowedUrl(row!.provider, url)) {
        throw new ConnectionError(
          `The ${row!.provider} connection is not sent to ${safeHost(url)}`,
          403,
          "HOST_NOT_ALLOWED"
        );
      }
      let res = await send(url, init, false);
      if (res.status === 401 && row!.authType === "oauth") res = await send(url, init, true);
      const now = new Date();
      await db
        .update(connConnections)
        .set(
          res.status === 401
            ? {
                status: "error",
                lastError: "The provider refused the credential (401)",
                updatedAt: now,
              }
            : { lastUsedAt: now }
        )
        .where(eq(connConnections.id, row!.id));
      return res;
    },
  };
}
