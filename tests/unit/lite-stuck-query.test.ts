/**
 * Lite mode: a statement stuck behind PGlite's single connection is logged with the stack that started it,
 * instead of the API hanging in silence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", async (importOriginal) => importOriginal());

const { watchLiteConnection, LITE_STUCK_MS } = await import("../../apps/api/src/db");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("watchLiteConnection", () => {
  it("logs a statement that waits too long, once, and never one that finishes", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    const client = {
      query: vi.fn(() => new Promise((r) => (release = () => r({ rows: [] })))),
      exec: vi.fn(async () => []),
      transaction: vi.fn(async () => undefined),
    };
    watchLiteConnection(client as never);

    await client.exec("SELECT 1");
    const stuck = client.query("SELECT * FROM koe_members");
    await vi.advanceTimersByTimeAsync(LITE_STUCK_MS - 1);
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(
      /only connection[\s\S]*SELECT \* FROM koe_members/
    );
    release();
    await stuck;
    await vi.advanceTimersByTimeAsync(LITE_STUCK_MS * 2);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
