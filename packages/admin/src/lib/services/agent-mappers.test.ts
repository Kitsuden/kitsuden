/**
 * The rows below are what routes/agents-v1.ts selects: no `model`, no `status`, no totals,
 * `tokensIn`/`tokensOut`, status `success`. The panel used to print "undefined" for them.
 */
import { describe, expect, it } from "vitest";

import { modelFromPrompt, toAgent, toTrace, toTracePage, traceStatus } from "./agent-mappers";

const API_AGENT = {
  id: "agent_1",
  name: "Support",
  description: null,
  type: "custom",
  capabilities: [],
  systemPrompt: "Model: gpt-4",
  allowedTools: [],
  scopes: ["mcp:connect"],
  rateLimit: 60,
  isActive: true,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
};

const API_TRACE = {
  id: "t1",
  agentId: "agent_1",
  sessionId: null,
  input: {},
  output: {},
  totalDurationMs: 1234,
  tokensIn: 100,
  tokensOut: 25,
  status: "success",
  createdAt: "2026-11-01T10:00:00.000Z",
};

describe("toAgent", () => {
  it("derives status and enabled from isActive", () => {
    expect(toAgent(API_AGENT)).toMatchObject({ status: "active", enabled: true });
    expect(toAgent({ ...API_AGENT, isActive: false })).toMatchObject({
      status: "paused",
      enabled: false,
    });
  });

  it("reads the model the create route wrote into the prompt, and keeps the type", () => {
    const a = toAgent(API_AGENT);
    expect(a.model).toBe("gpt-4");
    expect(a.type).toBe("custom");
    expect(toAgent({ ...API_AGENT, systemPrompt: "You are helpful." }).model).toBeUndefined();
    expect(modelFromPrompt(null)).toBeUndefined();
  });

  it("leaves totals undefined instead of inventing zeros", () => {
    const a = toAgent(API_AGENT);
    expect(a.totalTraces).toBeUndefined();
    expect(a.totalTokens).toBeUndefined();
    expect(toAgent({ ...API_AGENT, totalTraces: "7" }).totalTraces).toBe(7);
  });

  it("does not throw on a row with almost nothing", () => {
    expect(toAgent({ id: "x" })).toMatchObject({ id: "x", name: "", status: "active" });
    expect(toAgent(null).id).toBe("");
  });
});

describe("toTrace", () => {
  it("adds up the tokens: the API sends them per direction", () => {
    const t = toTrace(API_TRACE);
    expect(t.totalTokens).toBe(125);
    expect(() => t.totalTokens.toLocaleString("en-US")).not.toThrow();
  });

  it("null counters are zero, not NaN", () => {
    const t = toTrace({ ...API_TRACE, tokensIn: null, tokensOut: null, totalDurationMs: null });
    expect(t.totalTokens).toBe(0);
    expect(t.totalDurationMs).toBe(0);
  });

  it("keeps the API's status and reads `completed` as success", () => {
    expect(toTrace(API_TRACE).status).toBe("success");
    expect(traceStatus("completed")).toBe("success");
    expect(traceStatus("cancelled")).toBe("cancelled");
    expect(traceStatus(undefined)).toBe("pending");
  });

  it("keeps the fields it does not know (steps of an expanded trace)", () => {
    const t = toTrace({ ...API_TRACE, steps: [{ id: "s1" }] });
    expect(t.steps).toEqual([{ id: "s1" }]);
  });
});

describe("toTracePage", () => {
  it("reads { traces, total } with the count as Postgres sends it (a string)", () => {
    const page = toTracePage({ traces: [API_TRACE], total: "41" });
    expect(page.total).toBe(41);
    expect(page.traces).toHaveLength(1);
  });

  it("accepts a bare array and an empty answer", () => {
    expect(toTracePage([API_TRACE, API_TRACE]).total).toBe(2);
    expect(toTracePage(null)).toEqual({ traces: [], total: 0 });
    expect(toTracePage({})).toEqual({ traces: [], total: 0 });
  });
});
