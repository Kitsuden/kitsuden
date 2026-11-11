import { describe, expect, it } from "vitest";

import { nextPendingAfter } from "./approvals-next";

const p = (id: string, status = "pending") => ({ id, status });

describe("nextPendingAfter", () => {
  it("moves to the proposal below the one decided", () => {
    expect(nextPendingAfter([p("a"), p("b"), p("c")], "a")).toBe("b");
    expect(nextPendingAfter([p("a"), p("b"), p("c")], "b")).toBe("c");
  });

  it("at the end of the list it goes to the closest one above", () => {
    expect(nextPendingAfter([p("a"), p("b"), p("c")], "c")).toBe("b");
  });

  it("skips proposals that are not waiting", () => {
    const list = [p("a"), p("b", "executed"), p("c", "rejected"), p("d")];
    expect(nextPendingAfter(list, "a")).toBe("d");
    expect(nextPendingAfter(list, "d")).toBe("a");
  });

  it("is null when the queue is done", () => {
    expect(nextPendingAfter([p("a")], "a")).toBeNull();
    expect(nextPendingAfter([p("a"), p("b", "failed")], "a")).toBeNull();
    expect(nextPendingAfter([], "a")).toBeNull();
  });

  it("a proposal opened from a link (not in the list) goes to the first pending one", () => {
    expect(nextPendingAfter([p("a", "executed"), p("b")], "zz")).toBe("b");
  });
});
