/**
 * The panel talks to human approval
 * ============================================================================
 *
 * Contract with apps/api/src/routes/approvals.ts (/api/approvals): methods,
 * routes and bodies; a 403/409 reaches the user with the API's reason; and the
 * menu counter does not break if the API fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const BASE = import.meta.env.VITE_API_URL ?? "";

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: "", json: async () => body } as Response;
}

describe("approvals service", () => {
  beforeEach(() => vi.resetModules());

  it("each call goes to its route with its method and body", async () => {
    const calls: { what: string; body?: unknown }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        what: `${init?.method ?? "GET"} ${String(url)}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).endsWith("/count")) return response({ pending: 3 });
      return response({ proposals: [], total: 0, events: [] });
    }) as typeof fetch;

    const s = await import("./services/approvals");
    await s.listProposals({ status: "pending", limit: 100 });
    expect(await s.countPendingProposals()).toBe(3);
    await s.getProposal("p1");
    await s.approveProposal("p1", "ok");
    await s.rejectProposal("p2");
    await s.getApprovalSettings();
    await s.saveApprovalSettings({ enabled: true, operations: { "kon:blog:delete-post": null } });
    await s.setAgentApprovalMode("a1", "propose");
    await s.listApprovalAudit({ proposalId: "p1", limit: 50 });

    expect(calls.map((l) => l.what)).toEqual([
      `GET ${BASE}/api/approvals/proposals?status=pending&limit=100`,
      `GET ${BASE}/api/approvals/proposals/count`,
      `GET ${BASE}/api/approvals/proposals/p1`,
      `POST ${BASE}/api/approvals/proposals/p1/approve`,
      `POST ${BASE}/api/approvals/proposals/p2/reject`,
      `GET ${BASE}/api/approvals/settings`,
      `PUT ${BASE}/api/approvals/settings`,
      `PUT ${BASE}/api/approvals/agents/a1/mode`,
      `GET ${BASE}/api/approvals/audit?proposalId=p1&limit=50`,
    ]);
    expect(calls[3]!.body).toEqual({ comment: "ok" });
    expect(calls[4]!.body).toEqual({});
    expect(calls[6]!.body).toEqual({ enabled: true, operations: { "kon:blog:delete-post": null } });
    expect(calls[7]!.body).toEqual({ mode: "propose" });
  });

  it("agent signer: GET and PUT to its route, null removes it", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return response({ sponsor: null, candidates: [] });
    }) as typeof fetch;
    const s = await import("./services/agents");
    await s.getAgentSponsor("a1");
    await s.setAgentSponsor("a1", "u1");
    await s.setAgentSponsor("a1", null);
    expect(calls).toEqual([
      `GET ${BASE}/api/v1/agents/a1/sponsor`,
      `PUT ${BASE}/api/v1/agents/a1/sponsor`,
      `PUT ${BASE}/api/v1/agents/a1/sponsor`,
    ]);
    expect(bodies).toEqual([{ userId: "u1" }, { userId: null }]);
  });

  it("agent data ledger: per-field approval, later reviews (docs/agents/ledger.md)", async () => {
    const calls: { what: string; body?: unknown }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        what: `${init?.method ?? "GET"} ${String(url)}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response({ proposal: {}, review: {}, reviews: [], total: 0, due: 0 });
    }) as typeof fetch;
    const s = await import("./services/approvals");
    await s.approveProposal("p1", "ok", {
      fields: [
        { field: "data.price", decision: "accept", value: 45 },
        { field: "data.color", decision: "reject" },
      ],
      reviewAt: "2026-12-01T09:00:00.000Z",
    });
    await s.rejectProposal("p2", undefined, { reviewAt: "2026-12-01T09:00:00.000Z" });
    await s.scheduleReview("p1", { reviewAt: "2026-12-01T09:00:00.000Z", note: "n" });
    await s.listReviews({ status: "due" });
    await s.closeReview("r1", { cancel: true });
    expect(calls.map((c) => c.what)).toEqual([
      `POST ${BASE}/api/approvals/proposals/p1/approve`,
      `POST ${BASE}/api/approvals/proposals/p2/reject`,
      `POST ${BASE}/api/approvals/proposals/p1/review`,
      `GET ${BASE}/api/approvals/reviews?status=due`,
      `POST ${BASE}/api/approvals/reviews/r1/done`,
    ]);
    expect(calls[0]!.body).toEqual({
      comment: "ok",
      fields: [
        { field: "data.price", decision: "accept", value: 45 },
        { field: "data.color", decision: "reject" },
      ],
      reviewAt: "2026-12-01T09:00:00.000Z",
    });
    expect(calls[1]!.body).toEqual({ reviewAt: "2026-12-01T09:00:00.000Z" });
    expect(calls[4]!.body).toEqual({ cancel: true });
  });

  it("a 409 or a 403 arrives with the API's reason", async () => {
    global.fetch = vi.fn(async () =>
      response({ error: "Conflict", message: "Proposal is executed" }, 409)
    ) as typeof fetch;
    const s = await import("./services/approvals");
    await expect(s.approveProposal("p1")).rejects.toThrow("Proposal is executed");
  });

  it("the menu counter keeps the last value if the API fails", async () => {
    let fails = false;
    global.fetch = vi.fn(async () =>
      fails ? response({}, 500) : response({ pending: 2 })
    ) as typeof fetch;
    const { approvals } = await import("./states/approvals.svelte");
    await approvals.refresh();
    expect(approvals.pendingItems).toBe(2);
    fails = true;
    await approvals.refresh();
    expect(approvals.pendingItems).toBe(2);
  });
});
