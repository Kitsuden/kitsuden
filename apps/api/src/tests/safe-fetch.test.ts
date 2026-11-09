/**
 * Outbound calls connect to the address they checked (DNS rebinding)
 * ============================================================================
 *
 * Security review 2026-11-03: the sandbox `fetch`, `webhook_out`, the CIMD
 * fetch and the agent notifications resolved the name, checked it, and then
 * `fetch` resolved it AGAIN. A rebinding name answers a public address to the
 * check and an internal one to the connection. `pinnedFetch` resolves once and
 * connects only to what it checked.
 *
 * DNS is replaced (`setResolverForTests`); the "internal service" is a local
 * server that must never receive the rebinding request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { webhookTargetProblem } from "../lib/actions/handlers/webhook-out-handler";
import { pinnedFetch, setResolverForTests, UnsafeTargetError } from "../lib/safe-fetch";
import { requirePublicHost } from "../lib/worker-sandbox";

let hits = 0;
let lastHost: string | null = null;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits++;
      lastHost = req.headers.get("host");
      return new Response("internal secret", { headers: { "x-internal": "1" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  setResolverForTests(null);
  hits = 0;
  lastHost = null;
});

describe("pinnedFetch", () => {
  it("a name that rebinds between the check and the connection never reaches the internal address", async () => {
    let calls = 0;
    // 1st answer public (TEST-NET-3, unroutable), any later one: the internal server
    setResolverForTests(async () => {
      calls++;
      return calls === 1
        ? [{ address: "203.0.113.10", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    });
    let failed = false;
    try {
      await pinnedFetch(`http://rebind.test:${server.port}/latest/meta-data`, { timeoutMs: 1500 });
    } catch {
      failed = true; // it tried 203.0.113.10, which does not answer
    }
    expect(failed).toBe(true);
    expect(calls).toBe(1);
    expect(hits).toBe(0);
  }, 20_000);

  it("connects to exactly the checked address, with the real name as Host", async () => {
    setResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const res = await pinnedFetch(`http://pinned.test:${server.port}/x?y=1`, {
      allowInternal: true,
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-internal")).toBe("1");
    expect(await res.text()).toBe("internal secret");
    expect(lastHost).toBe(`pinned.test:${server.port}`);
  });

  it("refuses a name with any non-public address unless the caller opted in", async () => {
    setResolverForTests(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    let error: unknown = null;
    try {
      await pinnedFetch("http://mixed.test/");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect((error as UnsafeTargetError).reason).toBe("non_public");
    // An IP literal is checked too
    error = null;
    try {
      await pinnedFetch(`http://127.0.0.1:${server.port}/`);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect(hits).toBe(0);
  });

  it("does not follow redirects", async () => {
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    try {
      setResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
      const res = await pinnedFetch(`http://redirect.test:${redirector.port}/`, {
        allowInternal: true,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://169.254.169.254/");
    } finally {
      redirector.stop(true);
    }
  });
});

describe("the callers use the same resolver", () => {
  it("sandbox fetch and webhook_out refuse an internal resolution", async () => {
    setResolverForTests(async () => [{ address: "10.0.0.5", family: 4 }]);
    let sandbox: unknown = null;
    try {
      await requirePublicHost("internal.test");
    } catch (e) {
      sandbox = e;
    }
    expect(String((sandbox as Error)?.message)).toContain("non-public");
    expect(await webhookTargetProblem("https://internal.test/hook")).toContain("non-public");
  });
});
