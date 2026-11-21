/**
 * External MCP servers: where the API may connect
 * ============================================================================
 *
 * One check for the server's own URL (lib/external-mcp.ts) and for every URL
 * its OAuth metadata announces (lib/external-mcp-oauth.ts): https, and a host
 * that resolves to public addresses only. `KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL=true`
 * lifts both (development, tests, a server on the same private network).
 */

import { pinnedFetch, resolveTarget, UnsafeTargetError } from "./safe-fetch";

function internalAllowed(): boolean {
  return process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL === "true";
}

/** Shape of the URL (when saving it). */
export function serverUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid MCP server URL";
  }
  if (url.username || url.password)
    return "Credentials in the URL are not allowed (use the auth header)";
  if (url.protocol !== "https:" && !(internalAllowed() && url.protocol === "http:")) {
    return "The MCP server URL must be https://";
  }
  if (raw.length > 2000) return "URL too long";
  return null;
}

/** The host must resolve to public addresses only (unless the internal opt-in is on). */
export async function serverTargetProblem(raw: string): Promise<string | null> {
  const shape = serverUrlProblem(raw);
  if (shape) return shape;
  if (internalAllowed()) return null;
  const url = new URL(raw);
  try {
    await resolveTarget(url.hostname);
  } catch (err) {
    if (err instanceof UnsafeTargetError && err.reason === "non_public") {
      return `MCP server host resolves to a non-public address: ${url.hostname}`;
    }
    return `MCP server host could not be resolved: ${url.hostname}`;
  }
  return null;
}

/**
 * `fetch` for an external MCP server or its OAuth endpoints: the host is resolved
 * and checked ONCE and the connection goes only to those addresses
 * (lib/safe-fetch.ts). Checking with `serverTargetProblem` and then calling the
 * global `fetch` resolved the name twice, so a name with a short TTL could answer
 * a public address to the check and an internal one to the connection.
 */
export async function externalMcpFetch(
  input: string | URL,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  }
): Promise<Response> {
  return pinnedFetch(input, { ...init, allowInternal: internalAllowed() });
}
