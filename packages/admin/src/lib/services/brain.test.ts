/**
 * The shapes are the ones apps/api/src/routes/brain.ts returns: `{ notes }`,
 * `{ note, connections }`, a plain graph for the neighbourhood, scores 0–100.
 */
import { describe, expect, it } from "vitest";

import {
  fraction,
  toBrainNoteDetail,
  toBrainNotes,
  toKnowledgeGraph,
  toNeighborhood,
} from "./brain";

const API_NOTE = {
  id: "n1",
  title: "Orders table",
  content: "…",
  source: "scan",
  sourcePath: "apps/api/src/db/schema.ts",
  category: "schema",
  tags: ["db"],
  embedding: null,
  importance: 80,
  confidence: 65,
  metadata: {},
  relatedNoteIds: [],
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
};

describe("fraction", () => {
  it("turns the API's 0–100 into 0–1 and clamps", () => {
    expect(fraction(80)).toBe(0.8);
    expect(fraction(0)).toBe(0);
    expect(fraction(250)).toBe(1);
    expect(fraction(-3)).toBe(0);
    expect(fraction("50")).toBe(0.5);
  });

  it("uses the fallback for what is not a number", () => {
    expect(fraction(undefined)).toBe(0);
    expect(fraction(null, 0.5)).toBe(0.5);
    expect(fraction("x", 0.5)).toBe(0.5);
  });
});

describe("notes", () => {
  it("reads the list from { notes }", () => {
    const notes = toBrainNotes({ notes: [API_NOTE] });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.importance).toBe(0.8);
    expect(notes[0]!.confidence).toBe(0.65);
    // What the table prints: Math.round(importance * 100) + "%".
    expect(Math.round(notes[0]!.importance * 100)).toBe(80);
  });

  it("still accepts a bare array and { docs }, and survives nothing", () => {
    expect(toBrainNotes([API_NOTE])).toHaveLength(1);
    expect(toBrainNotes({ docs: [API_NOTE] })).toHaveLength(1);
    expect(toBrainNotes(null)).toEqual([]);
    expect(toBrainNotes({})).toEqual([]);
  });

  it("reads the detail from { note, connections }", () => {
    const note = toBrainNoteDetail({ note: API_NOTE, connections: [] });
    expect(note.title).toBe("Orders table");
    expect(note.tags).toEqual(["db"]);
  });

  it("a note with missing optional fields does not throw", () => {
    const note = toBrainNoteDetail({ note: { id: "n2" } });
    expect(note).toMatchObject({ id: "n2", title: "", tags: [], importance: 0, sourcePath: null });
  });
});

describe("graph", () => {
  const API_GRAPH = {
    nodes: [
      {
        id: "n1",
        label: "Orders table",
        type: "schema",
        group: "schema",
        importance: 80,
        metadata: { source: "scan", sourcePath: null, tags: [], confidence: 65 },
      },
      { id: "n2", label: "", type: "route", group: "route" },
    ],
    edges: [
      { source: "n1", target: "n2", relation: "uses", strength: 0.7 },
      { source: "n1", target: "gone", relation: "uses", strength: 0.7 },
    ],
    generatedAt: "2026-11-01T10:00:00.000Z",
  };

  it("scales importance for the node size (cytoscape maps 0–1)", () => {
    const g = toKnowledgeGraph(API_GRAPH);
    expect(g.nodes[0]!.importance).toBe(0.8);
    expect(g.nodes[0]!.metadata?.confidence).toBe(0.65);
    expect(g.nodes[1]!.importance).toBeUndefined();
    expect(g.nodes[1]!.label).toBe("n2");
  });

  it("drops an edge whose end is not in the graph", () => {
    expect(toKnowledgeGraph(API_GRAPH).edges).toEqual([
      { source: "n1", target: "n2", relation: "uses", strength: 0.7 },
    ]);
  });

  it("an empty or missing answer is an empty graph", () => {
    expect(toKnowledgeGraph(null)).toEqual({ nodes: [], edges: [], generatedAt: "" });
  });

  it("the neighbourhood takes its centre and depth from the request", () => {
    const n = toNeighborhood(API_GRAPH, "n1", 2);
    expect(n.centerId).toBe("n1");
    expect(n.depth).toBe(2);
    expect(n.nodes).toHaveLength(2);
  });
});
