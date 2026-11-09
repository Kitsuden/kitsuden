/**
 * @kitsuden/sdk — Hono RPC Client (KITSUDEN architecture §7)
 *
 * Automatic SDK via Hono RPC: it links the `AppType` exported by the
 * server (apps/api/src/index.ts) with `hc<AppType>()` to get a
 * client with strict autocompletion WITHOUT generating intermediate files.
 *
 * `hono` is a peerDependency: the consumer must have it installed
 * (import from "hono/client" weighs ~2KB, edge-ready).
 *
 * @example
 * ```typescript
 * import { createRpcClient } from '@kitsuden/sdk/rpc';
 * import type { KitsudenRpcType } from '@kitsuden/api'; // deep RPC type (chained routers)
 * // import type { AppType } from '../../apps/api/src/index';
 *
 * const client = createRpcClient<KitsudenRpcType>('http://localhost:3001', {
 *   apiKey: 'kitsuden_agent_xxx',
 * });
 *
 * const res = await client.api.health.$get();
 * const health = await res.json(); // ← typed end-to-end
 * ```
 */

import type { Hono } from "hono";
import { hc } from "hono/client";

export interface RpcClientOptions {
  /** Agent NHI token (kitsuden_agent_*) o API key legacy */
  apiKey?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** custom fetch (for edge runtimes or testing) */
  fetch?: typeof fetch;
}

/**
 * Creates a typed Hono RPC client against the server's AppType.
 * No codegen, no build steps: the types flow straight from Hono.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRpcClient<T extends Hono<any, any, any>>(
  baseUrl: string,
  options: RpcClientOptions = {}
): ReturnType<typeof hc<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;

  return hc<T>(baseUrl, {
    headers,
    // hono/client accepts a custom fetch; undefined uses the global one
    fetch: options.fetch as never,
  });
}

export { hc } from "hono/client";
export type { InferRequestType, InferResponseType } from "hono/client";
