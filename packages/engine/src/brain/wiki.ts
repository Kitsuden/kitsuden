/**
 * KITSUDEN Brain — Wiki Generator
 *
 * Writes structured Markdown files with YAML frontmatter to `.kitsuden/brain/`.
 * These files are designed for human readers and LLM context ingestion.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BrainNote, KnowledgeGraph } from "./types";

function escapeYaml(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, " ");
}

function buildFrontmatter(note: BrainNote): string {
  const tags = (note.tags ?? []).map((t) => `"${escapeYaml(t)}"`).join(", ");
  const title = escapeYaml(note.title);
  return `---
id: "${note.id}"
title: "${title}"
category: "${note.category}"
source: "${note.source}"
source_path: "${note.sourcePath ?? ""}"
importance: ${note.importance ?? 50}
confidence: ${note.confidence ?? 80}
tags: [${tags}]
generated_at: "${new Date().toISOString()}"
---
`;
}

function noteToMarkdown(note: BrainNote): string {
  return `${buildFrontmatter(note)}\n# ${note.title}\n\n${note.content}\n`;
}

export interface WikiGenerateOptions {
  wikiPath?: string;
  notes: BrainNote[];
  graph: KnowledgeGraph;
}

/**
 * Generate the `.kitsuden/brain/` wiki.
 */
export function generateWiki(options: WikiGenerateOptions): { files: string[]; path: string } {
  const wikiPath = options.wikiPath ?? ".kitsuden/brain";
  if (!existsSync(wikiPath)) {
    mkdirSync(wikiPath, { recursive: true });
  }

  const files: string[] = [];

  // One file per category
  const byCategory = new Map<string, BrainNote[]>();
  for (const note of options.notes) {
    const list = byCategory.get(note.category) ?? [];
    list.push(note);
    byCategory.set(note.category, list);
  }

  // Write individual note files
  for (const note of options.notes) {
    const safeTitle = note.title.replace(/[^a-z0-9\-_]/gi, "_").toLowerCase();
    const fileName = `${note.category}-${safeTitle.slice(0, 40)}-${note.id.slice(0, 8)}.md`;
    const filePath = join(wikiPath, fileName);
    writeFileSync(filePath, noteToMarkdown(note));
    files.push(filePath);
  }

  // Write category index files
  for (const [category, notes] of byCategory) {
    const indexPath = join(wikiPath, `${category}-index.md`);
    const lines = [
      `---\ncategory: "${category}"\ntotal: ${notes.length}\ngenerated_at: "${new Date().toISOString()}"\n---\n`,
      `# ${category.charAt(0).toUpperCase() + category.slice(1)} Index`,
      "",
      ...notes.map((n) => `- [${n.title}](${n.id}) — ${n.sourcePath ?? "no source"}`),
    ];
    writeFileSync(indexPath, lines.join("\n"));
    files.push(indexPath);
  }

  // Write main index
  const indexPath = join(wikiPath, "_index.md");
  const indexLines = [
    `---\ntotal_notes: ${options.notes.length}\ntotal_graph_nodes: ${options.graph.nodes.length}\ntotal_graph_edges: ${options.graph.edges.length}\ngenerated_at: "${new Date().toISOString()}"\n---\n`,
    "# KITSUDEN Brain Index",
    "",
    "Automatically generated knowledge base for the KITSUDEN project.",
    "",
    "## Categories",
    "",
    ...Array.from(byCategory.keys()).map(
      (c) => `- [${c}](${c}-index.md) (${byCategory.get(c)?.length ?? 0} notes)`
    ),
    "",
    "## Graph Summary",
    "",
    `- Nodes: ${options.graph.nodes.length}`,
    `- Edges: ${options.graph.edges.length}`,
    "",
    "> This directory is regenerated automatically by KITSUDEN Brain.",
  ];
  writeFileSync(indexPath, indexLines.join("\n"));
  files.push(indexPath);

  return { files, path: wikiPath };
}
