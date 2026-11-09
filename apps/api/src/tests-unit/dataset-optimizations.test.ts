import { describe, it, expect } from "bun:test";

import {
  normalizeDatasetField,
  buildDatasetEntryValidator,
  validateDatasetEntry,
  getSchemaVersion,
  addSchemaVersionToData,
  isEntrySchemaStale,
  buildDatasetWhereConditions,
  buildDatasetSearchCondition,
} from "../lib/dataset-optimizations";

describe("dataset-optimizations", () => {
  describe("normalizeDatasetField", () => {
    it("normalizes legacy backend format", () => {
      const field = normalizeDatasetField({
        fieldName: "email",
        fieldType: "email",
        required: true,
        defaultValue: "a@example.com",
      });
      expect(field).toEqual({
        key: "email",
        // `type` keeps what the author wrote; `resolvedType` is the registry's
        // canonical type. They are kept apart so that `getSchemaVersion` keeps
        // hashing the original and does not mark as outdated the entries of
        // schemas that use an alias.
        type: "email",
        resolvedType: "email",
        label: "email",
        required: true,
        defaultValue: "a@example.com",
        options: undefined,
        isUnique: false,
        validationRegex: undefined,
        minValue: undefined,
        maxValue: undefined,
        minLength: undefined,
        maxLength: undefined,
        index: false,
        searchable: undefined,
        subFields: undefined,
        showIf: undefined,
      });
    });

    it("normalizes modern admin format", () => {
      const field = normalizeDatasetField({
        key: "status",
        type: "select",
        isRequired: true,
        options: [{ value: "active", label: "Active" }],
      });
      expect(field?.key).toBe("status");
      expect(field?.type).toBe("select");
      expect(field?.required).toBe(true);
      expect(field?.options).toEqual([{ value: "active", label: "Active" }]);
    });

    it("parses string default values as JSON when possible", () => {
      const field = normalizeDatasetField({
        key: "count",
        type: "number",
        defaultValue: "42",
      });
      expect(field?.defaultValue).toBe(42);
    });

    it("returns null for invalid fields", () => {
      expect(normalizeDatasetField(null)).toBeNull();
      expect(normalizeDatasetField({})).toBeNull();
      expect(normalizeDatasetField({ type: "text" })).toBeNull();
    });
  });

  describe("buildDatasetEntryValidator", () => {
    it("validates entries with mixed field types", () => {
      const validator = buildDatasetEntryValidator([
        { key: "name", type: "text", isRequired: true },
        { key: "age", type: "number" },
        { key: "active", type: "boolean" },
        { key: "role", type: "select", options: ["admin", "user"] },
      ]);

      const result = validator.safeParse({
        name: "Ada",
        age: 30,
        active: true,
        role: "admin",
        extraField: "preserved",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Ada");
        expect(result.data.extraField).toBe("preserved");
      }
    });

    it("rejects invalid types", () => {
      const validator = buildDatasetEntryValidator([
        { key: "age", type: "number", isRequired: true },
      ]);
      const result = validator.safeParse({ age: "not-a-number" });
      expect(result.success).toBe(false);
    });

    it("applies default values", () => {
      const validator = buildDatasetEntryValidator([
        { key: "status", type: "select", options: ["draft", "published"], defaultValue: "draft" },
      ]);
      const result = validator.parse({});
      expect(result.status).toBe("draft");
    });

    it("allows optional fields to be missing", () => {
      const validator = buildDatasetEntryValidator([{ key: "bio", type: "textarea" }]);
      const result = validator.parse({});
      expect(result.bio).toBeUndefined();
    });
  });

  describe("validateDatasetEntry", () => {
    it("returns parsed data on success", () => {
      const result = validateDatasetEntry([{ key: "title", type: "text", isRequired: true }], {
        title: "Hello",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Hello");
      }
    });

    it("returns error details on failure", () => {
      const result = validateDatasetEntry([{ key: "count", type: "number", isRequired: true }], {
        count: "abc",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("schema versioning", () => {
    it("computes stable schema version", () => {
      const fields = [{ key: "title", type: "text", isRequired: true }];
      expect(getSchemaVersion(fields)).toBe(getSchemaVersion(fields));
      expect(getSchemaVersion(fields)).toHaveLength(8);
    });

    it("detects schema changes", () => {
      const v1 = getSchemaVersion([{ key: "title", type: "text" }]);
      const v2 = getSchemaVersion([{ key: "title", type: "textarea" }]);
      expect(v1).not.toBe(v2);
    });

    it("injects _schemaVersion into data", () => {
      const fields = [{ key: "title", type: "text" }];
      const data = addSchemaVersionToData(fields, { title: "Hello" });
      expect(data._schemaVersion).toBe(getSchemaVersion(fields));
    });

    it("does not overwrite existing _schemaVersion", () => {
      const data = addSchemaVersionToData([{ key: "title", type: "text" }], {
        _schemaVersion: "legacy",
      });
      expect(data._schemaVersion).toBe("legacy");
    });

    it("detects stale entries", () => {
      const fields = [{ key: "title", type: "text" }];
      const version = getSchemaVersion(fields);
      expect(isEntrySchemaStale(fields, { _schemaVersion: version })).toBe(false);
      expect(
        isEntrySchemaStale([{ key: "title", type: "textarea" }], { _schemaVersion: version })
      ).toBe(true);
    });
  });

  describe("buildDatasetWhereConditions", () => {
    it("uses @> for exact equality", () => {
      const conditions = buildDatasetWhereConditions({ status: "active" });
      expect(conditions.length).toBe(1);
    });

    it("uses ->> IS NULL for null values", () => {
      const conditions = buildDatasetWhereConditions({ deletedAt: null });
      expect(conditions.length).toBe(1);
    });

    it("skips internal keys", () => {
      const conditions = buildDatasetWhereConditions({ _schemaVersion: "abc", title: "x" });
      expect(conditions.length).toBe(1);
    });
  });

  describe("buildDatasetSearchCondition", () => {
    it("returns null when no searchable fields", () => {
      const condition = buildDatasetSearchCondition([{ key: "id", type: "number" }], "hello");
      expect(condition).toBeNull();
    });

    it("builds ILIKE condition for text fields", () => {
      const condition = buildDatasetSearchCondition([{ key: "title", type: "text" }], "hello");
      expect(condition).not.toBeNull();
    });

    it("respects searchable=false override", () => {
      const condition = buildDatasetSearchCondition(
        [{ key: "title", type: "text", searchable: false }],
        "hello"
      );
      expect(condition).toBeNull();
    });
  });
});
