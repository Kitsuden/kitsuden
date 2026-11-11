import { describe, expect, it } from "vitest";

import { relatedTableCandidates, relationBase, resolveRelatedTable } from "./explorer-relations";

describe("relation target of a foreign-key column", () => {
  it("reads the base from snake and camel case", () => {
    expect(relationBase("department_id")).toBe("department");
    expect(relationBase("departmentId")).toBe("department");
    expect(relationBase("assignedToId")).toBe("assigned_to");
  });

  it("tries the plain plural first, then the kon's prefix", () => {
    expect(relatedTableCandidates("departmentId", "directory_employees")).toEqual([
      "departments",
      "department",
      "directory_departments",
      "directory_department",
    ]);
  });

  it("finds a kon's own table: the case that left the edit dialog's select empty", () => {
    const known = new Set(["directory_employees", "directory_departments", "directory_positions"]);
    expect(resolveRelatedTable("departmentId", "directory_employees", known)).toBe(
      "directory_departments"
    );
    expect(resolveRelatedTable("position_id", "directory_employees", known)).toBe(
      "directory_positions"
    );
  });

  it("prefers an unprefixed table when both exist, and the fixed map over a guess", () => {
    const known = new Set(["games", "esports_games", "auth_users", "authors"]);
    expect(resolveRelatedTable("gameId", "esports_matches", known)).toBe("games");
    expect(resolveRelatedTable("authorId", "posts", known)).toBe("auth_users");
  });

  it("pluralizes -y and tries multi-word prefixes", () => {
    expect(relatedTableCandidates("category_id", "ocr_training_jobs")).toEqual([
      "categories",
      "category",
      "ocr_training_categories",
      "ocr_training_category",
      "ocr_categories",
      "ocr_category",
    ]);
  });

  it("is null when the explorer has none of them: nothing is requested", () => {
    expect(resolveRelatedTable("roomId", "booking_slots", new Set(["users"]))).toBeNull();
  });
});
