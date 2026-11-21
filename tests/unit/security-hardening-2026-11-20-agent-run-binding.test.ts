/**
 * Security hardening 2026-11-20: an agent run keeps to its own session and cache
 * ============================================================================
 *
 * 1. The semantic cache matches on the last message only. A run that carried the
 *    session's earlier turns (loaded by `sessionId`) or an event's data could be
 *    answered with another session's or another event's reply. Such runs are no
 *    longer cached.
 * 2. `traceId` attached the run to any trace, another agent's included. A trace
 *    is now continued only by the agent it belongs to; session history is read
 *    from the run's own agent's traces only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
  };
  return { db: chain };
});

import { runIsCacheable, traceToReuse } from "../../apps/api/src/services/agent-engine";

describe("which runs may use the response cache", () => {
  const bare = { narrowed: false, historyTurns: 0 };

  it("a bare question is cacheable", () => {
    expect(runIsCacheable(bare)).toBe(true);
  });

  it("a run with earlier turns of its session is not", () => {
    expect(runIsCacheable({ ...bare, historyTurns: 2 })).toBe(false);
  });

  it("a run carrying an event's data is not", () => {
    expect(runIsCacheable({ ...bare, event: { email: "a@b.test" } })).toBe(false);
    expect(runIsCacheable({ ...bare, event: null })).toBe(false);
  });

  it("narrowed tools or per-call context still make it uncacheable", () => {
    expect(runIsCacheable({ ...bare, narrowed: true })).toBe(false);
    expect(runIsCacheable({ ...bare, context: "found text" })).toBe(false);
  });
});

describe("which trace a run continues", () => {
  it("only a trace of the same agent", () => {
    expect(traceToReuse({ id: "t1", agentId: "ag_1" }, "ag_1")).toBe("t1");
    expect(traceToReuse({ id: "t1", agentId: "ag_other" }, "ag_1")).toBeNull();
    expect(traceToReuse({ id: "t1", agentId: null }, "ag_1")).toBeNull();
    expect(traceToReuse(undefined, "ag_1")).toBeNull();
  });
});
