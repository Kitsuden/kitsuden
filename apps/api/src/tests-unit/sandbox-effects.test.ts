/**
 * `kitsuden.effect(key, fn)` inside the sandbox (panel-defined code actions)
 * ============================================================================
 * The closure runs in QuickJS; the host only keeps the ledger. What it has to
 * satisfy, with an in-memory store (the Postgres one is in
 * tests/sandbox-effects-postgres.test.ts):
 *
 *   1. The first run executes `fn` and records its result; a second run with
 *      the same key returns the stored result WITHOUT executing `fn`.
 *   2. If `fn` throws, nothing is recorded as done: the next run executes it.
 *   3. A `finish` for a key this execution did not begin is refused (code that
 *      talks to `__request` by hand cannot close someone else's effect).
 *   4. `busy` and `unknown` reach the code as errors it can see.
 *   5. Without a store (outside an action) the call fails saying so; in a
 *      promotion test (`probe`) an in-memory store answers.
 */

import type { EffectStore } from "@kitsuden/engine";
import { describe, expect, test } from "bun:test";

import {
  callEffect,
  effectState,
  executeSandbox,
  memoryEffectStore,
  type SandboxEffects,
} from "../lib/worker-sandbox";

const base = { payload: {}, envVars: {}, timeoutMs: 8000, memoryLimitMb: 64 };

function effects(store: EffectStore, scope = "action:test"): SandboxEffects {
  return { scope, runId: "run-1", store };
}

/** The code counts how many times `fn` ran through a log line. */
const CODE = `
  const r = await kitsuden.effect("send:" + event.id, async () => {
    console.log("RAN");
    if (event.fail) throw new Error("provider down");
    return { sent: true, id: event.id };
  });
  return r;
`;

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

describe("kitsuden.effect in the sandbox", () => {
  test("runs once per key and returns the stored result on the next run", async () => {
    const store = memoryEffectStore();
    const first = await executeSandbox({
      ...base,
      payload: { id: 7 },
      code: CODE,
      effects: effects(store),
    });
    expect(first.error).toBeNull();
    expect(first.result).toEqual({ sent: true, id: 7 });
    expect(first.logs).toContain("RAN");

    const second = await executeSandbox({
      ...base,
      payload: { id: 7 },
      code: CODE,
      effects: effects(store),
    });
    expect(second.error).toBeNull();
    expect(second.result).toEqual({ sent: true, id: 7 });
    expect(second.logs).not.toContain("RAN");

    // Another key, another effect.
    const other = await executeSandbox({
      ...base,
      payload: { id: 8 },
      code: CODE,
      effects: effects(store),
    });
    expect(other.logs).toContain("RAN");
  }, 60_000);

  test("a failed effect is not recorded as done: the next run executes it again", async () => {
    const store = memoryEffectStore();
    const failed = await executeSandbox({
      ...base,
      payload: { id: 1, fail: true },
      code: CODE,
      effects: effects(store),
    });
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("provider down");

    const retried = await executeSandbox({
      ...base,
      payload: { id: 1 },
      code: CODE,
      effects: effects(store),
    });
    expect(retried.error).toBeNull();
    expect(retried.logs).toContain("RAN");
  }, 60_000);

  test("keys belong to the scope: another action does not share them", async () => {
    const store = memoryEffectStore();
    await executeSandbox({
      ...base,
      payload: { id: 3 },
      code: CODE,
      effects: effects(store, "action:a"),
    });
    const b = await executeSandbox({
      ...base,
      payload: { id: 3 },
      code: CODE,
      effects: effects(store, "action:b"),
    });
    expect(b.logs).toContain("RAN");
  }, 60_000);

  test("code calling the host by hand cannot finish an effect it did not begin", async () => {
    const store = memoryEffectStore();
    const r = await executeSandbox({
      ...base,
      code: `
        const raw = JSON.parse(await __request("effect", JSON.stringify({ phase: "finish", key: "x", ok: true, result: 1 })));
        return raw;
      `,
      effects: effects(store),
    });
    expect(r.result).toEqual({
      ok: false,
      error: 'The effect "x" was not begun by this execution',
    });
  }, 60_000);

  test("without a store the call fails saying why; in a promotion test it works in memory", async () => {
    const without = await executeSandbox({
      ...base,
      payload: { id: 1 },
      code: CODE,
    });
    expect(without.success).toBe(false);
    expect(without.error).toContain("not available here");

    const probe = await executeSandbox({
      ...base,
      payload: { id: 1 },
      code: CODE,
      probe: { fetch: async () => ({ status: 200, headers: {}, body: "" }) },
    });
    expect(probe.error).toBeNull();
    expect(probe.result).toEqual({ sent: true, id: 1 });
  }, 60_000);
});

describe("the host side of the ledger (callEffect)", () => {
  test("busy and unknown come back as errors; retryUnknown takes it over", async () => {
    const answers: Array<"busy" | "unknown" | "run"> = ["busy", "unknown", "run"];
    const seen: Array<{ retryUnknown: boolean; staleAfterMs: number; jobId: string | null }> = [];
    const store: EffectStore = {
      async begin(input) {
        seen.push(input);
        return { decision: answers.shift()!, result: null, attempts: 2 };
      },
      async finish() {},
    };
    const state = effectState(effects(store));
    const busy = await rejection(callEffect({ phase: "begin", key: "k" }, state));
    expect(busy.message).toContain("running in another execution");
    const unknown = await rejection(callEffect({ phase: "begin", key: "k" }, state));
    expect(unknown.message).toContain("may or may not have happened");
    const run = await callEffect({ phase: "begin", key: "k", retryUnknown: true }, state);
    expect(run).toEqual({ decision: "run", attempts: 2 });
    expect(seen[2]).toMatchObject({ retryUnknown: true, staleAfterMs: 600_000, jobId: "run-1" });
  });

  test("keys are validated and a key cannot be begun twice in one execution", async () => {
    const state = effectState(effects(memoryEffectStore()));
    expect((await rejection(callEffect({ phase: "begin", key: "" }, state))).message).toContain(
      "1 to 500"
    );
    expect(
      (await rejection(callEffect({ phase: "begin", key: "k", staleAfterMs: 10 }, state))).message
    ).toContain("staleAfterMs");
    await callEffect({ phase: "begin", key: "k" }, state);
    expect((await rejection(callEffect({ phase: "begin", key: "k" }, state))).message).toContain(
      "already running in this execution"
    );
    await callEffect({ phase: "finish", key: "k", ok: true, result: { a: 1 } }, state);
    // Finished once: a second finish is not this execution's any more.
    expect(
      (await rejection(callEffect({ phase: "finish", key: "k", ok: true }, state))).message
    ).toContain("not begun");
  });

  test("a result too large to keep is recorded as done without it", async () => {
    const finished: unknown[] = [];
    const store: EffectStore = {
      async begin() {
        return { decision: "run", result: null, attempts: 1 };
      },
      async finish(input) {
        finished.push(input.result);
      },
    };
    const state = effectState(effects(store));
    await callEffect({ phase: "begin", key: "big" }, state);
    await callEffect({ phase: "finish", key: "big", ok: true, result: "x".repeat(70_000) }, state);
    expect(finished).toEqual([{ truncated: true }]);
  });
});
