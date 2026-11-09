/**
 * Turns carrying third-party data: every write waits for a person (security review 2026-11-04)
 * ============================================================================
 *
 * An `agent` action with event data in its prompt runs the agent with
 * `holdWrites`. Even with approvals off, a tool that writes is stored as a
 * proposal instead of running; one that only reads follows its usual rule
 * (here, none: it runs).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  proposals: [] as Array<{ path: string; reason: string; method: string }>,
  writes: new Set<string>(["kitsuden_delete_record"]),
  unattendedMode: "hold" as "hold" | "deny",
}));

vi.mock("../../apps/api/src/lib/approvals", () => ({
  ReusedIdempotencyKey: class extends Error {},
  ProposalNotAdmitted: class extends Error {},
  agentCouldRun: async () => true,
  computeDiff: async () => null,
  createProposal: async (p: { path: string; reason: string; method: string }) => {
    state.proposals.push(p);
    return {
      proposal: { id: "11111111-1111-4111-8111-111111111111", status: "pending", expiresAt: null },
    };
  },
  // Everything off: without `holdWrites` nothing would be held.
  evaluateCoreTool: () => null,
  evaluateRequest: () => null,
  approvalsSnapshot: async () => ({
    config: { enabled: false },
    modes: new Map(),
    unattended: new Map(),
  }),
  allOff: () => true,
  unattendedDenial: () =>
    state.unattendedMode === "deny" ? { alternative: "Leave a note for the team instead." } : null,
  unattendedProblem: (alternative: string) => ({
    type: "about:blank",
    title: "Denied",
    status: 403,
    code: "KITSUDEN_E_DENIED_UNATTENDED",
    detail: "Refused.",
    alternative,
  }),
  auditUnattendedDenial: async () => undefined,
  statusUrl: (id: string) => `/api/approvals/proposals/${id}/status`,
  agentView: (p: unknown) => p,
}));

vi.mock("../../apps/api/src/services/mcp-tools", () => ({
  writingTool: (n: string) => state.writes.has(n),
  canTryTool: () => true,
}));

vi.mock("../../apps/api/src/lib/external-mcp-bridge", () => ({
  isExternalToolName: () => false,
  resolveExternalTool: async () => ({ ok: false }),
}));

vi.mock("@kitsuden/engine", () => ({ listMCPTools: () => [] }));
vi.mock("../../apps/api/src/lib/operations-mcp", () => ({ toolRequest: () => null }));

import { holdToolIfNeeded } from "../../apps/api/src/lib/approvals-mcp";

const agent = (holdWrites?: boolean, unattended?: boolean) => ({
  agentId: "ag_1",
  agentName: "Triage",
  apiKeyId: "",
  scopes: ["admin"],
  allowedTools: [],
  holdWrites,
  unattended,
});

describe("holdWrites", () => {
  beforeEach(() => {
    state.proposals.length = 0;
    state.unattendedMode = "hold";
  });

  it("without the flag and with everything off, nothing is held", async () => {
    expect(await holdToolIfNeeded("kitsuden_delete_record", { id: "x" }, agent())).toBeNull();
    expect(state.proposals).toHaveLength(0);
  });

  it("with the flag, a tool that writes becomes a proposal", async () => {
    const r = await holdToolIfNeeded("kitsuden_delete_record", { id: "x" }, agent(true));
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).toContain("KITSUDEN_E_APPROVAL_REQUIRED");
    expect(state.proposals).toEqual([
      expect.objectContaining({
        path: "mcp:kitsuden_delete_record",
        reason: "propose_only",
        method: "POST",
      }),
    ]);
  });

  it("with the flag, one that only reads runs", async () => {
    expect(await holdToolIfNeeded("kitsuden_query_collection", {}, agent(true))).toBeNull();
    expect(state.proposals).toHaveLength(0);
  });

  it("unattended with `deny` configured: the forced hold is refused, never run", async () => {
    state.unattendedMode = "deny";
    const r = await holdToolIfNeeded("kitsuden_delete_record", { id: "x" }, agent(true, true));
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).toContain("KITSUDEN_E_DENIED_UNATTENDED");
    expect(state.proposals).toHaveLength(0);
  });
});
