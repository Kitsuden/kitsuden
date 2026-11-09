/**
 * A down Valkey cannot cost one timeout per call.
 *
 * Every `getValkeyClient()` opened a new client and waited ~2 s for it to
 * fail; a request goes through several calls (limiter, cache, session) and,
 * measured in a container with Valkey stopped, `/api/*` exceeded bun's
 * idleTimeout: the connection was closed WITHOUT a response (neither 429 nor 503). Now after a
 * failure it rejects immediately for a few seconds and simultaneous attempts
 * share the same in-flight connection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Valkey CONFIGURED (without a URL no connection is attempted: single-instance mode).
vi.hoisted(() => {
  process.env.VALKEY_URL ??= "redis://localhost:6379";
});

const createdAll: number[] = [];

// `redis` is a dependency of apps/api, not of the root: it is mocked by its path.
vi.mock("../../apps/api/node_modules/redis", () => ({
  createClient: () => {
    createdAll.push(Date.now());
    return {
      isOpen: false,
      on: () => {},
      // Never connects: like a host that does not answer.
      connect: () => new Promise(() => {}),
      disconnect: () => Promise.resolve(),
    };
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("getValkeyClient with Valkey down", () => {
  it("simultaneous calls share ONE attempt, and after failing it rejects immediately", async () => {
    vi.useFakeTimers();
    const { getValkeyClient } = await import("../../apps/api/src/lib/valkey");

    const a = getValkeyClient();
    const b = getValkeyClient();
    const failures = Promise.allSettled([a, b]);
    await vi.advanceTimersByTimeAsync(2_100);
    const [ra, rb] = await failures;
    expect(ra.status).toBe("rejected");
    expect(rb.status).toBe("rejected");
    expect(createdAll).toHaveLength(1);

    // Inside the window: no new client and no waiting for the timeout.
    await expect(getValkeyClient()).rejects.toThrow(/recent connection failure/);
    expect(createdAll).toHaveLength(1);

    // After the window it tries again.
    await vi.advanceTimersByTimeAsync(5_100);
    const other = getValkeyClient();
    const result = Promise.allSettled([other]);
    await vi.advanceTimersByTimeAsync(2_100);
    await result;
    expect(createdAll).toHaveLength(2);
  });
});
