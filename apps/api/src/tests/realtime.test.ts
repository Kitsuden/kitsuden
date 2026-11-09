/**
 * Kitsuden — Real-time Test Suite
 *
 * Tests WebSocket connection, channel subscription, ping/pong,
 * presence system, and error handling.
 */

import { describe, it, expect, beforeAll } from "bun:test";

const WS_URL = process.env.WS_URL || "ws://localhost:3001/api/realtime";
let wsAvailable = false;

describe("Real-time WebSocket", () => {
  beforeAll(async () => {
    // Quick check if WebSocket server is available
    const ws = new WebSocket(WS_URL);
    wsAvailable = await Promise.race([
      new Promise<boolean>((resolve) => {
        ws.onopen = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          ws.close();
          resolve(false);
        }, 1000)
      ),
    ]);
  });
  it("should connect to WebSocket server", async () => {
    if (!wsAvailable) {
      console.log("⏭️ Skipping WebSocket tests — server not available");
      return;
    }
    const ws = new WebSocket(WS_URL);

    const result = await Promise.race([
      new Promise<boolean>((resolve) => {
        ws.onopen = () => {
          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data as string);
              if (msg.type === "connected" && msg.clientId) {
                ws.close();
                resolve(true);
              }
            } catch {
              ws.close();
              resolve(false);
            }
          };
        };
        ws.onerror = () => {
          resolve(false);
        };
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000)
      ),
    ]);

    expect(result).toBe(true);
  });

  it("an anonymous client can NOT subscribe to a channel", async () => {
    /**
     * This test asserted the opposite —that subscribing worked— and for
     * that reason had been red for a while: it described the behavior from BEFORE
     * `subscribeToChannel` authorized.
     *
     * Back then only the FORMAT of the channel was validated, so anyone with
     * an open connection could listen to changes on any table. Today
     * the authorizer denies by default except for admin, and that is exactly what
     * must be upheld: a test that demands the failure come back is worse than
     * none.
     *
     * Subscription WITH permission is covered in the authorizer's tests, which
     * do not need a running server.
     */
    if (!wsAvailable) return;
    const ws = new WebSocket(WS_URL);

    const response = await Promise.race([
      new Promise<string>((resolve) => {
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "connected") {
            ws.send(JSON.stringify({ type: "subscribe", channel: "table:test-dataset" }));
            return;
          }
          ws.close();
          resolve(msg.type as string);
        };
        ws.onerror = () => resolve("error");
      }),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          ws.close();
          resolve("timeout");
        }, 3000)
      ),
    ]);

    expect(response).toBe("error");
  });

  it("should handle ping/pong heartbeat", async () => {
    if (!wsAvailable) return;
    const ws = new WebSocket(WS_URL);

    const result = await Promise.race([
      new Promise<boolean>((resolve) => {
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "connected") {
            ws.send(JSON.stringify({ type: "ping" }));
          }
          if (msg.type === "pong" && msg.timestamp) {
            ws.close();
            resolve(true);
          }
        };
        ws.onerror = () => resolve(false);
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000)
      ),
    ]);

    expect(result).toBe(true);
  });

  it("presence: without a session you cannot enter a room (audit)", async () => {
    if (!wsAvailable) return;
    const ws = new WebSocket(WS_URL);

    // Before, anyone who opened the socket entered any room and saw
    // who was there. Now an anonymous user gets an error and no list.
    const result = await Promise.race([
      new Promise<boolean>((resolve) => {
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "connected") {
            ws.send(JSON.stringify({ type: "presence:join", room: "test-room" }));
          }
          if (msg.type === "presence") {
            ws.close();
            resolve(false);
          }
          if (msg.type === "error" && String(msg.message ?? msg.error ?? "").includes("Presence")) {
            ws.close();
            resolve(true);
          }
        };
        ws.onerror = () => resolve(false);
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000)
      ),
    ]);

    expect(result).toBe(true);
  });

  it("should handle invalid JSON gracefully", async () => {
    if (!wsAvailable) return;
    const ws = new WebSocket(WS_URL);

    const result = await Promise.race([
      new Promise<boolean>((resolve) => {
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "connected") {
            ws.send("not valid json {{{");
          }
          if (msg.type === "error") {
            ws.close();
            resolve(true);
          }
        };
        ws.onerror = () => resolve(false);
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000)
      ),
    ]);

    expect(result).toBe(true);
  });
});
