import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";

import {
  logger,
  createRequestLogger,
  createPerformanceLogger,
  logQuery,
  logSecurity,
} from "../lib/logger";

const calls: {
  child: any[];
  info: any[];
  warn: any[];
  error: any[];
  debug: any[];
} = {
  child: [],
  info: [],
  warn: [],
  error: [],
  debug: [],
};

function installSpies() {
  const log = logger as any;
  const original = {
    child: log.child,
    info: log.info,
    warn: log.warn,
    error: log.error,
    debug: log.debug,
  };

  log.child = (...args: any[]) => {
    calls.child.push(args);
    return original.child ? original.child.apply(log, args) : log;
  };
  log.info = (...args: any[]) => calls.info.push(args);
  log.warn = (...args: any[]) => calls.warn.push(args);
  log.error = (...args: any[]) => calls.error.push(args);
  log.debug = (...args: any[]) => calls.debug.push(args);

  return () => {
    log.child = original.child;
    log.info = original.info;
    log.warn = original.warn;
    log.error = original.error;
    log.debug = original.debug;
  };
}

let restoreSpies: () => void;

beforeAll(() => {
  restoreSpies = installSpies();
});

beforeEach(() => {
  calls.child.length = 0;
  calls.info.length = 0;
  calls.warn.length = 0;
  calls.error.length = 0;
  calls.debug.length = 0;
});

afterAll(() => {
  restoreSpies?.();
});

describe("logger", () => {
  it("exports a pino logger instance", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });

  it("createRequestLogger creates a child logger with request context", () => {
    const child = createRequestLogger("req-123", "user-456");
    expect(calls.child.length).toBe(1);
    expect(calls.child[0][0]).toEqual({
      requestId: "req-123",
      userId: "user-456",
      type: "request",
    });
    expect(child).toBeDefined();
  });

  it("createRequestLogger defaults userId to anonymous", () => {
    createRequestLogger("req-999");
    expect(calls.child[0][0].userId).toBe("anonymous");
  });

  it("createPerformanceLogger.finish logs duration and metadata", () => {
    const perf = createPerformanceLogger("op-1");
    perf.finish({ itemId: "x" });

    const last = calls.info[calls.info.length - 1];
    expect(last[0].operation).toBe("op-1");
    expect(typeof last[0].duration).toBe("number");
    expect(last[0].type).toBe("performance");
    expect(last[0].itemId).toBe("x");
    expect(last[1]).toContain("op-1 completed");
  });

  it("createPerformanceLogger.error logs error and duration", () => {
    const perf = createPerformanceLogger("op-2");
    perf.error(new Error("boom"), { retry: 1 });

    const last = calls.error[calls.error.length - 1];
    expect(last[0].operation).toBe("op-2");
    expect(last[0].error).toBe("boom");
    expect(last[0].type).toBe("performance-error");
    expect(last[0].retry).toBe(1);
    expect(last[1]).toContain("op-2 failed");
  });

  it("logQuery logs debug for fast queries", () => {
    logQuery("SELECT 1", ["a"], 100);
    const last = calls.debug[calls.debug.length - 1];
    expect(last[0].type).toBe("query");
    expect(last[0].sql).toBe("SELECT 1");
    expect(last[0].paramsCount).toBe(1);
    expect(last[0].slow).toBe(false);
  });

  it("logQuery logs warn for slow queries", () => {
    logQuery("SELECT *", [], 1500);
    const last = calls.warn[calls.warn.length - 1];
    expect(last[0].slow).toBe(true);
    expect(last[1]).toContain("Slow query");
  });

  it("logQuery logs error when error provided", () => {
    logQuery("SELECT bad", [], 50, new Error("syntax"));
    const last = calls.error[calls.error.length - 1];
    expect(last[0].error).toBe("syntax");
    expect(last[1]).toContain("Query failed");
  });

  it("logSecurity logs a security event", () => {
    logSecurity("login.failure", {
      userId: "u1",
      ip: "127.0.0.1",
      userAgent: "test",
      metadata: { attempts: 3 },
    });

    const last = calls.warn[calls.warn.length - 1];
    expect(last[0].type).toBe("security");
    expect(last[0].event).toBe("login.failure");
    expect(last[0].userId).toBe("u1");
    expect(last[0].ip).toBe("127.0.0.1");
    expect(last[1]).toContain("Security: login.failure");
  });
});
