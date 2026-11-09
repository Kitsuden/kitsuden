/**
 * DataSets Calculated Fields - Database Schema
 *
 * Drizzle ORM schema for storing DataSets calculated fields.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
} from "drizzle-orm/pg-core";

import { dataSets } from "./datasets.schema";

/**
 * Calculated Fields - Formulas and KPIs per dataset
 */
export const dataSetCalculatedFields = pgTable("data_set_calculated_fields", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Relation to the dataset
  dataSetId: uuid("data_set_id")
    .notNull()
    .references(() => dataSets.id, { onDelete: "cascade" }),

  // Identification
  name: varchar("name", { length: 100 }).notNull(), // Technical name
  label: varchar("label", { length: 200 }).notNull(), // Label for the UI

  // Calculation type
  type: varchar("type", { length: 50 }).notNull(), // formula, count, sum, avg, etc.

  // Calculation configuration (JSON)
  config: jsonb("config").default({}),

  // Output format
  format: jsonb("format"),

  // Dependencies
  dependsOn: jsonb("depends_on").$type<string[]>().default([]),

  // Metadata KPI
  description: text("description"),
  category: varchar("category", { length: 100 }),
  isKpi: boolean("is_kpi").default(false),
  target: integer("target"),
  warningThreshold: integer("warning_threshold"),

  // State
  isActive: boolean("is_active").default(true),
  sortOrder: integer("sort_order").default(0),

  // Audit
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  createdById: text("created_by_id"),
});

// Types
export type DataSetCalculatedField = typeof dataSetCalculatedFields.$inferSelect;
export type NewDataSetCalculatedField = typeof dataSetCalculatedFields.$inferInsert;
