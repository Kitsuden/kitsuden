/**
 * Request-scoped DI — deterministic tests (no DB).
 * Verifies that resolveExecutor/useRequest respect AsyncLocalStorage and that
 * repo() picks up the scope's tx automatically.
 */

import {
  runInRequestScope,
  useRequest,
  useUser,
  setRequestTx,
  clearRequestTx,
  provideRequestService,
  resolveExecutor,
} from "@kitsuden/engine";
import { describe, it, expect } from "bun:test";

const FALLBACK = { name: "global-db" };
const TX = { name: "rls-tx" };

describe("Request-scoped DI", () => {
  it("resolveExecutor uses the fallback outside a request", () => {
    expect(resolveExecutor(FALLBACK)).toBe(FALLBACK);
    expect(useRequest()).toBeUndefined();
  });

  it("inside the scope, resolveExecutor returns the tx when it is set", () => {
    runInRequestScope({ requestId: "r1" }, () => {
      expect(resolveExecutor(FALLBACK)).toBe(FALLBACK); // still no tx
      setRequestTx(TX);
      expect(resolveExecutor(FALLBACK)).toBe(TX); // now under RLS
      clearRequestTx();
      expect(resolveExecutor(FALLBACK)).toBe(FALLBACK); // released
    });
  });

  it("the scope isolates between concurrent requests (ALS)", async () => {
    const results: string[] = [];
    await Promise.all([
      runInRequestScope({ requestId: "A" }, async () => {
        setRequestTx({ name: "tx-A" });
        await new Promise((r) => setTimeout(r, 5));
        results.push((resolveExecutor(FALLBACK) as any).name);
      }),
      runInRequestScope({ requestId: "B" }, async () => {
        setRequestTx({ name: "tx-B" });
        await new Promise((r) => setTimeout(r, 1));
        results.push((resolveExecutor(FALLBACK) as any).name);
      }),
    ]);
    expect(results.sort()).toEqual(["tx-A", "tx-B"]);
  });

  it("useUser reads the user from the scope", () => {
    runInRequestScope({ user: { id: "u1", role: "admin" } }, () => {
      expect(useUser()?.id).toBe("u1");
    });
    expect(useUser()).toBeNull();
  });

  it("provideRequestService instantiates once per request (scoped singleton)", () => {
    let created = 0;
    runInRequestScope({ services: {} }, () => {
      const a = provideRequestService("svc", () => ({ n: ++created }));
      const b = provideRequestService("svc", () => ({ n: ++created }));
      expect(a).toBe(b); // same instance within the request
      expect(created).toBe(1);
    });
    // Another request → new instance.
    runInRequestScope({ services: {} }, () => {
      provideRequestService("svc", () => ({ n: ++created }));
    });
    expect(created).toBe(2);
  });
});
