/**
 * Kitsuden — Hono RPC surface (KITSUDEN architecture §7)
 *
 * CHAINED composition of the routers that expose deep types to the
 * client. Unlike a loose `app.route()` (which does not accumulate types),
 * this chain preserves Hono RPC's end-to-end inference.
 *
 * INCREMENTAL MIGRATION PATTERN:
 * Each legacy router converted to chained syntax (defined as a single
 * `new Hono().get(...).post(...)` expression + zValidator) is added
 * here with one more `.route(...)`. The rest of the API keeps working the same;
 * this only improves the client's DX.
 *
 * Usage on the client (no codegen):
 * ```typescript
 * import { hc } from "hono/client";
 * import type { KitsudenRpcType } from "@kitsuden/api"; // or a path relative to the monorepo
 *
 * const rpc = hc<KitsudenRpcType>("http://localhost:3001");
 * const res = await rpc.api.graph[":table"].$get({
 *   param: { table: "games" },
 *   query: { limit: "10" },
 * });
 * const data = await res.json(); // ← typed per endpoint 🎉
 * ```
 */

import { Hono } from "hono";

import { agentsV1Routes } from "./routes/agents-v1";
import { datasetsQueryRoutes } from "./routes/datasets-query";
import { graphifyRoutes } from "./routes/graphify";
import { itemsRoutes } from "./routes/items";
import { secretsRoutes } from "./routes/secrets";
import { vaultRoutes } from "./routes/vault";

/**
 * Mountable RPC surface: index.ts does `app.route("/", rpcSurface)` and the
 * path middlewares (transactional RLS, rate limiting, admin guard) apply
 * just the same because they are registered on the same /api/* routes.
 */
export const rpcSurface = new Hono()
  .route("/api/graph", graphifyRoutes)
  .route("/api/admin/secrets", secretsRoutes)
  .route("/api/admin/vault", vaultRoutes)
  .route("/api/items", itemsRoutes)
  .route("/api/datasets", datasetsQueryRoutes)
  .route("/api/v1", agentsV1Routes);

/**
 * Deep RPC type — grows with each router migrated to chained syntax.
 * Migrated: graphify, secrets, vault, items, datasets-query, agents-v1.
 * Next candidates: crud, functions, data-explorer.
 */
export type KitsudenRpcType = typeof rpcSurface;
