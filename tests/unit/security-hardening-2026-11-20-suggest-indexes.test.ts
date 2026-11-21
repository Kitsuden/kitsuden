/**
 * `GET /api/data-sets/:id/indexes/suggest` honours an agent's per-dataset denial (H85, 2026-11-20).
 *
 * The operation looked the dataset up by id with no visibility check, so an agent holding
 * `dataset:update` and `!datasets:<slug>:read` still got the dataset's field names. It now
 * goes through `datasetVisible`, the lookup every other dataset operation uses, and a denied
 * dataset answers the same 404 as a missing one. `canViewDataset` itself is covered elsewhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROUTES = readFileSync(
  join(__dirname, "../../packages/core/datasets/datasets.routes.ts"),
  "utf8"
);

describe("suggest-indexes", () => {
  it("looks the dataset up through datasetVisible", () => {
    const start = ROUTES.indexOf('id: "suggest-indexes"');
    const end = ROUTES.indexOf("defineOperation(", start);
    const op = ROUTES.slice(start, end);
    expect(op).toContain("await datasetVisible(c, dataSetId)");
    expect(op).not.toContain(".from(dataSets)");
  });
});
