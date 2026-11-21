/**
 * Kon queues: each kon's queue names live in its own namespace (H48, 2026-11-21).
 *
 *   - a kon could `queue.handle("koe-outbound", …)` and take over another kon's
 *     jobs, or `kitsuden-email` and the core's: a kon now handles only names in
 *     its namespace (`<short id>:`, `<kon id>:`, its legacy names), and a plain
 *     name is mapped into it;
 *   - a kon could queue jobs on any queue: it now queues on its own, on another
 *     kon's only when that kon opened it (`senders`) or the core's legacy grants
 *     say so, and never on a core queue;
 *   - the published kons (koe, chat, ingest) keep their queue names.
 *
 * The queue engine is the real one with a recording dispatcher; no database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkKonDispatch,
  checkKonHandle,
  currentKon,
  installKonQueueGuard,
  KonQueueRefused,
  outsideKonScope,
  resetKonQueueAccessForTests,
  runAsKon,
} from "../../apps/api/src/lib/queue-kon-access";
import {
  configureQueue,
  konQueue,
  queue,
  queueHandlers,
  type QueueJob,
} from "../../packages/engine/src/queue";
import type { KonContext, KonEvents } from "../../packages/shared/src";

const dispatched: Array<{ queue: string; name: string }> = [];
let n = 0;
/** A queue name no other test used (the engine's handler map lives for the whole file). */
const fresh = (base: string) => `${base}${++n}`;

function job(queueName: string): QueueJob {
  return {
    id: "j1",
    queue: queueName,
    name: "x",
    payload: {},
    attempt: 1,
    maxAttempts: 1,
    actor: null,
    requestId: null,
  };
}

beforeAll(() => {
  configureQueue({
    dispatch: async (queueName, name) => {
      dispatched.push({ queue: queueName, name });
      return { id: "id" };
    },
  });
  installKonQueueGuard();
});

beforeEach(() => {
  dispatched.length = 0;
  resetKonQueueAccessForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.KON_QUEUE_LEGACY_DRAIN;
});

const noop = async () => undefined;

describe("the published kons keep working", () => {
  it("koe, chat and ingest keep their queue names", () => {
    runAsKon("kon-koe", () => {
      for (const name of ["koe-inbound", "koe-outbound", "koe-bot-replies", "koe-notify"]) {
        konQueue.handle(name, noop);
        expect(queueHandlers().has(name)).toBe(true);
      }
    });
    runAsKon("kon-chat", () => konQueue.handle("chat-channel-turns", noop));
    runAsKon("kon-ingest", () => konQueue.handle("kitsuden-ingest", noop));
    expect(queueHandlers().has("chat-channel-turns")).toBe(true);
    expect(queueHandlers().has("kitsuden-ingest")).toBe(true);
  });

  it("their cross-kon jobs and kon-ingest's embeddings are allowed by the core", async () => {
    await runAsKon("kon-koe", () => konQueue.dispatch("chat-channel-turns", "turn", {}));
    await runAsKon("kon-koe", () => konQueue.dispatch("koe-media", "download", {}));
    await runAsKon("kon-chat", () => konQueue.dispatch("koe-bot-replies", "reply", {}));
    await runAsKon("kon-ingest", () => konQueue.dispatch("kitsuden-ingest", "document", {}));
    await runAsKon("kon-ingest", () => konQueue.dispatch("kitsuden-embeddings", "embed:x", {}));
    expect(dispatched.map((d) => d.queue)).toEqual([
      "chat-channel-turns",
      "koe-media",
      "koe-bot-replies",
      "kitsuden-ingest",
      "kitsuden-embeddings",
    ]);
  });

  it("the package hands kons the checked queue", () => {
    const index = readFileSync(join(__dirname, "../../packages/engine/index.ts"), "utf8");
    expect(index).toContain('export { konQueue as queue, PermanentError } from "./src/queue";');
  });
});

describe("a kon cannot take another kon's queue or the core's", () => {
  it("refuses handling a core queue, another kon's legacy name or namespace", () => {
    runAsKon("kon-evil", () => {
      expect(() => konQueue.handle("kitsuden-email", noop)).toThrow(KonQueueRefused);
      expect(() => konQueue.handle("koe-outbound", noop)).toThrow(/belongs to kon-koe/);
      expect(() => konQueue.handle("crm:sync", noop)).toThrow(/belongs to kon-crm/);
      expect(() => konQueue.handle("kon-crm:sync", noop)).toThrow(/belongs to kon-crm/);
      expect(() => konQueue.handle("core:anything", noop)).toThrow(/core's queues/);
    });
  });

  it("refuses handling a queue the core already handles", () => {
    const name = fresh("core-lane");
    queue.handle(name, noop);
    expect(() => runAsKon("kon-evil", () => konQueue.handle(name, noop))).toThrow(/core's queues/);
    expect(() => checkKonDispatch("kon-evil", name)).toThrow(/core's queues/);
  });

  it("refuses queueing on a core queue or a kon's queue it was not given", async () => {
    await expect(
      runAsKon("kon-evil", () => konQueue.dispatch("kitsuden-email", "x", {}))
    ).rejects.toThrow(/core's queues/);
    await expect(
      runAsKon("kon-evil", () => konQueue.dispatch("koe-outbound", "deliver", {}))
    ).rejects.toThrow(/belongs to kon-koe/);
    // The core's grant is for kon-chat only.
    await expect(
      runAsKon("kon-evil", () => konQueue.dispatch("koe-bot-replies", "reply", {}))
    ).rejects.toThrow(KonQueueRefused);
    expect(dispatched).toEqual([]);
  });

  it("a queue opened with `senders` takes jobs from those kons only", async () => {
    const name = fresh("a:jobs");
    runAsKon("kon-a", () => konQueue.handle(name, noop, { senders: ["kon-b"] }));
    await runAsKon("kon-b", () => konQueue.dispatch(name, "x", {}));
    await expect(runAsKon("kon-c", () => konQueue.dispatch(name, "x", {}))).rejects.toThrow(
      /has not opened it to kon-c/
    );
    // Opening a queue to senders never lets them handle it.
    expect(() => runAsKon("kon-b", () => konQueue.handle(name, noop))).toThrow(KonQueueRefused);
    expect(dispatched.map((d) => d.queue)).toEqual([name]);
  });

  it("with no kon scope, a kon is still kept off the core's queues", async () => {
    await expect(konQueue.dispatch("kitsuden-email", "x", {})).rejects.toThrow(/core's queues/);
    expect(() => konQueue.handle("kitsuden-webhooks", noop)).toThrow(/core's queues/);
    const name = fresh("koe-x");
    runAsKon("kon-koe", () => konQueue.handle(name, noop));
    expect(() => konQueue.handle(name, noop)).toThrow(/kon-koe already handles it/);
  });
});

describe("a plain name is mapped into the kon's namespace", () => {
  it("handle and dispatch both use <short id>:name, and the old name is drained", async () => {
    const plain = fresh("sync");
    const seen: Array<string | undefined> = [];
    runAsKon("kon-reports", () =>
      konQueue.handle(plain, async () => {
        seen.push(currentKon());
      })
    );
    expect(queueHandlers().has(`reports:${plain}`)).toBe(true);
    // Jobs queued under the old name before the upgrade still reach the kon's handler.
    expect(queueHandlers().has(plain)).toBe(true);

    await runAsKon("kon-reports", () => konQueue.dispatch(plain, "x", {}));
    expect(dispatched.at(-1)?.queue).toBe(`reports:${plain}`);

    // The handler runs as the kon, even when the worker calls it from nowhere.
    await outsideKonScope(() => queueHandlers().get(`reports:${plain}`)!.fn(job(plain)));
    await queueHandlers().get(plain)!.fn(job(plain));
    expect(seen).toEqual(["kon-reports", "kon-reports"]);

    // The old name now belongs to kon-reports.
    expect(() => runAsKon("kon-other", () => konQueue.handle(plain, noop))).toThrow(
      /belongs to kon-reports/
    );
  });

  it("KON_QUEUE_LEGACY_DRAIN=false maps without draining the old name", () => {
    process.env.KON_QUEUE_LEGACY_DRAIN = "false";
    const plain = fresh("tidy");
    runAsKon("kon-reports", () => konQueue.handle(plain, noop));
    expect(queueHandlers().has(`reports:${plain}`)).toBe(true);
    expect(queueHandlers().has(plain)).toBe(false);
  });

  it("a name already in the namespace is not prefixed twice", () => {
    const name = fresh("reports:nightly");
    expect(checkKonHandle("kon-reports", name, noop).queue).toBe(name);
    expect(checkKonDispatch("kon-reports", name)).toBe(name);
  });

  it("the worker runs jobs with no kon scope", () => {
    expect(runAsKon("kon-a", () => outsideKonScope(() => currentKon()))).toBeUndefined();
  });
});

describe("ctx.queue and the kon scope in the bound context", () => {
  it("ctx.queue maps, checks and needs no scope", async () => {
    const { bindKonContext } = await import("../../apps/api/src/lib/kon-setup");
    const ctx = bindKonContext({} as KonContext, "kon-billing");
    const plain = fresh("invoice");
    ctx.queue!.handle(plain, noop);
    expect(queueHandlers().has(`billing:${plain}`)).toBe(true);
    expect(ctx.queue!.name(plain)).toBe(`billing:${plain}`);
    await ctx.queue!.add(plain, "send", {});
    expect(dispatched.at(-1)?.queue).toBe(`billing:${plain}`);
    await expect(ctx.queue!.add("kitsuden-email", "x", {})).rejects.toThrow(/core's queues/);
    expect(() => ctx.queue!.handle("koe-outbound", noop)).toThrow(/belongs to kon-koe/);
  });

  it("a kon's event handlers run in its scope", async () => {
    const { bindKonContext } = await import("../../apps/api/src/lib/kon-setup");
    const handlers: Array<(data: unknown) => void> = [];
    const events: KonEvents = {
      emit: (_e, data) => handlers.forEach((h) => h(data)),
      on: (_e, h) => void handlers.push(h),
    };
    const ctx = bindKonContext({ events } as KonContext, "kon-billing");
    let seen: string | undefined;
    ctx.events.on("billing:paid", () => {
      seen = currentKon();
    });
    runAsKon("kon-other", () => events.emit("billing:paid", {}));
    expect(seen).toBe("kon-billing");
  });
});
