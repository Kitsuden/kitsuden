/**
 * Action CRUD keeps the live cron schedule in step
 * ============================================================================
 *
 * cron-scheduler.ts loads the active cron actions at startup. Before this was
 * wired, `createAction` / `updateAction` / `deleteAction` only logged "Would
 * schedule": a cron action created from the panel or the REST API did not run, and
 * a changed expression did not apply, until the API restarted.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";

const refreshed: Array<{ id: string; trigger: string; status: string }> = [];
const removed: string[] = [];
let row: Record<string, unknown> = {};

let engine: typeof import("../lib/actions/engine");

describe("action CRUD and the cron scheduler", () => {
  beforeAll(async () => {
    mock.module("../lib/cron-scheduler", () => ({
      refreshCronJob: (a: { id: string; trigger: string; status: string }) =>
        refreshed.push({ id: a.id, trigger: a.trigger, status: a.status }),
      removeCronJob: (id: string) => removed.push(id),
      initCronScheduler: async () => {},
      stopAllCronJobs: () => {},
      getCronJobStatus: () => [],
      refreshCronJobLegacy: () => {},
    }));

    const returning = (values: () => Record<string, unknown>) => ({
      returning: async () => [values()],
    });
    mock.module("../db", () => ({
      isLiteMode: false,
      isPgMem: false,
      poolStatus: () => null,
      mergedSchema: {},
      db: {
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => [row] }) }),
        }),
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            row = { id: "act-1", ...v };
            return returning(() => row);
          },
        }),
        update: () => ({
          set: (v: Record<string, unknown>) => {
            row = { ...row, ...v };
            return { where: () => returning(() => row) };
          },
        }),
        delete: () => ({ where: () => returning(() => row) }),
      },
    }));

    engine = await import("../lib/actions/engine");
  });

  it("schedules a new cron action at once", async () => {
    await engine.createAction({
      name: "Nightly",
      type: "code",
      trigger: "cron",
      triggerConfig: { cronExpression: "0 3 * * *" },
      config: {},
    } as never);
    expect(refreshed.at(-1)).toEqual({ id: "act-1", trigger: "cron", status: "active" });
  });

  it("hands every update to the scheduler, so a pause or a new expression applies now", async () => {
    const before = refreshed.length;
    await engine.updateAction("act-1", { status: "paused" } as never);
    expect(refreshed.length).toBe(before + 1);
    expect(refreshed.at(-1)).toEqual({ id: "act-1", trigger: "cron", status: "paused" });

    await engine.updateAction("act-1", { trigger: "manual" } as never);
    expect(refreshed.at(-1)?.trigger).toBe("manual");
  });

  it("unschedules a deleted action", async () => {
    await engine.deleteAction("act-1");
    expect(removed).toContain("act-1");
  });
});
