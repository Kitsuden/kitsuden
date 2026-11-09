import { describe, it, expect } from "bun:test";

import {
  initKitsudenBrain,
  shutdownKitsudenBrain,
  scanProjectKnowledge,
  getBrainIndex,
  getKnowledgeGraph,
  upsertBrainNote,
  listBrainNotes,
  embedTextLocal,
  cosineSimilarity,
  generateWiki,
  generateLlms,
  buildKnowledgeGraph,
  discoverConnections,
} from "../../../index.ts";

describe("KITSUDEN Brain @kitsuden/engine exports", () => {
  it("exports all public brain functions", () => {
    expect(typeof initKitsudenBrain).toBe("function");
    expect(typeof shutdownKitsudenBrain).toBe("function");
    expect(typeof scanProjectKnowledge).toBe("function");
    expect(typeof getBrainIndex).toBe("function");
    expect(typeof getKnowledgeGraph).toBe("function");
    expect(typeof upsertBrainNote).toBe("function");
    expect(typeof listBrainNotes).toBe("function");
    expect(typeof embedTextLocal).toBe("function");
    expect(typeof cosineSimilarity).toBe("function");
    expect(typeof generateWiki).toBe("function");
    expect(typeof generateLlms).toBe("function");
    expect(typeof buildKnowledgeGraph).toBe("function");
    expect(typeof discoverConnections).toBe("function");
  });
});
