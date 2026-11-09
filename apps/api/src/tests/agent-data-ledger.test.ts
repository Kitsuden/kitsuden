/**
 * Agent data ledger — per-field decisions, evidence per field, later reviews
 * ============================================================================
 *
 * Against the REAL app (test Postgres), a real agent in `propose` mode and a
 * real admin with a session:
 *
 *   · a dataset entry PATCH is held with a per-field diff (changed, added and
 *     removed keys of `data`) and the agent's `_evidence`, which is NOT left in
 *     the stored body;
 *   · approving field by field executes only the accepted fields (an edited value
 *     wins; a rejected key keeps the current value); the agent sees the decision;
 *   · the evidence of the accepted fields stays with the row: the team reads it
 *     at /api/approvals/evidence, a reader of the row in `_provenance.fields`;
 *   · whole approval keeps working (the create, and its evidence by result id);
 *   · every field rejected = rejected; bad decisions and bad evidence = 422;
 *   · MCP `kitsuden_update_record` decided per field (merge semantics);
 *   · `direct` mode: REST and MCP writes keep their evidence (no proposal), bad
 *     evidence is 422 and runs nothing;
 *   · later reviews: scheduled on deciding, due by their job or their date, closed;
 *     a due review emails whoever scheduled it when mail is configured;
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import {
  agentIdentities,
  agentProposals,
  approvalSettings,
  dataEntries,
  dataSets,
  fieldEvidence,
  ledgerReviews,
} from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { invalidateApprovalsConfig } from "../lib/approvals";
import { REVIEW_QUEUE, markReviewDue } from "../lib/ledger";
import { createAgent } from "../services/agent-auth";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let admin = { cookie: "", userId: "" };
const agents: string[] = [];
const datasets: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies read in the test
type Json = any;

async function request(
  method: string,
  path: string,
  o: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Json; headers: Headers }> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
  );
  const text = await res.text();
  let body: Json = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, headers: res.headers };
}

const asAdmin = (method: string, path: string, body?: unknown) =>
  request(method, path, { cookie: admin.cookie, body });

async function newAgent(scopes: string[]): Promise<{ id: string; token: string }> {
  const { agent, plainApiKey } = await createAgent({
    name: `ledger-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  agents.push(agent.id);
  const r = await asAdmin("PUT", `/api/approvals/agents/${agent.id}/mode`, { mode: "propose" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id: agent.id, token: plainApiKey };
}

async function dataset(prefix: string): Promise<{ id: string; slug: string }> {
  const slug = `${prefix}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [ds] = await db
    .insert(dataSets)
    .values({
      name: slug,
      slug,
      schema: [{ key: "price", type: "number" }],
      policyJson: null,
    } as never)
    .returning({ id: dataSets.id, slug: dataSets.slug });
  datasets.push(ds!.id);
  return ds!;
}

async function entry(
  datasetId: string,
  data: Record<string, unknown>,
  ownerId: string | null = null
) {
  const [row] = await db
    .insert(dataEntries)
    .values({ dataSetId: datasetId, title: "Acme", data, status: "published", ownerId } as never)
    .returning({ id: dataEntries.id });
  return row!.id;
}

async function rowData(id: string): Promise<Record<string, unknown>> {
  const [r] = await db
    .select({ data: dataEntries.data })
    .from(dataEntries)
    .where(eq(dataEntries.id, id));
  return (r?.data ?? {}) as Record<string, unknown>;
}

const EVIDENCE = [
  {
    field: "data.price",
    source: "https://acme.example/pricing",
    quote: "Pro plan: 49 per month",
    confidence: 0.9,
    retrievedAt: "2026-11-01T10:00:00.000Z",
  },
  { field: "data.color", source: "doc:brand-guide.pdf#p2", quote: "Primary: teal" },
];

// ── MCP ──
interface Session {
  token: string;
  sessionId: string;
  close: () => Promise<void>;
}
const open: Session[] = [];
async function mcpSession(token: string): Promise<Session> {
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", { headers: { Authorization: `Bearer ${token}` } })
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
  const s = { token, sessionId, close: () => reader.cancel().catch(() => {}) };
  open.push(s);
  return s;
}
let rpcId = 1;
async function call(s: Session, name: string, args: unknown): Promise<Json> {
  const res = await app.request(
    new Request(`http://localhost:3000/api/mcp?sessionId=${s.sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  );
  return res.json();
}

describe("agent data ledger", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    clearQuotaMemory();
    admin = await enterAs(app, {
      email: `ledger-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Ledger Admin",
      role: "admin",
    });
    await db.delete(approvalSettings);
    invalidateApprovalsConfig();
    const r = await asAdmin("PUT", "/api/approvals/settings", { enabled: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  afterAll(async () => {
    for (const s of open) await s.close();
    if (!dbAvailable) return;
    await db.delete(approvalSettings);
    if (agents.length) {
      await db
        .update(agentIdentities)
        .set({ approvalMode: "inherit" })
        .where(inArray(agentIdentities.id, agents));
    }
    if (datasets.length) await db.delete(dataSets).where(inArray(dataSets.id, datasets));
    invalidateApprovalsConfig();
  });

  it("holds an entry PATCH with a per-field diff and the evidence out of the body", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-diff");
    const a = await newAgent(["admin"]);
    const id = await entry(ds.id, { name: "Acme", price: 40, color: "red", legacy: "x" });

    const r = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { name: "Acme", price: 49, color: "teal", plan: "pro" }, _evidence: EVIDENCE },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const pid = r.body.proposal.id as string;

    const d = await asAdmin("GET", `/api/approvals/proposals/${pid}`);
    expect(d.status).toBe(200);
    const fields = Object.fromEntries((d.body.fieldDiff.fields as Json[]).map((f) => [f.field, f]));
    expect(d.body.fieldDiff.target.entity).toBe("dataset_entry");
    expect(fields["data.price"]).toMatchObject({ before: 40, after: 49, change: "update" });
    expect(fields["data.color"]).toMatchObject({ before: "red", after: "teal", change: "update" });
    expect(fields["data.plan"]).toMatchObject({ after: "pro", change: "add" });
    expect(fields["data.legacy"]).toMatchObject({ before: "x", change: "remove" });
    // Unchanged fields are not decided.
    expect(fields["data.name"]).toBeUndefined();
    expect(d.body.evidence).toHaveLength(2);
    expect(d.body.evidence[0]).toMatchObject({ field: "data.price", confidence: 0.9 });
    expect(JSON.stringify(d.body.body)).not.toContain("_evidence");
    // Nothing ran yet.
    expect((await rowData(id)).price).toBe(40);
  });

  it("approving field by field executes only the accepted fields, and keeps their evidence", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-fields");
    const a = await newAgent(["admin"]);
    const id = await entry(ds.id, { name: "Acme", price: 40, color: "red", legacy: "x" });
    const r = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { name: "Acme", price: 49, color: "teal", plan: "pro" }, _evidence: EVIDENCE },
    });
    const pid = r.body.proposal.id as string;

    // Someone changes the row meanwhile: what is not decided is not overwritten.
    await db
      .update(dataEntries)
      .set({ data: { name: "Acme Inc", price: 40, color: "red", legacy: "x" } as never })
      .where(eq(dataEntries.id, id));

    const ok = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      comment: "price checked, colour not",
      fields: [
        { field: "data.price", decision: "accept", value: 45 },
        { field: "data.color", decision: "reject" },
        { field: "data.legacy", decision: "reject" },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.proposal.status).toBe("executed");
    expect(ok.body.proposal.fieldDecisions).toHaveLength(4);

    const data = await rowData(id);
    expect(data.price).toBe(45); // edited by the reviewer
    expect(data.color).toBe("red"); // rejected
    expect(data.legacy).toBe("x"); // removal rejected
    expect(data.plan).toBeUndefined(); // not listed = rejected
    expect(data.name).toBe("Acme Inc"); // not part of the diff: untouched

    // The agent sees which fields went in.
    const mine = await request("GET", `/api/proposals/${pid}`, { token: a.token });
    expect(mine.status).toBe(200);
    const decisions = Object.fromEntries(
      (mine.body.fieldDecisions as Json[]).map((f) => [f.field, f])
    );
    expect(decisions["data.price"]).toMatchObject({ decision: "accept", edited: true });
    expect(decisions["data.color"]).toMatchObject({ decision: "reject" });

    // Evidence: only the accepted field, marked as edited.
    const kept = await db
      .select()
      .from(fieldEvidence)
      .where(and(eq(fieldEvidence.entity, "dataset_entry"), eq(fieldEvidence.rowId, id)));
    expect(kept.map((e) => e.field)).toEqual(["data.price"]);
    expect(kept[0]).toMatchObject({
      source: "https://acme.example/pricing",
      edited: true,
      proposalId: pid,
      agentId: a.id,
      acceptedBy: admin.userId,
    });
    expect(kept[0]!.value).toBe(45);

    // The team reads it per row.
    const ev = await asAdmin("GET", `/api/approvals/evidence?entity=dataset_entry&rowId=${id}`);
    expect(ev.status, JSON.stringify(ev.body)).toBe(200);
    expect(ev.body.fields["data.price"]).toMatchObject({
      source: "https://acme.example/pricing",
      quote: "Pro plan: 49 per month",
      confidence: 0.9,
      edited: true,
    });

    // And whoever reads the row asks for its provenance.
    const read = await request("GET", `/api/data-sets/${ds.id}/entries/${id}`, {
      cookie: admin.cookie,
      headers: { "X-Kitsuden-Provenance": "1" },
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body._provenance.fields["data.price"]).toMatchObject({
      source: "https://acme.example/pricing",
      current: true,
    });

    // The audit says which fields.
    const audit = await asAdmin("GET", `/api/approvals/audit?proposalId=${pid}`);
    const approved = (audit.body.events as Json[]).find((e) => e.action === "proposal_approved");
    expect(approved.details.fields).toMatchObject({
      rejected: ["data.color", "data.plan", "data.legacy"],
      edited: ["data.price"],
    });
  });

  it("whole approval still works, and a create keeps its evidence by the new row id", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-create");
    const a = await newAgent(["admin"]);
    const r = await request("POST", `/api/datasets/${ds.id}/entries`, {
      token: a.token,
      body: {
        title: "Globex",
        data: { price: 12 },
        _evidence: [{ field: "data.price", source: "https://globex.example/p" }],
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const pid = r.body.proposal.id as string;
    const d = await asAdmin("GET", `/api/approvals/proposals/${pid}`);
    expect(d.body.fieldDiff.target.kind).toBe("create");
    expect((d.body.fieldDiff.fields as Json[]).map((f) => f.field).sort()).toEqual([
      "data.price",
      "title",
    ]);

    const ok = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.proposal.status).toBe("executed");
    const rowId = ok.body.proposal.result.body.id as string;
    expect((await rowData(rowId)).price).toBe(12);
    const kept = await db.select().from(fieldEvidence).where(eq(fieldEvidence.rowId, rowId));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ field: "data.price", edited: false });
  });

  it("every field rejected is a rejection; bad decisions and bad evidence are 422", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-reject");
    const a = await newAgent(["admin"]);
    const id = await entry(ds.id, { price: 1 });

    const bad = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { price: 2 }, _evidence: [{ field: "data.price" }] },
    });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body.code).toBe("KITSUDEN_E_VALIDATION");
    const typo = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { price: 2 }, _evidence: [{ field: "data.prize", source: "x" }] },
    });
    expect(typo.status).toBe(422);
    expect(typo.body.detail).toContain("data.prize");

    const r = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { price: 2 } },
    });
    expect(r.status).toBe(202);
    const pid = r.body.proposal.id as string;

    const unknown = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      fields: [{ field: "data.nope", decision: "accept" }],
    });
    expect(unknown.status).toBe(422);
    const rejectWithValue = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      fields: [{ field: "data.price", decision: "reject", value: 3 }],
    });
    expect(rejectWithValue.status).toBe(422);
    const secret = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      fields: [{ field: "data.price", decision: "accept", value: { password: "hunter2hunter2" } }],
    });
    expect(secret.status).toBe(422);
    // An empty list approves nothing: say what you accept, or send no list.
    const empty = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, { fields: [] });
    expect(empty.status).toBe(422);
    const badDate = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      reviewAt: "2001-01-01T00:00:00Z",
    });
    expect(badDate.status).toBe(422);
    // Still pending after all of that.
    const [still] = await db.select().from(agentProposals).where(eq(agentProposals.id, pid));
    expect(still!.status).toBe("pending");

    const no = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      fields: [{ field: "data.price", decision: "reject" }],
    });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body.proposal.status).toBe("rejected");
    expect((await rowData(id)).price).toBe(1);
  });

  it("a proposal that is not a record can only be decided whole", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-delete");
    const a = await newAgent(["admin"]);
    const id = await entry(ds.id, { price: 1 });
    const r = await request("DELETE", `/api/datasets/${ds.id}/entries/${id}`, { token: a.token });
    expect(r.status).toBe(202);
    const no = await asAdmin("POST", `/api/approvals/proposals/${r.body.proposal.id}/approve`, {
      fields: [{ field: "data.price", decision: "accept" }],
    });
    expect(no.status).toBe(422);
  });

  it("MCP kitsuden_update_record is decided per field (only accepted keys are merged)", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-mcp");
    const a = await newAgent([
      "mcp:connect",
      "mcp:read",
      "mcp:write",
      `datasets:${ds.slug}:write`,
      `datasets:${ds.slug}:read`,
    ]);
    const id = await entry(ds.id, { price: 10, stock: 3 });
    const s = await mcpSession(a.token);
    const held = await call(s, "kitsuden_update_record", {
      collection: ds.slug,
      id,
      data: { price: 11, stock: 0 },
      _evidence: [{ field: "data.stock", source: "https://shop.example/stock", confidence: 0.4 }],
    });
    const sc = held.result?.structuredContent;
    expect(sc?.code, JSON.stringify(held)).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
    const pid = sc.proposal.id as string;
    const d = await asAdmin("GET", `/api/approvals/proposals/${pid}`);
    expect(d.body.fieldDiff.target.shape).toBe("mcp-record");
    const fields = Object.fromEntries((d.body.fieldDiff.fields as Json[]).map((f) => [f.field, f]));
    expect(fields["data.price"]).toMatchObject({ before: 10, after: 11 });
    expect(fields["data.stock"]).toMatchObject({ before: 3, after: 0 });

    const ok = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      fields: [
        { field: "data.price", decision: "reject" },
        { field: "data.stock", decision: "accept" },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.proposal.status, JSON.stringify(ok.body.proposal.result)).toBe("executed");
    const data = await rowData(id);
    expect(data.price).toBe(10);
    expect(data.stock).toBe(0);
    const kept = await db.select().from(fieldEvidence).where(eq(fieldEvidence.rowId, id));
    expect(kept.map((e) => e.field)).toEqual(["data.stock"]);
  });

  it("schedules a later review on deciding; it becomes due and a person closes it", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-review");
    const a = await newAgent(["admin"]);
    const id = await entry(ds.id, { price: 1 });
    const r = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { price: 2 } },
    });
    const pid = r.body.proposal.id as string;
    const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const ok = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      reviewAt: at,
      reviewNote: "Check the price again next week",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.proposal.reviews).toHaveLength(1);
    const review = ok.body.proposal.reviews[0];
    expect(review).toMatchObject({ status: "scheduled", rowId: id, entity: "dataset_entry" });

    // A queue job with that run date.
    const [stored] = await db
      .select({ jobId: ledgerReviews.jobId })
      .from(ledgerReviews)
      .where(eq(ledgerReviews.id, review.id));
    expect(stored!.jobId).toBeTruthy();
    const [job] = (
      (await db.execute(
        sql`SELECT queue, run_at FROM kitsuden_outbox WHERE id = ${stored!.jobId}::uuid`
      )) as unknown as { rows: Array<{ queue: string; run_at: Date }> }
    ).rows;
    expect(job!.queue).toBe(REVIEW_QUEUE);
    expect(Math.abs(new Date(job!.run_at).getTime() - new Date(at).getTime())).toBeLessThan(60_000);

    // Not due yet.
    const before = await asAdmin("GET", `/api/approvals/reviews?status=due&proposalId=${pid}`);
    expect(before.body.total).toBe(0);

    // The job runs: it is due.
    expect(await markReviewDue(review.id)).toBe(true);
    expect(await markReviewDue(review.id)).toBe(false); // idempotent
    const due = await asAdmin("GET", `/api/approvals/reviews?status=due&proposalId=${pid}`);
    expect(due.body.total).toBe(1);
    expect(due.body.reviews[0].note).toBe("Check the price again next week");

    const done = await asAdmin("POST", `/api/approvals/reviews/${review.id}/done`, {
      comment: "still right",
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.review.status).toBe("done");
    const again = await asAdmin("POST", `/api/approvals/reviews/${review.id}/done`, {});
    expect(again.status).toBe(409);

    // Scheduled later through its own route; one past its date counts as due even
    // without its job (the job is the notice, not the truth).
    const later = await asAdmin("POST", `/api/approvals/proposals/${pid}/review`, {
      reviewAt: new Date(Date.now() + 86_400_000).toISOString(),
      fields: ["data.price"],
    });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    await db
      .update(ledgerReviews)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(eq(ledgerReviews.id, later.body.review.id));
    const lazy = await asAdmin("GET", `/api/approvals/reviews?status=due&proposalId=${pid}`);
    expect(lazy.body.reviews.map((x: Json) => x.id)).toContain(later.body.review.id);
    expect(lazy.body.reviews[0].status).toBe("due");

    // Unknown field, pending proposal: 422.
    const badField = await asAdmin("POST", `/api/approvals/proposals/${pid}/review`, {
      reviewAt: new Date(Date.now() + 86_400_000).toISOString(),
      fields: ["data.nope"],
    });
    expect(badField.status).toBe(422);
    const pending = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { price: 9 } },
    });
    const notYet = await asAdmin(
      "POST",
      `/api/approvals/proposals/${pending.body.proposal.id}/review`,
      { reviewAt: new Date(Date.now() + 86_400_000).toISOString() }
    );
    expect(notYet.status).toBe(422);
  });

  it("a due review emails the person who scheduled it, once, only when mail is configured", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-notify");
    const a = await newAgent(["admin"]);
    const id = await entry(ds.id, { price: 1 });
    const r = await request("PATCH", `/api/datasets/${ds.id}/entries/${id}`, {
      token: a.token,
      body: { data: { price: 3 } },
    });
    const pid = r.body.proposal.id as string;
    const ok = await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {
      reviewAt: new Date(Date.now() + 86_400_000).toISOString(),
      reviewNote: "<b>look</b> again",
    });
    const reviewId = ok.body.proposal.reviews[0].id as string;

    const { emailQueue } = await import("../lib/queue");
    const original = emailQueue.add;
    const sent: Array<{ name: string; data: Json }> = [];
    emailQueue.add = (async (name: string, data: Json) => {
      sent.push({ name, data });
      return { id: "job" };
    }) as never;
    const saved = { driver: process.env.MAIL_DRIVER, host: process.env.SMTP_HOST };
    try {
      // No mail configured: the panel is the notice, nothing is queued.
      process.env.MAIL_DRIVER = "log";
      const second = await asAdmin("POST", `/api/approvals/proposals/${pid}/review`, {
        reviewAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(await markReviewDue(second.body.review.id)).toBe(true);
      expect(sent).toHaveLength(0);

      process.env.MAIL_DRIVER = "smtp";
      process.env.SMTP_HOST = "smtp.invalid";
      expect(await markReviewDue(reviewId)).toBe(true);
      expect(await markReviewDue(reviewId)).toBe(false);
      expect(sent).toHaveLength(1);
      const [mail] = await db
        .select({ email: sql<string>`email` })
        .from(sql`auth_users`)
        .where(sql`id = ${admin.userId}`);
      expect(sent[0]!.name).toBe("ledger.review-due");
      expect(sent[0]!.data.to).toBe(mail!.email);
      expect(sent[0]!.data.text).toContain(`tab=reviews&id=${pid}`);
      expect(sent[0]!.data.html).toContain("&#60;b&#62;look&#60;/b&#62;");
    } finally {
      emailQueue.add = original;
      for (const [k, v] of [
        ["MAIL_DRIVER", saved.driver],
        ["SMTP_HOST", saved.host],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);

  it("direct mode: REST and MCP writes keep their evidence; bad evidence runs nothing", async () => {
    if (!dbAvailable) return;
    const ds = await dataset("ledger-direct");
    const a = await newAgent(["admin"]);
    const m = await asAdmin("PUT", `/api/approvals/agents/${a.id}/mode`, { mode: "direct" });
    expect(m.status, JSON.stringify(m.body)).toBe(200);

    // REST create: runs at once, the row has no `_evidence`, the evidence is kept by the new id.
    const created = await request("POST", `/api/datasets/${ds.id}/entries`, {
      token: a.token,
      body: {
        title: "Initech",
        data: { price: 7 },
        _evidence: [{ field: "data.price", source: "https://initech.example/p", confidence: 0.7 }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const rowId = (created.body.id ?? created.body.data?.id) as string;
    expect(JSON.stringify(await rowData(rowId))).not.toContain("_evidence");
    const kept = await db.select().from(fieldEvidence).where(eq(fieldEvidence.rowId, rowId));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      entity: "dataset_entry",
      field: "data.price",
      value: 7,
      confidence: 0.7,
      proposalId: null,
      acceptedBy: null,
      agentId: a.id,
    });

    // Bad evidence: 422 and nothing is written.
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dataEntries)
      .where(eq(dataEntries.dataSetId, ds.id));
    const bad = await request("POST", `/api/datasets/${ds.id}/entries`, {
      token: a.token,
      body: { title: "X", data: { price: 1 }, _evidence: [{ field: "data.prize", source: "x" }] },
    });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body.reason).toBe("evidence");
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dataEntries)
      .where(eq(dataEntries.dataSetId, ds.id));
    expect(after[0]!.n).toBe(before[0]!.n);

    // MCP update: the evidence is kept for the row it updated.
    const s = await mcpSession(a.token);
    const res = await call(s, "kitsuden_update_record", {
      collection: ds.slug,
      id: rowId,
      data: { price: 8 },
      _evidence: [{ field: "data.price", source: "https://initech.example/p2" }],
    });
    expect(res.result?.isError, JSON.stringify(res)).toBeFalsy();
    expect((await rowData(rowId)).price).toBe(8);
    const both = await db
      .select()
      .from(fieldEvidence)
      .where(
        and(eq(fieldEvidence.rowId, rowId), eq(fieldEvidence.source, "https://initech.example/p2"))
      );
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ value: 8, proposalId: null, acceptedBy: null });

    // MCP with evidence for a field it does not write: refused, nothing changes.
    const wrong = await call(s, "kitsuden_update_record", {
      collection: ds.slug,
      id: rowId,
      data: { price: 9 },
      _evidence: [{ field: "data.colour", source: "x" }],
    });
    expect(JSON.stringify(wrong)).toContain("_evidence");
    expect((await rowData(rowId)).price).toBe(8);
  }, 30_000);

  it("an agent cannot read evidence or reviews through the approvals routes", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["admin"]);
    expect((await request("GET", "/api/approvals/reviews", { token: a.token })).status).toBe(403);
    expect(
      (
        await request("GET", "/api/approvals/evidence?entity=dataset_entry&rowId=x", {
          token: a.token,
        })
      ).status
    ).toBe(403);
  });
});
