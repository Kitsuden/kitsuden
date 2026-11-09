/**
 * Rate limiter — behavior when Valkey is not available
 * ============================================================================
 *
 * The limiter FAILS OPEN by default: if Valkey goes down, requests are served anyway. That is
 * right for 99% of routes — serving too much is better than not serving.
 *
 * But for an endpoint that sends mail to unverified addresses, failing
 * open means having no brake at all exactly when you cannot count:
 * an attacker sends unlimited mail from your domain while Redis is
 * down. Those routes set `failClosed: true`.
 *
 * It is checked against the SOURCE instead of running the middleware because
 * `getValkeyClient` opens a real connection and bun's `mock.module` leaks into
 * the whole process (see test-suite-caveats). The goal here is that the
 * fail-closed branch exists and is wired at both failure points.
 */

import { describe, expect, test } from "bun:test";

// `import.meta.dir` and not `new URL(...).pathname`: on Windows the latter
// returns "/C:/..." and the open fails. This file only runs under bun test.
// Normalized: a checkout may have CRLF, and a pattern below includes line ends.
const SOURCE = (await Bun.file(`${import.meta.dir}/../lib/rate-limiter.ts`).text()).replaceAll(
  "\r\n",
  "\n"
);
const LOADER = await Bun.file(`${import.meta.dir}/../lib/module-loader.ts`).text();

describe("rate limiter: fail-closed", () => {
  test("RateLimitConfig exposes the failClosed option", () => {
    expect(SOURCE).toContain("failClosed?: boolean");
  });

  test("by default it still fails OPEN", () => {
    // Changing this would take down the whole API on a Valkey hiccup.
    const defaults = SOURCE.match(/const DEFAULT_CONFIG: RateLimitConfig = \{[^}]+\}/s)?.[0] ?? "";
    expect(defaults).not.toContain("failClosed");
  });

  test("covers BOTH failure paths: no client and an exception", () => {
    // There are two ways to end up without a counter —Valkey does not exist and the
    // operation blows up— and both must respect failClosed. Covering only one
    // leaves the hole open in exactly the rare case.
    const fn = SOURCE.match(/export async function checkRateLimit[\s\S]*?\n\}\n/)?.[0] ?? "";
    const branches = fn.match(/if \(config\.failClosed\) \{\s*return countInMemory\(/g) ?? [];
    expect(branches.length).toBe(2);
  });

  test("getValkeyClient() goes INSIDE a try (it throws when Valkey is down)", () => {
    // Outside the try, the exception reached the middleware's catch —which lets
    // the request through— and failClosed routes failed open. The real behavior
    // is tested in tests/unit/rate-limiter-valkey-down.test.ts (vitest).
    const fn = SOURCE.match(/export async function checkRateLimit[\s\S]*?\n\}\n/)?.[0] ?? "";
    expect(fn).toMatch(/try \{\s*valkey = await getValkeyClient\(\);/);
    expect(fn).not.toMatch(/const valkey = await getValkeyClient\(\);/);
  });

  test("with no possible counter, the response is 503 with Retry-After (not 429 or 500)", () => {
    const fn = SOURCE.match(/function withoutCounter[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain("Retry-After");
    expect(fn).toContain("503");
  });
});

describe("rate limits declared by kons", () => {
  test("the loader mounts the kon's limits BEFORE the router", () => {
    // In Hono the middleware only runs if it was registered before the route it
    // protects. Reversing the order leaves the limits decorative.
    const applyAt = LOADER.indexOf("applyKonRateLimits(app, konDef, finalMountPath)");
    const routeAt = LOADER.indexOf("app.route(finalMountPath, router)");

    expect(applyAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(-1);
    expect(applyAt).toBeLessThan(routeAt);
  });

  test("the kon's routes are resolved against its mountPath", () => {
    // A kon declares relative routes: if the loader used them as is, the
    // limit would hang at the root and protect nothing.
    const fn = LOADER.match(/export function applyKonRateLimits[\s\S]{0,900}/)?.[0] ?? "";
    expect(fn).toContain("mountPath.replace");
    expect(fn).toContain("`${base}");
  });

  test("propagates the kon's failClosed to the middleware", () => {
    const fn = LOADER.match(/export function applyKonRateLimits[\s\S]{0,900}/)?.[0] ?? "";
    expect(fn).toContain("failClosed: rule.failClosed");
  });
});
