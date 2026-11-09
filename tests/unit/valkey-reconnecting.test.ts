/**
 * Valkey going down AFTER connecting.
 *
 * The node-redis client stays with `isOpen = true` while it reconnects, and
 * `getValkeyClient()` returned it anyway: each command sat in the wait queue
 * until Valkey came back. Measured in a container: with Valkey
 * stopped, `/api/version` —which uses neither database nor cache, it only goes through the
 * limiter— never answered; bun closed the connection after ~10 s. Neither the limiter's
 * fail-open nor its fail-closed ever got to run.
 */
import { describe, expect, it, vi } from "vitest";

// Valkey CONFIGURED (without a URL no connection is attempted: single-instance mode).
vi.hoisted(() => {
  process.env.VALKEY_URL ??= "redis://localhost:6379";
});

const options: unknown[] = [];
const client = {
  isOpen: false,
  isReady: false,
  on: () => {},
  connect: async () => {
    client.isOpen = true;
    client.isReady = true;
  },
  disconnect: () => Promise.resolve(),
};

vi.mock("../../apps/api/node_modules/redis", () => ({
  createClient: (o: unknown) => {
    options.push(o);
    return client;
  },
}));

describe("getValkeyClient with the connection dropped midway", () => {
  it("with the client reconnecting it rejects immediately instead of returning it", async () => {
    const { getValkeyClient } = await import("../../apps/api/src/lib/valkey");
    expect(await getValkeyClient()).toBe(client);

    // Valkey goes down: the client stays «open» but is no longer ready
    client.isReady = false;
    const t = Date.now();
    await expect(getValkeyClient()).rejects.toThrow(/reconnecting/);
    expect(Date.now() - t).toBeLessThan(100);
    expect(options).toHaveLength(1); // does not open another client on top

    // It comes back: the same client is used
    client.isReady = true;
    expect(await getValkeyClient()).toBe(client);
  });

  it("commands do not wait in a queue while the connection is down", () => {
    expect(options[0]).toMatchObject({ disableOfflineQueue: true });
  });
});
