/**
 * Agent Audit Service — Unit Tests
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ─── DB proxy ───────────────────────────────────────────────────────────────
let selectResults: any[][] = [];
let insertResult: any[] = [];
let deleteResult: any = { rowCount: 0 };
let selectCallIndex = 0;

function createDbProxy(result: any): any {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") return (resolve: any) => resolve(result);
      return createDbProxy(result);
    },
    apply(_target, _thisArg, _args) {
      return createDbProxy(result);
    },
  });
}

function getNextSelectResult() {
  return selectResults[selectCallIndex++] || [];
}

const mockDb = {
  select: mock(() => createDbProxy(getNextSelectResult())),
  insert: mock(() => createDbProxy(insertResult)),
  delete: mock(() => createDbProxy(deleteResult)),
  update: mock(() => createDbProxy([])),
};

mock.module("../db", () => ({ db: mockDb, mergedSchema: {} }));
mock.module("../db/schema", () => ({
  agentAuditLogs: {
    id: "id",
    agentId: "agentId",
    keyId: "keyId",
    action: "action",
    resource: "resource",
    resourceId: "resourceId",
    details: "details",
    ipAddress: "ipAddress",
    userAgent: "userAgent",
    durationMs: "durationMs",
    success: "success",
    errorMessage: "errorMessage",
    createdAt: "createdAt",
  },
  agentIdentities: { id: "id", name: "name" },
}));
// WATCH OUT: "drizzle-orm" is NOT mocked here.
//
// `mock.module` in bun is GLOBAL and IRREVERSIBLE (`mock.restore()` does not
// undo it), so stubbing the whole package contaminated every
// test file that ran afterwards: `sql` without `.raw` broke rls-builder, `sql` without
// `.identifier` blew up drizzle's dialect, and `eq()` returning the
// string "eq" generated corrupt SQL (`where $1`) in any test with
// real queries.
//
// Not needed: `mockDb` is a Proxy that swallows any chain of
// calls, so drizzle's real helpers build their SQL object and
// nobody ever serializes it.

const logger = {
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  info: mock(() => {}),
};
mock.module("../lib/logger", () => ({ logger }));

mock.module("./agent-webhooks", () => ({
  notifyAuthSuccess: mock(() => {}),
  notifyAuthFailure: mock(() => {}),
  notifyRateLimited: mock(() => {}),
  notifyPermissionDenied: mock(() => {}),
}));

import {
  logAgentAction,
  logAuthSuccess,
  logAuthFailure,
  logToolCall,
  logPermissionDenied,
  logRateLimited,
  queryAuditLogs,
  getAgentStats,
  detectSuspiciousActivity,
  cleanupOldLogs,
} from "../services/agent-audit";

afterAll(() => mock.restore());

beforeEach(() => {
  selectResults = [];
  insertResult = [];
  deleteResult = { rowCount: 0 };
  selectCallIndex = 0;
  logger.error.mockReset?.();
  logger.info.mockReset?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// Logging helpers
// ═════════════════════════════════════════════════════════════════════════════

describe("logAuthSuccess", () => {
  it("executes without error", () => {
    logAuthSuccess("a1", "k1");
    expect(true).toBe(true);
  });
});

describe("logAuthFailure", () => {
  it("executes without error", () => {
    logAuthFailure("a1", "bad key");
    expect(true).toBe(true);
  });
});

describe("logToolCall", () => {
  it("executes without error", () => {
    logToolCall("a1", "k1", "read", [], 10, true);
    expect(true).toBe(true);
  });
});

describe("logPermissionDenied", () => {
  it("executes without error", () => {
    logPermissionDenied("a1", "k1", "users", "admin");
    expect(true).toBe(true);
  });
});

describe("logRateLimited", () => {
  it("executes without error", () => {
    logRateLimited("a1", 60);
    expect(true).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Queries
// ═════════════════════════════════════════════════════════════════════════════

describe("queryAuditLogs", () => {
  it("returns logs with default pagination", async () => {
    selectResults = [[{ id: "log1", agentId: "a1", action: "auth_success" }], [{ count: 5 }]];
    const result = await queryAuditLogs();
    expect(result.logs.length).toBe(1);
    expect(result.total).toBe(5);
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it("applies filters when provided", async () => {
    selectResults = [[{ id: "log1", agentId: "a1", action: "auth_failure" }], [{ count: 1 }]];
    const result = await queryAuditLogs({
      agentId: "a1",
      action: "auth_failure",
      resource: "users",
      success: false,
    });
    expect(result.logs.length).toBe(1);
  });
});

describe("getAgentStats", () => {
  it("returns stats for an agent", async () => {
    selectResults = [
      [
        { action: "auth_success", success: true, count: 10 },
        { action: "auth_failure", success: false, count: 2 },
      ],
    ];
    const result = await getAgentStats("a1", 7);
    expect(result.totalCalls).toBe(12);
    expect(result.successfulCalls).toBe(10);
    expect(result.failedCalls).toBe(2);
    expect(result.successRate).toBe("83.33%");
    expect(result.actionsByType["auth_success"].count).toBe(10);
  });

  it("returns 0% when no calls", async () => {
    selectResults = [[]];
    const result = await getAgentStats("a1");
    expect(result.totalCalls).toBe(0);
    expect(result.successRate).toBe("0%");
  });
});

describe("detectSuspiciousActivity", () => {
  it("returns auth failures, rate limits, and permission denials", async () => {
    selectResults = [
      [{ agentId: "a1", count: 12 }],
      [{ agentId: "a2", count: 4 }],
      [{ agentId: "a1", count: 6 }],
    ];
    const result = await detectSuspiciousActivity(24);
    expect(result.authFailures.length).toBe(1);
    expect(result.authFailures[0].severity).toBe("high");
    expect(result.rateLimits.length).toBe(1);
    expect(result.rateLimits[0].severity).toBe("low");
    expect(result.permissionDenials.length).toBe(1);
    expect(result.permissionDenials[0].severity).toBe("medium");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Maintenance
// ═════════════════════════════════════════════════════════════════════════════

describe("cleanupOldLogs", () => {
  it("deletes old logs and returns count", async () => {
    deleteResult = { rowCount: 5 };
    const deleted = await cleanupOldLogs(90);
    expect(deleted).toBe(5);
    expect((logger.info as any).mock.calls.length).toBe(1);
  });
});
