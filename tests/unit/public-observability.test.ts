/**
 * What observability shows without a session.
 *
 * `GET /` returned to anyone counts of users/entries/agents and the recent
 * activity (entry titles, names), with no request limit
 * and running several COUNTs. `GET /metrics` was public.
 */
import { afterEach, describe, expect, it } from "vitest";

import { observabilityRoutes, validMetricsToken } from "../../apps/api/src/lib/observability";

const before = process.env.METRICS_TOKEN;
afterEach(() => {
  if (before === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = before;
});

describe("observability without a session", () => {
  it("GET / only says it is alive", async () => {
    const res = await observabilityRoutes.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Kitsuden API", status: "ok" });
  });

  it("GET /metrics without token or session: 401", async () => {
    delete process.env.METRICS_TOKEN;
    expect((await observabilityRoutes.request("/metrics")).status).toBe(401);
  });

  it("GET /admin/logs without a session: 401", async () => {
    expect((await observabilityRoutes.request("/admin/logs")).status).toBe(401);
  });
});

describe("validMetricsToken", () => {
  it("without METRICS_TOKEN (or too short) it never works", () => {
    delete process.env.METRICS_TOKEN;
    expect(validMetricsToken("Bearer anything")).toBe(false);
    process.env.METRICS_TOKEN = "short";
    expect(validMetricsToken("Bearer short")).toBe(false);
  });

  it("only the exact token, with Bearer", () => {
    process.env.METRICS_TOKEN = "long-metrics-token-1234";
    expect(validMetricsToken("Bearer long-metrics-token-1234")).toBe(true);
    expect(validMetricsToken("Bearer long-metrics-token-123")).toBe(false);
    expect(validMetricsToken("long-metrics-token-1234")).toBe(false);
    expect(validMetricsToken(undefined)).toBe(false);
  });
});

describe("index.ts: what comes out without a session", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const source = fs.readFileSync(path.resolve(__dirname, "../../apps/api/src/index.ts"), "utf8");
  const store = fs.readFileSync(path.resolve(__dirname, "../../apps/api/src/lib/store.ts"), "utf8");

  it("/media comes out with CSP sandbox (an uploaded .svg/.html does not run on the API's origin)", () => {
    expect(store).toMatch(/MEDIA_CSP\s*=\s*\n?\s*"default-src 'none';[^"]*sandbox"/);
    expect(source).toContain('"Content-Security-Policy": MEDIA_CSP');
  });

  it("public health checks do not return the error message", () => {
    const health = source.slice(
      source.indexOf('app.get("/api/health"'),
      source.indexOf("// 🎛️ HEADLESS MODE")
    );
    expect(health).not.toMatch(/error: messageOf\(err\)/);
  });

  it("the WebSocket checks Origin against ALLOWED_ORIGINS", () => {
    expect(source).toMatch(/origin && !corsConfig\.origins\.includes\(origin\)/);
  });

  it("the legacy kitsuden_sk_ keys no longer get in (removed)", () => {
    expect(source).toContain("Date.now() >= LEGACY_KEYS_END");
  });
});
