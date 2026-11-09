/**
 * ============================================================================
 * SINGLE REGISTRY OF FIELD TYPES
 * ============================================================================
 *
 * This information used to be spread across four places that had to be touched
 * at once and had already diverged:
 *
 *   - `FieldTypeSchema` (which types exist)
 *   - the `switch` in `fieldTypeToZod` (how each one validates)
 *   - `FIELD_TYPE_OPTIONS` in the admin (which ones can be created)
 *   - `shouldIndexByDefault` / `shouldSearchByDefault` (how they are indexed)
 *
 * The divergence was not theoretical: `multiselect`, `textarea`, `datetime` and
 * `media` validated correctly in the backend but did not exist for the
 * user, because nobody added them to the admin's list. Four working types
 * that nobody could create.
 *
 * From here on, a new type is declared ONCE, in this file.
 *
 * It does NOT define: how the concrete widget is drawn (that is the admin's job) nor a
 * kon's business rules. Only what EVERYONE needs to know about a type.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shape of the value
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Value family on which validation is built.
 *
 * It is deliberately short: if this grew to have one entry per type we would
 * be back to the `switch` we came to eliminate, just somewhere else.
 */
export type FieldValueKind =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "uuid"
  /** A media item: media library id OR http(s) address. See `image`. */
  | "mediaRef"
  | "json"
  | "stringArray"
  | "rows";

/** Refinements on `string` that add format validation. */
export type FieldStringFormat = "email" | "url";

export interface FieldTypeSpec {
  /** Value family: the base validator comes from here. */
  kind: FieldValueKind;
  /** Format refinement, only for `kind: "string"`. */
  format?: FieldStringFormat;

  // ── UI metadata (consumed by the admin palette) ──
  label: string;
  description: string;
  /** Name of the lucide icon. */
  icon: string;
  /** Accent color in the palette. */
  color: string;
  /**
   * `false` leaves the type usable through the API but out of the palette. It is used
   * for legacy aliases, which still validate but are not offered as a new
   * option: having them in the palette would offer two names for the same
   * thing.
   */
  creatable: boolean;

  // ── Configuration affordances ──
  /** Supports `options[]` (lists of values). */
  supportsOptions?: boolean;
  /** Supports `subFields[]` (repeater). */
  supportsSubFields?: boolean;
  /** Supports `relation{}`. */
  supportsRelation?: boolean;

  // ── Indexing ──
  /** Often filtered by exact value → index by default. */
  indexByDefault: boolean;
  /** Contains prose → search index by default. */
  searchByDefault: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

export const FIELD_TYPES = {
  text: {
    kind: "string",
    label: "Text",
    description: "Single or multi-line text",
    icon: "Type",
    color: "#00E5FF",
    creatable: true,
    indexByDefault: false,
    searchByDefault: true,
  },
  textarea: {
    kind: "string",
    label: "Long text",
    description: "Multi-line prose",
    // `AlignLeft` no longer exists in lucide 0.575; `Pilcrow` is also the paragraph
    // sign, which says "prose" better than an alignment does.
    icon: "Pilcrow",
    color: "#00B8D4",
    creatable: true,
    indexByDefault: false,
    searchByDefault: true,
  },
  number: {
    kind: "number",
    label: "Number",
    description: "Integer or decimal",
    icon: "Hash",
    color: "#76FF03",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  boolean: {
    kind: "boolean",
    label: "Boolean",
    description: "True / False toggle",
    icon: "ToggleLeft",
    color: "#FFD600",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  date: {
    kind: "date",
    label: "Date",
    description: "Date or datetime",
    icon: "Calendar",
    color: "#E040FB",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  datetime: {
    kind: "date",
    label: "Date & time",
    description: "Timestamp with time of day",
    icon: "Clock",
    color: "#D500F9",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  image: {
    /**
     * Media library id OR http(s) URL.
     *
     * With a plain `uuid`, a dataset with external images could not be saved
     * (the URL failed validation), and consumers —tier lists,
     * catalogs, the public grid— only knew how to draw URLs: no image
     * field worked for both validating and drawing.
     */
    kind: "mediaRef",
    label: "Image",
    description: "Reference to a media item, or an absolute image URL",
    icon: "Image",
    color: "#FF9100",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  media: {
    kind: "mediaRef",
    label: "File",
    description: "Any media item — PDF, video, document",
    icon: "Paperclip",
    color: "#FF6E40",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  url: {
    kind: "string",
    format: "url",
    label: "URL",
    description: "Validated web address",
    icon: "Link",
    color: "#40C4FF",
    creatable: true,
    indexByDefault: true,
    searchByDefault: false,
  },
  email: {
    kind: "string",
    format: "email",
    label: "Email",
    description: "Validated email address",
    icon: "Mail",
    color: "#B388FF",
    creatable: true,
    indexByDefault: true,
    searchByDefault: false,
  },
  select: {
    kind: "string",
    label: "Select",
    description: "One value from a list",
    icon: "List",
    color: "#1DE9B6",
    creatable: true,
    supportsOptions: true,
    indexByDefault: true,
    searchByDefault: false,
  },
  multiselect: {
    kind: "stringArray",
    label: "Multi-select",
    description: "Several values from a list",
    icon: "ListChecks",
    color: "#00BFA5",
    creatable: true,
    supportsOptions: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  json: {
    kind: "json",
    label: "JSON",
    description: "Free-form structured data",
    icon: "Braces",
    color: "#8D99AE",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  richtext: {
    kind: "string",
    label: "Rich text",
    description: "Formatted content",
    icon: "FileText",
    color: "#FF4081",
    creatable: true,
    indexByDefault: false,
    // It is prose and should be searchable, but `shouldSearchByDefault` never
    // included it. Enabling it here would create search indexes on datasets that
    // already exist without anyone having asked for it; it is left as it was and stays as a
    // conscious improvement, not as a side effect of a refactor.
    searchByDefault: false,
  },
  relation: {
    kind: "uuid",
    label: "Relation",
    description: "Link to another dataset",
    icon: "GitBranch",
    color: "#536DFE",
    creatable: true,
    supportsRelation: true,
    indexByDefault: true,
    searchByDefault: false,
  },
  kpi: {
    kind: "number",
    label: "KPI / Formula",
    description: "Calculated metric",
    icon: "Calculator",
    color: "#FF1493",
    creatable: true,
    indexByDefault: false,
    searchByDefault: false,
  },
  repeater: {
    kind: "rows",
    label: "Repeater",
    description: "Repeating group of subfields",
    icon: "Rows3",
    color: "#FF6D00",
    creatable: true,
    supportsSubFields: true,
    indexByDefault: false,
    searchByDefault: false,
  },
} as const satisfies Record<string, FieldTypeSpec>;

export type FieldTypeName = keyof typeof FIELD_TYPES;

/** All type names, to derive the Zod enum without repeating the list. */
export const FIELD_TYPE_NAMES = Object.keys(FIELD_TYPES) as [FieldTypeName, ...FieldTypeName[]];

/**
 * Legacy aliases that appear in old schemas and in other vocabularies
 * of the repo (SQL columns in `AutoFormModal`, kon-esports' `CustomFieldType`).
 * They are resolved to the canonical type instead of duplicating entries.
 *
 * Map instead of branching: when a new vocabulary appears, it is added
 * here and no validator is touched.
 */
export const FIELD_TYPE_ALIASES = {
  // SQL column vocabulary (AutoFormModal)
  string: "text",
  integer: "number",
  float: "number",
  numeric: "number",
  jsonb: "json",
  object: "json",
  timestamp: "datetime",
  checkbox: "boolean",
  // Other names seen in old schemas
  file: "media",
  longtext: "textarea",
  bool: "boolean",
  // `as const` and not `Record<string, …>`: with the wide signature, `keyof` would give
  // `string` and any consumer that ties itself to this list with `satisfies`
  // would pass the check without checking anything.
} as const satisfies Record<string, FieldTypeName>;

export type FieldTypeAlias = keyof typeof FIELD_TYPE_ALIASES;

/**
 * Resolves any name —canonical, alias or unknown— to a type in the
 * registry.
 *
 * An unknown type falls back to `text` instead of blowing up: a schema with a type
 * this build does not know yet must keep storing its data as text,
 * not take down the whole form. It is the same reason the entry validator
 * uses `passthrough()`.
 */
export function resolveFieldType(type: string | undefined | null): FieldTypeName {
  if (!type) return "text";
  if (type in FIELD_TYPES) return type as FieldTypeName;
  return (FIELD_TYPE_ALIASES as Record<string, FieldTypeName>)[type] ?? "text";
}

/** Spec of a type, resolving aliases. Never returns `undefined`. */
export function fieldTypeSpec(type: string | undefined | null): FieldTypeSpec {
  return FIELD_TYPES[resolveFieldType(type)];
}

/** Types that can be offered in the admin palette, in declaration order. */
export function creatableFieldTypes(): Array<{ type: FieldTypeName } & FieldTypeSpec> {
  return (Object.entries(FIELD_TYPES) as Array<[FieldTypeName, FieldTypeSpec]>)
    .filter(([, spec]) => spec.creatable)
    .map(([type, spec]) => ({ type, ...spec }));
}

export function shouldIndexByDefault(type: string): boolean {
  return fieldTypeSpec(type).indexByDefault;
}

export function shouldSearchByDefault(type: string): boolean {
  return fieldTypeSpec(type).searchByDefault;
}

/**
 * The fields of `data_sets.schema`, whatever shape it comes in.
 *
 * The column has been written in TWO shapes: a list of fields ("lite" routes,
 * validation, kon catalogs, the `/data` table) and a `{fields}` object
 * (the public grid, bulk import, kon-datasets' POST, MCP).
 * Each consumer expected only one, so no dataset worked for all of them:
 * validation blew up with `{fields}` and the grid drew 0 columns with
 * a list. Everyone now reads through here.
 */
export function schemaFields(schema: unknown): Record<string, unknown>[] {
  const list = Array.isArray(schema)
    ? schema
    : schema && typeof schema === "object" && Array.isArray((schema as { fields?: unknown }).fields)
      ? (schema as { fields: unknown[] }).fields
      : [];
  return list.filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object");
}
