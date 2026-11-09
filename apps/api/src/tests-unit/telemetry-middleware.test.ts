/**
 * Telemetry middleware — integration on a minimal Hono app (no DB).
 * Verifies that the 5 practices are applied per request end to end.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";

import { getMetricsSnapshot, resetMetrics } from "../lib/metrics";
import { requestContextMiddleware, accessLogAndMetrics } from "../middleware/telemetry";

function makeApp() {
  const app = new Hono();
  app.use("*", requestContextMiddleware());
  app.use("*", accessLogAndMetrics());
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/notfound", (c) => c.json({ error: "nope" }, 404));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  return app;
}

describe("Telemetry middleware (end-to-end)", () => {
  beforeEach(() => resetMetrics());

  it("responds with a W3C traceparent and x-trace-id", async () => {
    const res = await makeApp().request("http://x/ok");
    expect(res.status).toBe(200);
    const tp = res.headers.get("traceparent");
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(res.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("continues an incoming trace (same trace_id)", async () => {
    const res = await makeApp().request("http://x/ok", {
      headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
    });
    expect(res.headers.get("traceparent")).toContain("0af7651916cd43dd8448eb211c80319c");
  });

  it("records real metrics: success, 4xx and 5xx (throw → 500)", async () => {
    const app = makeApp();
    await app.request("http://x/ok");
    await app.request("http://x/notfound");
    try {
      await app.request("http://x/boom");
    } catch {
      // the throw propagates; the middleware's finally already recorded the 500
    }

    const snap = getMetricsSnapshot();
    expect(snap.total).toBe(3);
    expect(snap.serverErrors).toBe(1);
    expect(snap.clientErrors).toBe(1);
    expect(snap.successRate).toBeCloseTo(2 / 3, 5);
  });
});
