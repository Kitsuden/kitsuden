/**
 * Human approval: three fixes from the security audit of 2026-11-19
 * ============================================================================
 *
 * 1. `/api/proposals` (the agent's view) is also open to the team. A human who
 *    could not approve a proposal must get its result body as REDACTED_CONTENT
 *    there too, as in the inbox, on the list, the detail and the event flow.
 * 2. A held REST path that a URL parser would read as another route (a
 *    backslash, a control character, a `.` or `..` segment, as Hono hands them
 *    over already decoded) is neither held nor replayed.
 * 3. A GraphQL delete mutation (a POST to /api/graphql) counts as a DELETE for
 *    the legacy rules, like a delete inside POST /api/datasets/batch.
 */
import { DEFAULT_APPROVALS_CONFIG } from "@kitsuden/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  proposals: [] as Array<Record<string, unknown>>,
  /** Who may approve: everyone else gets `admin_route`. */
  approvers: new Set<string>(),
}));

vi.mock("../../apps/api/src/lib/approvals", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../apps/api/src/lib/approvals")>();
  return {
    ...real,
    expireProposals: async () => undefined,
    listProposals: async (f: { agentId?: string | null }) => {
      const proposals = state.proposals.filter((p) => !f.agentId || p.agentId === f.agentId);
      return { proposals, total: proposals.length };
    },
    proposalById: async (id: string) => state.proposals.find((p) => p.id === id) ?? null,
    freshHuman: async (id: string) => ({ id, role: id.startsWith("admin") ? "admin" : "editor" }),
    reasonNotToApprove: async (h: { id: string }) =>
      state.approvers.has(h.id) ? null : "admin_route",
  };
});

import {
  ambiguousPath,
  batchDeletes,
  evaluateRequest,
  graphqlDeletes,
  internalRequest,
  setApprovalsApp,
  type ApprovalsSnapshot,
} from "../../apps/api/src/lib/approvals";
import { REDACTED_CONTENT, proposalOperations } from "../../apps/api/src/routes/approvals";

const SECRET_RESULT = { apiKey: "the admin route's answer" };

function proposal(id: string, agentId = "ag_1") {
  return {
    id,
    agentId,
    status: "executed",
    reason: "sensitive",
    channel: "rest",
    method: "POST",
    path: "/api/admin/secrets",
    tool: null,
    operationKey: null,
    createdAt: new Date(),
    expiresAt: null,
    decidedAt: new Date(),
    decisionComment: null,
    executedAt: new Date(),
    fieldDecisions: null,
    resultStatus: 200,
    resultContentType: "application/json",
    resultBody: SECRET_RESULT,
    resultError: null,
  };
}

function ctx(values: Record<string, unknown>) {
  return {
    get: (k: string) => values[k],
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  };
}

function op(id: string) {
  const found = proposalOperations.find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id}`);
  return found as unknown as {
    handle: (e: unknown, h: { c: unknown }) => Promise<Response | AsyncIterable<unknown>>;
  };
}

const PID = "11111111-1111-4111-8111-111111111111";
const editor = { user: { id: "editor-1", role: "editor" } };
const admin = { user: { id: "admin-1", role: "admin" } };
const agent = { agent: { agentId: "ag_1" }, user: { id: "ag_1", role: "agent" } };

describe("/api/proposals redacts the result for a human who could not approve it", () => {
  beforeEach(() => {
    state.proposals = [proposal(PID)];
    state.approvers = new Set(["admin-1"]);
  });

  it("list: an editor gets REDACTED_CONTENT, an admin and the agent the real body", async () => {
    const list = async (who: Record<string, unknown>) =>
      (await (
        (await op("my-proposals").handle({ query: {} }, { c: ctx(who) })) as Response
      ).json()) as { proposals: Array<{ result: { body: unknown } }> };
    expect((await list(editor)).proposals[0]!.result.body).toEqual(REDACTED_CONTENT);
    expect((await list(admin)).proposals[0]!.result.body).toEqual(SECRET_RESULT);
    expect((await list(agent)).proposals[0]!.result.body).toEqual(SECRET_RESULT);
  });

  it("detail: an editor gets REDACTED_CONTENT, the agent the real body", async () => {
    const detail = async (who: Record<string, unknown>) =>
      (await (
        (await op("proposal-status").handle({ params: { id: PID } }, { c: ctx(who) })) as Response
      ).json()) as { result: { body: unknown; status: number } };
    const seen = await detail(editor);
    expect(seen.result.body).toEqual(REDACTED_CONTENT);
    expect(seen.result.status).toBe(200);
    expect((await detail(agent)).result.body).toEqual(SECRET_RESULT);
  });

  it("events: the flow an editor opens carries REDACTED_CONTENT", async () => {
    const flow = (await op("proposal-events").handle(
      { params: { id: PID } },
      { c: ctx(editor) }
    )) as AsyncIterable<{ result: { body: unknown } }>;
    const views = [];
    for await (const v of flow) views.push(v);
    expect(views).toHaveLength(1);
    expect(views[0]!.result.body).toEqual(REDACTED_CONTENT);
  });

  it("another agent's proposal stays 404 on the detail and the events", async () => {
    state.proposals = [proposal(PID, "ag_other")];
    const res = (await op("proposal-status").handle(
      { params: { id: PID } },
      { c: ctx(agent) }
    )) as Response;
    expect(res.status).toBe(404);
    const ev = (await op("proposal-events").handle(
      { params: { id: PID } },
      { c: ctx(agent) }
    )) as Response;
    expect(ev.status).toBe(404);
  });
});

describe("paths a URL parser would rewrite are never held or replayed", () => {
  const B = "\\";
  it("flags backslashes, control characters and dot segments", () => {
    expect(ambiguousPath(`/api/blog/posts/x${B}..${B}..${B}admin${B}secrets`)).toBe(true);
    expect(ambiguousPath("/api/blog/posts/../../admin/secrets")).toBe(true);
    expect(ambiguousPath("/api/blog/posts/%2e%2E/admin")).toBe(true);
    expect(ambiguousPath("/api/blog/posts/.%2e")).toBe(true);
    expect(ambiguousPath("/api/blog/posts/./x")).toBe(true);
    expect(ambiguousPath("/api/blog/posts/.\t./admin")).toBe(true);
    expect(ambiguousPath("/api/blog/posts/x\n")).toBe(true);
  });

  it("leaves ordinary paths alone (dots inside a segment, the query string)", () => {
    expect(ambiguousPath("/api/blog/posts/abc")).toBe(false);
    expect(ambiguousPath("/api/media/file.v2.png")).toBe(false);
    expect(ambiguousPath("/api/blog/posts/...")).toBe(false);
    expect(ambiguousPath("/api/blog/posts/abc?next=../x")).toBe(false);
    expect(ambiguousPath("/api/blog/posts/café au lait")).toBe(false);
  });

  it("an approved replay to such a path is refused before it reaches the app", async () => {
    const fetched: string[] = [];
    setApprovalsApp((req) => {
      fetched.push(new URL(req.url).pathname);
      return new Response("{}", { status: 200 });
    });
    const execution = {
      agent: { agentId: "ag_1" },
      approval: { proposalId: PID, approvedBy: "admin-1" },
    } as never;
    await expect(
      internalRequest(execution, "PATCH", `/api/blog/posts/x${B}..${B}..${B}admin${B}secrets`, {})
    ).rejects.toThrow(/would rewrite/);
    expect(fetched).toEqual([]);
    // A canonical path still runs.
    const res = await internalRequest(execution, "PATCH", "/api/blog/posts/abc", {});
    expect(res.status).toBe(200);
    expect(fetched).toEqual(["/api/blog/posts/abc"]);
  });
});

describe("GraphQL delete mutations count as a DELETE for the legacy rules", () => {
  it("recognizes delete mutations, aliased or inside a fragment", () => {
    expect(graphqlDeletes('mutation { deletePost(id: "1") { success } }')).toBe(true);
    expect(graphqlDeletes('mutation { x: deleteDataset_Items(id: "1") { success } }')).toBe(true);
    expect(
      graphqlDeletes(
        'mutation M { ...F } fragment F on Mutation { deletePost(id: "1") { success } }'
      )
    ).toBe(true);
    // A document that does not parse counts as deleting.
    expect(graphqlDeletes("mutation { deletePost(")).toBe(true);
  });

  it("does not hold reads or other mutations", () => {
    expect(graphqlDeletes("{ posts { id } }")).toBe(false);
    expect(graphqlDeletes('mutation { updatePost(id: "1", title: "x") { id } }')).toBe(false);
    expect(graphqlDeletes(undefined)).toBe(false);
  });

  const reqCtx = (body: string) =>
    ({
      req: {
        raw: new Request("http://localhost/api/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      },
    }) as never;

  it("batchDeletes reads the GraphQL body, and the default DELETE rule then holds it", async () => {
    const del = JSON.stringify({ query: 'mutation { deletePost(id: "1") { success } }' });
    const read = JSON.stringify({ query: "{ posts { id } }" });
    expect(await batchDeletes(reqCtx(del), "POST", "/api/graphql")).toBe(true);
    expect(await batchDeletes(reqCtx(read), "POST", "/api/graphql")).toBe(false);
    expect(await batchDeletes(reqCtx("not json"), "POST", "/api/graphql")).toBe(true);

    const snapshot: ApprovalsSnapshot = {
      config: { ...DEFAULT_APPROVALS_CONFIG, enabled: true },
      modes: new Map(),
      unattended: new Map(),
      read: Date.now(),
      updatedBy: null,
      updatedAt: null,
    };
    expect(evaluateRequest(snapshot, "ag_1", "POST", "/api/graphql", { deletes: true })).not.toBe(
      null
    );
    expect(evaluateRequest(snapshot, "ag_1", "POST", "/api/graphql", { deletes: false })).toBe(
      null
    );
  });
});
