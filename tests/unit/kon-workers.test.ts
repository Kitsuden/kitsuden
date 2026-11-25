/**
 * Kons' long-running processes (apps/api/src/lib/kon-workers.ts, docs/kons/workers.md)
 *
 * One instance per lock, a crash restarts it, switching the kon off stops it, `KITSUDEN_WORKERS=off`
 * runs nothing and `KITSUDEN_WORKER_FILTER` narrows what a process takes. The lock is injected: the real
 * one is a Postgres advisory lock, which these tests do not need to prove the supervisor.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const offKons = new Set<string>();

vi.mock("../../apps/api/src/lib/kon-activation", () => ({
  konSwitchedOff: async (id: string) => offKons.has(id),
}));
vi.mock("../../apps/api/src/lib/deferred-kons", () => ({
  hotKonSwitchedOff: async () => false,
}));
vi.mock("../../apps/api/src/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  listKonWorkers,
  lockKeyOf,
  processLockForTests,
  registerKonWorkers,
  resetKonWorkersForTests,
  startKonWorkers,
  stopKonWorkers,
  workerAllowed,
  workerIdOf,
  workersMode,
  type LockAcquirer,
} from "../../apps/api/src/lib/kon-workers";

const ctx = {} as never;
const fast = {
  lockRetry: 10,
  activationCheck: 10,
  stopGrace: 50,
  backoffFirst: 5,
  backoffMax: 20,
  healthy: 60_000,
};

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A worker that runs until stopped, counting starts and stops. */
function steady() {
  const state = { starts: 0, stops: 0, running: 0 };
  return {
    state,
    run: async (_ctx: unknown, w: { signal: AbortSignal }) => {
      state.starts++;
      state.running++;
      await new Promise<void>((resolve) => w.signal.addEventListener("abort", () => resolve()));
      state.running--;
      state.stops++;
    },
  };
}

afterEach(async () => {
  await stopKonWorkers();
  resetKonWorkersForTests();
  offKons.clear();
});

describe("kon workers", () => {
  it("names and modes", () => {
    expect(workerIdOf("kon-dc", "gateway")).toBe("dc:gateway");
    expect(workersMode({})).toBe("inline");
    expect(workersMode({ KITSUDEN_WORKERS: "OFF" })).toBe("off");
    expect(workersMode({ KITSUDEN_WORKERS: "only" })).toBe("only");
    expect(workersMode({ KITSUDEN_WORKERS: "sometimes" })).toBe("inline");
    expect(workerAllowed("dc:gateway", {})).toBe(true);
    expect(workerAllowed("dc:gateway", { KITSUDEN_WORKER_FILTER: "dc:*" })).toBe(true);
    expect(workerAllowed("dc:gateway", { KITSUDEN_WORKER_FILTER: "koe:*, dc:poller" })).toBe(false);
    // Stable across processes and versions: another process must compute the same key
    expect(lockKeyOf("dc:gateway")).toBe(lockKeyOf("dc:gateway"));
    expect(lockKeyOf("dc:gateway")).not.toBe(lockKeyOf("koe:gateway"));
    expect(BigInt(lockKeyOf("dc:gateway")) > 0n).toBe(true);
  });

  it("refuses a bad declaration and keeps the good ones", () => {
    const problems = registerKonWorkers(
      {
        id: "kon-dc",
        workers: [
          { id: "Bad Id", run: async () => {} },
          { id: "no-run" } as never,
          { id: "gateway", run: async () => {} },
          { id: "gateway", run: async () => {} },
        ],
      },
      ctx
    );
    expect(problems).toHaveLength(3);
    expect(listKonWorkers().map((w) => w.id)).toEqual(["dc:gateway"]);
  });

  it("holds the lock while it runs: a second process cannot take it", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    const w = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: w.run }] }, ctx);
    startKonWorkers({});
    await until(() => w.state.running === 1);
    expect(await processLockForTests("dc:gateway")).toBeNull();
    await stopKonWorkers();
    // Released on stop
    expect(await processLockForTests("dc:gateway")).not.toBeNull();
  });

  it("restarts a worker that crashes, with a pause", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    let starts = 0;
    registerKonWorkers(
      {
        id: "kon-dc",
        workers: [
          {
            id: "gateway",
            run: async () => {
              starts++;
              throw new Error("socket closed");
            },
          },
        ],
      },
      ctx
    );
    startKonWorkers({});
    await until(() => starts >= 3);
    const [info] = listKonWorkers();
    expect(info.restarts).toBeGreaterThanOrEqual(2);
    expect(info.lastError).toBe("socket closed");
  });

  it("treats returning while not stopped as a crash", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    let starts = 0;
    registerKonWorkers(
      { id: "kon-dc", workers: [{ id: "gateway", run: async () => void starts++ }] },
      ctx
    );
    startKonWorkers({});
    await until(() => starts >= 2);
    expect(listKonWorkers()[0].lastError).toMatch(/returned/);
  });

  it("stops when the kon is switched off and starts again when it is back on", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    const w = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: w.run }] }, ctx);
    startKonWorkers({});
    await until(() => w.state.running === 1);
    offKons.add("kon-dc");
    await until(() => w.state.stops === 1);
    expect(listKonWorkers()[0].runningHere).toBe(false);
    offKons.delete("kon-dc");
    await until(() => w.state.starts === 2 && w.state.running === 1);
    // A stop is not a crash
    expect(listKonWorkers()[0].restarts).toBe(0);
  });

  it("stops when the lock is lost, and takes it again", async () => {
    const losers: AbortController[] = [];
    const acquire: LockAcquirer = async () => {
      const lost = new AbortController();
      losers.push(lost);
      return { lost: lost.signal, release: async () => {} };
    };
    resetKonWorkersForTests({ acquire, timings: fast });
    const w = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: w.run }] }, ctx);
    startKonWorkers({});
    await until(() => w.state.running === 1);
    losers[0].abort();
    await until(() => w.state.stops === 1 && w.state.running === 1);
    expect(losers).toHaveLength(2);
  });

  it("waits for the lock while another process holds it", async () => {
    let free = false;
    const acquire: LockAcquirer = async (id) => (free ? processLockForTests(id) : null);
    resetKonWorkersForTests({ acquire, timings: fast });
    const w = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: w.run }] }, ctx);
    startKonWorkers({});
    await new Promise((r) => setTimeout(r, 50));
    expect(w.state.starts).toBe(0);
    free = true;
    await until(() => w.state.running === 1);
  });

  it("KITSUDEN_WORKERS=off runs nothing; the filter narrows", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    const w = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: w.run }] }, ctx);
    startKonWorkers({ KITSUDEN_WORKERS: "off" });
    await new Promise((r) => setTimeout(r, 40));
    expect(w.state.starts).toBe(0);

    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    const g = steady();
    const p = steady();
    vi.stubEnv("KITSUDEN_WORKER_FILTER", "dc:gateway");
    try {
      registerKonWorkers(
        {
          id: "kon-dc",
          workers: [
            { id: "gateway", run: g.run },
            { id: "poller", run: p.run },
          ],
        },
        ctx
      );
      startKonWorkers({ KITSUDEN_WORKERS: "only" });
      await until(() => g.state.running === 1);
      expect(p.state.starts).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a kon announced again replaces its workers", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    const first = steady();
    const second = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: first.run }] }, ctx);
    startKonWorkers({});
    await until(() => first.state.running === 1);
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: second.run }] }, ctx);
    await until(() => first.state.stops === 1 && second.state.running === 1);
  });

  it("a worker that ignores its stop keeps the lock: no second copy starts beside it", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    let running = 0;
    let most = 0;
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    const stubborn = async () => {
      running++;
      most = Math.max(most, running);
      await gate;
      running--;
    };
    const second = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: stubborn }] }, ctx);
    startKonWorkers({});
    await until(() => running === 1);
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: second.run }] }, ctx);
    // Well past the grace and several lock retries: still the old one alone.
    await new Promise((r) => setTimeout(r, fast.stopGrace * 4));
    expect(second.state.starts).toBe(0);
    letGo();
    await until(() => second.state.running === 1);
    expect(most).toBe(1);
  });

  it("shutdown stops every worker", async () => {
    resetKonWorkersForTests({ acquire: processLockForTests, timings: fast });
    const w = steady();
    registerKonWorkers({ id: "kon-dc", workers: [{ id: "gateway", run: w.run }] }, ctx);
    startKonWorkers({});
    await until(() => w.state.running === 1);
    await stopKonWorkers();
    expect(w.state.stops).toBe(1);
  });
});
