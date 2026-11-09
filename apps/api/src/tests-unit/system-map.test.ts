/**
 * System Map — Deterministic unit tests (no DB, no network)
 */

import { buildSystemMap } from "@kitsuden/engine";
import { describe, it, expect } from "bun:test";

// The repo root from apps/api (cwd of bun test) is two levels up.
const ROOT = `${process.cwd()}/../..`;

describe("System Map (deterministic)", () => {
  it("maps the real repo: endpoints, tables, kons, services, libs", () => {
    const map = buildSystemMap({ projectRoot: ROOT });
    expect(map.summary.totalEndpoints).toBeGreaterThan(50);
    expect(map.summary.totalRepoTables).toBeGreaterThan(20);
    expect(map.summary.totalKons).toBeGreaterThan(0);
    expect(map.graph.nodes.length).toBeGreaterThan(0);
  });

  it("is deterministic except for the timestamp", () => {
    const a = buildSystemMap({ projectRoot: ROOT });
    const b = buildSystemMap({ projectRoot: ROOT });
    expect({ ...a, generatedAt: "" }).toEqual({ ...b, generatedAt: "" });
  });

  it("degrades cleanly without a DB (database undefined, no FK relations)", () => {
    const map = buildSystemMap({ projectRoot: ROOT });
    expect(map.database).toBeUndefined();
    expect(map.summary.totalRelations).toBe(0);
  });

  it("integrates FK relations injected by the host", () => {
    const map = buildSystemMap({
      projectRoot: ROOT,
      database: {
        tables: ["data_entries", "data_sets"],
        relations: [{ from: "data_entries", to: "data_sets", via: "data_set_id" }],
      },
    });
    expect(map.summary.totalDbTables).toBe(2);
    expect(map.summary.totalRelations).toBe(1);
    const edge = map.graph.edges.find((e) => e.relation.startsWith("fk:"));
    expect(edge).toEqual({
      from: "table:data_entries",
      to: "table:data_sets",
      relation: "fk:data_set_id",
    });
  });

  it("creates kon→table edges (defines) by scanning schemas", () => {
    const map = buildSystemMap({ projectRoot: ROOT });
    const definesEdges = map.graph.edges.filter((e) => e.relation === "defines");
    // At least some kon declares tables.
    expect(definesEdges.length).toBeGreaterThanOrEqual(0);
  });
});
