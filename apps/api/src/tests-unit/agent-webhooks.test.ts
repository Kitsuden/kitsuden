/**
 * Agent Webhooks Service — Unit Tests
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

const logger = {
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  info: mock(() => {}),
};

mock.module("../lib/logger", () => ({ logger }));

import {
  sendAgentWebhook,
  notifyAuthSuccess,
  notifyAuthFailure,
  notifyRateLimited,
  notifyPermissionDenied,
  notifySuspiciousActivity,
  onSuspiciousActivityDetected,
} from "../services/agent-webhooks";

afterAll(() => mock.restore());

beforeEach(() => {
  logger.debug.mockReset?.();
  logger.warn.mockReset?.();
  logger.error.mockReset?.();
  delete process.env.AGENT_WEBHOOK_URL;
  delete process.env.AGENT_WEBHOOK_EVENTS;
  delete process.env.AGENT_WEBHOOK_SECRET;
});

describe("sendAgentWebhook", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as any)) as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("returns early when no webhook config", async () => {
    await sendAgentWebhook({
      id: "evt-1",
      type: "auth_success",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    expect((global.fetch as any).mock.calls.length).toBe(0);
  });

  it("returns early when event is filtered out", async () => {
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "auth_failure";
    await sendAgentWebhook({
      id: "evt-1",
      type: "auth_success",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    expect((global.fetch as any).mock.calls.length).toBe(0);
  });

  it("sends webhook for matching event", async () => {
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "auth_success";
    await sendAgentWebhook({
      id: "evt-1",
      type: "auth_success",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    // Wait for background promise
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("sends webhook for all events wildcard", async () => {
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "all";
    await sendAgentWebhook({
      id: "evt-1",
      type: "rate_limited",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("includes signature header when secret is set", async () => {
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "all";
    process.env.AGENT_WEBHOOK_SECRET = "shh";
    await sendAgentWebhook({
      id: "evt-1",
      type: "auth_success",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const call = (global.fetch as any).mock.calls[0];
    const headers = call[1].headers;
    expect(headers["X-Kitsuden-Signature"]).toMatch(/^sha256=[a-f0-9]+$/);
  });

  it("logs warning when delivery fails", async () => {
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 500 } as any)) as any;
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "all";
    await sendAgentWebhook({
      id: "evt-1",
      type: "auth_success",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });

  it("logs error when fetch throws", async () => {
    global.fetch = mock(() => Promise.reject(new Error("net fail"))) as any;
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "all";
    await sendAgentWebhook({
      id: "evt-1",
      type: "auth_success",
      timestamp: new Date().toISOString(),
      agent: { id: "a1", name: "Test" },
      details: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(logger.error.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("notification helpers", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as any)) as any;
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "all";
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("notifyAuthSuccess triggers webhook", async () => {
    notifyAuthSuccess("a1", "Test", { ipAddress: "1.2.3.4" });
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("notifyAuthFailure triggers webhook", async () => {
    notifyAuthFailure("a1", "Test", "bad key", { ipAddress: "1.2.3.4" });
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("notifyRateLimited triggers webhook", async () => {
    notifyRateLimited("a1", "Test", 60, { ipAddress: "1.2.3.4" });
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("notifyPermissionDenied triggers webhook", async () => {
    notifyPermissionDenied("a1", "Test", "users", "admin", { ipAddress: "1.2.3.4" });
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("notifySuspiciousActivity triggers webhook", async () => {
    notifySuspiciousActivity("a1", "Test", "auth_failures", 10, "high");
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });
});

describe("onSuspiciousActivityDetected", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as any)) as any;
    process.env.AGENT_WEBHOOK_URL = "http://example.com/hook";
    process.env.AGENT_WEBHOOK_EVENTS = "all";
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("does nothing for low severity", async () => {
    await onSuspiciousActivityDetected("a1", "Test", "auth_failures", 5, "low");
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(0);
  });

  it("notifies for medium severity", async () => {
    await onSuspiciousActivityDetected("a1", "Test", "auth_failures", 5, "medium");
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("notifies for high severity", async () => {
    await onSuspiciousActivityDetected("a1", "Test", "rate_limits", 10, "high");
    await new Promise((r) => setTimeout(r, 10));
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });
});
