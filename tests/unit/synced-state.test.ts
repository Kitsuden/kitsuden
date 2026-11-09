/**
 * Synced State — the replicant-style primitive
 * ============================================================================
 *
 * What is pinned down here is the contract a live overlay depends on:
 * that it broadcasts, that it persists by grouping bursts, and above all that a
 * late message NEVER overwrites a newer state.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  createMemoryStateStore,
  defineSyncedState,
  getSyncedState,
  resetSyncedState,
  setStateStore,
  setStateTransport,
  stateChannel,
  type SyncedStateMessage,
} from "../../packages/engine/src/state";

type Score = { a: number; b: number; round?: string };

function fakeTransport() {
  const sent: { channel: string; message: SyncedStateMessage }[] = [];
  return {
    sent,
    broadcast(channel: string, message: unknown) {
      sent.push({ channel, message: message as SyncedStateMessage });
    },
  };
}

afterEach(() => {
  resetSyncedState();
});

describe("declaration", () => {
  test("the same key returns the SAME instance", () => {
    const a = defineSyncedState<Score>("m:1", { default: { a: 0, b: 0 } });
    const b = defineSyncedState<Score>("m:1", { default: { a: 9, b: 9 } });
    // Two modules talking about the same scoreboard cannot end up with two copies.
    expect(b).toBe(a);
    expect(b.get()).toEqual({ a: 0, b: 0 });
    expect(getSyncedState<Score>("m:1")).toBe(a);
  });

  test("the channel carries a prefix so the authorizer can match it", () => {
    const s = defineSyncedState<Score>("broadcast:match:42", { default: { a: 0, b: 0 } });
    expect(s.channel).toBe("state:broadcast:match:42");
    expect(stateChannel("broadcast:match:42")).toBe(s.channel);
  });
});

describe("mutation and broadcast", () => {
  test("set increments the revision and broadcasts the new value", async () => {
    const t = fakeTransport();
    setStateTransport(t);
    const s = defineSyncedState<Score>("m:2", { default: { a: 0, b: 0 }, persist: false });

    expect(s.revision).toBe(0);
    await s.set({ a: 1, b: 0 });

    expect(s.revision).toBe(1);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].channel).toBe("state:m:2");
    expect(t.sent[0].message).toEqual({
      type: "state:sync",
      key: "m:2",
      revision: 1,
      value: { a: 1, b: 0 },
    });
  });

  test("patch merges and does not lose the keys it does not touch", async () => {
    const s = defineSyncedState<Score>("m:3", {
      default: { a: 0, b: 0, round: "Winners" },
      persist: false,
    });
    await s.patch({ a: 2 });
    expect(s.get()).toEqual({ a: 2, b: 0, round: "Winners" });
  });

  test("subscribers receive every change", async () => {
    const s = defineSyncedState<Score>("m:4", { default: { a: 0, b: 0 }, persist: false });
    const seen: number[] = [];
    const off = s.subscribe((v) => seen.push(v.a));

    await s.set({ a: 1, b: 0 });
    await s.set({ a: 2, b: 0 });
    off();
    await s.set({ a: 3, b: 0 });

    expect(seen).toEqual([1, 2]); // after unsubscribing nothing arrives any more
  });

  test("a subscriber that blows up does not take down the others", async () => {
    const s = defineSyncedState<Score>("m:5", { default: { a: 0, b: 0 }, persist: false });
    s.subscribe(() => {
      throw new Error("broken panel");
    });
    const seen: number[] = [];
    s.subscribe((v) => seen.push(v.a));

    await s.set({ a: 7, b: 0 });
    expect(seen).toEqual([7]);
  });
});

describe("remote messages — the defense against reordering", () => {
  test("applies a newer message", () => {
    const s = defineSyncedState<Score>("m:6", { default: { a: 0, b: 0 }, persist: false });
    const applied = s.applyRemote({
      type: "state:sync",
      key: "m:6",
      revision: 5,
      value: { a: 3, b: 1 },
    });
    expect(applied).toBe(true);
    expect(s.get()).toEqual({ a: 3, b: 1 });
    expect(s.revision).toBe(5);
  });

  test("DISCARDS a late message instead of overwriting the state", async () => {
    const s = defineSyncedState<Score>("m:7", { default: { a: 0, b: 0 }, persist: false });
    await s.set({ a: 5, b: 5 }); // revision 1

    // A message from an earlier revision arrives late: WS reconnection, bad
    // network at the tournament. Applying it would send the scoreboard back LIVE.
    const applied = s.applyRemote({
      type: "state:sync",
      key: "m:7",
      revision: 1,
      value: { a: 0, b: 0 },
    });

    expect(applied).toBe(false);
    expect(s.get()).toEqual({ a: 5, b: 5 });
  });

  test("ignores messages with another key", () => {
    const s = defineSyncedState<Score>("m:8", { default: { a: 0, b: 0 }, persist: false });
    expect(
      s.applyRemote({ type: "state:sync", key: "other", revision: 99, value: { a: 1, b: 1 } })
    ).toBe(false);
    expect(s.get()).toEqual({ a: 0, b: 0 });
  });

  test("a payload that does not validate is rejected and the good value is kept", async () => {
    const s = defineSyncedState<Score>("m:9", {
      default: { a: 0, b: 0 },
      persist: false,
      validate: (v: any) => {
        if (typeof v?.a !== "number") throw new Error("invalid");
        return v as Score;
      },
    });
    await s.set({ a: 4, b: 2 });

    const applied = s.applyRemote({
      type: "state:sync",
      key: "m:9",
      revision: 99,
      value: { a: "I am not a number" },
    });

    expect(applied).toBe(false);
    expect(s.get()).toEqual({ a: 4, b: 2 });
  });
});

describe("persistence", () => {
  test("hydrates from the store and respects its revision", async () => {
    const store = createMemoryStateStore();
    await store.write("m:10", { a: 3, b: 1 }, 12);
    setStateStore(store);

    const s = defineSyncedState<Score>("m:10", { default: { a: 0, b: 0 } });
    await s.hydrate();

    expect(s.get()).toEqual({ a: 3, b: 1 });
    expect(s.revision).toBe(12);
  });

  test("writes to the store on mutation", async () => {
    const store = createMemoryStateStore();
    setStateStore(store);
    const s = defineSyncedState<Score>("m:11", {
      default: { a: 0, b: 0 },
      persistDebounceMs: 0,
    });

    await s.set({ a: 1, b: 0 });
    await s.flush();

    expect(await store.read("m:11")).toEqual({ value: { a: 1, b: 0 }, revision: 1 });
  });

  test("groups a burst into ONE single write", async () => {
    let writes = 0;
    setStateStore({
      async read() {
        return null;
      },
      async write() {
        writes++;
      },
    });
    const s = defineSyncedState<Score>("m:12", { default: { a: 0, b: 0 }, persistDebounceMs: 50 });

    // Five presses of `+` in a row cannot be five writes.
    for (let i = 1; i <= 5; i++) await s.set({ a: i, b: 0 });
    await s.flush();

    expect(writes).toBe(1);
    expect(s.get()).toEqual({ a: 5, b: 0 });
  });

  test("persist:false does not touch the store", async () => {
    const store = createMemoryStateStore();
    setStateStore(store);
    const s = defineSyncedState<Score>("m:13", {
      default: { a: 0, b: 0 },
      persist: false,
      persistDebounceMs: 0,
    });
    await s.set({ a: 1, b: 1 });
    await s.flush();
    expect(await store.read("m:13")).toBeNull();
  });
});

describe("degradation — an overlay never goes down because of the infrastructure", () => {
  test("without transport or store it keeps working in memory", async () => {
    const s = defineSyncedState<Score>("m:14", { default: { a: 0, b: 0 } });
    await s.set({ a: 2, b: 2 });
    expect(s.get()).toEqual({ a: 2, b: 2 });
    expect(s.revision).toBe(1);
  });

  test("a transport that throws does not break the mutation", async () => {
    setStateTransport({
      broadcast() {
        throw new Error("valkey down");
      },
    });
    const s = defineSyncedState<Score>("m:15", { default: { a: 0, b: 0 }, persist: false });
    await s.set({ a: 1, b: 1 });
    expect(s.get()).toEqual({ a: 1, b: 1 });
  });

  test("a store that throws on hydration leaves the default", async () => {
    setStateStore({
      async read() {
        throw new Error("postgres down");
      },
      async write() {},
    });
    const s = defineSyncedState<Score>("m:16", { default: { a: 0, b: 0 } });
    await s.hydrate();
    expect(s.get()).toEqual({ a: 0, b: 0 });
  });

  test("toMessage gives the snapshot for a client that has just connected", async () => {
    const s = defineSyncedState<Score>("m:17", { default: { a: 0, b: 0 }, persist: false });
    await s.set({ a: 3, b: 2 });
    expect(s.toMessage()).toEqual({
      type: "state:sync",
      key: "m:17",
      revision: 1,
      value: { a: 3, b: 2 },
    });
  });
});
