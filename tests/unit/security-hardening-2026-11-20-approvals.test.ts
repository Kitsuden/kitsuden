/**
 * Human approval and the agent data ledger: hardening from the 2026-11-19 audit
 * ============================================================================
 *
 * H83 `before` values are read as the agent: an approver sees only those their
 *     own access confirms (the row is read again with THEIR credentials).
 * H81 the agent's evidence is redacted like the body and the diff.
 * H82 scheduling or closing a review needs the right to see the proposal.
 * H84 an MCP record update does not resend fields that were unchanged.
 * H13 the approvals settings: one invalid field no longer switches them off,
 *     and a cold database error is not read as "off".
 * H15 a proposal made without a key replays with the scopes it had.
 * H78 an MCP tool whose path parameters land on a sibling route is refused.
 */
import { DEFAULT_APPROVALS_CONFIG, readApprovalsConfig } from "@kitsuden/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  proposals: [] as Array<Record<string, unknown>>,
  approvers: new Set<string>(),
  reviews: [] as Array<Record<string, unknown>>,
  scheduled: 0,
  closed: 0,
}));

/** A query builder that answers every query with no rows. */
vi.mock("../../apps/api/src/db", () => {
  const chain: unknown = new Proxy(function () {} as object, {
    get: (_t, k) => (k === "then" ? (resolve: (v: unknown) => void) => resolve([]) : () => chain),
    apply: () => chain,
  });
  return { db: chain };
});

vi.mock("../../apps/api/src/lib/approvals", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../apps/api/src/lib/approvals")>();
  return {
    ...real,
    expireProposals: async () => undefined,
    proposalById: async (id: string) => state.proposals.find((p) => p.id === id) ?? null,
    freshHuman: async (id: string) => ({ id, role: id.startsWith("admin") ? "admin" : "editor" }),
    reasonNotToApprove: async (h: { id: string }) =>
      state.approvers.has(h.id) ? null : "admin_route",
    userNames: async () => ({}),
    proposalFiles: async () => [],
  };
});

vi.mock("../../apps/api/src/lib/ledger", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../apps/api/src/lib/ledger")>();
  return {
    ...real,
    listReviews: async () => ({ total: 0, reviews: [] }),
    reviewById: async (id: string) => state.reviews.find((r) => r.id === id) ?? null,
    scheduleReview: async () => {
      state.scheduled++;
      return { id: "r1", proposalId: PID, fields: [], dueAt: new Date(), status: "scheduled" };
    },
    closeReview: async () => {
      state.closed++;
      return { id: "r1", proposalId: PID, fields: [], dueAt: new Date(), status: "done" };
    },
  };
});

const approvals = await import("../../apps/api/src/lib/approvals");
const ledger = await import("../../apps/api/src/lib/ledger");
const { approvalOperations } = await import("../../apps/api/src/routes/approvals");

const PID = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";
const DS = "33333333-3333-4333-8333-333333333333";
const ENTRY_PATH = `/api/datasets/${DS}/entries/${ROW}`;

function ctx(values: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    get: (k: string) => values[k],
    req: { header: (k: string) => headers[k.toLowerCase()] },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  };
}

function op(id: string) {
  const found = approvalOperations.find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id}`);
  return found as unknown as { handle: (e: unknown, h: { c: unknown }) => Promise<Response> };
}

const fieldDiff = {
  target: {
    kind: "update",
    shape: "entry",
    entity: "dataset_entry",
    rowId: ROW,
    replacesData: true,
    readPath: ENTRY_PATH,
  },
  fields: [
    { field: "data.name", before: "Ada", after: "Ada L.", change: "update" },
    { field: "data.notes", before: "owes money", after: "paid", change: "update" },
  ],
};

function proposal(over: Record<string, unknown> = {}) {
  return {
    id: PID,
    agentId: "ag_1",
    agentName: "Agent",
    keyId: "k1",
    status: "pending",
    reason: "sensitive",
    channel: "rest",
    method: "PATCH",
    path: ENTRY_PATH,
    tool: null,
    operationKey: null,
    createdAt: new Date(),
    expiresAt: null,
    decidedAt: null,
    decisionComment: null,
    executedAt: null,
    body: { data: { name: "Ada L.", notes: "paid" } },
    diff: {
      kind: "update",
      changes: [
        { field: "data", before: { name: "Ada", notes: "owes money" }, after: {} },
        { field: "title", before: "Ada", after: "Ada L." },
      ],
    },
    fieldDiff,
    fieldDecisions: null,
    evidence: [{ field: "data.notes", source: "https://x", quote: "invoice 12 settled" }],
    scopes: [],
    resultStatus: null,
    resultContentType: null,
    resultBody: null,
    resultError: null,
    ...over,
  };
}

/** The app as the approver reads it: their cookie decides what the row shows. */
const reads: Array<{ path: string; cookie: string | null; env: unknown }> = [];
function approverApp() {
  reads.length = 0;
  approvals.setApprovalsApp((req, env) => {
    const cookie = req.headers.get("cookie");
    reads.push({ path: new URL(req.url).pathname, cookie, env });
    if (cookie !== "session=admin") return new Response("{}", { status: 401 });
    // The approver's access hides `notes`.
    return Response.json({ id: ROW, title: "Ada", status: "draft", data: { name: "Ada" } });
  });
}

// ── H83 ──────────────────────────────────────────────────────────────────────

describe("H83: an approver sees only the before values their own access shows", () => {
  beforeEach(() => {
    state.proposals = [proposal()];
    state.approvers = new Set(["admin-1"]);
    approverApp();
  });

  it("the detail drops a before value the approver cannot read", async () => {
    const res = await op("proposal-detail").handle(
      { params: { id: PID } },
      { c: ctx({ user: { id: "admin-1" } }, { cookie: "session=admin" }) }
    );
    const view = (await res.json()) as {
      fieldDiff: { fields: Array<Record<string, unknown>> };
      diff: { changes: Array<Record<string, unknown>> };
    };
    const [name, notes] = view.fieldDiff.fields;
    expect(name).toMatchObject({ field: "data.name", before: "Ada" });
    expect(notes).not.toHaveProperty("before");
    expect(notes).toMatchObject({ field: "data.notes", after: "paid", beforeHidden: true });
    expect(JSON.stringify(view)).not.toContain("owes money");
    // The REST diff too: `title` is confirmed, `data` (with notes) is not.
    expect(view.diff.changes[1]).toMatchObject({ field: "title", before: "Ada" });
    expect(view.diff.changes[0]).toMatchObject({ field: "data", beforeHidden: true });
    // Read with the approver's own cookie, never with an internal identity.
    expect(reads[0]!.cookie).toBe("session=admin");
    expect(Object.getOwnPropertySymbols(reads[0]!.env as object)).toEqual([]);
    expect(reads.map((r) => r.path)).toEqual([ENTRY_PATH]);
  });

  it("without credentials that read the row, no before value is shown", async () => {
    const res = await op("proposal-detail").handle(
      { params: { id: PID } },
      { c: ctx({ user: { id: "admin-1" } }) }
    );
    const view = (await res.json()) as { fieldDiff: { fields: Array<Record<string, unknown>> } };
    for (const f of view.fieldDiff.fields) expect(f).not.toHaveProperty("before");
    expect(reads).toEqual([]);
  });

  it("once executed, the applied value confirms the field", () => {
    const shown = ledger.fieldDiffForViewer(fieldDiff as never, {
      data: { name: "Ada L.", notes: "paid" },
    });
    expect(shown.fields.every((f) => "before" in f)).toBe(true);
  });

  it("a delete's current row keeps only what the approver reads", () => {
    const d = approvals.diffForViewer(
      { kind: "delete", current: { id: ROW, title: "Ada", secret: "x" } },
      { id: ROW, title: "Ada" }
    );
    expect(d).toEqual({ kind: "delete", current: { id: ROW, title: "Ada" }, currentHidden: true });
    expect(approvals.diffForViewer({ kind: "delete", current: { id: ROW } }, null)).toEqual({
      kind: "delete",
      current: null,
      currentHidden: true,
    });
  });
});

// ── H81 ──────────────────────────────────────────────────────────────────────

describe("H81: the evidence is redacted with the content", () => {
  beforeEach(() => {
    state.proposals = [proposal()];
    state.approvers = new Set(["admin-1"]);
    approverApp();
  });

  it("an editor who cannot approve gets no evidence", async () => {
    const res = await op("proposal-detail").handle(
      { params: { id: PID } },
      { c: ctx({ user: { id: "editor-1" } }) }
    );
    const view = (await res.json()) as Record<string, unknown>;
    expect(view.evidence).toEqual([]);
    expect(view.evidenceRedacted).toBe(true);
    expect(JSON.stringify(view)).not.toContain("invoice 12 settled");
  });
});

// ── H82 ──────────────────────────────────────────────────────────────────────

describe("H82: reviews need the right to see the proposal", () => {
  beforeEach(() => {
    state.proposals = [proposal({ status: "executed" })];
    state.approvers = new Set(["admin-1"]);
    state.reviews = [{ id: "44444444-4444-4444-8444-444444444444", proposalId: PID }];
    state.scheduled = 0;
    state.closed = 0;
  });

  it("an editor who cannot approve gets 403 and nothing is stored", async () => {
    const reviewAt = new Date(Date.now() + 86_400_000).toISOString();
    const schedule = await op("schedule-proposal-review").handle(
      { params: { id: PID }, body: { reviewAt, fields: ["data.notes"] } },
      { c: ctx({ user: { id: "editor-1" } }) }
    );
    expect(schedule.status).toBe(403);
    const close = await op("close-review").handle(
      { params: { id: state.reviews[0]!.id }, body: {} },
      { c: ctx({ user: { id: "editor-1" } }) }
    );
    expect(close.status).toBe(403);
    expect(state.scheduled + state.closed).toBe(0);
  });

  it("someone who can approve it still can", async () => {
    const reviewAt = new Date(Date.now() + 86_400_000).toISOString();
    const schedule = await op("schedule-proposal-review").handle(
      { params: { id: PID }, body: { reviewAt } },
      { c: ctx({ user: { id: "admin-1" } }) }
    );
    expect(schedule.status).toBe(201);
    const close = await op("close-review").handle(
      { params: { id: state.reviews[0]!.id }, body: {} },
      { c: ctx({ user: { id: "admin-1" } }) }
    );
    expect(close.status).toBe(200);
  });
});

// ── H84 ──────────────────────────────────────────────────────────────────────

describe("H84: an MCP record update does not resend unchanged fields", () => {
  it("only the fields of the diff are sent", () => {
    const target = {
      kind: "update",
      shape: "mcp-record",
      entity: "dataset_entry",
      rowId: ROW,
      readPath: ENTRY_PATH,
    } as const;
    const body = {
      collection: "people",
      id: ROW,
      data: { name: "Ada", notes: "paid" },
      status: "draft",
    };
    const diff = ledger.computeFieldDiff(target, body, {
      status: "draft",
      data: { name: "Ada", notes: "owes money" },
    });
    expect(diff.fields.map((f) => f.field)).toEqual(["data.notes"]);
    const sent = ledger.applyDecisions(
      diff,
      body,
      [{ field: "data.notes", decision: "accept", edited: false }],
      null
    );
    expect(sent).toEqual({ collection: "people", id: ROW, data: { notes: "paid" } });
  });

  it("a create still sends every field", () => {
    const target = {
      kind: "create",
      shape: "mcp-record",
      entity: "dataset_entry",
      rowId: null,
    } as const;
    const body = { collection: "people", data: { name: "Ada" } };
    const diff = ledger.computeFieldDiff(target, body, null);
    const sent = ledger.applyDecisions(
      diff,
      body,
      [{ field: "data.name", decision: "accept", edited: false }],
      null
    );
    expect(sent).toEqual(body);
  });
});

// ── H13 ──────────────────────────────────────────────────────────────────────

describe("H13: approvals settings do not fail open", () => {
  it("one invalid field keeps the rest, approvals stay on", () => {
    const c = readApprovalsConfig({
      enabled: true,
      ttlHours: "a week",
      operations: { "kon:blog:publish": true, "not a key": true },
      legacyRules: [{ method: "DELETE", path: "/api/**" }, { method: 7 }],
    });
    expect(c.enabled).toBe(true);
    expect(c.ttlHours).toBe(DEFAULT_APPROVALS_CONFIG.ttlHours);
    expect(c.operations).toEqual({ "kon:blog:publish": true });
    expect(c.legacyRules).toEqual([{ method: "DELETE", path: "/api/**" }]);
  });

  it("only a database without the table falls back to off", () => {
    expect(approvals.missingTable({ code: "42P01" })).toBe(true);
    expect(approvals.missingTable(new Error('relation "approval_settings" does not exist'))).toBe(
      true
    );
    expect(approvals.missingTable({ message: "x", cause: { code: "42703" } })).toBe(true);
    expect(approvals.missingTable(new Error("connect ECONNREFUSED 127.0.0.1:5434"))).toBe(false);
    expect(approvals.missingTable(new Error("timeout exceeded when trying to connect"))).toBe(
      false
    );
  });
});

// ── H15 ──────────────────────────────────────────────────────────────────────

describe("H15: a proposal without a key replays with the scopes it had", () => {
  // A minimal agent context: only the fields narrowToProposal reads.
  const ok = (scopes: string[]) =>
    ({ ok: true, context: { agentId: "ag_1", scopes } }) as unknown as Parameters<
      typeof approvals.narrowToProposal
    >[0];
  const narrow = (...args: Parameters<typeof approvals.narrowToProposal>) =>
    approvals.narrowToProposal(...args) as { context: { scopes: string[] } };

  it("narrows the agent's scopes to those stored on the proposal", () => {
    const r = narrow(ok(["admin", "!datasets:hr:*"]), {
      keyId: null,
      scopes: ["datasets:crm:write"],
    });
    expect(r.context.scopes).toEqual(["!datasets:hr:*", "datasets:crm:write"]);
  });

  it("a scope revoked since is not given back", () => {
    const r = narrow(ok(["datasets:crm:read"]), {
      keyId: null,
      scopes: ["datasets:crm:write"],
    });
    expect(r.context.scopes).toEqual([]);
  });

  it("a keyed proposal and a legacy row without scopes are left alone", () => {
    expect(narrow(ok(["admin"]), { keyId: "k1", scopes: [] }).context.scopes).toEqual(["admin"]);
    expect(narrow(ok(["admin"]), { keyId: null, scopes: null }).context.scopes).toEqual(["admin"]);
  });
});

// ── H78 ──────────────────────────────────────────────────────────────────────

describe("H78: an MCP tool cannot reach a sibling operation's route", () => {
  it("refuses a path parameter equal to a sibling's static segment", async () => {
    const { registerMountedOperations, forgetMountedOperations } =
      await import("../../packages/engine/src/operations");
    const { toolHttpRequest } = await import("../../apps/api/src/lib/operations-mcp");
    const exportOp = { id: "items-export", method: "POST", route: "/items/export" } as never;
    const updateOp = { id: "items-update", method: "POST", route: "/items/:id" } as never;
    forgetMountedOperations();
    registerMountedOperations("kon-x", "/api/x", [exportOp, updateOp], new Hono());
    try {
      expect(() =>
        toolHttpRequest({ mountPath: "/api/x", op: updateOp }, { id: "export" })
      ).toThrow(/different operation/);
      const r = toolHttpRequest({ mountPath: "/api/x", op: updateOp }, { id: "abc" });
      expect(new URL(r.url).pathname).toBe("/api/x/items/abc");
    } finally {
      forgetMountedOperations();
    }
  });
});
