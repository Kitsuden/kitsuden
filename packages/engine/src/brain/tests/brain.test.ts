import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "bun:test";

import { scoreConnection, discoverConnections, suggestConnections } from "../connections";
import { embedTextLocal, cosineSimilarity, createLocalEmbeddingProvider } from "../embeddings";
import { buildKnowledgeGraph, neighborhoodGraph } from "../knowledge-graph";
import { generateLlms } from "../llms";
import { scanProject } from "../scanner";
import type { BrainNote, KnowledgeGraphNode, KnowledgeGraphEdge } from "../types";
import { generateWiki } from "../wiki";

function makeNote(
  id: string,
  title: string,
  content: string,
  category: BrainNote["category"] = "general",
  tags: string[] = []
): BrainNote {
  return {
    id,
    title,
    content,
    source: "user",
    sourcePath: null,
    category,
    tags,
    embedding: embedTextLocal(`${title} ${content} ${tags.join(" ")}`),
    importance: 50,
    confidence: 80,
    metadata: {},
    relatedNoteIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("KITSUDEN Brain", () => {
  describe("embeddings", () => {
    it("produces normalized vectors", () => {
      const vec = embedTextLocal("hello world");
      expect(vec.length).toBe(384);
      const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it("computes cosine similarity between related texts", () => {
      const a = embedTextLocal("user authentication with better-auth");
      const b = embedTextLocal("login session handled by better-auth");
      const c = embedTextLocal("PostgreSQL full-text search with pg_trgm");
      expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
    });

    it("exposes a provider interface", () => {
      const provider = createLocalEmbeddingProvider(128);
      expect(provider.dimensions).toBe(128);
      const vec = provider.embed("test");
      expect(vec.length).toBe(128);
    });
  });

  describe("connections", () => {
    it("scores strongly related notes higher", () => {
      const a = makeNote("a", "Auth users table", "Stores user accounts and sessions");
      const b = makeNote("b", "Auth sessions", "Session tokens for authenticated users");
      const c = makeNote("c", "Media storage", "S3 upload and image optimization");
      expect(scoreConnection(a, b)).toBeGreaterThan(scoreConnection(a, c));
    });

    it("discovers connections above threshold", () => {
      const notes = [
        makeNote("a", "Users", "user accounts"),
        makeNote("b", "Sessions", "user sessions"),
        makeNote("c", "Posts", "blog posts"),
        makeNote("d", "Media", "image uploads"),
      ];
      const connections = discoverConnections(notes, { threshold: 0.1, maxPerNote: 2 });
      expect(connections.length).toBeGreaterThan(0);
      for (const c of connections) {
        expect(c.sourceNoteId).not.toBe(c.targetNoteId);
        expect(c.strength).toBeGreaterThanOrEqual(0);
        expect(c.strength).toBeLessThanOrEqual(1);
      }
    });

    it("suggests connections for a new note", () => {
      const existing = [
        makeNote("a", "Users", "user accounts"),
        makeNote("b", "Sessions", "user sessions"),
      ];
      const note = makeNote("c", "User profiles", "extended user profile data");
      const suggestions = suggestConnections(note, existing, { limit: 2, threshold: 0.1 });
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].noteId).toBe("a");
    });
  });

  describe("knowledge graph", () => {
    it("builds nodes and edges from notes and connections", () => {
      const notes = [
        makeNote("a", "Users", "users table", "schema"),
        makeNote("b", "Sessions", "sessions table", "schema"),
      ];
      const edges = [
        { sourceNoteId: "a", targetNoteId: "b", relationType: "references", strength: 0.9 },
      ];
      const graph = buildKnowledgeGraph(notes, edges);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].relation).toBe("references");
      expect(graph.nodes.every((n) => n.id && n.label && n.type)).toBe(true);
    });

    it("filters to neighborhood", () => {
      const notes = [
        makeNote("a", "A", "center"),
        makeNote("b", "B", "neighbor of a"),
        makeNote("c", "C", "neighbor of b"),
        makeNote("d", "D", "isolated"),
      ];
      const edges = [
        { sourceNoteId: "a", targetNoteId: "b", relationType: "related", strength: 0.8 },
        { sourceNoteId: "b", targetNoteId: "c", relationType: "related", strength: 0.8 },
      ];
      const graph = buildKnowledgeGraph(notes, edges);
      const neighborhood = neighborhoodGraph(graph, "a", 1);
      expect(neighborhood.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
      expect(neighborhood.edges).toHaveLength(1);
    });
  });

  describe("scanner", () => {
    it("scans TypeScript files and extracts entities", async () => {
      const root = mkdtempSync(join(tmpdir(), "kitsuden-brain-"));
      const routesDir = join(root, "apps", "api", "src", "routes");
      mkdirSync(routesDir, { recursive: true });
      writeFileSync(
        join(routesDir, "users.ts"),
        `
/**
 * User management routes.
 */
import { Hono } from "hono";
const app = new Hono();
app.get("/users", (c) => c.json([]));
app.post("/users", (c) => c.json({}));
export { app };
        `.trim()
      );

      const entities = await scanProject({
        root,
        include: ["apps/api/src/routes"],
        exclude: [],
      });

      expect(entities.length).toBeGreaterThan(0);
      const routeEntity = entities.find((e) => e.category === "route");
      expect(routeEntity).toBeDefined();
      expect(routeEntity?.title).toContain("Routes:");
      expect(routeEntity?.content).toContain("GET /users");
      expect(routeEntity?.content).toContain("POST /users");
    });
  });

  describe("wiki generator", () => {
    it("writes markdown files with frontmatter", () => {
      const notes = [
        makeNote("a", "Users", "users table", "schema"),
        makeNote("b", "Posts", "blog posts", "schema"),
      ];
      const graph = buildKnowledgeGraph(notes, []);
      const tmp = mkdtempSync(join(tmpdir(), "kitsuden-wiki-"));
      const result = generateWiki({ wikiPath: tmp, notes, graph });
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files.some((f) => f.endsWith("_index.md"))).toBe(true);
    });
  });

  describe("llms generator", () => {
    it("writes llms.txt and .llms/ sections", () => {
      const notes = [
        makeNote("a", "Users", "users table", "schema"),
        makeNote("b", "Sessions", "sessions table", "schema"),
        makeNote("c", "Get users", "GET /users", "route"),
      ];
      const graph = buildKnowledgeGraph(notes, []);
      const tmp = mkdtempSync(join(tmpdir(), "kitsuden-llms-"));
      const result = generateLlms({ projectRoot: tmp, notes, graph });
      expect(result.files.some((f) => f.endsWith("llms.txt"))).toBe(true);
      expect(result.files.some((f) => f.endsWith(join(".llms", "schema.md")))).toBe(true);
      expect(result.files.some((f) => f.endsWith(join(".llms", "routes.md")))).toBe(true);
    });
  });
});
