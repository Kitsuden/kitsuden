/**
 * Loading a kon (2026-11-20).
 *
 *   - H47: a switched-off kon activated hot had only its MANIFEST's SDK checked;
 *     the SDK its code declares now gets the check startup gives it.
 *   - H49: its code could declare another kon's id and get a context bound to
 *     that id (secrets, events, channels). The code's id must be the installed one.
 *   - H46: startup mounted a kon at any path it declared (`/`, `/api`, `/api/*`),
 *     in front of the whole API. The path must be `/api/<segment>…`, as deferred
 *     kons already had to be.
 */
import { describe, expect, it } from "vitest";

import { deferredKonCodeProblem, konMountPathProblem } from "../../apps/api/src/lib/installed-kons";

describe("activating a deferred kon's code", () => {
  it("H49: refuses code that declares another kon's id", () => {
    expect(deferredKonCodeProblem("kon-blog", "kon-payments", 1, 3)).toMatch(
      /not the installed one/
    );
    expect(deferredKonCodeProblem("kon-blog", undefined, 1, 3)).toMatch(/not the installed one/);
  });

  it("H49: accepts the installed id with or without the prefix", () => {
    expect(deferredKonCodeProblem("kon-blog", "kon-blog", 1, 3)).toBeNull();
    expect(deferredKonCodeProblem("kon-blog", "blog", 1, 3)).toBeNull();
  });

  it("H47: refuses code written for a newer SDK, or with a malformed one", () => {
    expect(deferredKonCodeProblem("kon-blog", "kon-blog", 4, 3)).toMatch(/needs kons SDK v4/);
    expect(deferredKonCodeProblem("kon-blog", "kon-blog", "2", 3)).toMatch(/not an integer/);
    expect(deferredKonCodeProblem("kon-blog", "kon-blog", undefined, 3)).toBeNull();
  });
});

describe("H46: where a kon may be mounted", () => {
  it.each(["/api/blog", "/api/shop/", "/api/custom/kon-x", "/api/v2.alpha_1"])("accepts %s", (p) =>
    expect(konMountPathProblem("kon-x", p)).toBeNull()
  );

  it.each([
    "/",
    "",
    "/api",
    "/api/",
    "api/blog",
    "/api/*",
    "/api/:id",
    "/api/..",
    "/admin/x",
    "/api//x",
    "/api/a b",
  ])("refuses %j", (p) =>
    expect(konMountPathProblem("kon-x", p)).toMatch(/must be \/api\/<segment>/)
  );

  it("refuses a non-string", () => {
    expect(konMountPathProblem("kon-x", 42)).toMatch(/not a string/);
  });
});

describe("H70: ctx.agents.run passes the engine only the KonAgentRun fields", () => {
  it("drops engine-only options a kon slips in, and keeps memory off", async () => {
    const { konAgentRunOptions } = await import("../../apps/api/src/lib/kon-setup");
    const onEvent = () => {};
    const out = konAgentRunOptions({
      agentId: "ag_1",
      message: "hi",
      toolset: "kon:kon-x/read",
      onEvent,
      holdWrites: false,
      enableMemory: true,
      enableBrainSearch: true,
      userId: "admin-1",
    } as never) as Record<string, unknown>;
    expect(out).toMatchObject({
      agentId: "ag_1",
      message: "hi",
      toolset: "kon:kon-x/read",
      onEvent,
      enableMemory: false,
      enableBrainSearch: false,
    });
    expect(out).not.toHaveProperty("holdWrites");
    expect(out).not.toHaveProperty("userId");
    expect(Object.keys(out).sort()).toEqual(
      [
        "agentId",
        "allowedTools",
        "context",
        "enableBrainSearch",
        "enableMemory",
        "history",
        "message",
        "onEvent",
        "sessionId",
        "toolset",
      ].sort()
    );
  });
});
