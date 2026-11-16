/**
 * /api/connections: connecting accounts, and seeing and revoking them (docs/connections.md)
 * ============================================================================
 *
 * Mounted with the request's RLS transaction (`mountKonRls`): a person reads and changes only their own
 * `user` connections, an admin the `organization` ones and nobody's personal one (migration 0082). The
 * OAuth callback has no session (the provider redirects the browser); the `state` authenticates it, and it
 * runs as the system.
 *
 * An agent can list and refresh the connections of the person it acts for, and never starts a consent or
 * stores a key: connecting an account is a person's decision.
 */

import { defineOperation } from "@kitsuden/shared";
import { and, desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";

// Deep imports, not the facade: the facade reaches the loader, which reaches the routes.
import { AppError } from "../../../../packages/engine/src/errors";
import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { resolveExecutor } from "../../../../packages/engine/src/request-scope";
import { db } from "../db";
import { announceConnection } from "../lib/connections";
import { describeProvider, providers } from "../lib/connections/providers";
import { connConnections, publicConnection, type ConnectionRow } from "../lib/connections/schema";
import {
  ConnectionError,
  addApiKey,
  completeOAuth,
  refreshConnection,
  revokeConnection,
  startOAuth,
  type Fetch,
} from "../lib/connections/service";
import { registerCoreOperations } from "../lib/core-operations";
import { konSecrets } from "../lib/kon-secrets";
import { optionalAuth, requireAuth } from "../middleware/auth";

export const CONNECTIONS_KON = "kon-connections";
export const CONNECTIONS_ROUTE = "/api/connections";

// ── Helpers ─────────────────────────────────────────────────────────────────

const requestDb = () => resolveExecutor(db) as typeof db;

function toAppError(err: unknown): never {
  if (err instanceof ConnectionError) {
    const details = { code: err.code };
    if (err.status === 404) throw AppError.notFound(err.message, details);
    if (err.status === 403) throw AppError.forbidden(err.message, details);
    if (err.status === 409) throw AppError.conflict(err.message, details);
    if (err.status === 422) throw AppError.validation(err.message, details);
    if (err.status === 400) throw AppError.badRequest(err.message, details);
    throw new AppError("INTERNAL", err.message, { status: err.status, expose: true, details });
  }
  throw err;
}

/** Origins a person may be sent back to: `CONNECTIONS_RETURN_ORIGINS`, else `ALLOWED_ORIGINS`. */
export function allowedReturn(url: string | null | undefined, env = process.env): boolean {
  if (!url) return false;
  const origins = new Set<string>();
  for (const part of [env.CONNECTIONS_RETURN_ORIGINS, env.ALLOWED_ORIGINS]
    .filter(Boolean)
    .join(",")
    .split(",")) {
    try {
      const u = new URL(part.trim());
      if (u.protocol === "https:" || u.protocol === "http:") origins.add(u.origin);
    } catch {
      /* malformed: ignored */
    }
  }
  try {
    const u = new URL(url);
    return !u.username && !u.password && origins.has(u.origin);
  } catch {
    return false;
  }
}

/** Where the provider sends the person back: `CONNECTIONS_CALLBACK_URL`, else this API's own route. */
export function callbackUrl(env = process.env): string {
  if (env.CONNECTIONS_CALLBACK_URL) return env.CONNECTIONS_CALLBACK_URL;
  const base = (env.BETTER_AUTH_URL || env.API_URL || "").replace(/\/$/, "");
  return `${base}${CONNECTIONS_ROUTE}/oauth/callback`;
}

function person(
  user: { id?: string; role?: string } | null,
  what: string
): { id: string; role: string } {
  if (!user?.id || user.role === "agent")
    throw AppError.forbidden(`${what} is a person's decision`);
  return { id: user.id, role: user.role ?? "user" };
}

/**
 * Whose connections the caller may touch, said in the query as well as by row security: a person their own
 * `user` connections, an admin the organization's. The two agree; the query is what still holds where the
 * connection does not drop privileges (a superuser test database, a misconfigured role).
 */
function mine(user: { id?: string; role?: string } | null): SQL {
  if (!user?.id) return eq(connConnections.id, "00000000-0000-0000-0000-000000000000");
  const own = and(eq(connConnections.scope, "user"), eq(connConnections.ownerId, user.id))!;
  if (user.role !== "admin") return own;
  return and(eq(connConnections.scope, "organization"), isNull(connConnections.ownerId))!;
}

async function visible(
  id: string,
  user: { id?: string; role?: string } | null
): Promise<ConnectionRow> {
  const [row] = await requestDb()
    .select()
    .from(connConnections)
    .where(and(eq(connConnections.id, id), user?.role === "admin" ? undefined : mine(user)))
    .limit(1);
  // An admin also manages their OWN personal connections; never anyone else's.
  if (row && user?.role === "admin" && !(row.scope === "organization" || row.ownerId === user.id)) {
    throw AppError.notFound("Connection not found");
  }
  if (!row) throw AppError.notFound("Connection not found");
  return row as ConnectionRow;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const Connection = z.object({}).passthrough();
const Scope = z
  .enum(["user", "organization"])
  .describe("`user`: your own account. `organization`: the installation's (admin)");
const Start = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(40)
      .describe("`google` or `microsoft` (GET /providers lists them)"),
    scope: Scope.default("user"),
    scopeSets: z
      .array(z.string().min(1).max(60))
      .max(20)
      .default([])
      .describe("What to ask for: `mail.read`, `mail.send`, `calendar.read`"),
    returnTo: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe("Where to send the person after consenting: one of the site's origins"),
    label: z.string().max(200).optional(),
  })
  .strict();
const ApiKey = z
  .object({
    provider: z.string().min(1).max(40),
    scope: Scope.default("organization"),
    apiKey: z.string().min(8).max(4096).describe("Stored sealed; never returned"),
    label: z.string().max(200).optional(),
    accountId: z.string().max(200).optional(),
  })
  .strict();
const Callback = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
});
const ParamId = z.object({ id: z.string().uuid().describe("The connection") });

const session = { access: "session" as const };

/** `network` lets a test answer for the providers. */
export function connectionsOperations(network: Fetch = (u, i) => fetch(u, i)): AnyOperation[] {
  return [
    defineOperation({
      ...session,
      id: "list-providers",
      method: "GET",
      route: "/providers",
      tags: ["connections"],
      summary: "The providers you can connect",
      description:
        "Each provider in the catalog: `id`, `name`, how it connects (`oauth`, `api_key`), whether this installation has it `configured`, and the scope sets you can ask for. Never a secret. Signed-in people.",
      output: { schema: z.object({ data: z.array(z.object({}).passthrough()) }) },
      handle: async () => ({ data: providers().map(describeProvider) }),
    }),

    defineOperation({
      ...session,
      id: "list-connections",
      method: "GET",
      route: "/connections",
      tags: ["connections"],
      summary: "Your connections",
      description:
        "Your connected accounts, and the organization's if you are an admin: provider, account, granted scopes, status (`active`, `expired`, `revoked`, `error`), expiry and last use. Never a token or a key. Nobody sees another person's connections, an admin included.",
      output: { schema: z.object({ data: z.array(Connection) }) },
      handle: async (_input, h) => {
        const own = h.user?.id
          ? and(eq(connConnections.scope, "user"), eq(connConnections.ownerId, h.user.id))
          : undefined;
        const where = h.user?.role === "admin" && own ? or(own, mine(h.user)) : mine(h.user);
        const rows = await requestDb()
          .select()
          .from(connConnections)
          .where(where)
          .orderBy(desc(connConnections.createdAt))
          .limit(200);
        return { data: (rows as ConnectionRow[]).map(publicConnection) };
      },
    }),

    defineOperation({
      ...session,
      id: "get-connection",
      method: "GET",
      route: "/connections/:id",
      tags: ["connections"],
      summary: "One connection and its status",
      description:
        "One of your connections (or an organization's, for an admin), without its credential. 404 if it is not yours.",
      input: { params: ParamId },
      output: { schema: z.object({ data: Connection }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, h) => ({
        data: publicConnection(await visible((input.params as { id: string }).id, h.user)),
      }),
    }),

    defineOperation({
      ...session,
      id: "start-connection",
      method: "POST",
      route: "/oauth/start",
      tags: ["connections"],
      summary: "Start connecting an account (OAuth)",
      description:
        "Returns the provider's consent `url` to send the person to; it is valid for ten minutes and works once (PKCE). `scope: organization` is admin only. `returnTo` must be one of the site's origins (CONNECTIONS_RETURN_ORIGINS or ALLOWED_ORIGINS). 404 for an unknown provider, 422 for an unknown scope set, 503 when the provider is not configured here or this Kitsuden has no secrets key. A person only.",
      input: { body: Start },
      output: { schema: z.object({ data: z.object({ url: z.string(), expiresAt: z.string() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
      mcp: { exclude: "A consent happens in a browser, by a person." },
      handle: async (input, h) => {
        const user = person(h.user, "Connecting an account");
        const body = input.body as z.infer<typeof Start>;
        if (body.scope === "organization" && user.role !== "admin")
          throw AppError.forbidden("Only an admin connects the organization's account");
        if (body.returnTo && !allowedReturn(body.returnTo))
          throw AppError.validation("returnTo is not one of the site's origins");
        try {
          const data = await startOAuth(requestDb(), konSecrets, {
            provider: body.provider,
            scope: body.scope,
            userId: user.id,
            scopeSets: body.scopeSets,
            redirectUri: callbackUrl(),
            returnTo: body.returnTo ?? null,
            label: body.label,
          });
          return { data };
        } catch (err) {
          toAppError(err);
        }
      },
    }),

    defineOperation({
      access: "public",
      id: "finish-connection",
      method: "GET",
      route: "/oauth/callback",
      tags: ["connections"],
      summary: "Where the provider sends the person back",
      description:
        "The provider's redirect after consent. The `state` authenticates it (one use, ten minutes); no session is needed. Exchanges the code, stores the credential sealed, and redirects to `returnTo` with `?connection=<id>`, or answers JSON without one. 400 for an unknown, used or refused consent.",
      input: { query: Callback },
      output: { schema: z.object({ data: Connection }), otherStatuses: [302] },
      mcp: { exclude: "The provider's browser redirect, not a tool." },
      handle: async (input, h) => {
        const q = input.query as z.infer<typeof Callback>;
        try {
          if (q.error || !q.code || !q.state) {
            throw new ConnectionError(
              `The provider did not connect the account (${q.error ?? "no code"})`,
              400,
              "CONSENT_DENIED"
            );
          }
          // As the system: no session, and the state names the owner.
          const done = await completeOAuth(db, konSecrets, {
            state: q.state,
            code: q.code,
            redirectUri: callbackUrl(),
            fetch: network,
          });
          if (done.created) announceConnection("created", done.connection);
          if (done.returnTo && allowedReturn(done.returnTo)) {
            const to = new URL(done.returnTo);
            to.searchParams.set("connection", done.connection.id);
            return h.c.redirect(to.toString(), 302);
          }
          return { data: publicConnection(done.connection) };
        } catch (err) {
          toAppError(err);
        }
      },
    }),

    defineOperation({
      ...session,
      id: "add-api-key",
      method: "POST",
      route: "/api-keys",
      tags: ["connections"],
      summary: "Connect a provider with an API key",
      description:
        "Stores an API key for a provider that takes one (registered by a kon: `stripe`, `resend`…), sealed; it is never returned. `scope: organization` (the default) is admin only; `user` is your own. 404 for an unknown provider, 422 for a provider that connects with OAuth or a key that does not look like one, 503 without a secrets key. A person only.",
      input: { body: ApiKey },
      output: { status: 201, schema: z.object({ data: Connection }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
      mcp: { exclude: "A key is typed by a person, not passed through an agent." },
      handle: async (input, h) => {
        const user = person(h.user, "Storing a key");
        const body = input.body as z.infer<typeof ApiKey>;
        if (body.scope === "organization" && user.role !== "admin")
          throw AppError.forbidden("Only an admin connects the organization's account");
        try {
          const row = await addApiKey(requestDb(), konSecrets, { ...body, userId: user.id });
          announceConnection("created", row);
          return { data: publicConnection(row) };
        } catch (err) {
          toAppError(err);
        }
      },
    }),

    defineOperation({
      ...session,
      id: "refresh-connection",
      method: "POST",
      route: "/connections/:id/refresh",
      tags: ["connections"],
      summary: "Check a connection and refresh its token now",
      description:
        "Refreshes an OAuth connection's access token now and returns `outcome`: `refreshed`, `expired` (connect it again), `failed` (the provider did not answer; try later) or `not-needed` (an API key). 404 if it is not yours.",
      input: { params: ParamId },
      output: { schema: z.object({ data: Connection, outcome: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, h) => {
        const row = await visible((input.params as { id: string }).id, h.user);
        try {
          const r = await refreshConnection(requestDb(), konSecrets, row, {
            fetch: network,
            force: true,
            actorUserId: h.user?.id ?? null,
          });
          if (r.outcome === "expired")
            announceConnection("expired", r.connection, { reason: r.connection.lastError });
          return { data: publicConnection(r.connection), outcome: r.outcome };
        } catch (err) {
          toAppError(err);
        }
      },
    }),

    defineOperation({
      ...session,
      id: "revoke-connection",
      method: "POST",
      route: "/connections/:id/revoke",
      tags: ["connections"],
      sensitive: true,
      summary: "Disconnect an account",
      description:
        "Revokes the token at the provider when it allows it, deletes the credential, and keeps the connection as `revoked` for the record. Kons using it stop at once (kon-inbox deletes what it synced from it). Cannot be undone: connect again instead. 404 if it is not yours.",
      input: { params: ParamId },
      output: { schema: z.object({ data: Connection, atProvider: z.boolean() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, h) => {
        const row = await visible((input.params as { id: string }).id, h.user);
        const r = await revokeConnection(requestDb(), konSecrets, row, {
          fetch: network,
          actorUserId: h.user?.id ?? null,
        });
        if (row.status !== "revoked") announceConnection("revoked", r.connection);
        return { data: publicConnection(r.connection), atProvider: r.atProvider };
      },
    }),
  ];
}

export const connectionsKon = {
  id: CONNECTIONS_KON,
  name: "Connections",
  version: "1.0.0",
  mountPath: CONNECTIONS_ROUTE,
  operations: connectionsOperations(),
};

registerCoreOperations({
  konId: CONNECTIONS_KON,
  mountPath: CONNECTIONS_ROUTE,
  description:
    "Accounts at other services (Google, Microsoft, API keys) that kons use without seeing a credential.",
  operations: connectionsKon.operations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const connectionsRoutes = operationsRouter(
  CONNECTIONS_KON,
  connectionsKon.operations,
  context
);

/** A router with a provider double, for tests. */
export function connectionsRouterFor(network: Fetch) {
  return operationsRouter(CONNECTIONS_KON, connectionsOperations(network), context);
}
