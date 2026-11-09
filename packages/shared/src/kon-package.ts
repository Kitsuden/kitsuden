/**
 * ============================================================================
 * KON PACKAGE — Standard contract for kon npm packages
 * ============================================================================
 *
 * Defines the structure that any npm package installable
 * as a Kitsuden kon must meet.
 *
 * Usage:
 *   - package.json → "kitsuden" field meets KonPackage
 *   - kon.json (standalone) meets KonPackage
 *   - CLI validates before install
 *   - API validates before loading from node_modules
 */

/**
 * Dependencies on another kon (by ID, not by npm package name).
 * The loader resolves the ID to the corresponding npm package.
 */
export interface KonDependencies {
  /** Required kon IDs (installed automatically) */
  kons?: string[];
  /** Optional kon IDs (suggested to the user) */
  optional?: string[];
  /** Minimum required versions of each kon */
  konsMinVersion?: Record<string, string>;
}

/**
 * Mount configuration of the kon's router in the API.
 */
export interface KonMountConfig {
  /** Base path of the router (e.g. /api/crm) */
  path?: string;
  /** Whether it requires authentication on all routes */
  requireAuth?: boolean;
  /** Allowed roles */
  allowedRoles?: string[];
}

/**
 * Definition of a table exposed by the kon for the schema merger.
 */
export interface KonTableConfig {
  name: string;
  /** Name of the table in Drizzle (if it differs from name) */
  table?: string;
  label?: string;
  icon?: string;
  description?: string;
  primaryKey?: string;
  searchableFields?: string[];
  filterableFields?: string[];
  readonly?: boolean;
}

/**
 * Lifecycle hooks of the kon (optional).
 */
export interface KonLifecycleHooks {
  /** Run when the kon is mounted in the API */
  onStartup?: string;
  /** Run when the kon is unmounted */
  onShutdown?: string;
}

/**
 * Full contract of a kon npm package.
 *
 * It can be declared in:
 *   1. A `kon.json` file at the package root.
 *   2. The `kitsuden` field inside `package.json`.
 */
export interface KonPackage {
  /** Unique kon ID (e.g. "kon-crm") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semver version */
  version: string;
  /** Type is always "kon" for npm packages */
  type: "kon";
  /** Short description */
  description?: string;
  /** Icon (icon name or URL) */
  icon?: string;
  /** Package author */
  author?: string;
  /** Category of the kon */
  category?: "core" | "core-den" | "optional" | string;
  /** Whether it is a core kon that must always be loaded */
  core?: boolean;
  /** Admin path in the frontend (e.g. /g/crm) */
  adminRoute?: string;
  /** Tables exposed for the schema merger */
  tables?: (string | KonTableConfig)[];
  /** Router mount configuration */
  mount?: KonMountConfig;
  /** Dependencies on other kons */
  dependencies?: KonDependencies;
  /** Lifecycle hooks (names of exported functions) */
  hooks?: KonLifecycleHooks;
  /** OpenAPI schema exported by the kon */
  openApi?: {
    tags?: Array<{ name: string; description?: string }>;
    paths?: Record<string, any>;
  };
  /** Whether the kon handles its own migrations (schema is not merged) */
  selfMigrating?: boolean;
  /**
   * Columns that hold customer or personal data, per table:
   * `{ "crm_contacts": { "email": "customer" } }`. An execution that reads them
   * cannot send them to a host not allowed for customer data (docs/agents/egress.md).
   */
  sensitivity?: Record<string, Record<string, "customer" | "personal">>;
}

/**
 * Minimum contract version (required fields only).
 */
export type KonPackageMinimal = Pick<KonPackage, "id" | "name" | "version" | "type">;

/**
 * Validates whether an object meets the minimum KonPackage contract.
 * It does not validate semver or deep structure.
 */
export function isValidKonPackage(obj: unknown): obj is KonPackage {
  if (typeof obj !== "object" || obj === null) return false;
  const pkg = obj as Record<string, unknown>;
  return (
    typeof pkg.id === "string" &&
    pkg.id.length > 0 &&
    typeof pkg.name === "string" &&
    pkg.name.length > 0 &&
    typeof pkg.version === "string" &&
    pkg.version.length > 0 &&
    pkg.type === "kon"
  );
}
