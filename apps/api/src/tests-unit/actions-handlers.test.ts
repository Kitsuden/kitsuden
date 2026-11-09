import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import type { Context } from "hono";

let handlers: any;

describe("Actions Handlers (Unit)", () => {
  beforeAll(async () => {
    /**
     * `../lib/actions/engine` is stubbed, NOT the `../lib/actions` barrel.
     *
     * The barrel re-exports two different families: the CRUD (from `./engine`) and
     * the four executors (from `./handlers`). bun's `mock.module` does not
     * replace just the requested module: it writes through the re-export chain
     * down to the ORIGINAL binding. Stubbing the barrel therefore left
     * `executeAgentAction` replaced by a `() => ({success:true})` **inside
     * handlers/agent-handler.ts**, for the whole bun process — and that handler's
     * test failed five times with nothing to do with this
     * file, just because of the order in which bun loaded the files.
     *
     * By stubbing the leaf, that same write-through is used on purpose:
     * the routes still import from the barrel and receive these doubles, while
     * `./handlers` stays intact.
     */
    mock.module("../lib/actions/engine", () => ({
      listActions: async () => [],
      getAction: async (id: string) => ({
        id,
        name: "Test",
        type: "code",
        trigger: "manual",
        status: "active",
      }),
      createAction: async (data: any) => ({ id: "act-1", ...data }),
      updateAction: async (id: string, data: any) => ({ id, ...data }),
      deleteAction: async (id: string) => ({ id, name: "Test" }),
      executeActionById: async () => ({
        success: true,
        result: {},
        logs: [],
        error: null,
        durationMs: 1,
        httpResponse: null,
      }),
      // The barrel re-exports these four from `./engine`: if they are missing, whoever
      // imports "../lib/actions" transitively (function-dispatcher,
      // module-loader) fails with "Export named X not found".
      executeAction: async () => ({
        success: true,
        result: {},
        logs: [],
        error: null,
        durationMs: 1,
        httpResponse: null,
      }),
      dispatchEvent: async () => {},
      initActionsEngine: () => {},
    }));

    mock.module("../db", () => ({
      isLiteMode: false,
      isPgMem: false,
      mergedSchema: {},
      db: {
        select: (cols?: any) => ({
          from: (_table: any) => {
            const baseResult = cols ? [{ count: 0, type: "code" }] : [];
            const chain: any = {
              where: () => chain,
              orderBy: () => ({ limit: (n: number) => Promise.resolve(baseResult) }),
              limit: (n: number) => Promise.resolve(baseResult),
              groupBy: () => Promise.resolve(baseResult),
              then: (onFulfilled: any) => Promise.resolve(baseResult).then(onFulfilled),
            };
            return chain;
          },
        }),
        insert: () => ({
          values: (data: any) => ({
            returning: () => Promise.resolve([{ id: "act-1", ...data }]),
          }),
        }),
        update: () => ({
          set: (data: any) => ({
            where: (_cond: any) => ({
              returning: () => Promise.resolve([{ id: "act-1", ...data }]),
            }),
          }),
        }),
        delete: () => ({
          where: (_cond: any) => ({
            returning: () => Promise.resolve([{ id: "act-1", name: "Test" }]),
          }),
        }),
      },
    }));

    handlers = await import("../routes/actions");
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

  it("listActionsHandler returns docs", async () => {
    const c = createMockContext();
    const res = await handlers.listActionsHandler(c);
    expect(res.data.docs).toEqual([]);
  });

  it("createActionHandler validates required fields", async () => {
    const c = createMockContext({ body: { name: "Incomplete" } });
    const res = await handlers.createActionHandler(c);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("required");
  });

  it("createActionHandler validates type", async () => {
    const c = createMockContext({ body: { name: "T", code: "c", trigger: "manual", type: "bad" } });
    const res = await handlers.createActionHandler(c);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("Invalid type");
  });

  it("createActionHandler validates trigger", async () => {
    const c = createMockContext({ body: { name: "T", code: "c", trigger: "bad", type: "code" } });
    const res = await handlers.createActionHandler(c);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("Invalid trigger");
  });

  it("createActionHandler requires cronExpression for cron", async () => {
    const c = createMockContext({ body: { name: "T", code: "c", trigger: "cron", type: "code" } });
    const res = await handlers.createActionHandler(c);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("cronExpression");
  });

  it("createActionHandler creates successfully", async () => {
    const c = createMockContext({
      body: { name: "T", code: "c", trigger: "manual", type: "code" },
    });
    const res = await handlers.createActionHandler(c);
    expect(res.status).toBe(201);
    expect(res.data.name).toBe("T");
  });

  it("getActionHandler returns action", async () => {
    const c = createMockContext({ params: { id: "act-1" } });
    const res = await handlers.getActionHandler(c);
    expect(res.data.id).toBe("act-1");
  });

  it("updateActionHandler updates action", async () => {
    const c = createMockContext({ params: { id: "act-1" }, body: { name: "Updated" } });
    const res = await handlers.updateActionHandler(c);
    expect(res.data.name).toBe("Updated");
  });

  it("deleteActionHandler deletes action", async () => {
    const c = createMockContext({ params: { id: "act-1" } });
    const res = await handlers.deleteActionHandler(c);
    expect(res.data.success).toBe(true);
  });

  it("executeActionHandler returns result", async () => {
    const c = createMockContext({ params: { id: "act-1" }, body: { payload: {} } });
    const res = await handlers.executeActionHandler(c);
    expect(res.data.success).toBe(true);
  });

  it("listActionExecutionsHandler returns docs", async () => {
    const c = createMockContext({ params: { id: "act-1" } });
    const res = await handlers.listActionExecutionsHandler(c);
    expect(Array.isArray(res.data.docs)).toBe(true);
  });

  it("getActionStatsHandler returns stats", async () => {
    const c = createMockContext();
    const res = await handlers.getActionStatsHandler(c);
    expect(typeof res.data.total).toBe("number");
    expect(typeof res.data.active).toBe("number");
    expect(typeof res.data.byType).toBe("object");
  });
});
