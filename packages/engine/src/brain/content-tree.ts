/**
 * Kitsuden — Tree index for retrieval by reasoning
 * ============================================================================
 *
 * Second retrieval layer, complementary to vector search
 * (inspired by PageIndex).
 *
 * THE PROBLEM IT SOLVES: chopping a document into chunks of N tokens
 * destroys its structure. A guide has sections with meaning —
 * "Rotation", "Gear per phase", "Boss strategy" — and a chunk in the middle of
 * a table means nothing. Vector search returns "similar" pieces
 * and trusts the model to reconstruct the meaning.
 *
 * THE ALTERNATIVE: preserve the document's index as a TREE and let the
 * agent navigate — like a human who opens the manual at the right chapter.
 * Each answer carries the exact path it came from: `Guide > Phase 3 > Gear`.
 *
 * WHEN TO USE EACH (they do not replace each other):
 *   · Vector  → "find me something similar", large corpus, fast answer.
 *   · Tree    → long, structured document, an answer that must cite its
 *               source, or when the question requires understanding the hierarchy.
 *
 * COST: navigating by reasoning means LLM calls per query (seconds and
 * cents), versus an embedding + ANN (milliseconds). That is why
 * building the tree is DETERMINISTIC and AI-free: only navigation can
 * use the model, and even that has a no-cost heuristic mode.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface TreeNode {
  /** Stable hierarchical path: "0.2.1". It is the citation. */
  id: string;
  /** Heading text. */
  title: string;
  /** Level (1 = h1). */
  level: number;
  /** The section's own content, without its children's. */
  content: string;
  /** Deterministic summary of the section (first useful sentence). */
  summary: string;
  /** Start line in the original document — exact traceability. */
  line: number;
  children: TreeNode[];
}

export interface ContentTree {
  /** Document title (first h1, or the given name). */
  title: string;
  /** Source identifier (slug, path, dataset id…). */
  sourceId: string;
  root: TreeNode[];
  /** Total nodes — to decide whether the tree fits in the context. */
  nodeCount: number;
}

/** Readable path of a node: "Guide > Phase 3 > Gear". */
export interface TreePath {
  id: string;
  titles: string[];
  line: number;
}

// ── Construction (deterministic, no AI) ──────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

/** First sentence with substance — the summary without calling any model. */
function summarize(content: string, maxLength = 180): string {
  const clean = content
    .replace(/```[\s\S]*?```/g, " ") // strip code blocks
    .replace(/[|>*_`#-]/g, " ") // strip markdown marks and tables
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "";
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1)}…` : sentence;
}

/**
 * Builds the tree from markdown headings.
 *
 * It is deterministic and cheap: same document → same tree, no AI. That matters
 * because the index is rebuilt every time the content changes, and paying an
 * LLM for that would be prohibitive.
 */
export function buildContentTree(
  markdown: string,
  options: { sourceId: string; title?: string } = { sourceId: "doc" }
): ContentTree {
  const lines = markdown.split("\n");

  interface Raw {
    level: number;
    title: string;
    line: number;
    body: string[];
  }

  const sections: Raw[] = [];
  let current: Raw | null = null;
  const preamble: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ``` toggles a code block: a "# " inside is NOT a heading.
    if (/^\s*```/.test(line)) inCodeBlock = !inCodeBlock;

    const match = inCodeBlock ? null : HEADING.exec(line);
    if (match) {
      current = { level: match[1].length, title: match[2], line: i + 1, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  // Nested by level with a stack.
  const root: TreeNode[] = [];
  const stack: TreeNode[] = [];
  let counter = 0;

  // The preamble (text before the first heading) is not lost: it is hung
  // as an introductory node, or the whole document if there are no headings.
  const preambleText = preamble.join("\n").trim();
  if (preambleText) {
    const node: TreeNode = {
      id: String(counter++),
      title: options.title ?? "Introduction",
      level: 1,
      content: preambleText,
      summary: summarize(preambleText),
      line: 1,
      children: [],
    };
    root.push(node);
  }

  for (const section of sections) {
    const content = section.body.join("\n").trim();
    const node: TreeNode = {
      id: "",
      title: section.title,
      level: section.level,
      content,
      summary: summarize(content),
      line: section.line,
      children: [],
    };

    // Pop until finding the parent (lower level).
    while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      node.id = String(counter++);
      root.push(node);
    } else {
      const parent = stack[stack.length - 1];
      node.id = `${parent.id}.${parent.children.length}`;
      parent.children.push(node);
    }
    stack.push(node);
  }

  const count = (nodes: TreeNode[]): number =>
    nodes.reduce((n, node) => n + 1 + count(node.children), 0);

  return {
    title: options.title ?? sections.find((s) => s.level === 1)?.title ?? options.sourceId,
    sourceId: options.sourceId,
    root,
    nodeCount: count(root),
  };
}

// ── Navigation ───────────────────────────────────────────────────────────────

/** Finds a node by its path id. */
export function findNode(tree: ContentTree, id: string): TreeNode | null {
  const walk = (nodes: TreeNode[]): TreeNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = walk(node.children);
      if (found) return found;
    }
    return null;
  };
  return walk(tree.root);
}

/** Readable path to a node — the citation that accompanies the answer. */
export function pathOf(tree: ContentTree, id: string): TreePath | null {
  const walk = (nodes: TreeNode[], titles: string[]): TreePath | null => {
    for (const node of nodes) {
      const trail = [...titles, node.title];
      if (node.id === id) return { id, titles: trail, line: node.line };
      const found = walk(node.children, trail);
      if (found) return found;
    }
    return null;
  };
  return walk(tree.root, []);
}

/**
 * Compact index of the tree: only titles and summaries, no body.
 *
 * This is what the agent is given so it can CHOOSE the branch. Putting the whole
 * document in the context would be exactly what this approach avoids: the index of
 * a 20,000-word guide fits in a few hundred tokens.
 */
export function renderIndex(tree: ContentTree, maxDepth = 3): string {
  const lines: string[] = [`# ${tree.title}`, ""];

  const walk = (nodes: TreeNode[], depth: number) => {
    if (depth > maxDepth) return;
    for (const node of nodes) {
      const indent = "  ".repeat(depth);
      const summary = node.summary ? ` — ${node.summary}` : "";
      lines.push(`${indent}[${node.id}] ${node.title}${summary}`);
      walk(node.children, depth + 1);
    }
  };

  walk(tree.root, 0);
  return lines.join("\n");
}

/** Content of a node with that of its children — what is read after choosing a branch. */
export function readNode(tree: ContentTree, id: string, includeChildren = true): string {
  const node = findNode(tree, id);
  if (!node) return "";

  const parts: string[] = [];
  const walk = (n: TreeNode, depth: number) => {
    parts.push(`${"#".repeat(Math.min(n.level + depth, 6))} ${n.title}`);
    if (n.content) parts.push(n.content);
    if (includeChildren) for (const child of n.children) walk(child, depth);
  };

  walk(node, 0);
  return parts.join("\n\n").trim();
}

// ── Branch selection ────────────────────────────────────────────────────────

export interface BranchSelector {
  /**
   * Given the index and the question, returns the ids of the relevant nodes.
   * The host implements it with an LLM; heuristic mode is the fallback.
   */
  select(index: string, query: string): Promise<string[]>;
}

export interface RetrieveOptions {
  /** Without a selector, heuristic matching is used (no cost, no AI). */
  selector?: BranchSelector;
  /** Maximum number of sections to return. */
  maxSections?: number;
  /** Include the content of the children of each chosen section. */
  includeChildren?: boolean;
}

export interface RetrievedSection {
  /** Citable path: "Guide > Phase 3 > Gear". */
  path: string;
  id: string;
  line: number;
  content: string;
  /** "reasoned" (the agent chose) or "heuristic" (term match). */
  via: "reasoned" | "heuristic";
  score?: number;
}

/**
 * Heuristic selection: scores by term match in title and
 * summary. It is not as good as the LLM's reasoning, but it is deterministic,
 * instant and free — and serves as a fallback when no model is available.
 */
function heuristicSelect(
  tree: ContentTree,
  query: string,
  limit: number
): { id: string; score: number }[] {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const scored: { id: string; score: number }[] = [];

  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      const title = node.title.toLowerCase();
      const body = `${node.summary} ${node.content}`.toLowerCase();

      let score = 0;
      for (const term of terms) {
        // The title weighs much more: it is what declares what the section is about.
        if (title.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ id: node.id, score: score / terms.length });
      walk(node.children);
    }
  };

  walk(tree.root);
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Retrieves the relevant sections by navigating the tree.
 *
 * With `selector` the agent reasons over the index and chooses; without it the
 * heuristic is used. In both cases the result carries the source PATH, so the
 * answer can cite exactly where it came from — unlike a
 * vector match, which is opaque.
 */
export async function retrieveFromTree(
  tree: ContentTree,
  query: string,
  options: RetrieveOptions = {}
): Promise<RetrievedSection[]> {
  const maxSections = options.maxSections ?? 3;
  const includeChildren = options.includeChildren ?? true;

  let ids: string[] = [];
  let via: "reasoned" | "heuristic" = "heuristic";
  let scores: Map<string, number> | undefined;

  if (options.selector) {
    try {
      ids = (await options.selector.select(renderIndex(tree), query)).slice(0, maxSections);
      via = "reasoned";
    } catch {
      ids = []; // the selector failed → heuristic
    }
  }

  if (ids.length === 0) {
    const picked = heuristicSelect(tree, query, maxSections);
    ids = picked.map((p) => p.id);
    scores = new Map(picked.map((p) => [p.id, p.score]));
    via = "heuristic";
  }

  const sections: RetrievedSection[] = [];
  for (const id of ids) {
    const path = pathOf(tree, id);
    if (!path) continue; // the selector may invent ids: they are discarded
    sections.push({
      id,
      path: path.titles.join(" > "),
      line: path.line,
      content: readNode(tree, id, includeChildren),
      via,
      score: scores?.get(id),
    });
  }

  return sections;
}
