/**
 * Brain — tree index (retrieval by reasoning)
 * ============================================================================
 * Second layer next to vector search. Construction is deterministic
 * (no AI), so it is tested entirely in memory; the selector is injected
 * as a fake to test the reasoned path without calling a model.
 */

import {
  buildContentTree,
  retrieveFromTree,
  renderTreeIndex,
  readTreeNode,
  findTreeNode,
  treePathOf,
  type BranchSelector,
} from "@kitsuden/engine";
import { describe, expect, test } from "bun:test";

/** A guide with the typical structure: nested sections and a table. */
const GUIDE = `# Frost Mage Guide

Build aimed at high-level PvE.

## Leveling

Climb through elite zones up to level 40.

### Leveling rotation

Frostbolt, Lance, Nova when there are 3 or more enemies.

## Gear by phase

### Phase 1

Starter set. Prioritize intellect over crit.

### Phase 3

The Eternal Frost set is mandatory here.

| Piece | Source |
|-------|--------|
| Helm  | Final boss |

## Boss strategy

Move out of the puddle during the transition phase.
`;

describe("tree construction (deterministic, no AI)", () => {
  test("nests by heading level", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "frost-mage-guide" });

    expect(tree.title).toBe("Frost Mage Guide");
    // Preamble + h1 → then the h2s hang from the h1
    const h1 = tree.root.find((n) => n.title === "Frost Mage Guide");
    expect(h1).toBeDefined();
    expect(h1!.children.map((c) => c.title)).toEqual([
      "Leveling",
      "Gear by phase",
      "Boss strategy",
    ]);
  });

  test("nests the third level under its parent", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const gear = findTreeNode(tree, "0.1");
    expect(gear!.title).toBe("Gear by phase");
    expect(gear!.children.map((c) => c.title)).toEqual(["Phase 1", "Phase 3"]);
  });

  test("summarizes each section without calling any model", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const phase3 = findTreeNode(tree, "0.1.1");
    expect(phase3!.summary).toContain("Eternal Frost");
    // The summary cleans up the table marks.
    expect(phase3!.summary).not.toContain("|");
  });

  test("stores the source line (traceability)", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    expect(findTreeNode(tree, "0.1.1")!.line).toBeGreaterThan(0);
  });

  test("is DETERMINISTIC: same input, same tree", () => {
    const a = buildContentTree(GUIDE, { sourceId: "g" });
    const b = buildContentTree(GUIDE, { sourceId: "g" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("does NOT mistake a '#' inside a code block for a heading", () => {
    const doc = "# Real\n\n```bash\n# this is a comment\n```\n\n## Other\n";
    const tree = buildContentTree(doc, { sourceId: "d" });
    const titles: string[] = [];
    const walk = (nodes: any[]) => nodes.forEach((n) => (titles.push(n.title), walk(n.children)));
    walk(tree.root);
    expect(titles).toEqual(["Real", "Other"]);
  });

  test("a document without headings is not lost", () => {
    const tree = buildContentTree("Just plain text, no headings.", { sourceId: "d" });
    expect(tree.nodeCount).toBe(1);
    expect(tree.root[0].content).toContain("Just plain text");
  });
});

describe("compact index (what the agent sees)", () => {
  test("includes ids and summaries, NOT the full body", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const index = renderTreeIndex(tree);

    expect(index).toContain("[0.1.1] Phase 3");
    expect(index).toContain("Eternal Frost"); // the summary does
    expect(index).not.toContain("| Helm"); // the table does not
    // The index is MUCH shorter than the document: that is why it fits in context.
    expect(index.length).toBeLessThan(GUIDE.length);
  });

  test("respects the maximum depth", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    expect(renderTreeIndex(tree, 1)).not.toContain("Phase 3");
  });
});

describe("reading and citations", () => {
  test("readNode returns the section with its children", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const gear = readTreeNode(tree, "0.1");
    expect(gear).toContain("Phase 1");
    expect(gear).toContain("Eternal Frost");
    expect(gear).not.toContain("puddle"); // does not swallow sibling sections
  });

  test("pathOf gives the citable path", () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const path = treePathOf(tree, "0.1.1");
    expect(path!.titles).toEqual(["Frost Mage Guide", "Gear by phase", "Phase 3"]);
  });
});

describe("retrieval", () => {
  test("heuristic: finds the section by title terms", async () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const results = await retrieveFromTree(tree, "gear for phase 3", { maxSections: 2 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].via).toBe("heuristic");
    // Each result carries its CITATION — unlike an opaque vector match.
    expect(results[0].path).toContain("Gear by phase");
    expect(results[0].line).toBeGreaterThan(0);
  });

  test("reasoned: the selector chooses the branch and it is marked as 'reasoned'", async () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });

    // Agent fake: in reality, an LLM reads the index and returns the ids.
    const selector: BranchSelector = {
      async select(index, query) {
        expect(index).toContain("[0.2] Boss strategy"); // received the index
        expect(query).toContain("boss");
        return ["0.2"];
      },
    };

    const results = await retrieveFromTree(tree, "how do I kill the boss", { selector });
    expect(results[0].via).toBe("reasoned");
    expect(results[0].content).toContain("puddle");
    expect(results[0].path).toContain("Boss strategy");
  });

  test("if the selector FAILS, it falls back to the heuristic (does not break)", async () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const broken: BranchSelector = {
      async select() {
        throw new Error("LLM down");
      },
    };

    const results = await retrieveFromTree(tree, "leveling rotation", { selector: broken });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].via).toBe("heuristic");
  });

  test("discards ids invented by the selector (hallucination)", async () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    const invents: BranchSelector = {
      async select() {
        return ["99.99", "0.2"];
      },
    };

    const results = await retrieveFromTree(tree, "boss", { selector: invents });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("0.2");
  });

  test("a query with no matches returns empty, not noise", async () => {
    const tree = buildContentTree(GUIDE, { sourceId: "g" });
    expect(await retrieveFromTree(tree, "zzz qqq")).toEqual([]);
  });
});
