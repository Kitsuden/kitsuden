import { readFileSync } from "fs";
import { resolve } from "path";

import { describe, it, expect } from "vitest";

describe("GraphQL mutations smoke test", () => {
  const filePath = resolve("apps/api/src/routes/graphql.ts");
  const content = readFileSync(filePath, "utf-8");

  it("contains MutationRoot", () => {
    expect(content).toContain("MutationRoot");
  });

  it("contains buildNativeTableMutations", () => {
    expect(content).toContain("buildNativeTableMutations");
  });

  it("contains buildDatasetMutations", () => {
    expect(content).toContain("buildDatasetMutations");
  });

  it("contains createDataset_ mutation pattern", () => {
    expect(content).toContain("createDataset_");
  });

  it("contains DeletionResultType", () => {
    expect(content).toContain("DeletionResultType");
  });

  it("buildSchema passes mutation: MutationRoot to GraphQLSchema", () => {
    expect(content).toContain("mutation: MutationRoot");
  });

  it("registers queries and mutations under a single schema (no separate schemas)", () => {
    // Count occurrences of `new GraphQLSchema(` to ensure there's only one unified schema
    const matches = content.match(/new GraphQLSchema\(/g);
    expect(matches).toHaveLength(1);
    // And it must include both query and mutation roots
    expect(content).toContain("query: QueryRoot");
    expect(content).toContain("mutation: MutationRoot");
  });
});
