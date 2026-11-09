/**
 * Pub/Sub without Valkey: what is published reaches the subscribers of THIS
 * process (and, via NOTIFY, the other replicas). Before, with Valkey down,
 * `publish` only left a warning and real time went quiet.
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.VALKEY_URL;
  delete process.env.REDIS_URL;
});

const listened = vi.hoisted(() => [] as string[]);
vi.mock("../../apps/api/src/lib/postgres-listen", () => ({
  listen: async (channel: string) => {
    listened.push(channel);
    return async () => {};
  },
}));
// The NOTIFY to other replicas: there is no database here; it is checked that it does not break.
vi.mock("../../apps/api/src/db", () => ({
  db: { execute: async () => ({ rows: [] }) },
  isPgMem: false,
  isLiteMode: false,
}));

const { publish, subscribe, valkeyConfigured } = await import("../../apps/api/src/lib/valkey");

describe("bus without Valkey", () => {
  it("without a URL there is no Valkey configured", () => {
    expect(valkeyConfigured()).toBe(false);
  });

  it("delivers in-process by pattern and listens on the Postgres channel", async () => {
    const receivedValues: Array<[string, string]> = [];
    const remove = await subscribe("table:*", (channel, msg) =>
      receivedValues.push([channel, msg])
    );
    await publish("table:abc", { op: "insert" });
    await publish("entry:xyz", { op: "update" });
    expect(receivedValues).toEqual([["table:abc", JSON.stringify({ op: "insert" })]]);
    expect(listened).toContain("kitsuden_bus");
    await remove();
    await publish("table:abc", { op: "delete" });
    expect(receivedValues).toHaveLength(1);
  });
});
