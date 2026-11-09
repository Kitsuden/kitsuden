/**
 * Kitsuden Codegen — Frontend code generation engine
 *
 * Generates strongly-typed frontend code from any Kitsuden collection
 * (dataset or native table) without manual boilerplate.
 */

export interface ColumnInfo {
  name: string;
  type: string;
  required: boolean;
  isPrimaryKey?: boolean;
  isRelation?: boolean;
  relationTable?: string;
}

export interface CollectionInfo {
  slug: string;
  name: string;
  kind: "dataset" | "native";
  columns: ColumnInfo[];
  primaryKey: string;
}

export interface GeneratedFile {
  filename: string;
  content: string;
  language: string;
}

export interface GenerateOptions {
  collection: CollectionInfo;
  framework: "react" | "vue" | "svelte";
  type: "hook" | "component" | "form" | "types" | "all";
  baseUrl?: string;
}

export * from "./generators/react.js";
export * from "./generators/vue.js";
export * from "./generators/svelte.js";
