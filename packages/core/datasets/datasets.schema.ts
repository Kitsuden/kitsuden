/**
 * DataSets Schema
 *
 * Drizzle ORM schema for dynamic data collections.
 */

import { pgTable, uuid, varchar, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

/**
 * Data Sets - Collection definitions
 */
export const dataSets = pgTable("data_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  description: text("description"),
  icon: varchar("icon", { length: 50 }),

  /**
   * Field definition of the dataset.
   *
   * The `$type<>` comes from `apps/api/src/db/schema-core.ts`, which was the other
   * declaration of this table. When unifying into a single source, the MORE typed
   * version of each field had to be kept: without it, `schema` is
   * `unknown` and the OpenAPI aggregator, which generates the API documentation
   * from these fields, stops compiling.
   *
   * Losing types when deduplicating is the silent way to spoil a
   * unification: it compiles, it runs, and the code that depended on the type is left with
   * `unknown` and casts.
   */
  schema: jsonb("schema")
    .$type<
      Array<{
        fieldName: string;
        fieldType: string;
        required?: boolean;
        options?: string;
        defaultValue?: string;
      }>
    >()
    .default([]),

  // Display configuration
  displayConfig: jsonb("display_config"),

  // RLS Policy
  policyJson: jsonb("policy_json"),

  // Workflow configuration
  workflowJson: jsonb("workflow_json"),

  /**
   * Content publishing configuration.
   *
   * It has existed in the database since the initial migration and this module did NOT declare it:
   * only `apps/api/src/db/schema-core.ts` did. So half of the
   * code saw a column the other half ignored, and neither of the two
   * failed — each simply worked with a different table.
   */
  contentConfig: jsonb("content_config"),

  /**
   * Provenance: where this data came from and under what terms.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * All optional: a dataset someone writes by hand has no source, and
   * forcing them to invent one would be worse than leaving it empty.
   *
   * It matters when the dataset comes from OUTSIDE. An imported catalog without this
   * is a mystery after three months: nobody knows whether the numbers are from the
   * current patch, where they were taken from, or whether they can be republished. It is
   * exactly what sites doing this same thing do not publish — and it is cheap to have.
   */
  sourceName: varchar("source_name", { length: 300 }),
  sourceUrl: text("source_url"),
  /** Terms as long text, not a license identifier. */
  sourceLicense: text("source_license"),
  /** Version or patch of the source: `1_4`, `3.1`. */
  sourceVersion: varchar("source_version", { length: 60 }),
  /** When it was downloaded. Different from `updatedAt`, which is when it was touched here. */
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  /** Warnings the dump came with: unverified data, declared gaps. */
  sourceCaveats: jsonb("source_caveats").default([]),

  // Metadata
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/**
 * Data Entries - Actual data records
 */
export const dataEntries = pgTable("data_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 500 }).notNull(),

  // Relation to dataset
  dataSetId: uuid("data_set_id")
    .notNull()
    .references(() => dataSets.id, { onDelete: "cascade" }),

  // The actual data (JSONB)
  /**
   * The content of the entry.
   *
   * The `$type<>` and the `notNull()` come from the other declaration of this table,
   * the one in `apps/api/src/db/schema-core.ts`. When unifying, the version
   * that tells the TRUTH about the database has to be kept, and in both
   * cases it was that one:
   *
   *   · Without `$type`, `entry.data` is `unknown` and all the code that reads it
   *     needs a cast.
   *   · Without `notNull`, it is `Record | null` — but the column is `jsonb NOT NULL`
   *     since the initial migration, so that `null` cannot occur and
   *     forced a check on every use.
   *
   * Losing typing "for deduplication" is the silent way to spoil a
   * unification: it compiles, it runs, and the code fills up with casts.
   */
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),

  /**
   * Row owner. Used by RLS to isolate per user.
   *
   * It has existed in the database from the start and this module did not declare it, so
   * dataset queries could neither filter by owner nor write it. It is not
   * the same as `createdById`: that is who wrote it, this is whose it is.
   */
  ownerId: text("owner_id"),

  // Status
  status: varchar("status", { length: 50 }).default("published"),

  // Sorting
  sortOrder: integer("sort_order").default(0),

  // Media
  thumbnailId: uuid("thumbnail_id"),

  // Metadata
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),

  // Audit
  createdById: text("created_by_id"),
  updatedById: text("updated_by_id"),
});

// Types
export type DataSet = typeof dataSets.$inferSelect;
export type DataEntry = typeof dataEntries.$inferSelect;
export type NewDataSet = typeof dataSets.$inferInsert;
export type NewDataEntry = typeof dataEntries.$inferInsert;

// Field definition type
export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  type:
    | "text"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "select"
    | "multiselect"
    | "relation"
    | "image"
    | "file"
    | "richtext"
    | "json";
  required?: boolean;
  unique?: boolean;
  defaultValue?: any;
  options?: { label: string; value: any }[];
  relation?: {
    table: string;
    field: string;
    displayField: string;
  };
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    message?: string;
  };
  /** Customer or personal data: it does not leave for third parties (docs/agents/egress.md). */
  sensitivity?: "customer" | "personal";
}

// Policy types
export type RLSType = "admin" | "public" | "authenticated";

export interface RLSRule {
  field: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt";
  value: string;
}

export interface PolicyJson {
  readAccess: RLSType;
  writeAccess: RLSType;
  enableRLS: boolean;
  rlsRules?: RLSRule[];
}
