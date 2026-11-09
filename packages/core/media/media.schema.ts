/**
 * Media Library Schema
 *
 * Drizzle ORM schema for media assets and folders.
 */

import { pgTable, uuid, varchar, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

/**
 * Media - Stored files metadata
 */
export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: varchar("filename", { length: 500 }).notNull(),
  originalName: varchar("original_name", { length: 500 }).notNull(),

  // File metadata
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  size: integer("size").notNull(), // in bytes

  // Storage
  key: text("key").notNull(), // S3/MinIO object key
  bucket: varchar("bucket", { length: 100 }).notNull(),

  // URLs
  publicUrl: text("public_url"), // Public URL if available

  // Thumbnails (for images)
  thumbnails: jsonb("thumbnails").default({}),
  // {
  //   "small": { "url": "...", "width": 150, "height": 150 },
  //   "medium": { "url": "...", "width": 300, "height": 300 },
  //   "large": { "url": "...", "width": 800, "height": 800 }
  // }

  // Image metadata
  width: integer("width"),
  height: integer("height"),

  // Folder organization
  folderId: uuid("folder_id"),

  // Alt text for accessibility
  altText: text("alt_text"),
  caption: text("caption"),

  // Metadata
  metadata: jsonb("metadata").default({}),

  // Status
  status: varchar("status", { length: 50 }).default("active"),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),

  // Audit
  createdById: text("created_by_id"),
});

/**
 * Media Folders - Organization
 */
export const mediaFolders = pgTable("media_folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 200 }).notNull(),

  // Hierarchy
  parentId: uuid("parent_id"),

  // Path for quick lookup
  path: text("path").notNull(), // e.g., "/images/products"

  // Metadata
  description: text("description"),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Types
export type Media = typeof media.$inferSelect;
export type MediaFolder = typeof mediaFolders.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type NewMediaFolder = typeof mediaFolders.$inferInsert;

// Thumbnail type
export interface ThumbnailInfo {
  url: string;
  width: number;
  height: number;
  key: string;
}

export interface ThumbnailsMap {
  small?: ThumbnailInfo;
  medium?: ThumbnailInfo;
  large?: ThumbnailInfo;
}
