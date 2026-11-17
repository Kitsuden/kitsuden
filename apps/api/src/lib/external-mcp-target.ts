/**
 * External MCP servers: where the API may connect
 * ============================================================================
 *
 * One check for the server's own URL (lib/external-mcp.ts) and for every URL
 * its OAuth metadata announces (lib/external-mcp-oauth.ts): https, and a host
 * that resolves to public addresses only. `KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL=true`
 * lifts both (development, tests, a server on the same private network).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { nonPublicAddress } from "./oauth/cimd";

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
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true, verbatim: true });
  } catch {
    return `MCP server host could not be resolved: ${url.hostname}`;
  }
  if (!addresses.length || addresses.some((a) => nonPublicAddress(a.address))) {
    return `MCP server host resolves to a non-public address: ${url.hostname}`;
  }
  return null;
}
