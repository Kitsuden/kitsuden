/**
 * Which tables can be touched through the generic explorer
 * ============================================================================
 *
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────
 *
 * `/api/explorer/*` was protected only with `requireAuth`, which checks that
 * a session exists and NOTHING ELSE —this CMS's roles are `admin`, `editor` and
 * `user`—. And `resolveTable()` fell back to dynamic introspection, so it resolved
 * ANY table in the database. Verified on a real installation:
 *
 *     kitsuden_secrets      resolves (13 columns)
 *     auth_accounts         resolves (13 columns)   ← credentials
 *     api_keys              resolves (8 columns)
 *     kitsuden_migrations   resolves (5 columns)
 *
 * With `PATCH`, `POST` and `DELETE` on `/:collection/:id` in the same router.
 * That is: an `editor` could read and write the secrets, the credentials and
 * the migration history. Editing `kitsuden_migrations` from the browser
 * silently desynchronizes history and schema — the failure that cost a whole
 * day of diagnosis.
 *
 * ── THE RULE: WHAT SOMEONE DECLARES IS EXPLORED ────────────────────────────
 *
 * WHITE list, not black. A table is explorable if some kon declares it in its
 * `kon.json` or if it is in the explorer's static registry. Everything else is
 * invisible.
 *
 * It is the right shape in this architecture —the kon owns its data and
 * decides what it exposes— and above all it fails on the safe side: a
 * new table someone adds tomorrow is born closed, without anyone having to
 * remember to forbid it.
 *
 * ── AND EVEN SO, A BLACKLIST ON TOP ────────────────────────────────────────
 *
 * Because the static registry includes platform tables for convenience
 * (`modules`), and because a kon might declare a sensitive table by mistake or
 * on purpose. The blacklist always wins, even over what is declared.
 *
 * ── WRITING ────────────────────────────────────────────────────────────────
 *
 * There are tables that are worth being able to LOOK at from the panel but that not just
 * anyone can modify: `auth_users` (changing a role is privilege escalation) and
 * `modules` (turning kons on). Those are read with a session and only written by an
 * `admin`.
 */

import { scanPackages } from "../services/scanner";

import { TABLES_ONLY_VIA_THEIR_ROUTE } from "./actions-code";

/**
 * Never, by any path, with any role.
 *
 * Credentials, secrets, sessions, keys and the system's memory. None of
 * these makes sense behind a generic grid: they are either secrets, or the internal
 * record of something administered through its own screen.
 */
export const FORBIDDEN_TABLES = new Set([
  "kitsuden_secrets",
  "auth_accounts",
  "auth_sessions",
  "auth_verifications",
  "api_keys",
  "agent_api_keys",
  "agent_tokens",
  // OAuth for MCP (0055): hashes of codes and tokens, clients and grants
  "oauth_clients",
  "oauth_authorization_requests",
  "oauth_grants",
  "oauth_codes",
  "oauth_tokens",
  "kitsuden_migrations",
  "rate_limit_logs",
  "member_sessions",
  // kon-members magic access links: their token_hash opens another
  // person's session (2026-10-15, found during a review of the user kons)
  "member_signins",
]);

/**
 * Columns that hold a LIVE secret (token, password, hash of a key).
 *
 * The explorer is admin-only, but not even an admin is shown them: an unsubscribe
 * or confirmation token of `nl_members`, the `encrypted_password` of `data_sources` or the
 * `ingest_token` of a broadcast can be used to act on someone else's behalf, and
 * a panel screen is no place for them. By column NAME (in
 * snake_case and camelCase), so it works for tables that do not exist yet.
 * `tokens_in`/`tokens_out` (an LLM's counters) do not match: they do not end in token.
 */
const SECRET_COLUMN = /(^|_|[a-z])(token|password|secret|token_?hash|password_?hash|key_?hash)$/i;

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN.test(name);
}

/** Copy of the value (row, list, response envelope) without secret columns. */
export function withoutSecretColumns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecretColumns);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretColumn(k)) continue;
      clean[k] = withoutSecretColumns(v);
    }
    return clean;
  }
  return value;
}

/**
 * Read with a session; written only with the `admin` role.
 *
 * `auth_users` because changing `role` is privilege escalation. `modules` because
 * it is the kon switch: turning one on creates tables and mounts routes.
 */
export const ADMIN_WRITE_TABLES = new Set(["auth_users", "modules", "installed_kons"]);

// Manifests do not change while the process lives, but it is refreshed in case
// a kon is installed on the fly. Cheap: it is a read of files already cached
// by the scanner itself.
let declaredCache: Set<string> | null = null;
let declaredStamp = 0;
const TTL_MS = 60_000;

/** Tables that some kon on disk declares in its manifest. */
async function declaredByKons(): Promise<Set<string>> {
  if (declaredCache && Date.now() - declaredStamp < TTL_MS) return declaredCache;

  const declaredMany = new Set<string>();
  try {
    for (const kon of await scanPackages("kons")) {
      const tables = (kon as { tables?: (string | { name?: string })[] }).tables ?? [];
      for (const t of tables) {
        const name = typeof t === "string" ? t : t?.name;
        if (name) declaredMany.add(name);
      }
      const views = (kon as { admin?: { views?: { table?: string }[] } }).admin?.views ?? [];
      for (const v of views) if (v.table) declaredMany.add(v.table);
    }
  } catch {
    // If the scan fails the door is NOT opened: what there was is returned, and if
    // there was nothing, nothing. A failure reading the disk cannot translate into
    // "allow everything" — which is how holes get written.
    return declaredCache ?? new Set();
  }

  declaredCache = declaredMany;
  declaredStamp = Date.now();
  return declaredMany;
}

export interface VerdictTable {
  allowed: boolean;
  /** Only when denied: why, for the log. Never sent to the client. */
  reason?: "forbidden" | "undeclared";
}

/**
 * Can this table be explored?
 *
 * `staticRegistry` are the keys of the explorer's own registry, which the
 * caller knows and this module does not.
 */
export async function tableIsExplorable(
  name: string,
  staticRegistry: Iterable<string>
): Promise<VerdictTable> {
  if (FORBIDDEN_TABLES.has(name)) return { allowed: false, reason: "forbidden" };

  for (const key of staticRegistry) if (key === name) return { allowed: true };

  const declaredMany = await declaredByKons();
  if (declaredMany.has(name)) return { allowed: true };

  return { allowed: false, reason: "undeclared" };
}

/** Does modifying this table require the `admin` role? */
export function writeRequiresAdmin(name: string): boolean {
  return ADMIN_WRITE_TABLES.has(name);
}

/**
 * ── NATIVE TABLES THROUGH THE GENERIC SURFACES (security review 2026-11-04) ─
 *
 * GraphQL, inline relations and `POST /api/datasets/query/:table` resolve
 * tables from the merged schema (or from `information_schema`) without the
 * explorer's white list. One rule for all of them, the same as MCP
 * (`services/mcp-tools.ts`), kept here in one place:
 *
 *   · `FORBIDDEN_TABLES` and every `auth_*` table except `auth_users` are
 *     neither read nor written through any of them, with any role.
 *   · `TABLES_ONLY_VIA_THEIR_ROUTE` are not written through them.
 *   · `ADMIN_WRITE_TABLES` are written only by a HUMAN admin: an agent key
 *     with `admin` does not change a role or turn kons on this way.
 *   · Secret columns (`isSecretColumn`) are not returned, not written, and
 *     not filtered or sorted by (a filter is an oracle).
 */
export function isForbiddenNativeTable(name: string): boolean {
  return FORBIDDEN_TABLES.has(name) || (name.startsWith("auth_") && name !== "auth_users");
}

export type NotWritableReason = "forbidden" | "only-via-own-route" | "requires-human-admin";

/**
 * Why can this table not be written through a generic surface? `null` if it
 * can. `humanAdmin`: a person's session with the `admin` role (not a key).
 */
export function whyNativeTableIsNotWritable(
  name: string,
  humanAdmin: boolean
): NotWritableReason | null {
  if (isForbiddenNativeTable(name)) return "forbidden";
  if (TABLES_ONLY_VIA_THEIR_ROUTE.has(name)) return "only-via-own-route";
  if (writeRequiresAdmin(name) && !humanAdmin) return "requires-human-admin";
  return null;
}

/** Is the request from a PERSON with the `admin` role? An agent key is not. */
export function isHumanAdmin(c: { get: unknown }): boolean {
  const get = (c.get as (k: string) => unknown).bind(c);
  if (get("agent")) return false;
  return (get("user") as { role?: string } | null | undefined)?.role === "admin";
}

/** The keys of `value` that are secret columns (to refuse a write). */
export function secretColumnsIn(value: Record<string, unknown> | null | undefined): string[] {
  return value ? Object.keys(value).filter(isSecretColumn) : [];
}

/** For tests: forget what was cached. */
export function cleanDeclaredCache(): void {
  declaredCache = null;
}
