/**
 * Second Brain — Deterministic unit tests (no DB, no network)
 * ============================================================================
 *
 * They verify that the CORE of the second brain is deterministic: same input →
 * same output. This is what lets a local AI, API or CLI run it
 * reproducibly.
 */

import {
  hashContent,
  summarize,
  keywords,
  headings,
  links,
  extractSignals,
  createInstructionAuthor,
  buildAuthorPrompt,
  generateBrainSchemaDoc,
  type AuthorTask,
} from "@kitsuden/engine";
import { describe, it, expect } from "bun:test";

const SAMPLE = `# TOON format
TOON is a token-oriented notation. It declares array keys once and lists CSV rows.
This reduces token usage for LLM responses significantly. See https://toonformat.dev for details.
The format is deterministic and round-trippable.`;

describe("Second Brain — extraction (deterministic)", () => {
  it("hashContent is stable and distinguishes contents", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
    expect(hashContent("abc")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("summarize returns the first meaningful sentences, in a stable way", () => {
    const a = summarize(SAMPLE);
    const b = summarize(SAMPLE);
    expect(a).toBe(b);
    expect(a).toContain("TOON");
  });

  it("keywords is deterministic and excludes stopwords", () => {
    const k1 = keywords(SAMPLE);
    const k2 = keywords(SAMPLE);
    expect(k1).toEqual(k2);
    expect(k1).toContain("toon");
    expect(k1).not.toContain("the");
  });

  it("headings extracts Markdown headings", () => {
    expect(headings(SAMPLE)).toContain("TOON format");
  });

  it("links extracts URLs and deduplicates", () => {
    expect(links(SAMPLE)).toEqual(["https://toonformat.dev"]);
  });

  it("extractSignals is fully deterministic", () => {
    const s1 = extractSignals(SAMPLE);
    const s2 = extractSignals(SAMPLE);
    expect(s1).toEqual(s2);
  });
});

describe("Second Brain — InstructionAuthor (deterministic, no AI)", () => {
  const task: AuthorTask = {
    title: "TOON format",
    content: SAMPLE,
    signals: extractSignals(SAMPLE),
    relatedTitles: ["AI Optimization"],
    schemaRules: "- test rule",
  };

  it("produces byte-for-byte stable output", async () => {
    const author = createInstructionAuthor();
    const a = await author.author(task);
    const b = await author.author(task);
    expect(a.markdown).toBe(b.markdown);
  });

  it("includes the AGENT-TASK block and marks pendingAgent", async () => {
    const author = createInstructionAuthor();
    const res = await author.author(task);
    expect(res.markdown).toContain("<!-- AGENT-TASK");
    expect(res.markdown).toContain("[[AI Optimization]]");
    expect(res.pendingAgent).toBe(true);
    expect(res.authoredBy).toBe("instruction");
  });

  it("buildAuthorPrompt is deterministic and contains the signals", () => {
    const p1 = buildAuthorPrompt(task);
    const p2 = buildAuthorPrompt(task);
    expect(p1).toBe(p2);
    expect(p1).toContain("TOON format");
    expect(p1).toContain("[[AI Optimization]]");
  });
});

describe("Second Brain — BRAIN.md (Layer 3)", () => {
  it("generates the deterministic schema with the 3 layers and 4 operations", () => {
    const doc = generateBrainSchemaDoc({ projectName: "Kitsuden" });
    expect(doc).toBe(generateBrainSchemaDoc({ projectName: "Kitsuden" }));
    expect(doc).toContain("Layer 1");
    expect(doc).toContain("Layer 2");
    expect(doc).toContain("Layer 3");
    expect(doc).toContain("capture");
    expect(doc).toContain("lint");
    expect(doc).toContain("KITSUDEN_BRAIN_AUTHOR");
  });
});
