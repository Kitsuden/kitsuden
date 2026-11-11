/**
 * Agent memory (brain) as SDK operations: REST + OpenAPI + MCP from ONE
 * declaration (2026-10-28)
 * ============================================================================
 *
 * Mounted by the core at `/api/brain/memory` (index.ts) inside the request's
 * RLS transaction, and registered among the MOUNTED operations so that:
 *
 *   · every operation is an MCP tool (`brain_search`, `brain_read`,
 *     `brain_note_write`…; names fixed with `mcp.name`, they are contract);
 *   · the `/api/brain` gate (admin only) lets through an agent whose scopes
 *     open THAT operation (`operationOpenedByFineScope`), and the team
 *     (admin, editor) through its own rule in `ADMIN_ONLY_ROUTES`;
 *   · human approval holds the sensible ones (DELETE by default) as proposals.
 *
 * Who sees what is decided by Postgres (rls-owned-tables.sql, «Agent
 * memory»): a note belongs to a user OR an agent, is private by default, and
 * `shared` makes it readable by the team and by agents. Admin sees all.
 *
 * Scopes: `brain:read` (search, read, list, export) and `brain:write`
 * (everything, reads included). Also `brain:*`, the fine ones
 * (`kon:brain:<operation>`) and `admin`, as for any SDK operation.
 *
 * Legacy routes (`routes/brain.ts`: scan, sync, capture, graph, tree…) stay
 * as they were: admin only, global (they run as the system).
 */

import {
  actorFromUser,
  addClaim,
  connectNotes,
  deleteMemoryNote,
  exportOkf,
  getVisibleNote,
  importGraphify,
  lintClaims,
  listClaims,
  listMemoryNotes,
  listNoteConnections,
  parseGraphify,
  resolveEmbeddingProvider,
  resolveExecutor,
  reverifyClaim,
  searchMemoryNotes,
  toMemoryNote,
  writeMemoryNote,
  type BrainActor,
  type PluggableEmbeddingProvider,
} from "@kitsuden/engine";
import { defineOperation } from "@kitsuden/shared";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { db } from "../db";
import { registerCoreOperations } from "../lib/core-operations";
import { requireAuth, optionalAuth } from "../middleware/auth";

export const MEMORY_KON = "kon-brain";
export const MEMORY_ROUTE = "/api/brain/memory";
export const SCOPE_BRAIN_READ = "brain:read";
export const SCOPE_BRAIN_WRITE = "brain:write";

const read = {
  access: "session" as const,
  permission: { scopes: [SCOPE_BRAIN_READ, SCOPE_BRAIN_WRITE], roles: ["admin", "editor"] },
  tags: ["brain"],
};
const write = {
  access: "session" as const,
  permission: { scopes: [SCOPE_BRAIN_WRITE], roles: ["admin", "editor"] },
  tags: ["brain"],
};

/** The request's RLS transaction (or the global db outside a request). */
function ex(): typeof db {
  return resolveExecutor(db) as typeof db;
}

function actor(user: unknown): BrainActor {
  return actorFromUser(user);
}

let provider: PluggableEmbeddingProvider | null = null;
/** Resolved once (env is read at first use); tests may reset it. */
export function embeddingsProvider(): PluggableEmbeddingProvider {
  provider ??= resolveEmbeddingProvider();
  return provider;
}
export function forgetEmbeddingsProvider(): void {
  provider = null;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const Visibility = z.enum(["private", "shared"]);
const BooleanString = z.enum(["true", "false"]);
const Embedding = z.object({
  kind: z.string(),
  mode: z.enum(["lexical", "semantic"]),
  dimensions: z.number(),
});
const Note = z.object({
  id: z.string(),
  key: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  visibility: Visibility,
  owner: z.object({
    userId: z.string().nullable(),
    agentId: z.string().nullable(),
    sponsorUserId: z.string().nullable(),
  }),
  category: z.string(),
  source: z.string(),
  tags: z.array(z.string()),
  importance: z.number(),
  confidence: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  embeddingKind: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const Origin = z.enum(["EXTRACTED", "INFERRED", "MANUAL"]);
const Connection = z.object({
  id: z.string(),
  sourceNoteId: z.string(),
  targetNoteId: z.string(),
  relationType: z.string(),
  origin: Origin,
  confidence: z.number(),
  strength: z.number(),
  owner: z.object({ userId: z.string().nullable(), agentId: z.string().nullable() }),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
const Range = z.object({
  unit: z.enum(["line", "char"]),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
const Assertion = z.object({
  id: z.string(),
  noteId: z.string(),
  statement: z.string(),
  source: z.object({
    id: z.string().nullable(),
    sha256: z.string(),
    uri: z.string().nullable(),
    range: Range.nullable(),
  }),
  status: z.enum(["fresh", "stale"]),
  staleReason: z.string().nullable(),
  checkedAt: z.string(),
  verifiedAt: z.string().nullable(),
  verifiedBy: z.string().nullable(),
  owner: z.object({ userId: z.string().nullable(), agentId: z.string().nullable() }),
  createdAt: z.string(),
});
const ParamId = z.object({ id: z.guid() });
const Category = z.enum([
  "schema",
  "route",
  "kon",
  "agent",
  "function",
  "dataset",
  "insight",
  "connection",
  "general",
]);
const Key = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\w.:/@-]+$/, "letters, digits and . _ : / @ -");

/**
 * Note ids one OKF export accepts in `noteIds`. They travel in the URL of a GET, and
 * the HTTP server refuses a request line plus headers over its limit (16 KB by default
 * in Bun and in Node) with an empty `431`, before the API sees it: a status no operation
 * can document. The cap was 20,000 characters, which the server could never deliver
 * (Schemathesis sent it and got the 431). 200 ids are 7,399 characters, which fits with
 * room for the cookie and the key; for more, export in batches or leave `noteIds` out.
 */
export const OKF_MAX_NOTE_IDS = 200;
/** 36 characters per id and a comma between them. */
const OKF_NOTE_IDS_MAX_LENGTH = OKF_MAX_NOTE_IDS * 37 - 1;

// ── Operations ──────────────────────────────────────────────────────────────

export const memoryOperations: AnyOperation[] = [
  defineOperation({
    ...read,
    id: "search",
    method: "GET",
    route: "/search",
    summary: "Search memory",
    description:
      "Notes nearest to `q` among those you can see (yours, your agents' if you sign for them, and shared ones). The default embeddings are LEXICAL (a term-frequency hash: shared words, not meaning) and `embedding.mode` says so; only notes embedded with the same provider are compared.",
    input: {
      query: z.object({
        q: z.string().min(1).max(2000),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        threshold: z.coerce.number().min(0).max(1).optional(),
        visibility: Visibility.optional(),
      }),
    },
    output: {
      schema: z.object({
        hits: z.array(z.object({ note: Note, score: z.number() })),
        embedding: Embedding,
        compared: z.number(),
      }),
    },
    mcp: { name: "brain_search" },
    guide: {
      whenToUse:
        "To recall what you (or the team, in shared notes) already wrote before writing again. Then read a hit with brain_read.",
      examples: [{ title: "Find decisions about auth", args: { q: "auth decision", limit: 5 } }],
      traps: [
        {
          if: "no hits for a synonym",
          then: "the default embeddings are lexical: search with the words the note uses",
        },
      ],
    },
    handle: async (e, { user: user }) => {
      const q = e.query as {
        q: string;
        limit?: number;
        threshold?: number;
        visibility?: "private" | "shared";
      };
      return searchMemoryNotes(ex(), actor(user), q.q, embeddingsProvider(), q);
    },
  }),
  defineOperation({
    ...read,
    id: "list-notes",
    method: "GET",
    route: "/notes",
    summary: "List memory notes",
    description:
      "Notes you can see, most recently updated first. `mine=true` keeps only your own; `keyPrefix` filters by the keys you chose.",
    input: {
      query: z.object({
        mine: BooleanString.optional(),
        visibility: Visibility.optional(),
        tag: z.string().max(100).optional(),
        keyPrefix: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    },
    output: { schema: z.object({ notes: z.array(Note) }) },
    mcp: { name: "brain_list" },
    handle: async (e, { user: user }) => ({
      notes: await listMemoryNotes(ex(), actor(user), {
        ...(e.query as Record<string, never>),
        mine: (e.query as { mine?: string }).mine === "true",
      }),
    }),
  }),
  defineOperation({
    ...write,
    id: "write-note",
    method: "PUT",
    route: "/notes",
    summary: "Write a memory note (idempotent by key)",
    description:
      "Creates or updates YOUR note with this `key` (keys are per owner: another agent's `key` is another note). Writing the same content again changes nothing (`outcome: unchanged`). Private by default; `visibility: shared` lets the team and other agents read it (never write it).",
    input: {
      body: z.object({
        key: Key,
        title: z.string().min(1).max(500),
        content: z.string().min(1).max(200_000),
        visibility: Visibility.optional(),
        category: Category.optional(),
        tags: z.array(z.string().min(1).max(100)).max(50).optional(),
        importance: z.number().int().min(0).max(100).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    output: {
      schema: z.object({
        note: Note,
        outcome: z.enum(["created", "updated", "unchanged"]),
        embedding: Embedding,
      }),
      otherStatuses: [201],
    },
    mcp: { name: "brain_note_write" },
    guide: {
      whenToUse: "To remember something across sessions. Reuse the same key to update it.",
      examples: [
        {
          title: "Remember a decision",
          args: {
            body: {
              key: "project-x/decisions/db",
              title: "DB choice",
              content: "We use Postgres 16 with pgvector.",
            },
          },
        },
      ],
    },
    handle: async (e, { user: user, c }) => {
      const r = await writeMemoryNote(ex(), actor(user), e.body as never, embeddingsProvider());
      return c.json(r, r.outcome === "created" ? 201 : 200);
    },
  }),
  defineOperation({
    ...read,
    id: "read-note",
    method: "GET",
    route: "/notes/:id",
    summary: "Read a memory note",
    description:
      "One note you can see, with its connections (each with `origin` EXTRACTED|INFERRED|MANUAL and `confidence`) and its claims (each with its evidence and fresh|stale status). 404 if it does not exist or is not visible to you.",
    input: { params: ParamId },
    output: {
      schema: z.object({
        note: Note,
        connections: z.array(Connection),
        claims: z.array(Assertion),
      }),
    },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "brain_read" },
    handle: async (e, { user: user }) => {
      const { id } = e.params as { id: string };
      const a = actor(user);
      const note = toMemoryNote(await getVisibleNote(ex(), a, id));
      const connections = await listNoteConnections(ex(), a, id);
      const claims = await listClaims(ex(), a, { noteId: id });
      return { note, connections, claims };
    },
  }),
  defineOperation({
    ...write,
    id: "delete-note",
    method: "DELETE",
    route: "/notes/:id",
    summary: "Delete a memory note",
    description:
      "Deletes YOUR note (and, in cascade, its connections and claims). A shared note of someone else is 403; one you cannot see, 404. Sensible: an agent under human approval gets a proposal (202) instead.",
    input: { params: ParamId },
    output: { status: 204 },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "brain_note_delete" },
    handle: async (e, { user: user, c }) => {
      await deleteMemoryNote(ex(), actor(user), (e.params as { id: string }).id);
      return c.body(null, 204);
    },
  }),
  defineOperation({
    ...read,
    id: "note-connections",
    method: "GET",
    route: "/notes/:id/connections",
    summary: "Connections of a note",
    description:
      "The connections of a note you can see whose other end you can also see, with provenance: `origin` EXTRACTED (explicit in a source), INFERRED (similarity or a model's guess) or MANUAL (asserted through the API), and `confidence` in [0, 1].",
    input: { params: ParamId },
    output: { schema: z.object({ connections: z.array(Connection) }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "brain_connections" },
    handle: async (e, { user: user }) => ({
      connections: await listNoteConnections(ex(), actor(user), (e.params as { id: string }).id),
    }),
  }),
  defineOperation({
    ...write,
    id: "connect",
    method: "POST",
    route: "/connections",
    summary: "Connect two notes",
    description:
      "Connects two notes you can see. Idempotent by (source, target, relationType): repeating it returns the existing connection. `origin` defaults to MANUAL with confidence 1.",
    idempotent: true,
    input: {
      body: z.object({
        sourceNoteId: z.guid(),
        targetNoteId: z.guid(),
        relationType: z.string().min(1).max(100).optional(),
        origin: Origin.optional(),
        confidence: z.number().min(0).max(1).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    output: {
      schema: z.object({ connection: Connection, created: z.boolean() }),
      status: 201,
      otherStatuses: [200],
    },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    mcp: { name: "brain_connect" },
    handle: async (e, { user: user, c }) => {
      const r = await connectNotes(ex(), actor(user), e.body as never);
      return c.json(r, r.created ? 201 : 200);
    },
  }),
  defineOperation({
    ...read,
    id: "list-claims",
    method: "GET",
    route: "/claims",
    summary: "List claims with evidence",
    description:
      "Claims (statement + source + the source's SHA-256 + optional range) of the notes you can see. `status=stale` lists the ones whose evidence changed.",
    input: {
      query: z.object({
        noteId: z.guid().optional(),
        status: z.enum(["fresh", "stale"]).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
      }),
    },
    output: { schema: z.object({ claims: z.array(Assertion) }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "brain_claims" },
    handle: async (e, { user: user }) => ({
      claims: await listClaims(ex(), actor(user), e.query as never),
    }),
  }),
  defineOperation({
    ...write,
    id: "add-claim",
    method: "POST",
    route: "/claims",
    summary: "Add a claim with evidence to your note",
    description:
      "Ties a statement of YOUR note to its evidence: an existing source (`sourceId`) or the evidence itself (`source`: title, content, uri), captured as an immutable, content-addressed source. Records the source's SHA-256 and an optional range (`line`: 1-based inclusive; `char`: 0-based, end exclusive). Idempotent by (note, statement, source hash). The response never includes the source's content.",
    idempotent: true,
    input: {
      body: z.object({
        noteId: z.guid(),
        statement: z.string().min(1).max(5000),
        sourceId: z.guid().optional(),
        source: z
          .object({
            title: z.string().min(1).max(500),
            content: z.string().min(1).max(2_000_000),
            uri: z.string().max(2000).optional(),
            sourceType: z.enum(["url", "file", "text", "note"]).optional(),
          })
          .optional(),
        range: Range.optional(),
      }),
    },
    output: {
      schema: z.object({ claim: Assertion, created: z.boolean() }),
      status: 201,
      otherStatuses: [200],
    },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "brain_claim_add" },
    guide: {
      whenToUse:
        "When a note states a fact taken from a document: cite it, so lint can tell you when the document changed. Give the same `uri` every time you capture a new version of that document.",
      before: ["noteId: from brain_note_write or brain_search"],
    },
    handle: async (e, { user: user, c }) => {
      const r = await addClaim(ex(), actor(user), e.body as never);
      return c.json(r, r.created ? 201 : 200);
    },
  }),
  defineOperation({
    ...write,
    id: "verify-claim",
    method: "POST",
    route: "/claims/:id/verify",
    summary: "Re-verify a claim",
    description:
      "Re-checks your claim against its source: fresh (and recorded as verified by you, now) or stale with the reason. With `rebind: true` and a newer source for the same uri, the claim moves to it — you assert the statement still holds there.",
    idempotent: true,
    input: {
      params: ParamId,
      body: z.object({ rebind: z.boolean().optional() }),
    },
    output: {
      schema: z.object({
        claim: Assertion,
        check: z.object({
          status: z.enum(["fresh", "stale"]),
          reason: z.string().nullable(),
          newerSourceId: z.string().nullable(),
        }),
        rebound: z.boolean(),
      }),
    },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    mcp: { name: "brain_claim_verify" },
    handle: async (e, { user: user }) =>
      reverifyClaim(
        ex(),
        actor(user),
        (e.params as { id: string }).id,
        e.body as { rebind?: boolean }
      ),
  }),
  defineOperation({
    ...write,
    id: "lint",
    method: "POST",
    route: "/lint",
    summary: "Lint claims (mark stale evidence)",
    description:
      "Deterministic (no AI): re-checks every claim you can see and stores fresh|stale on the ones you may write. A claim is stale when its source was re-captured with another hash (same uri), was deleted, or its range no longer fits.",
    idempotent: true,
    output: {
      schema: z.object({
        checked: z.number(),
        updated: z.number(),
        stale: z.array(
          z.object({
            claimId: z.string(),
            noteId: z.string(),
            statement: z.string(),
            reason: z.string(),
          })
        ),
      }),
    },
    mcp: { name: "brain_lint" },
    handle: async (_e, { user: user }) => lintClaims(ex(), { actor: actor(user) }),
  }),
  defineOperation({
    ...read,
    id: "export-okf",
    method: "GET",
    route: "/export/okf",
    summary: "Export to Open Knowledge Format v0.2",
    description:
      'The notes you can see (or `noteIds`, comma-separated, at most 200 per call) as an OKF v0.2 bundle: `files[]` with paths and Markdown (YAML frontmatter: type, title, tags, status, generated, verified, sources; claims as footnotes), plus a root index.md with okf_version "0.2". A longer list is a 422; a URL over the HTTP server\'s header limit never reaches the API and gets an empty 431.',
    input: {
      query: z.object({
        noteIds: z
          .string()
          .max(OKF_NOTE_IDS_MAX_LENGTH)
          .regex(/^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36})*$/, "comma-separated note ids")
          .optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
      }),
    },
    output: {
      schema: z.object({
        okfVersion: z.literal("0.2"),
        files: z.array(z.object({ path: z.string(), content: z.string() })),
        notes: z.number(),
        claims: z.number(),
      }),
    },
    mcp: { name: "brain_export_okf" },
    cost: 5,
    handle: async (e, { user: user }) => {
      const q = e.query as { noteIds?: string; limit?: number };
      return exportOkf(ex(), actor(user), {
        noteIds: q.noteIds ? q.noteIds.split(",").slice(0, OKF_MAX_NOTE_IDS) : undefined,
        limit: q.limit,
      });
    },
  }),
  defineOperation({
    ...write,
    id: "import-graphify",
    method: "POST",
    route: "/import/graphify",
    summary: "Import a graphify graph.json",
    description:
      "Loads a graph.json produced by graphify into YOUR memory: each node is a note with key `graphify:<namespace>:<node id>` (re-importing updates the same notes), each link a connection keeping graphify's EXTRACTED/INFERRED as `origin` and `confidence_score` as `confidence` (AMBIGUOUS → INFERRED, flagged). Checks `graph.schema_version`: absent = legacy format (warning), 1 = supported, anything else = 422 unless `allowUnknownSchemaVersion`. At most 5000 nodes and 20000 links per call.",
    idempotent: true,
    cost: 20,
    before: [bodyLimit({ maxSize: 25 * 1024 * 1024 })],
    input: {
      body: z.object({
        namespace: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, . _ -"),
        visibility: Visibility.optional(),
        allowUnknownSchemaVersion: z.boolean().optional(),
        graph: z.record(z.string(), z.unknown()),
      }),
    },
    output: {
      schema: z.object({
        namespace: z.string(),
        schemaVersion: z.union([z.string(), z.number()]).nullable(),
        graphifyVersion: z.string().nullable(),
        notes: z.object({ created: z.number(), updated: z.number(), unchanged: z.number() }),
        connections: z.object({
          created: z.number(),
          existing: z.number(),
          extracted: z.number(),
          inferred: z.number(),
        }),
        hyperedgesSkipped: z.number(),
        embedding: Embedding,
        warnings: z.array(z.string()),
      }),
    },
    mcp: { name: "brain_import_graphify" },
    handle: async (e, { user: user }) => {
      const b = e.body as {
        namespace: string;
        visibility?: "private" | "shared";
        allowUnknownSchemaVersion?: boolean;
        graph: unknown;
      };
      const parsed = parseGraphify(b.graph, {
        allowUnknownSchemaVersion: b.allowUnknownSchemaVersion,
      });
      return importGraphify(ex(), actor(user), parsed, embeddingsProvider(), {
        namespace: b.namespace,
        visibility: b.visibility,
      });
    },
  }),
];

/** For the inventory (OpenAPI, coverage). */
export const memoryKon = {
  id: MEMORY_KON,
  name: "Agent memory (brain)",
  version: "1.0.0",
  mountPath: MEMORY_ROUTE,
  operations: memoryOperations,
};

registerCoreOperations({
  konId: MEMORY_KON,
  mountPath: MEMORY_ROUTE,
  description:
    "Agent memory: notes with an owner (private by default, optionally shared), connections with provenance, claims with evidence, OKF export and graphify import.",
  operations: memoryOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const brainMemoryRoutes = operationsRouter(MEMORY_KON, memoryOperations, context);
