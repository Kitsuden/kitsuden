/**
 * Public contract of the Admin Registry
 * ============================================================================
 *
 * `GET /api/admin/registry` is what makes the Kitsuden panel
 * **replaceable**: it describes which kons exist, which tables they expose and
 * which views they offer, without the client knowing anything about the backend.
 *
 * That matters strategically. Directus and Strapi lock you into their admin;
 * here the official panel is a CLIENT of this API, just as one written in
 * React by someone else would be. But that is only true if the contract is
 * versioned: without a version, any internal change silently breaks whoever
 * has built on top.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Evolution rules
 *
 * Within a single version ONLY the following is allowed:
 *   - adding optional fields
 *   - adding values to an enum that the client already handles with a `default`
 *
 * Requires bumping `ADMIN_REGISTRY_VERSION`:
 *   - removing or renaming a field
 *   - changing the type or meaning of an existing one
 *   - making something mandatory that was optional
 *
 * The server sends the version in the body and in the `X-Kitsuden-Contract`
 * header, so a client can decide without parsing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Current version of the registry contract. */
export const ADMIN_REGISTRY_VERSION = 1 as const;

/** Header the server uses to announce the version. */
export const CONTRACT_HEADER = "X-Kitsuden-Contract";

export interface AdminRegistryTable {
  name: string;
  label: string;
  icon?: string;
  description?: string;
  primaryKey?: string;
  searchableFields?: string[];
  filterableFields?: string[];
  readonly?: boolean;
}

export interface AdminRegistryView {
  id: string;
  /**
   * A client that does not recognize a type must fall back to `grid`, not break:
   * that is why adding new types does NOT bump the contract version.
   */
  type: "grid" | "kanban" | "calendar" | "custom" | "element";
  title: string;
  table?: string;
  /** @deprecated Svelte view coupled to the admin's framework. Use `element`. */
  component?: string;
  /** Framework-agnostic Web Component: tag name. */
  element?: string;
  /** Compiled artifact, relative to the kon's package. */
  src?: string;
  icon?: string;
  groupBy?: string;
  dateField?: string;
  titleField?: string;
}

export interface AdminRegistryKon {
  id: string;
  name: string;
  icon?: string;
  category: "core" | "content" | "data" | "esports";
  hasCustomView: boolean;
  tables: AdminRegistryTable[];
  views: AdminRegistryView[];
  defaultView: string;
  apiBase?: string;
}

/** Response of `GET /api/admin/registry`. */
export interface AdminRegistryResponse {
  success: true;
  /** Contract version. Check it before assuming the shape of the rest. */
  contract: typeof ADMIN_REGISTRY_VERSION;
  kons: AdminRegistryKon[];
  total: number;
  withCustomViews: number;
  generatedAt: string;
}

/** Response of `GET /api/admin/registry/:konId`. */
export interface AdminRegistryKonResponse {
  success: true;
  contract: typeof ADMIN_REGISTRY_VERSION;
  kon: AdminRegistryKon;
}

/**
 * Checks that the response comes from a version the client understands.
 *
 * Meant so that a third-party panel fails CLEARLY and early instead of breaking
 * halfway through a render on a field that no longer exists.
 */
export function assertSupportedContract(
  received: unknown,
  supported: number = ADMIN_REGISTRY_VERSION
): void {
  const version = (received as { contract?: unknown })?.contract;

  if (typeof version !== "number") {
    throw new Error(
      "The admin registry response does not declare a contract version. " +
        "Are you talking to a Kitsuden older than v1?"
    );
  }
  if (version > supported) {
    throw new Error(
      `The admin registry speaks contract v${version} and this client understands up to v${supported}. ` +
        "Update the client."
    );
  }
}
