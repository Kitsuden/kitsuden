/**
 * Regression tests for the security review of 2026-11-03: what can be checked
 * without a database. The routes and MCP tools are covered in
 * apps/api/src/tests/security-review-2026-11-03.test.ts.
 */
import { scanCode } from "@kitsuden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// webhook_out sends through pinnedFetch (lib/safe-fetch.ts): the outbound calls
// are recorded here instead of leaving the machine.
const outbound = vi.hoisted(() => ({
  calls: [] as { url: string; init: Record<string, unknown> }[],
}));
vi.mock("../../apps/api/src/lib/safe-fetch", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/lib/safe-fetch")>()),
  pinnedFetch: vi.fn(async (url: string, init: Record<string, unknown>) => {
    outbound.calls.push({ url: String(url), init });
    throw new Error("down");
  }),
}));

vi.mock("../../apps/api/src/lib/valkey", () => ({
  valkeyConfigured: () => false,
  getValkeyClient: () => Promise.reject(new Error("no Valkey in this test")),
}));

const { webhookTargetProblem, executeWebhookOutAction } =
  await import("../../apps/api/src/lib/actions/handlers/webhook-out-handler");
const { requestFromArguments } = await import("../../apps/api/src/lib/operations-openapi");

// ── webhook_out: no internal targets ────────────────────────────────────────

describe("webhook_out targets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KITSUDEN_WEBHOOK_ALLOW_INTERNAL;
  });

  it("refuses internal addresses, other protocols and credentials", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:3001/api/health",
      "http://[::1]/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost/",
    ]) {
      expect(await webhookTargetProblem(url), url).toMatch(/non-public|resolved/);
    }
    expect(await webhookTargetProblem("file:///etc/passwd")).toMatch(/Protocol/);
    expect(await webhookTargetProblem("https://u:p@93.184.215.14/")).toMatch(/Credentials/);
    expect(await webhookTargetProblem("not a url")).toMatch(/Invalid/);
  });

  it("lets a public address through, and the opt-in lets an internal one", async () => {
    expect(await webhookTargetProblem("https://93.184.215.14/hook")).toBeNull();
    process.env.KITSUDEN_WEBHOOK_ALLOW_INTERNAL = "true";
    expect(await webhookTargetProblem("http://127.0.0.1/hook")).toBeNull();
  });

  it("never calls out for an internal target", async () => {
    outbound.calls.length = 0;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await executeWebhookOutAction(
      { config: { url: "http://169.254.169.254/" } } as never,
      { actionId: "a", actionName: "n", executionId: "e" } as never
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outbound.calls.length).toBe(0);
  });

  it("sends through the pinned fetch (no redirects), caps retries and drops reserved headers", async () => {
    outbound.calls.length = 0;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await executeWebhookOutAction(
      {
        config: {
          url: "https://93.184.215.14/hook",
          headers: { Host: "internal", "X-Ok": "1", "X-Bad": "a\r\nInjected: 1" },
          retryPolicy: { maxRetries: 1_000_000, backoffMs: 0 },
        },
      } as never,
      { actionId: "a", actionName: "n", executionId: "e" } as never
    );
    expect(result.success).toBe(false);
    // Never the global fetch: it would resolve the name again (DNS rebinding)
    expect(fetchSpy).not.toHaveBeenCalled();
    const calls = outbound.calls.map((c) => c.init);
    expect(calls.length).toBe(6); // 1 + at most 5 retries
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.Host).toBeUndefined();
    expect(headers["X-Bad"]).toBeUndefined();
    expect(headers["X-Ok"]).toBe("1");
  });
});

// ── MCP operation tools: path parameters ────────────────────────────────────

describe("path parameters of an operation tool", () => {
  const op = { method: "GET", route: "/things/:id/children" } as never;

  it("refuses dot segments, which would re-route the call", () => {
    expect(() => requestFromArguments("/api/k", op, { id: ".." })).toThrow(/Invalid argument/);
    expect(() => requestFromArguments("/api/k", op, { id: "." })).toThrow(/Invalid argument/);
  });

  it("encodes the rest", () => {
    const r = requestFromArguments("/api/k", op, { id: "a/../b" });
    expect(r.url).toContain("/api/k/things/a%2F..%2Fb/children");
  });
});

// ── Promotion scanner: string escapes ───────────────────────────────────────

describe("scanner string escapes", () => {
  it("reads \\u and \\x escapes in API paths as QuickJS runs them", () => {
    const paths = (code: string) => scanCode(code).apiCalls.map((c) => c.path);
    expect(paths('await kitsuden.api.post("/api/\\u0061dmin/x", {});')).toEqual(["/api/admin/x"]);
    expect(paths('await kitsuden.api.post("/api/\\x61dmin/x", {});')).toEqual(["/api/admin/x"]);
    expect(paths('await kitsuden.api.post("/api/\\u{61}dmin/x", {});')).toEqual(["/api/admin/x"]);
    expect(paths("await kitsuden.api.post(`/api/\\u0061dmin/x`, {});")).toEqual(["/api/admin/x"]);
  });

  it("keeps the usual escapes", () => {
    const paths = (code: string) => scanCode(code).apiCalls.map((c) => c.path);
    expect(paths("await kitsuden.api.get('/api/it\\'s');")).toEqual(["/api/it's"]);
  });
});
