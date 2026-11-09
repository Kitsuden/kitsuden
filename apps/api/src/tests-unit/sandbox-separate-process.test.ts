/**
 * Code actions: separate process, without the API's secrets
 * ============================================================================
 *
 * Audit: the sandbox was a Worker in the same process and the action's code
 * read `globalThis.process.env` (all the secrets) and launched
 * commands. It now runs in a child process with an empty environment, with a
 * time limit, and in production it ships disabled unless `ENABLE_CODE_ACTIONS=true`.
 * The code now also runs inside QuickJS (WASM): the attack tests
 * are in hostile-sandbox.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { enabledCodeActions, executeSandbox } from "../lib/worker-sandbox";

const base = { payload: { hello: "world" }, envVars: {}, timeoutMs: 5000, memoryLimitMb: 64 };
const nodeEnv = process.env.NODE_ENV;
const previousSwitch = process.env.ENABLE_CODE_ACTIONS;

afterEach(() => {
  process.env.NODE_ENV = nodeEnv;
  if (previousSwitch === undefined) delete process.env.ENABLE_CODE_ACTIONS;
  else process.env.ENABLE_CODE_ACTIONS = previousSwitch;
});

describe("code actions sandbox", () => {
  test("returns the result and the event arrives", async () => {
    const r = await executeSandbox({
      ...base,
      code: "console.log('x'); return { echo: event.hello, n: 1 + 1 };",
    });
    expect(r.error).toBeNull();
    expect(r.result).toEqual({ echo: "world", n: 2 });
    expect(r.logs).toContain("[LOG] x");
  });

  test("the API process's secrets do not reach the code", async () => {
    process.env.SANDBOX_TEST_SECRET = "must-not-show";
    try {
      const r = await executeSandbox({
        ...base,
        envVars: { DECLARED: "yes" },
        // There is not even a `process` anymore (QuickJS): see hostile-sandbox.test.ts.
        code: "return { hasProcess: typeof globalThis.process !== 'undefined', env };",
      });
      expect(JSON.stringify(r.result)).not.toContain("must-not-show");
      expect(JSON.stringify(r.result)).not.toContain("DATABASE_URL");
      expect((r.result as { env: Record<string, string> }).env.DECLARED).toBe("yes");
      expect((r.result as { hasProcess: boolean }).hasProcess).toBe(false);
    } finally {
      delete process.env.SANDBOX_TEST_SECRET;
    }
  });

  test("an infinite loop is cut off by time", async () => {
    const r = await executeSandbox({ ...base, timeoutMs: 800, code: "while (true) {}" });
    expect(r.exitReason).toBe("timeout");
  });

  test("in production it ships disabled unless ENABLE_CODE_ACTIONS=true", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENABLE_CODE_ACTIONS;
    expect(enabledCodeActions()).toBe(false);
    const r = await executeSandbox({ ...base, code: "return 1;" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("ENABLE_CODE_ACTIONS");
    process.env.ENABLE_CODE_ACTIONS = "true";
    expect(enabledCodeActions()).toBe(true);
  });
});
