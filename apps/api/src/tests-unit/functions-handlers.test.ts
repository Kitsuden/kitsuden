import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import type { Context } from "hono";

let handlers: any;

describe("Functions Handlers (Unit)", () => {
  beforeAll(async () => {
    mock.module("../db", () => ({
      isLiteMode: false,
      isPgMem: false,
      mergedSchema: {},
      db: {
        select: () => ({
          from: (_table: any) => ({
            where: (_cond: any) => ({
              orderBy: () => ({ limit: (n: number) => Promise.resolve([]) }),
              limit: (n: number) => Promise.resolve([]),
            }),
            orderBy: () => ({ limit: (n: number) => Promise.resolve([]) }),
            limit: (n: number) => Promise.resolve([]),
          }),
        }),
        insert: () => ({
          values: (data: any) => ({
            returning: () => Promise.resolve([{ id: "fn-1", ...data }]),
          }),
        }),
        update: () => ({
          set: (data: any) => ({
            where: (_cond: any) => ({
              returning: () => Promise.resolve([{ id: "fn-1", ...data }]),
            }),
          }),
        }),
        delete: () => ({
          where: (_cond: any) => ({
            returning: () => Promise.resolve([{ id: "fn-1", name: "Test" }]),
          }),
        }),
      },
    }));

    mock.module("../lib/cron-scheduler", () => ({
      refreshCronJob: () => {},
      removeCronJob: () => {},
      stopAllCronJobs: () => {},
      getCronJobStatus: () => [{ name: "test", active: true }],
      refreshCronJobLegacy: () => {},
      initCronScheduler: async () => {},
    }));

    mock.module("../lib/function-dispatcher", () => ({
      executeFunction: async () => ({
        success: true,
        result: { hello: "world" },
        logs: [],
        error: null,
        durationMs: 1,
        exitReason: "done",
      }),
      executeManually: async () => ({
        success: true,
        result: { hello: "world" },
        logs: [],
        error: null,
        durationMs: 1,
        exitReason: "done",
      }),
      initFunctionDispatcher: () => {},
    }));

    handlers = await import("../routes/functions");
  });

  afterAll(() => {
    mock.restore();
  });

  function createMockContext(options: any = {}): Context {
    const { params = {}, query = {}, body = null, jsonError = null } = options;
    const responses: any[] = [];
    return {
      req: {
        param: (name: string) => params[name],
        query: (name: string) => query[name],
        json: async () => {
          if (jsonError) throw jsonError;
          return body;
        },
      },
      json: (data: any, status?: number) => {
        responses.push({ data, status });
        return { data, status } as any;
      },
      body: (data: any, status?: number) => ({ data, status }) as any,
      _responses: responses,
    } as any;
  }

  it("listFunctionsHandler returns docs", async () => {
    const c = createMockContext();
    const res = await handlers.listFunctionsHandler(c);
    expect(res.data.docs).toEqual([]);
    expect(res.data.totalDocs).toBe(0);
  });

  it("getCronStatusHandler returns jobs", async () => {
    const c = createMockContext();
    const res = await handlers.getCronStatusHandler(c);
    expect(Array.isArray(res.data.jobs)).toBe(true);
  });

  it("createFunctionHandler validates required fields", async () => {
    const c = createMockContext({ body: { name: "Incomplete" } });
    const res = await handlers.createFunctionHandler(c);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("required");
  });

  it("createFunctionHandler creates with slug fallback", async () => {
    const c = createMockContext({
      body: { name: "Test Fn", code: "return 1;", trigger: "manual" },
    });
    const res = await handlers.createFunctionHandler(c);
    expect(res.status).toBe(201);
    expect(res.data.name).toBe("Test Fn");
    expect(res.data.slug).toBe("test-fn");
  });

  it("updateFunctionHandler validates cron", async () => {
    const c = createMockContext({ params: { id: "fn-1" }, body: { trigger: "cron" } });
    const res = await handlers.updateFunctionHandler(c);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("cronExpression");
  });

  it("deleteFunctionHandler returns success", async () => {
    const c = createMockContext({ params: { id: "fn-1" } });
    const res = await handlers.deleteFunctionHandler(c);
    expect(res.data.success).toBe(true);
  });

  it("executeFunctionHandler returns result", async () => {
    const c = createMockContext({ params: { id: "fn-1" }, body: { payload: {} } });
    const res = await handlers.executeFunctionHandler(c);
    expect(res.data.success).toBe(true);
  });

  it("listExecutionsHandler returns docs", async () => {
    const c = createMockContext({ params: { id: "fn-1" } });
    const res = await handlers.listExecutionsHandler(c);
    expect(Array.isArray(res.data.docs)).toBe(true);
  });
});
