/**
 * KITSUDEN Brain — importer for graphify's `graph.json` (2026-10-28)
 * ============================================================================
 *
 * graphify (https://github.com/safishamsi/graphify, Apache-2.0) turns a folder
 * into a knowledge graph and writes `graphify-out/graph.json`. This is OUR
 * parser of that OUTPUT FORMAT — no graphify code is used or copied. What the
 * format is, as far as it could be checked on 2026-10-28:
 *
 *   · NetworkX "node-link" JSON: `{ directed, multigraph, graph: {…},
 *     nodes: [...], links: [...], hyperedges: [...], built_at_commit }`.
 *     Old releases wrote `edges` instead of `links` on one code path (fixed in
 *     graphify v0.7.18): both are accepted.
 *   · node: `id` (required), `label`, `file_type`, `source_file`,
 *     `source_location`, `community`, `community_name`, …
 *   · link: `source`, `target`, `relation` (graphify drops links without one),
 *     `confidence` ∈ EXTRACTED | INFERRED | AMBIGUOUS, `confidence_score`,
 *     `weight`, `source_file`, `source_location`, `context`.
 *   · The README says the persisted graph carries `graph.schema_version` (and
 *     `graph.graphify_version`) "so integrations can detect incompatible format
 *     changes". Its VALUE is not documented anywhere that could be read, and
 *     the five real graph.json files inspected (July–October 2026) do
 *     not have it. So:
 *       - absent            → accepted as the legacy, pre-versioned format
 *                             (with a warning in the response);
 *       - 1 / "1" / "1.x"   → accepted;
 *       - anything else     → rejected (422), unless the caller passes
 *                             `allowUnknownSchemaVersion: true`, and then the
 *                             structure is still validated node by node.
 *
 * Mapping into the brain:
 *   · each node → a note owned by the caller, key `graphify:<ns>:<node id>`
 *     (re-importing the same graph updates the same notes: idempotent);
 *   · each link → a connection with `origin` EXTRACTED or INFERRED and
 *     `confidence` = `confidence_score` (EXTRACTED without a score = 1).
 *     AMBIGUOUS becomes INFERRED with `metadata.ambiguous = true`: the brain
 *     has no third value and an ambiguous edge is, at best, a guess. A legacy
 *     numeric `confidence` becomes INFERRED with that number as the score
 *     (what graphify itself does since v0.9.48).
 *   · hyperedges are not imported (counted in the report).
 */

import { and, eq, like, sql } from "drizzle-orm";

import { brainConnections, brainNotes } from "../../../../apps/api/src/db/schema-core";
import { AppError } from "../errors";

import type { EmbeddingInfo, PluggableEmbeddingProvider } from "./embeddings";
import type { BrainActor, BrainVisibility } from "./memory";
import type { BrainDb } from "./notes";

export interface GraphifyNode {
  id: string;
  label: string;
  fileType: string | null;
  sourceFile: string | null;
  sourceLocation: string | null;
  community: string | null;
}

export interface GraphifyEdge {
  source: string;
  target: string;
  relation: string;
  origin: "EXTRACTED" | "INFERRED";
  confidence: number;
  ambiguous: boolean;
  sourceFile: string | null;
  sourceLocation: string | null;
}

export interface ParsedGraphify {
  schemaVersion: string | number | null;
  graphifyVersion: string | null;
  directed: boolean;
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
  hyperedges: number;
  warnings: string[];
}

export const SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS = ["1"] as const;

function text(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function supportedVersion(v: string | number): boolean {
  const s = String(v).trim();
  return SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS.some((ok) => s === ok || s.startsWith(`${ok}.`));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Parse and validate a graphify `graph.json` (already JSON-decoded). Throws
 * a 422 (AppError.validation) with the reason; never trusts a field's type.
 */
export function parseGraphify(
  doc: unknown,
  opts: { allowUnknownSchemaVersion?: boolean; maxNodes?: number; maxEdges?: number } = {}
): ParsedGraphify {
  if (!isObject(doc)) throw AppError.validation("graph.json: expected a JSON object");
  const warnings: string[] = [];
  const graph = isObject(doc.graph) ? doc.graph : {};
  const rawVersion = graph.schema_version ?? doc.schema_version;
  const schemaVersion =
    typeof rawVersion === "string" || typeof rawVersion === "number" ? rawVersion : null;
  if (rawVersion !== undefined && schemaVersion === null) {
    throw AppError.validation("graph.json: graph.schema_version must be a string or a number");
  }
  if (schemaVersion === null) {
    warnings.push("no graph.schema_version: read as the legacy (pre-versioned) graphify format");
  } else if (!supportedVersion(schemaVersion)) {
    if (!opts.allowUnknownSchemaVersion) {
      throw AppError.validation(
        `graph.json: schema_version ${JSON.stringify(schemaVersion)} is not supported (supported: ${SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS.join(", ")} and the legacy format without it). Pass allowUnknownSchemaVersion to try anyway.`,
        { schemaVersion, supported: SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS }
      );
    }
    warnings.push(
      `schema_version ${JSON.stringify(schemaVersion)} is unknown; imported because allowUnknownSchemaVersion was set`
    );
  }
  const graphifyVersion = text(graph.graphify_version);

  if (!Array.isArray(doc.nodes)) throw AppError.validation("graph.json: 'nodes' must be an array");
  const rawEdges = Array.isArray(doc.links)
    ? doc.links
    : Array.isArray(doc.edges)
      ? doc.edges
      : null;
  if (!rawEdges)
    throw AppError.validation("graph.json: 'links' (or legacy 'edges') must be an array");
  const maxNodes = opts.maxNodes ?? 5000;
  const maxEdges = opts.maxEdges ?? 20000;
  if (doc.nodes.length > maxNodes) {
    throw AppError.validation(
      `graph.json: ${doc.nodes.length} nodes; at most ${maxNodes} per import`
    );
  }
  if (rawEdges.length > maxEdges) {
    throw AppError.validation(
      `graph.json: ${rawEdges.length} links; at most ${maxEdges} per import`
    );
  }

  const nodes: GraphifyNode[] = [];
  const ids = new Set<string>();
  doc.nodes.forEach((n, i) => {
    if (!isObject(n)) throw AppError.validation(`graph.json: nodes[${i}] is not an object`);
    const id = text(n.id);
    if (!id || !id.trim()) throw AppError.validation(`graph.json: nodes[${i}] has no id`);
    if (id.length > 300) throw AppError.validation(`graph.json: nodes[${i}].id is longer than 300`);
    if (ids.has(id)) {
      warnings.push(`duplicate node id '${id}' (kept the first)`);
      return;
    }
    ids.add(id);
    const label = (text(n.label) ?? id).slice(0, 500);
    nodes.push({
      id,
      label: label.trim() || id,
      fileType: text(n.file_type),
      sourceFile: text(n.source_file),
      sourceLocation: text(n.source_location),
      community: text(n.community_name) ?? text(n.community),
    });
  });

  const edges: GraphifyEdge[] = [];
  let withoutRelation = 0;
  let hanging = 0;
  rawEdges.forEach((e, i) => {
    if (!isObject(e)) throw AppError.validation(`graph.json: links[${i}] is not an object`);
    const source = text(e.source);
    const target = text(e.target);
    const relation = text(e.relation) ?? text(e.relationship);
    if (!relation || !relation.trim()) {
      withoutRelation++;
      return;
    }
    if (!source || !target || !ids.has(source) || !ids.has(target) || source === target) {
      hanging++;
      return;
    }
    const conf = e.confidence;
    const score =
      typeof e.confidence_score === "number" && Number.isFinite(e.confidence_score)
        ? clamp01(e.confidence_score)
        : null;
    let origin: GraphifyEdge["origin"] = "INFERRED";
    let ambiguous = false;
    let confidence = score ?? 0.5;
    if (typeof conf === "string") {
      const tag = conf.trim().toUpperCase();
      if (tag === "EXTRACTED") {
        origin = "EXTRACTED";
        confidence = score ?? 1;
      } else if (tag === "AMBIGUOUS") {
        ambiguous = true;
      } else if (tag !== "INFERRED") {
        warnings.push(`links[${i}]: unknown confidence '${conf}' read as INFERRED`);
      }
    } else if (typeof conf === "number" && Number.isFinite(conf)) {
      confidence = score ?? clamp01(conf);
    }
    edges.push({
      source,
      target,
      relation: relation.trim().slice(0, 100),
      origin,
      confidence,
      ambiguous,
      sourceFile: text(e.source_file),
      sourceLocation: text(e.source_location),
    });
  });
  if (withoutRelation) warnings.push(`${withoutRelation} link(s) without 'relation' skipped`);
  if (hanging) warnings.push(`${hanging} link(s) to unknown nodes (or self-loops) skipped`);

  return {
    schemaVersion,
    graphifyVersion,
    directed: doc.directed === true,
    nodes,
    edges,
    hyperedges: Array.isArray(doc.hyperedges) ? doc.hyperedges.length : 0,
    warnings,
  };
}

export interface GraphifyImportReport {
  namespace: string;
  schemaVersion: string | number | null;
  graphifyVersion: string | null;
  notes: { created: number; updated: number; unchanged: number };
  connections: { created: number; existing: number; extracted: number; inferred: number };
  hyperedgesSkipped: number;
  embedding: EmbeddingInfo;
  warnings: string[];
}

function noteText(n: GraphifyNode): string {
  const lines = [n.label];
  if (n.fileType) lines.push(`type: ${n.fileType}`);
  if (n.sourceFile)
    lines.push(`file: ${n.sourceFile}${n.sourceLocation ? ` (${n.sourceLocation})` : ""}`);
  if (n.community) lines.push(`community: ${n.community}`);
  return lines.join("\n");
}

const BATCH = 200;

/**
 * Load a parsed graph into the caller's memory. All embeddings are computed
 * BEFORE the first query (an HTTP provider must not keep the request's
 * transaction open), then notes and connections go in batches.
 */
export async function importGraphify(
  db: BrainDb,
  actor: BrainActor,
  parsed: ParsedGraphify,
  provider: PluggableEmbeddingProvider,
  opts: { namespace: string; visibility?: BrainVisibility }
): Promise<GraphifyImportReport> {
  if (actor.kind === "system") throw AppError.forbidden("An import needs an owner");
  const ns = opts.namespace;
  const visibility = opts.visibility ?? "private";
  const prefix = `graphify:${ns}:`;

  const vectors = new Map<string, number[]>();
  for (const n of parsed.nodes) vectors.set(n.id, await provider.embed(noteText(n)));

  const owner =
    actor.kind === "agent"
      ? { ownerUserId: null, ownerAgentId: actor.id, sponsorUserId: actor.sponsorUserId ?? null }
      : { ownerUserId: actor.id, ownerAgentId: null, sponsorUserId: null };
  const myOwn =
    actor.kind === "agent"
      ? eq(brainNotes.ownerAgentId, actor.id!)
      : and(sql`${brainNotes.ownerAgentId} IS NULL`, eq(brainNotes.ownerUserId, actor.id!));

  // What this owner already has from this namespace.
  const existingOnes = new Map<
    string,
    { id: string; title: string; content: string; visibility: string; kind: string | null }
  >();
  const escaped = prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
  const rows = await db
    .select({
      id: brainNotes.id,
      key: brainNotes.noteKey,
      title: brainNotes.title,
      content: brainNotes.content,
      visibility: brainNotes.visibility,
      kind: brainNotes.embeddingKind,
    })
    .from(brainNotes)
    .where(and(myOwn, like(brainNotes.noteKey, `${escaped}%`)));
  for (const f of rows) if (f.key) existingOnes.set(f.key, f);

  const report: GraphifyImportReport = {
    namespace: ns,
    schemaVersion: parsed.schemaVersion,
    graphifyVersion: parsed.graphifyVersion,
    notes: { created: 0, updated: 0, unchanged: 0 },
    connections: { created: 0, existing: 0, extracted: 0, inferred: 0 },
    hyperedgesSkipped: parsed.hyperedges,
    embedding: provider.info,
    warnings: [...parsed.warnings],
  };

  const nodeId = new Map<string, string>();
  const newOnes: (typeof brainNotes.$inferInsert)[] = [];
  for (const n of parsed.nodes) {
    const key = `${prefix}${n.id}`;
    const content = noteText(n);
    const e = existingOnes.get(key);
    const metadata = {
      graphify: {
        id: n.id,
        file_type: n.fileType,
        source_file: n.sourceFile,
        source_location: n.sourceLocation,
        community: n.community,
        schema_version: parsed.schemaVersion,
        graphify_version: parsed.graphifyVersion,
      },
    };
    if (e) {
      nodeId.set(n.id, e.id);
      if (
        e.title === n.label &&
        e.content === content &&
        e.visibility === visibility &&
        e.kind === provider.info.kind
      ) {
        report.notes.unchanged++;
        continue;
      }
      await db
        .update(brainNotes)
        .set({
          title: n.label,
          content,
          visibility,
          metadata,
          embedding: vectors.get(n.id)!,
          embeddingKind: provider.info.kind,
          updatedAt: new Date(),
        })
        .where(eq(brainNotes.id, e.id));
      report.notes.updated++;
      continue;
    }
    newOnes.push({
      title: n.label,
      content,
      source: actor.kind === "agent" ? "agent" : "user",
      sourcePath: n.sourceFile,
      category: n.fileType === "code" ? "function" : "general",
      tags: ["graphify", ...(n.fileType ? [n.fileType] : [])],
      embedding: vectors.get(n.id)!,
      embeddingKind: provider.info.kind,
      importance: 50,
      confidence: 80,
      metadata,
      noteKey: key,
      visibility,
      ...owner,
    });
  }
  for (let i = 0; i < newOnes.length; i += BATCH) {
    const createdAll = await db
      .insert(brainNotes)
      .values(newOnes.slice(i, i + BATCH))
      .returning({ id: brainNotes.id, key: brainNotes.noteKey });
    for (const c of createdAll) if (c.key) nodeId.set(c.key.slice(prefix.length), c.id);
    report.notes.created += createdAll.length;
  }

  const connections: (typeof brainConnections.$inferInsert)[] = [];
  const views = new Set<string>();
  for (const e of parsed.edges) {
    const s = nodeId.get(e.source);
    const t = nodeId.get(e.target);
    if (!s || !t) continue;
    const key = `${s}|${t}|${e.relation}`;
    if (views.has(key)) continue;
    views.add(key);
    if (e.origin === "EXTRACTED") report.connections.extracted++;
    else report.connections.inferred++;
    connections.push({
      sourceNoteId: s,
      targetNoteId: t,
      relationType: e.relation,
      strength: e.confidence,
      origin: e.origin,
      confidence: e.confidence,
      metadata: {
        graphify: {
          source_file: e.sourceFile,
          source_location: e.sourceLocation,
          directed: parsed.directed,
          ...(e.ambiguous ? { confidence: "AMBIGUOUS" } : {}),
        },
        ...(e.ambiguous ? { ambiguous: true } : {}),
      },
      ownerUserId: owner.ownerUserId,
      ownerAgentId: owner.ownerAgentId,
    });
  }
  for (let i = 0; i < connections.length; i += BATCH) {
    const batch = connections.slice(i, i + BATCH);
    const createdMany = await db
      .insert(brainConnections)
      .values(batch)
      .onConflictDoNothing({
        target: [
          brainConnections.sourceNoteId,
          brainConnections.targetNoteId,
          brainConnections.relationType,
        ],
      })
      .returning({ id: brainConnections.id });
    report.connections.created += createdMany.length;
    report.connections.existing += batch.length - createdMany.length;
  }
  return report;
}
