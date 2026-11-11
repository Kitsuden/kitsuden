/** The dashboard's numbers and lists, mapped from the API's answers ($lib/dashboard.ts). */
import { describe, expect, it } from "vitest";

import {
  activitySeries,
  activityTotals,
  busiestAgents,
  changesFeed,
  logsOf,
  requestTotals,
  systemChecks,
  timeAgo,
  type AgentLog,
} from "./dashboard";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const log = (day: string, agentId: string, success = true, action = "tool_call"): AgentLog => ({
  id: `${agentId}-${day}-${Math.random()}`,
  agentId,
  action,
  success,
  createdAt: `${day}T08:00:00.000Z`,
});

const LOGS = [
  log("2026-11-10", "a1"),
  log("2026-11-10", "a1", false),
  log("2026-11-09", "a2"),
  log("2026-11-05", "a1"),
  log("2026-10-01", "a1"), // outside the window
];

describe("agent logs", () => {
  it("reads a bare array (the API) or a wrapped one", () => {
    expect(logsOf([{ id: "1" }])).toHaveLength(1);
    expect(logsOf({ success: true, data: [{ id: "1" }, { id: "2" }] })).toHaveLength(2);
    expect(logsOf({ error: "x" })).toEqual([]);
    expect(logsOf(null)).toEqual([]);
  });

  it("one row per day, oldest first, zero where nothing happened", () => {
    const series = activitySeries(LOGS, 7, NOW);
    expect(series.map((d) => d.day)).toEqual([
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(series.map((d) => d.calls)).toEqual([0, 1, 0, 0, 0, 1, 2]);
    expect(series.map((d) => d.failures)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it("totals: calls, failures, rate and the change between the two halves", () => {
    const totals = activityTotals(activitySeries(LOGS, 6, NOW));
    expect(totals).toEqual({ calls: 4, failures: 1, failureRate: 25, delta: 2 });
    expect(activityTotals(activitySeries([], 6, NOW))).toEqual({
      calls: 0,
      failures: 0,
      failureRate: 0,
      delta: 0,
    });
  });

  it("the busiest agents, by name, linking to the agent", () => {
    const rows = busiestAgents(LOGS, [{ id: "a1", name: "Curator" }]);
    expect(rows).toEqual([
      { label: "Curator", value: 4, href: "/agents/a1", note: "1" },
      { label: "a2", value: 1, href: "/agents/a2", note: undefined },
    ]);
    expect(busiestAgents(LOGS, [], 1)).toHaveLength(1);
  });
});

describe("recent changes", () => {
  const t = (key: string) => (key === "activity.proposal_approved" ? "Proposal approved" : key);

  it("merges the approvals audit and the agent log, newest first", () => {
    const feed = changesFeed(
      [
        {
          id: "e1",
          at: "2026-11-10T09:00:00.000Z",
          action: "proposal_approved",
          agentId: "a1",
          agentName: "Curator",
          byName: "Ana Admin",
          success: true,
        },
        {
          id: "e2",
          at: "2026-11-08T09:00:00.000Z",
          action: "proposal_rejected",
          agentId: "a1",
          byName: "Luis",
        },
      ],
      [log("2026-11-09", "a1", false, "permission_denied")],
      [{ id: "a1", name: "Curator" }],
      t
    );
    expect(feed.map((f) => f.id.split(":")[0])).toEqual(["audit", "log", "audit"]);
    // An agent's change names the agent and the person who decided.
    expect(feed[0]).toMatchObject({
      title: "Proposal approved",
      agent: "Curator",
      person: "Ana Admin",
      tone: "success",
    });
    expect(feed[1]).toMatchObject({
      agent: "Curator",
      tone: "error",
      href: "/agents/a1?tab=activity",
    });
    expect(feed[2]).toMatchObject({ tone: "error", person: "Luis" });
    // A code with no translation is still readable.
    expect(feed[1]!.title).toBe("Permission denied");
  });

  it("skips what has no date and respects the limit", () => {
    const feed = changesFeed(
      [{ id: "x", at: "not a date", action: "proposal_created" }],
      [log("2026-11-09", "a1"), log("2026-11-08", "a1")],
      [],
      t,
      1
    );
    expect(feed).toHaveLength(1);
    expect(feed[0]!.at).toContain("2026-11-09");
  });
});

describe("requests and system", () => {
  it("adds up the request summary and finds the slowest route", () => {
    const totals = requestTotals([
      { requests: 90, errors: 3, denials: 1, p95_ms: 40, route: "/api/a", method: "GET" },
      { requests: 10, errors: 2, denials: 0, p95_ms: 900, route: "/api/b", method: "POST" },
    ]);
    expect(totals).toMatchObject({ requests: 100, errors: 5, denials: 1, errorRate: 5 });
    expect(totals.slowest?.route).toBe("/api/b");
    expect(requestTotals([])).toMatchObject({ requests: 0, errorRate: 0, slowest: null });
  });

  it("an editor only gets the API check; an admin gets the queue and the system", () => {
    expect(systemChecks({ apiOnline: true })).toEqual([{ id: "api", state: "ok" }]);
    const checks = systemChecks({
      apiOnline: false,
      queue: { worker: "stopped", dead: [{}, {}] },
      status: { migrations: { total: 71 }, kons: { total: 9, active: 6 } },
    });
    expect(Object.fromEntries(checks.map((c) => [c.id, [c.state, c.value]]))).toEqual({
      api: ["down", undefined],
      queue: ["down", "stopped"],
      deadJobs: ["warn", "2"],
      kons: ["ok", "6 / 9"],
      migrations: ["ok", "71"],
    });
  });

  it("what could not be read is unknown, not fine", () => {
    const checks = systemChecks({ apiOnline: null, queue: null, status: null });
    expect(checks.every((c) => c.state === "unknown")).toBe(true);
    expect(systemChecks({ apiOnline: true, queue: { worker: "disabled" } })[1]!.state).toBe("warn");
  });

  it("timeAgo follows the language", () => {
    expect(timeAgo("2026-11-10T11:55:00.000Z", "en", NOW)).toBe("5 minutes ago");
    expect(timeAgo("2026-11-09T12:00:00.000Z", "es", NOW)).toBe("ayer");
    expect(timeAgo("nope", "en", NOW)).toBe("");
  });
});
