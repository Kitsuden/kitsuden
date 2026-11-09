import { describe, it, expect } from "bun:test";

import { events, hooks } from "../lib/events";

describe("events", () => {
  it("events and hooks are the same instance", () => {
    expect(events).toBe(hooks);
  });

  it("can emit and listen to events", async () => {
    let received: any = null;
    events.once("test-event", (data) => {
      received = data;
    });
    events.emit("test-event", { foo: "bar" });
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual({ foo: "bar" });
  });

  it("has max listeners set to 20", () => {
    expect(events.getMaxListeners()).toBe(20);
  });
});
