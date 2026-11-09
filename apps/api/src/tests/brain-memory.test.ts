/**
 * Agent memory (brain) over MCP, with an owner — against the REAL app
 * ============================================================================
 *
 * Real agents (`createAgent`) open MCP sessions and call the GENERATED tools
 * (`brain_search`, `brain_read`, `brain_note_write`…):
 *
 *   · without a brain scope the tools are not listed, and calling one is
 *     KITSUDEN_E_FORBIDDEN; `brain:read` lists reads but not writes;
 *   · one agent does NOT see another's private notes (list, read, search,
 *     claims, export), sees shared ones, and still cannot delete them;
 *   · `brain_note_write` is idempotent by key (same content = unchanged);
 *   · claims go stale when their source is re-captured with another hash,
 *     and `brain_claim_verify` with rebind makes them fresh again;
 *   · the graphify importer keeps EXTRACTED / INFERRED and rejects an
 *     unknown schema_version;
 *   · and the RLS policies alone (as kitsuden_app, without the app filter)
 *     isolate the rows too.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { db } from "../db";
import { brainNotes } from "../db/schema";
import { app } from "../index";
import { createAgent } from "../services/agent-auth";

import { ensureAppRole, isDatabaseAvailable, generateTestId } from "./setup";

let dbAvailable = false;

interface Session {
  agentId: string;
  token: string;
  sessionId: string;
  close: () => Promise<void>;
}

const open: Session[] = [];
const createdNotes: string[] = [];

async function mcpSession(scopes: string[]): Promise<Session> {
  const { agent, plainApiKey } = await createAgent({
    name: `brain-${scopes.join("+")}-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", {
      headers: { Authorization: `Bearer ${plainApiKey}` },
    })
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const sessionId = text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!;
  const s: Session = {
    agentId: agent.id,
    token: plainApiKey,
    sessionId,
    close: () => reader.cancel().catch(() => {}),
  };
  open.push(s);
  return s;
}

let nextId = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC response read in the test
async function rpc(s: Session, method: string, params: unknown): Promise<any> {
  const res = await app.request(
    new Request(`http://localhost:3000/api/mcp?sessionId=${s.sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    })
  );
  expect(res.status).toBe(200);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool result
async function call(s: Session, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await rpc(s, "tools/call", { name, arguments: args });
  return r.result;
}

async function tools(s: Session): Promise<string[]> {
  const r = await rpc(s, "tools/list", {});
  return (r.result.tools as { name: string }[]).map((t) => t.name);
}

const READ = [
  "brain_search",
  "brain_read",
  "brain_list",
  "brain_connections",
  "brain_claims",
  "brain_export_okf",
];
const WRITE = [
  "brain_note_write",
  "brain_note_delete",
  "brain_connect",
  "brain_claim_add",
  "brain_claim_verify",
  "brain_lint",
  "brain_import_graphify",
];

async function write(s: Session, body: Record<string, unknown>) {
  const r = await call(s, "brain_note_write", { body });
  expect(r.isError, JSON.stringify(r).slice(0, 600)).toBeUndefined();
  const note = r.structuredContent.data.note;
  createdNotes.push(note.id);
  return r.structuredContent;
}

describe("brain over MCP: tools, scopes and owners", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await ensureAppRole();
  });
  afterAll(async () => {
    for (const s of open) await s.close();
    if (dbAvailable && createdNotes.length) {
      await db.delete(brainNotes).where(inArray(brainNotes.id, createdNotes));
    }
  });

  it("tools/list and tools/call follow brain:read / brain:write", async () => {
    if (!dbAvailable) return;
    const nobody = await mcpSession(["mcp:connect"]);
    const reader = await mcpSession(["mcp:connect", "brain:read"]);
    const writer = await mcpSession(["mcp:connect", "brain:write"]);

    const ofNobody = await tools(nobody);
    for (const t of [...READ, ...WRITE]) expect(ofNobody).not.toContain(t);

    const ofTheReader = await tools(reader);
    for (const t of READ) expect(ofTheReader).toContain(t);
    for (const t of WRITE) expect(ofTheReader).not.toContain(t);

    const ofTheWriter = await tools(writer);
    for (const t of [...READ, ...WRITE]) expect(ofTheWriter).toContain(t);

    // Calling without the scope: forbidden, not executed.
    const withoutScope = await call(nobody, "brain_search", { q: "anything" });
    expect(withoutScope.isError).toBe(true);
    expect(JSON.stringify(withoutScope)).toContain("KITSUDEN_E_FORBIDDEN");
    const readerWrites = await call(reader, "brain_note_write", {
      body: { key: "x", title: "x", content: "x" },
    });
    expect(readerWrites.isError).toBe(true);
    expect(JSON.stringify(readerWrites)).toContain("KITSUDEN_E_FORBIDDEN");

    // With the scope: it runs, and the response says the vectors are lexical.
    const searches = await call(reader, "brain_search", { q: "anything" });
    expect(searches.isError).toBeUndefined();
    expect(searches.structuredContent.data.embedding.mode).toBe("lexical");
  });

  it("one agent does not see another's private notes; shared ones are readable, not writable", async () => {
    if (!dbAvailable) return;
    const a = await mcpSession(["mcp:connect", "brain:write"]);
    const b = await mcpSession(["mcp:connect", "brain:write"]);
    const mark = `zq${generateTestId()
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()}`;

    const privateNote = (
      await write(a, {
        key: `p/${mark}`,
        title: `Private ${mark}`,
        content: `secret ${mark} plans`,
      })
    ).data.note;
    expect(privateNote.visibility).toBe("private");
    expect(privateNote.owner.agentId).toBe(a.agentId);
    const shared = (
      await write(a, {
        key: `s/${mark}`,
        title: `Shared ${mark}`,
        content: `team ${mark} notes`,
        visibility: "shared",
      })
    ).data.note;

    // B: read → 404, list → absent, search → absent
    const read = await call(b, "brain_read", { id: privateNote.id });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read)).toContain("KITSUDEN_E_NOT_FOUND");
    const list = await call(b, "brain_list", { limit: 200 });
    const ids = (list.structuredContent.data.notes as { id: string }[]).map((n) => n.id);
    expect(ids).not.toContain(privateNote.id);
    expect(ids).toContain(shared.id);
    const searches = await call(b, "brain_search", { q: mark, threshold: 0 });
    const foundOnes = (searches.structuredContent.data.hits as { note: { id: string } }[]).map(
      (h) => h.note.id
    );
    expect(foundOnes).not.toContain(privateNote.id);
    expect(foundOnes).toContain(shared.id);

    // A sees both
    const fromA = await call(a, "brain_search", { q: mark, threshold: 0 });
    const idsA = (fromA.structuredContent.data.hits as { note: { id: string } }[]).map(
      (h) => h.note.id
    );
    expect(idsA).toEqual(expect.arrayContaining([privateNote.id, shared.id]));

    // B cannot delete A's shared note, nor write over it (its key is B's own note)
    const deletes = await call(b, "brain_note_delete", { id: shared.id });
    expect(deletes.isError).toBe(true);
    expect(JSON.stringify(deletes)).toContain("KITSUDEN_E_FORBIDDEN");
    const sameKey = await write(b, { key: `s/${mark}`, title: "B's", content: "other" });
    expect(sameKey.data.outcome).toBe("created");
    expect(sameKey.data.note.id).not.toBe(shared.id);

    // Exports and claims follow the same rule
    const okf = await call(b, "brain_export_okf", { noteIds: `${privateNote.id},${shared.id}` });
    expect(okf.structuredContent.data.notes).toBe(1);
    expect(okf.structuredContent.data.files[0].content).toContain('okf_version: "0.2"');

    // The owner deletes its own
    const deletesTo = await call(a, "brain_note_delete", { id: privateNote.id });
    expect(deletesTo.isError, JSON.stringify(deletesTo).slice(0, 400)).toBeUndefined();
    expect(deletesTo.structuredContent.status).toBe(204);
  });

  it("brain_note_write is idempotent by key", async () => {
    if (!dbAvailable) return;
    const a = await mcpSession(["mcp:connect", "brain:write"]);
    const body = { key: `idem/${generateTestId()}`, title: "Idem", content: "same content" };
    const r1 = await write(a, body);
    const r2 = await write(a, body);
    expect(r1.status).toBe(201);
    expect(r1.data.outcome).toBe("created");
    expect(r2.status).toBe(200);
    expect(r2.data.outcome).toBe("unchanged");
    expect(r2.data.note.id).toBe(r1.data.note.id);
    expect(r2.data.note.updatedAt).toBe(r1.data.note.updatedAt);
    const r3 = await write(a, { ...body, content: "new content" });
    expect(r3.data.outcome).toBe("updated");
    expect(r3.data.note.id).toBe(r1.data.note.id);
  });

  it("claims: stale when the source changes, fresh again after rebind; lint persists it", async () => {
    if (!dbAvailable) return;
    const a = await mcpSession(["mcp:connect", "brain:write"]);
    const b = await mcpSession(["mcp:connect", "brain:write"]);
    const uri = `file:///docs/${generateTestId()}.md`;
    const note = (
      await write(a, { key: `c/${generateTestId()}`, title: "Ports", content: "API port" })
    ).data.note;

    const add = await call(a, "brain_claim_add", {
      body: {
        noteId: note.id,
        statement: "The API listens on 3000",
        source: { title: "README", content: "line one\nThe API listens on 3000\n", uri },
        range: { unit: "line", start: 2, end: 2 },
      },
    });
    expect(add.isError, JSON.stringify(add).slice(0, 600)).toBeUndefined();
    const claim = add.structuredContent.data.claim;
    expect(claim.status).toBe("fresh");
    expect(claim.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(add)).not.toContain("line one"); // never the source content
    // Idempotent
    const again = await call(a, "brain_claim_add", {
      body: {
        noteId: note.id,
        statement: "The API listens on 3000",
        source: { title: "README", content: "line one\nThe API listens on 3000\n", uri },
        range: { unit: "line", start: 2, end: 2 },
      },
    });
    expect(again.structuredContent.data.created).toBe(false);
    expect(again.structuredContent.data.claim.id).toBe(claim.id);

    // B may not add claims to A's note (it cannot even see it)
    const foreign = await call(b, "brain_claim_add", {
      body: { noteId: note.id, statement: "x", source: { title: "t", content: "c" } },
    });
    expect(foreign.isError).toBe(true);

    // The document changes: a new capture with the same uri
    const otherNote = (
      await write(a, { key: `c2/${generateTestId()}`, title: "tmp", content: "tmp" })
    ).data.note;
    await call(a, "brain_claim_add", {
      body: {
        noteId: otherNote.id,
        statement: "Port moved",
        source: { title: "README", content: "line one\nThe API listens on 4000\n", uri },
      },
    });
    const lint = await call(a, "brain_lint", {});
    expect(lint.isError, JSON.stringify(lint).slice(0, 400)).toBeUndefined();
    const stale = lint.structuredContent.data.stale as { claimId: string; reason: string }[];
    expect(stale.map((s) => s.claimId)).toContain(claim.id);
    expect(stale.find((s) => s.claimId === claim.id)!.reason).toContain("source changed");
    const listing = await call(a, "brain_claims", { noteId: note.id });
    expect(listing.structuredContent.data.claims[0].status).toBe("stale");

    const withoutRebind = await call(a, "brain_claim_verify", { id: claim.id, body: {} });
    expect(withoutRebind.structuredContent.data.check.status).toBe("stale");
    const withRebind = await call(a, "brain_claim_verify", {
      id: claim.id,
      body: { rebind: true },
    });
    expect(withRebind.structuredContent.data.rebound).toBe(true);
    expect(withRebind.structuredContent.data.claim.status).toBe("fresh");
    expect(withRebind.structuredContent.data.claim.verifiedBy).toBe(`agent:${a.agentId}`);
    createdNotes.push(otherNote.id);
  });

  it("graphify import keeps EXTRACTED/INFERRED, is idempotent and checks schema_version", async () => {
    if (!dbAvailable) return;
    const a = await mcpSession(["mcp:connect", "brain:write"]);
    const ns = `t${generateTestId()
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()}`.slice(0, 40);
    const graph = {
      directed: false,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: "app_main",
          label: "main.py",
          file_type: "code",
          source_file: "app/main.py",
          source_location: "L1",
        },
        { id: "app_db", label: "db.py", file_type: "code", source_file: "app/db.py" },
        { id: "doc_arch", label: "Architecture", file_type: "document" },
      ],
      links: [
        {
          source: "app_main",
          target: "app_db",
          relation: "imports_from",
          confidence: "EXTRACTED",
          confidence_score: 1,
        },
        {
          source: "app_db",
          target: "doc_arch",
          relation: "conceptually_related_to",
          confidence: "INFERRED",
          confidence_score: 0.7,
        },
        {
          source: "app_main",
          target: "doc_arch",
          relation: "references",
          confidence: "AMBIGUOUS",
          confidence_score: 0.3,
        },
        { source: "app_main", target: "nope", relation: "calls", confidence: "EXTRACTED" },
      ],
      hyperedges: [],
    };
    const r1 = await call(a, "brain_import_graphify", { body: { namespace: ns, graph } });
    expect(r1.isError, JSON.stringify(r1).slice(0, 800)).toBeUndefined();
    const rep = r1.structuredContent.data;
    expect(rep.notes.created).toBe(3);
    expect(rep.connections).toMatchObject({ created: 3, extracted: 1, inferred: 2 });
    expect(rep.warnings.join(" ")).toContain("legacy");

    const r2 = await call(a, "brain_import_graphify", { body: { namespace: ns, graph } });
    expect(r2.structuredContent.data.notes).toMatchObject({ created: 0, unchanged: 3 });
    expect(r2.structuredContent.data.connections).toMatchObject({ created: 0, existing: 3 });

    const notes = await call(a, "brain_list", { keyPrefix: `graphify:${ns}:`, mine: "true" });
    const list = notes.structuredContent.data.notes as { id: string; key: string }[];
    expect(list).toHaveLength(3);
    createdNotes.push(...list.map((n) => n.id));
    const main = list.find((n) => n.key === `graphify:${ns}:app_main`)!;
    const withValue = await call(a, "brain_connections", { id: main.id });
    const byRel = Object.fromEntries(
      (
        withValue.structuredContent.data.connections as {
          relationType: string;
          origin: string;
          confidence: number;
          metadata: Record<string, unknown>;
        }[]
      ).map((c) => [c.relationType, c])
    );
    expect(byRel.imports_from.origin).toBe("EXTRACTED");
    expect(byRel.imports_from.confidence).toBe(1);
    expect(byRel.references.origin).toBe("INFERRED");
    expect(byRel.references.metadata.ambiguous).toBe(true);

    const rare = await call(a, "brain_import_graphify", {
      body: { namespace: ns, graph: { ...graph, graph: { schema_version: 99 } } },
    });
    expect(rare.isError).toBe(true);
    expect(JSON.stringify(rare)).toContain("KITSUDEN_E_VALIDATION");
    const v1 = await call(a, "brain_import_graphify", {
      body: {
        namespace: ns,
        graph: { ...graph, graph: { schema_version: 1, graphify_version: "0.9.99" } },
      },
    });
    expect(v1.isError).toBeUndefined();
    expect(v1.structuredContent.data.graphifyVersion).toBe("0.9.99");
  });

  it("RLS alone (kitsuden_app, no app filter) isolates notes between agents", async () => {
    if (!dbAvailable) return;
    const mark = `rls-${generateTestId()}`;
    const [row] = await db
      .insert(brainNotes)
      .values({
        title: mark,
        content: "x",
        ownerAgentId: "agent-rls-a",
        visibility: "private",
        noteKey: mark,
      })
      .returning({ id: brainNotes.id });
    createdNotes.push(row!.id);
    const like = async (id: string, role: string): Promise<number> =>
      db.transaction(async (tx) => {
        const su = await tx.execute(sql`SELECT current_setting('is_superuser') AS su`);
        if ((su.rows[0] as { su: string }).su === "on")
          await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${id}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);
        const r = await tx.execute(
          sql`SELECT count(*)::int AS n FROM brain_notes WHERE note_key = ${mark}`
        );
        return (r.rows[0] as { n: number }).n;
      });
    expect(await like("agent-rls-a", "agent")).toBe(1);
    expect(await like("agent-rls-b", "agent")).toBe(0);
    expect(await like("some-editor", "editor")).toBe(0);
    expect(await like("", "anonymous")).toBe(0);
    expect(await like("some-admin", "admin")).toBe(1);
    // An agent cannot insert a note owned by another agent. The failing
    // INSERT goes in a SAVEPOINT (an error must not abort the transaction:
    // docs/install/kon-transactions.md), and the outcome is returned.
    const foreign = await db.transaction(async (tx) => {
      const su = await tx.execute(sql`SELECT current_setting('is_superuser') AS su`);
      if ((su.rows[0] as { su: string }).su === "on")
        await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', 'agent-rls-b', true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_role', 'agent', true)`);
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(
            sql`INSERT INTO brain_notes (title, content, owner_agent_id) VALUES ('forged', 'x', 'agent-rls-a')`
          );
        });
        return "inserted";
      } catch (e) {
        return String((e as { cause?: { code?: string } }).cause?.code ?? e);
      }
    });
    expect(foreign).toBe("42501"); // insufficient_privilege: the policy's WITH CHECK
  });
});
