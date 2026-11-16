/**
 * Kon entities and kon secrets: what a kon may ask the host for
 * ============================================================================
 *
 * ── ENTITIES (docs/kons/entities.md) ───────────────────────────────────────
 *
 * A kon that needs a table writes a migration. A kon that needs a table whose
 * FIELDS the installation decides (a CRM's "custom objects", the extra fields
 * of a registration form) cannot: the columns are not known when the kon is
 * written.
 *
 * An entity is a dataset the kon owns. The kon declares it:
 *
 *   defineKon({ entities: [{ slug: "crm-vehicle", name: "Vehicle",
 *     fields: [{ key: "plate", type: "text", required: true }] }] })
 *
 * and the host creates the dataset at load, with no SQL. Records are rows of
 * `data_entries`, validated against the fields on every write, with the same
 * policies, history, search and MCP tools as any other dataset.
 *
 * ── SECRETS (docs/kons/secrets.md) ─────────────────────────────────────────
 *
 * A kon that stores a third party's credential (an OAuth refresh token, an
 * API key) must not store it readable. `ctx.secrets` seals it with the
 * installation's secrets key and records every time it is opened.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

/** One field of an entity. `type` is a name from the field type registry. */
export interface KonEntityField {
  key: string;
  /** `text`, `number`, `boolean`, `date`, `select`, `relation`… (FIELD_TYPES). */
  type: string;
  label?: string;
  required?: boolean;
  /** For `select` and `multiselect`. */
  options?: Array<string | { value: string; label?: string }>;
  description?: string;
  /** `customer` or `personal`: tracked by the egress guard (docs/agents/egress.md). */
  sensitivity?: "customer" | "personal";
  /**
   * Anything else is stored with the field as it is: the limits the field
   * compiler reads (`minValue`, `maxValue`, `minLength`, `maxLength`,
   * `validationRegex`, `showIf`) and keys the kon keeps for itself.
   */
  [extra: string]: unknown;
}

export type KonEntityAccess = "admin" | "authenticated" | "public";

export interface KonEntityDefinition {
  /**
   * The dataset slug. Prefix it with the kon's name (`crm-vehicle`): slugs are
   * global, and a kon must not take a name a person may want.
   */
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  fields: KonEntityField[];
  /** Who may read and write records. Default: staff only (`admin`). */
  access?: { read?: KonEntityAccess; write?: KonEntityAccess };
  /**
   * Settings the kon keeps for this entity (numbering, a default pipeline,
   * flags). Stored with the definition and returned by `describe`; the core
   * never reads it.
   */
  settings?: Record<string, unknown>;
}

export const KON_ENTITY_SLUG = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;
export const KON_ENTITY_FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const MAX_KON_ENTITY_FIELDS = 200;

const ENTITY_ACCESS: readonly KonEntityAccess[] = ["admin", "authenticated", "public"];

/** Why an entity cannot be declared, or `null`. Field TYPES are the host's check. */
export function konEntityProblem(entity: unknown): string | null {
  const e = entity as Partial<KonEntityDefinition> | null | undefined;
  if (!e || typeof e !== "object") return "an entity must be an object";
  if (typeof e.slug !== "string" || !KON_ENTITY_SLUG.test(e.slug)) {
    return `entity slug "${String(e.slug)}" must be lower case letters, digits and "-" (3 to 100)`;
  }
  if (typeof e.name !== "string" || e.name.trim() === "") return `entity "${e.slug}" needs a name`;
  if (!Array.isArray(e.fields)) return `entity "${e.slug}" needs a list of fields`;
  if (e.fields.length > MAX_KON_ENTITY_FIELDS) {
    return `entity "${e.slug}" has more than ${MAX_KON_ENTITY_FIELDS} fields`;
  }
  const keys = new Set<string>();
  for (const field of e.fields) {
    if (!field || typeof field !== "object") return `entity "${e.slug}": a field is not an object`;
    if (typeof field.key !== "string" || !KON_ENTITY_FIELD_KEY.test(field.key)) {
      return `entity "${e.slug}": field key "${String(field.key)}" is not a valid name`;
    }
    if (keys.has(field.key)) return `entity "${e.slug}": field "${field.key}" is declared twice`;
    keys.add(field.key);
    if (typeof field.type !== "string" || field.type.trim() === "") {
      return `entity "${e.slug}": field "${field.key}" needs a type`;
    }
  }
  for (const side of ["read", "write"] as const) {
    const value = e.access?.[side];
    if (value !== undefined && !ENTITY_ACCESS.includes(value)) {
      return `entity "${e.slug}": access.${side} must be one of ${ENTITY_ACCESS.join(", ")}`;
    }
  }
  return null;
}

export interface KonEntityRecord {
  id: string;
  title: string;
  data: Record<string, unknown>;
  status: string | null;
  ownerId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface KonEntityWrite {
  /** Shown in lists and search. Required on create. */
  title?: string;
  data?: Record<string, unknown>;
  status?: string;
  /** Owner of the record, for the dataset's row policies. */
  ownerId?: string | null;
}

export interface KonEntityListOptions {
  /** Equality on fields of `data`: `{ plate: "ABC-123" }`. */
  where?: Record<string, string | number | boolean>;
  limit?: number;
  offset?: number;
}

/** A write the fields rejected: one message per field. */
export class KonEntityValidationError extends Error {
  readonly issues: Array<{ field: string; message: string }>;
  constructor(slug: string, issues: Array<{ field: string; message: string }>) {
    super(
      `entity "${slug}": ${issues.map((i) => `${i.field || "data"}: ${i.message}`).join("; ")}`
    );
    this.name = "KonEntityValidationError";
    this.issues = issues;
  }
}

/**
 * `ctx.entities`. Every call runs on the request's connection, so the
 * dataset's row policies apply to whoever is asking; outside a request it is
 * the system.
 */
export interface KonEntities {
  /** The definition as stored, or `null` when the entity does not exist. */
  describe(slug: string): Promise<KonEntityDefinition | null>;
  /**
   * Creates an entity at runtime, or replaces its definition: for entity TYPES
   * a person creates in the settings of the kon, which no declaration can know
   * in advance. Persisted; survives restarts. `konId` is the id of the kon
   * itself. Throws when the definition is malformed or the slug belongs to
   * someone else. Always written as the system: check the permission of
   * whoever is asking first.
   */
  define(konId: string, definition: KonEntityDefinition): Promise<KonEntityDefinition>;
  /**
   * Removes an entity the kon owns. Refuses while it has records, unless
   * `withRecords` is set, which deletes them too. `false` when the kon owns no
   * such entity.
   */
  undefine(konId: string, slug: string, options?: { withRecords?: boolean }): Promise<boolean>;
  /** Every entity the kon owns, declared or defined at runtime. */
  definitions(konId: string): Promise<KonEntityDefinition[]>;
  /**
   * Checks `data` against the fields of the entity WITHOUT storing it, and
   * returns it as validated: for values the kon keeps in a column of its own
   * table (the custom fields of a deal). Throws `KonEntityValidationError`.
   */
  validate(slug: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(slug: string, options?: KonEntityListOptions): Promise<KonEntityRecord[]>;
  get(slug: string, id: string): Promise<KonEntityRecord | null>;
  /** Throws `KonEntityValidationError` when `data` does not meet the fields. */
  create(slug: string, input: KonEntityWrite & { title: string }): Promise<KonEntityRecord>;
  /** `data` is MERGED into what is stored; a key set to `null` is cleared. */
  update(slug: string, id: string, input: KonEntityWrite): Promise<KonEntityRecord | null>;
  remove(slug: string, id: string): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A sealed secret, as the kon stores it (in a `jsonb` column). Name the column
 * so it ends in `secret` or `token` (`refresh_token`, `api_secret`): the
 * generic surfaces hide columns with those names.
 */
export interface SealedSecret {
  /** Format version. */
  v: 1;
  /** The kon it was sealed for. Authenticated: changing it makes the value unopenable. */
  kon: string;
  valueEncrypted: string;
  iv: string;
  authTag: string;
}

export interface SecretAccess {
  /** Why it is being opened: `sync-mailbox`, `refresh-token`. Recorded. */
  purpose: string;
  /** What the secret belongs to: `connection:<id>`. Recorded, never the value. */
  subject?: string;
  /** The account on whose behalf it is opened, when there is one. */
  actorUserId?: string | null;
}

export function isSealedSecret(value: unknown): value is SealedSecret {
  const v = value as Partial<SealedSecret> | null | undefined;
  return (
    !!v &&
    typeof v === "object" &&
    v.v === 1 &&
    typeof v.kon === "string" &&
    typeof v.valueEncrypted === "string" &&
    typeof v.iv === "string" &&
    typeof v.authTag === "string"
  );
}

/**
 * A column where a kon stores sealed secrets: `defineKon({ secretColumns })`.
 * Declaring it is what lets a change of the installation's secrets key
 * re-encrypt the kon's rows too; an undeclared column is left behind and its
 * secrets stop opening.
 */
export interface KonSecretColumn {
  table: string;
  /** A `jsonb` column holding a `SealedSecret`. */
  column: string;
  /** Primary key column. Default `id`. */
  idColumn?: string;
}

/**
 * `ctx.secrets`. `konId` is the kon's own id: a secret sealed for one kon does
 * not open for another.
 */
export interface KonSecrets {
  /** Encrypts. Synchronous: sealing never touches the database. */
  seal(konId: string, plaintext: string): SealedSecret;
  /**
   * Decrypts and records the access (kon, purpose, subject, actor, time).
   * Rejects when the value was sealed for another kon, was tampered with, or
   * the installation's key changed without a rekey.
   */
  open(konId: string, sealed: SealedSecret, access: SecretAccess): Promise<string>;
}
