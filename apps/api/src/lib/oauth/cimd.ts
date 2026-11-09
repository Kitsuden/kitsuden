/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00)
 * ============================================================================
 *
 * MCP 2026-07-28 prefers it over dynamic registration: the `client_id` is an https
 * URL with a path, and the client's JSON is there (name and redirects).
 * This reads that document with the precautions of section 6 of the draft:
 *
 *   · SSRF: https only, port 443, no credentials in the URL, and the host must
 *     resolve ONLY to public addresses (no loopback, private,
 *     link-local, CGNAT, multicast…). Redirects are not followed. 5 s and 64 KB
 *     at most. Optional: KITSUDEN_OAUTH_CIMD_ALLOWED_HOSTS.
 *     Remaining risk: a DNS that changes between the check and the connection
 *     (rebinding). It is reduced with the host list; see docs/agents/oauth.md.
 *   · the document must be JSON with a `client_id` IDENTICAL to the URL,
 *     `client_name` and valid `redirect_uris`; `token_endpoint_auth_method`
 *     `none` (`private_key_jwt` is not supported).
 *   · cached according to Cache-Control (between 5 min and 24 h; 1 h if it says nothing).
 */

import { pinnedFetch, UnsafeTargetError } from "../safe-fetch";

import { allowedCimdHosts } from "./config";
import { invalidRedirectReason } from "./uris";

export interface ClientDocument {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  grantTypes: string[];
  softwareId: string | null;
  softwareVersion: string | null;
  /** Until when the copy is valid. */
  expires: Date;
}

export type Read = { ok: true; doc: ClientDocument } | { ok: false; reason: string };

/** Does it have the shape of a CIMD client_id? (https with a path). */
export function isClientIdUrl(clientId: string): boolean {
  if (!clientId.startsWith("https://")) return false;
  try {
    const u = new URL(clientId);
    return u.pathname.length > 1;
  } catch {
    return false;
  }
}

// The address rule lives in lib/public-address.ts (shared with every outbound
// call); re-exported here, where the tests and older imports find it.
export { nonPublicAddress } from "../public-address";

type Searcher = (url: string) => Promise<Response>;

/** The real fetch, after checking the destination. */
async function searchWithCaution(url: string): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) {
    throw new Error("client_id must be an https URL on port 443 without credentials");
  }
  const allowedOnes = allowedCimdHosts();
  const host = u.hostname.toLowerCase();
  if (allowedOnes.length && !allowedOnes.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error("client_id host is not in KITSUDEN_OAUTH_CIMD_ALLOWED_HOSTS");
  }
  // Resolved, checked and connected to the SAME addresses (lib/safe-fetch.ts):
  // a second resolution at connect time could answer an internal one.
  try {
    return await pinnedFetch(u, { headers: { accept: "application/json" }, timeoutMs: 5000 });
  } catch (err) {
    if (err instanceof UnsafeTargetError && err.reason === "non_public") {
      throw new Error("client_id host resolves to a non-public address");
    }
    throw err;
  }
}

let searcher: Searcher = searchWithCaution;

/** Tests only: replaces the network (tests do not leave the machine). `null` restores the real one. */
export function setMetadataFinder(b: Searcher | null): void {
  searcher = b ?? searchWithCaution;
}

const MAX_BYTES = 64 * 1024;

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("metadata document is larger than 64 KB");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function expiry(res: Response): Date {
  const cc = res.headers.get("cache-control") ?? "";
  const m = /max-age=(\d+)/i.exec(cc);
  let s = m ? Number(m[1]) : 3600;
  if (/no-store|no-cache/i.test(cc)) s = 300;
  s = Math.min(Math.max(s, 300), 86_400);
  return new Date(Date.now() + s * 1000);
}

const text = (v: unknown, max = 500) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** Reads and validates the client's document. Never throws: returns the reason. */
export async function readClientDocument(clientId: string): Promise<Read> {
  if (!isClientIdUrl(clientId))
    return { ok: false, reason: "client_id is not an https URL with a path" };
  let res: Response;
  try {
    res = await searcher(clientId);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "fetch failed" };
  }
  if (res.status !== 200)
    return { ok: false, reason: `metadata document answered HTTP ${res.status}` };
  let doc: Record<string, unknown>;
  try {
    const raw = JSON.parse(await readBody(res)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    doc = raw as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      reason: `metadata document is not valid JSON (${e instanceof Error ? e.message : ""})`,
    };
  }
  if (doc.client_id !== clientId)
    return { ok: false, reason: "metadata client_id does not match the URL exactly" };
  const clientName = text(doc.client_name, 200);
  if (!clientName) return { ok: false, reason: "metadata document needs client_name" };
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20) {
    return { ok: false, reason: "metadata document needs 1-20 redirect_uris" };
  }
  for (const r of redirectUris) {
    const reason = invalidRedirectReason(r);
    if (reason) return { ok: false, reason: `redirect_uri ${String(r).slice(0, 100)} ${reason}` };
  }
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    return {
      ok: false,
      reason: "only token_endpoint_auth_method 'none' is supported for metadata-document clients",
    };
  }
  const grantTypes = Array.isArray(doc.grant_types)
    ? doc.grant_types.filter((g): g is string => typeof g === "string")
    : ["authorization_code"];
  if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return {
      ok: false,
      reason: "only authorization_code and refresh_token grant types are supported",
    };
  }
  return {
    ok: true,
    doc: {
      clientId,
      clientName,
      clientUri: text(doc.client_uri),
      logoUri: text(doc.logo_uri),
      redirectUris: redirectUris as string[],
      grantTypes,
      softwareId: text(doc.software_id, 200),
      softwareVersion: text(doc.software_version, 100),
      expires: expiry(res),
    },
  };
}
