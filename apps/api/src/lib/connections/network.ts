/**
 * Where a connection's credential may travel on the network
 * ============================================================================
 *
 * A provider lists the hosts its credential may be sent to (`apiHosts`, providers.ts). That decides the
 * NAME; this file decides the ADDRESS. Every call a connected client makes goes through `pinnedFetch`
 * (safe-fetch.ts): the name is resolved once, every address is checked, and the connection goes only to
 * those. A provider host that resolves to a private or loopback address is refused, so a DNS record
 * changed after the provider was registered cannot turn a token into a request to the metadata service or
 * to another container.
 *
 * ── A PRIVATE HOST, ON PURPOSE ─────────────────────────────────────────────
 *
 * A self-hosted service (an Odoo on the office network, an ERP in the same Docker network) lives at a
 * private address. The operator names those hosts, one by one, in `CONNECTIONS_PRIVATE_HOSTS`
 * (comma-separated host names or IP literals, no ports, no wildcards):
 *
 *     CONNECTIONS_PRIVATE_HOSTS=odoo.internal,10.0.4.12
 *
 * A host on that list may resolve to a private address, may be a single-label name (`odoo`) and may use
 * `http:` (plain HTTP inside a private network is common; the credential still never leaves that host).
 * The list only widens what a provider ALREADY lists in `apiHosts`: it never adds a host by itself.
 * Nothing in a request, a kon or the database can extend it: only the server's environment.
 */

import { isIP } from "node:net";

import { pinnedFetch } from "../safe-fetch";

const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The hosts the operator allowed to be private, normalized. Invalid entries are ignored with a warning. */
export function privateHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env["CONNECTIONS_PRIVATE_HOSTS"] ?? "";
  const out = new Set<string>();
  for (const entry of raw.split(",")) {
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    if (!host) continue;
    if (HOST.test(host) || isIP(host)) out.add(host);
    else
      console.warn(`[connections] CONNECTIONS_PRIVATE_HOSTS: "${entry.trim()}" is not a host name`);
  }
  return out;
}

/** Whether `host` (a URL's hostname) is on the operator's private list. */
export function isPrivateHostAllowed(
  host: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  return privateHosts(env).has(host.toLowerCase().replace(/^\[|\]$/g, ""));
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyText(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  throw new TypeError("A connected client sends a string, URLSearchParams or bytes as the body");
}

/**
 * The `fetch` a connected client uses: pinned, public addresses only, unless the host is on
 * `CONNECTIONS_PRIVATE_HOSTS`. Redirects are never followed (a 3xx comes back as is).
 */
export async function connectionFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  const allowInternal = isPrivateHostAllowed(parsed.hostname);
  const headers = headerRecord(init.headers);
  if (
    typeof init.body === "object" &&
    init.body instanceof URLSearchParams &&
    !Object.keys(headers).includes("content-type")
  ) {
    headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }
  return pinnedFetch(parsed, {
    method: init.method,
    headers,
    body: bodyText(init.body),
    allowInternal,
  });
}
