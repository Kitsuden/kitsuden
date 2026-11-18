/**
 * Credential vault for sandboxed code
 * ============================================================================
 *
 * Code actions used to receive API keys as `env` values (`config.envVars`):
 * the code SAW them, so a buggy or hostile version could log them, put them in
 * its result, or send them anywhere `fetch` reaches. The vault keeps the value
 * out of the sandbox entirely:
 *
 *   config.credentials = [{
 *     secret: "STRIPE_KEY",            // a key in the secrets store (/api/admin/secrets)
 *     host:   "api.stripe.com",        // exact host or `*.example.com`
 *     header: "Authorization",         // default Authorization
 *     format: "Bearer {secret}",       // default "Bearer {secret}"
 *   }]
 *
 * The parent process (worker-sandbox.ts `callFetch`) adds the header AFTER the
 * egress policy and the customer-data check, only over HTTPS, and only when the
 * request's host matches the binding. The code's own header of the same name is
 * replaced, so the code cannot choose where the value goes inside the request.
 * If the response echoes the value (headers or body), it is replaced with
 * `[redacted:vault]` before the code sees it.
 *
 * Only a PERSON sets `credentials` (like `customerDataHosts`): an agent that
 * could bind a secret to a host of its choice would be reading the secret.
 * A new code version for an action with credentials always waits for a human
 * (promotion reason `target_has_credentials`): it never sees the value, but its
 * requests carry that authority.
 *
 * In a promotion TEST (`probe`), the header carries `[vault:<secret>]`, never
 * the value, so a test can check that the binding applies.
 *
 * Inspired by OpenSandbox's Credential Vault (Apache-2.0); no code is copied.
 * See docs/agents/sandbox.md.
 */

import { normalizeTarget } from "./egress-policy";

export interface CredentialBinding {
  secret: string;
  host: string;
  header: string;
  format: string;
}

/** A binding with its value, in the API process only. Never sent to the child. */
export interface VaultCredential extends CredentialBinding {
  /** null in a promotion test: the header then carries a placeholder. */
  value: string | null;
}

const MAX_BINDINGS = 20;
const DEFAULT_HEADER = "Authorization";
const DEFAULT_FORMAT = "Bearer {secret}";
/** Headers a binding may not set: they change routing, framing or the body. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "content-type",
  "cookie",
  "te",
  "upgrade",
  "proxy-authorization",
]);
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Parses `config.credentials`. Returns the problem as text when invalid. */
export function parseCredentialBindings(raw: unknown): CredentialBinding[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return '"credentials" must be a list';
  if (raw.length > MAX_BINDINGS) return `At most ${MAX_BINDINGS} credentials per action`;
  const out: CredentialBinding[] = [];
  for (const [i, item] of raw.entries()) {
    const where = `credentials[${i}]`;
    if (!item || typeof item !== "object") return `${where} must be an object`;
    const b = item as Record<string, unknown>;
    const extra = Object.keys(b).find((k) => !["secret", "host", "header", "format"].includes(k));
    if (extra) return `${where}: unknown key "${extra}"`;
    if (typeof b.secret !== "string" || !SECRET_KEY.test(b.secret))
      return `${where}.secret must be the key of a stored secret (letters, digits, _)`;
    const host = normalizeTarget(b.host);
    if (!host || host === "*" || host.includes("/"))
      return `${where}.host must be a host name or *.domain (not *, an IP range or a URL)`;
    const header = b.header === undefined ? DEFAULT_HEADER : b.header;
    if (typeof header !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(header))
      return `${where}.header must be a header name`;
    if (FORBIDDEN_HEADERS.has(header.toLowerCase())) return `${where}.header cannot be ${header}`;
    const format = b.format === undefined ? DEFAULT_FORMAT : b.format;
    if (
      typeof format !== "string" ||
      format.length > 256 ||
      !format.includes("{secret}") ||
      /[\r\n]/.test(format)
    )
      return `${where}.format must contain {secret} and fit on one line`;
    if (format.split("{secret}").length !== 2) return `${where}.format must contain {secret} once`;
    out.push({ secret: b.secret, host, header, format });
  }
  return out;
}

/** The problem with `config.credentials`, or null (used when an action is saved). */
export function credentialsProblem(raw: unknown): string | null {
  const parsed = parseCredentialBindings(raw);
  return typeof parsed === "string" ? parsed : null;
}

/** Does the config bind any credential? */
export function hasCredentials(config: unknown): boolean {
  const c = (config && typeof config === "object" ? config : {}) as { credentials?: unknown };
  return Array.isArray(c.credentials) && c.credentials.length > 0;
}

function hostMatches(pattern: string, hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return pattern.startsWith("*.")
    ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1
    : h === pattern;
}

/** The bindings that apply to this URL. */
export function credentialsFor(list: VaultCredential[] | undefined, url: URL): VaultCredential[] {
  return (list ?? []).filter((c) => hostMatches(c.host, url.hostname));
}

export class VaultError extends Error {}

/**
 * Adds the matching credentials to `headers` (in place) and returns the values
 * that must not come back to the code. HTTPS only: a credential is never sent
 * in clear text.
 */
export function injectCredentials(
  list: VaultCredential[] | undefined,
  url: URL,
  headers: Record<string, string>
): string[] {
  const matching = credentialsFor(list, url);
  if (!matching.length) return [];
  if (url.protocol !== "https:") {
    throw new VaultError(
      `Credential ${matching[0]!.secret} is only sent over https (${url.hostname})`
    );
  }
  const values: string[] = [];
  for (const c of matching) {
    for (const k of Object.keys(headers))
      if (k.toLowerCase() === c.header.toLowerCase()) delete headers[k];
    const value = c.value ?? `[vault:${c.secret}]`;
    headers[c.header] = c.format.replace("{secret}", value);
    if (c.value) values.push(c.value, headers[c.header]!);
  }
  return values.filter((v) => v.length >= 4);
}

/** Replaces every occurrence of the injected values in a text the code will see. */
export function redact(text: string, values: string[]): string {
  let out = text;
  // Longest first: the full header value ("Bearer <secret>") before the bare secret.
  const ordered = [...values].sort((a, b) => b.length - a.length);
  for (const v of ordered) if (v && out.includes(v)) out = out.split(v).join("[redacted:vault]");
  return out;
}

/**
 * Loads the values for an action's bindings from the secrets store. A missing
 * secret, or a reserved key (the API's own configuration), is an error: the
 * action fails instead of calling the host without its credential.
 */
export async function resolveCredentials(raw: unknown): Promise<VaultCredential[]> {
  const bindings = parseCredentialBindings(raw);
  if (typeof bindings === "string") throw new VaultError(bindings);
  if (!bindings.length) return [];
  const { readSecretValue, reservedSecretKey } = await import("../services/secrets");
  const out: VaultCredential[] = [];
  for (const b of bindings) {
    if (reservedSecretKey(b.secret))
      throw new VaultError(`Secret ${b.secret} is reserved and cannot be bound`);
    const value = await readSecretValue(b.secret);
    if (value === null) throw new VaultError(`Secret ${b.secret} is not in the secrets store`);
    out.push({ ...b, value });
  }
  return out;
}

/** The bindings with placeholders instead of values (promotion tests). */
export function placeholderCredentials(raw: unknown): VaultCredential[] {
  const bindings = parseCredentialBindings(raw);
  return typeof bindings === "string" ? [] : bindings.map((b) => ({ ...b, value: null }));
}
