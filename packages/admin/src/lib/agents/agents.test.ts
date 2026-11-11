/**
 * Agents and the approvals inbox, apart from their markup: what a key press does in the
 * inbox, how a proposal is told as an ApprovalCard, what a bulk approval can run, and how
 * an agent becomes a row of the list and the meta line of its page.
 */
import { describe, expect, it } from "vitest";

import { activeKeyCount, agentMetaParts, agentRow, pendingByAgent } from "./agent-rows";
import {
  approvalCardProps,
  bulkApprovable,
  bulkSummary,
  inboxKeyAction,
  proposalTitle,
  type CardProposal,
  type InboxKeyContext,
} from "./inbox";

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${Object.values(params).join(",")}` : key;

const ctx = (over: Partial<InboxKeyContext> = {}): InboxKeyContext => ({
  ids: ["a", "b", "c"],
  currentId: "b",
  canApprove: true,
  canReject: true,
  blocked: false,
  ...over,
});

describe("inbox keyboard", () => {
  it("j and k move to the next and the previous proposal", () => {
    expect(inboxKeyAction({ key: "j" }, ctx())).toEqual({ type: "move", id: "c" });
    expect(inboxKeyAction({ key: "k" }, ctx())).toEqual({ type: "move", id: "a" });
    expect(inboxKeyAction({ key: "J" }, ctx())).toEqual({ type: "move", id: "c" });
  });

  it("at the ends it stays; with nothing open j opens the first and k the last", () => {
    expect(inboxKeyAction({ key: "j" }, ctx({ currentId: "c" }))).toBeNull();
    expect(inboxKeyAction({ key: "k" }, ctx({ currentId: "a" }))).toBeNull();
    expect(inboxKeyAction({ key: "j" }, ctx({ currentId: null }))).toEqual({
      type: "move",
      id: "a",
    });
    expect(inboxKeyAction({ key: "k" }, ctx({ currentId: null }))).toEqual({
      type: "move",
      id: "c",
    });
    expect(inboxKeyAction({ key: "j" }, ctx({ ids: [] }))).toBeNull();
    // The open proposal left the list (decided, filtered): start again from the top.
    expect(inboxKeyAction({ key: "j" }, ctx({ currentId: "zzz" }))).toEqual({
      type: "move",
      id: "a",
    });
  });

  it("a approves and r rejects, only when this person may", () => {
    expect(inboxKeyAction({ key: "a" }, ctx())).toEqual({ type: "approve" });
    expect(inboxKeyAction({ key: "r" }, ctx())).toEqual({ type: "reject" });
    // Someone who could not do it themselves cannot approve it, but may reject it.
    expect(inboxKeyAction({ key: "a" }, ctx({ canApprove: false }))).toBeNull();
    expect(inboxKeyAction({ key: "r" }, ctx({ canApprove: false }))).toEqual({ type: "reject" });
    expect(inboxKeyAction({ key: "r" }, ctx({ canReject: false }))).toBeNull();
  });

  it("stays out while typing, behind a dialog, and with a modifier", () => {
    for (const key of ["j", "k", "a", "r"]) {
      expect(inboxKeyAction({ key }, ctx({ blocked: true }))).toBeNull();
      expect(inboxKeyAction({ key, ctrlKey: true }, ctx())).toBeNull();
      expect(inboxKeyAction({ key, metaKey: true }, ctx())).toBeNull();
      expect(inboxKeyAction({ key, altKey: true }, ctx())).toBeNull();
    }
    expect(inboxKeyAction({ key: "x" }, ctx())).toBeNull();
  });
});

const proposal = (over: Partial<CardProposal> = {}): CardProposal => ({
  id: "p1",
  status: "pending",
  method: "PATCH",
  path: "/api/datasets/d1/entries/e1",
  createdAt: "2026-11-01T10:00:00.000Z",
  decidedAt: null,
  agentName: "Curator",
  decidedByName: null,
  diff: { kind: "update", changes: [{ field: "data.price", before: 19.5, after: 21 }] },
  ...over,
});

const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

describe("a proposal as an ApprovalCard", () => {
  it("the title says what would happen, from the method and the target", () => {
    expect(proposalTitle(proposal(), t)).toBe("inbox.titleUpdate:/api/datasets/d1/entries/e1");
    expect(proposalTitle(proposal({ method: "POST", path: "/api/blog" }), t)).toBe(
      "inbox.titleCreate:/api/blog"
    );
    expect(proposalTitle(proposal({ method: "delete" }), t)).toContain("inbox.titleDelete");
    expect(
      proposalTitle(proposal({ tool: "send_mail", method: "POST", path: "/api/mcp" }), t)
    ).toBe("inbox.titleTool:send_mail");
    expect(proposalTitle(proposal({ method: "GET" }), t)).toContain("inbox.titleOther");
  });

  it("a pending update: the agent asks, the changes are the diff", () => {
    const card = approvalCardProps(proposal(), t, date);
    expect(card).toMatchObject({ requester: "Curator", status: "pending", riskLevel: "medium" });
    expect(card.outcome).toBeUndefined();
    expect(card.risk).toBeUndefined();
    expect(card.changes).toEqual([{ field: "price", label: undefined, before: 19.5, after: 21 }]);
  });

  it("a deleted agent is named as such; a delete is high risk", () => {
    const card = approvalCardProps(
      proposal({
        agentName: null,
        method: "DELETE",
        diff: { kind: "delete", current: { title: "T" } },
      }),
      t,
      date
    );
    expect(card.requester).toBe("approvals.agentDeleted");
    expect(card).toMatchObject({ riskLevel: "high", risk: "inbox.riskDelete" });
    expect(card.changes).toEqual([{ field: "title", label: undefined, before: "T", after: null }]);
  });

  it("a tool call shows the tool and its arguments, not a diff", () => {
    const card = approvalCardProps(
      proposal({
        tool: "send_mail",
        method: "POST",
        path: "/api/mcp",
        diff: { kind: "tool", arguments: { to: "a@b.c" } },
      }),
      t,
      date
    );
    expect(card).toMatchObject({ tool: "send_mail", args: { to: "a@b.c" } });
    expect(card.changes).toBeUndefined();
  });

  it("with a per-field ledger the card leaves the changes to the inbox's own table", () => {
    expect(approvalCardProps(proposal(), t, date, { ledger: true }).changes).toBeUndefined();
  });

  it("the card's four states, and an outcome that says who decided", () => {
    const decided = { decidedAt: "2026-11-02T08:00:00.000Z", decidedByName: "Ana Admin" };
    const executed = approvalCardProps(proposal({ status: "executed", ...decided }), t, date);
    expect(executed.status).toBe("approved");
    expect(executed.outcome).toBe("inbox.outcomeBy:approvals.status_executed,Ana Admin,2026-11-02");
    // Approved but it failed while running: still an approval, and the outcome says so.
    const failed = approvalCardProps(proposal({ status: "failed", ...decided }), t, date);
    expect(failed.status).toBe("approved");
    expect(failed.outcome).toContain("approvals.status_failed");
    expect(approvalCardProps(proposal({ status: "rejected", ...decided }), t, date).status).toBe(
      "rejected"
    );
    const expired = approvalCardProps(proposal({ status: "expired" }), t, date);
    expect(expired).toMatchObject({ status: "expired", outcome: "approvals.status_expired" });
  });
});

describe("bulk approval", () => {
  const list = [
    { id: "a", status: "pending" },
    { id: "b", status: "executed" },
    { id: "c", status: "pending" },
  ];

  it("only the checked proposals that still wait, in the list's order", () => {
    expect(bulkApprovable(list, ["c", "b", "a", "gone"]).map((p) => p.id)).toEqual(["a", "c"]);
    expect(bulkApprovable(list, [])).toEqual([]);
  });

  it("the summary counts what ran and what did not", () => {
    expect(bulkSummary(["executed", "failed", "executed", "error"])).toEqual({
      executed: 2,
      failed: 2,
    });
    expect(bulkSummary([])).toEqual({ executed: 0, failed: 0 });
  });
});

describe("agents as rows and as a header", () => {
  const agent = {
    id: "a1",
    name: "Curator",
    description: "Keeps the catalogue",
    type: "custom",
    enabled: true,
    status: "active" as const,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scopes: ["mcp:connect", "datasets:products:read"],
    rateLimit: 60,
  };

  it("counts the proposals that wait, per agent", () => {
    const counts = pendingByAgent([
      { agentId: "a1", status: "pending" },
      { agentId: "a1", status: "pending" },
      { agentId: "a1", status: "executed" },
      { agentId: "a2", status: "pending" },
    ]);
    expect([...counts]).toEqual([
      ["a1", 2],
      ["a2", 1],
    ]);
  });

  it("a row: the model wins over the type; unknown limits are null, not zero", () => {
    expect(agentRow(agent, new Map([["a1", 2]]))).toEqual({
      id: "a1",
      name: "Curator",
      description: "Keeps the catalogue",
      status: "active",
      kind: "custom",
      scopes: 2,
      rateLimit: 60,
      pending: 2,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const bare = agentRow({
      ...agent,
      model: "gpt-4",
      scopes: undefined,
      rateLimit: undefined,
    } as never);
    expect(bare).toMatchObject({ kind: "gpt-4", scopes: 0, rateLimit: null, pending: 0 });
  });

  it("a working key is neither revoked nor expired", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(
      activeKeyCount(
        [
          { revokedAt: null, expiresAt: null },
          { revokedAt: "2026-11-01T00:00:00Z", expiresAt: null },
          { revokedAt: null, expiresAt: "2026-11-01T00:00:00Z" },
          { revokedAt: null, expiresAt: "2026-12-01T00:00:00Z" },
        ],
        now
      )
    ).toBe(2);
  });

  it("the meta line leaves out what the API did not give", () => {
    expect(
      agentMetaParts(
        { kind: "custom", sponsor: "Ana", activeKeys: 1, totalKeys: 2, pending: 3, calls: 40 },
        t
      )
    ).toEqual([
      "custom",
      "agentPage.sponsoredBy:Ana",
      "agentPage.keysOne",
      "agentPage.pending:3",
      "agentPage.calls:40",
    ]);
    expect(
      agentMetaParts(
        { kind: "", sponsor: null, activeKeys: null, totalKeys: null, pending: 0, calls: null },
        t
      )
    ).toEqual(["agentPage.noSponsor"]);
  });
});
