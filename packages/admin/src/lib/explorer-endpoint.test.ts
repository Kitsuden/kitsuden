import { describe, expect, it } from "vitest";

import { explorerEndpoint, isApiBase, resourceForTable } from "./explorer-endpoint";

describe("explorerEndpoint", () => {
  it("without an endpoint it is the generic explorer", () => {
    expect(explorerEndpoint(undefined, "blog_posts")).toBe("/api/explorer/blog_posts");
  });

  it("a complete endpoint is used as it is", () => {
    expect(explorerEndpoint("/api/explorer/games", "games")).toBe("/api/explorer/games");
    expect(explorerEndpoint("/api/datasets/abc/entries", "x")).toBe("/api/datasets/abc/entries");
  });

  it("kon-directory: the table carries the kon's prefix, the route does not", () => {
    for (const [table, route] of [
      ["directory_employees", "/api/directory/employees"],
      ["directory_departments", "/api/directory/departments"],
      ["directory_positions", "/api/directory/positions"],
      ["directory_organizations", "/api/directory/organizations"],
    ]) {
      expect(explorerEndpoint("/api/directory", table!)).toBe(route);
    }
  });

  it("kon-vekstudio: /api/ocr + ocr_documents", () => {
    expect(explorerEndpoint("/api/ocr", "ocr_documents")).toBe("/api/ocr/documents");
  });

  it("a table without the prefix keeps its name, with dashes as in routes", () => {
    expect(resourceForTable("/api/crm", "contacts")).toBe("contacts");
    expect(resourceForTable("/api/dms", "dms_audit_log")).toBe("audit-log");
    expect(resourceForTable("/api/ocr-training", "ocr_training_jobs")).toBe("jobs");
  });

  it("tells a base from a complete endpoint", () => {
    expect(isApiBase("/api/directory")).toBe(true);
    expect(isApiBase("/api/directory/")).toBe(true);
    expect(isApiBase("/api/explorer/games")).toBe(false);
  });
});
