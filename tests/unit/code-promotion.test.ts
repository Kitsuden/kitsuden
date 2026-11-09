/**
 * The pure contract of code promotion: the local scan, the
 * capability diff, what touches secrets/users/security, the decision
 * table and the configuration. No database or network.
 */

import {
  DEFAULT_PROMOTION_CONFIG,
  capabilitiesOf,
  decidePromotion,
  capabilitiesDiff,
  scanCode,
  mergePromotionConfig,
  hostCovers,
  readPromotionConfig,
  FALLBACK_REASONS,
  secretName,
  pathTouch,
  scopeTouch,
  type DecisionInput,
} from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

const rules = (code: string, fetchAllow: string[] = []) =>
  scanCode(code, { fetchAllow }).findings.map((h) => `${h.severity}:${h.rule}`);

describe("code scan", () => {
  it("clean code: approved, with its calls, hosts and variables", () => {
    const r = scanCode(
      `// comment with eval( and process.env inside
       const data = await kitsuden.api.get('/api/data-sets/clients/entries?limit=5');
       await kitsuden.api.post("/api/blog", { title: "x" });
       const x = await kitsuden.api.request("PATCH", "/api/items/a", {});
       const h = await fetch("https://api.example.com/v1/x");
       const s = "text with eval() and globalThis inside";
       return { n: env.REGION, t: kitsuden.env.OTHER };`,
      { fetchAllow: ["api.example.com"] }
    );
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.apiCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/data-sets/clients/entries?limit=5",
      "POST /api/blog",
      "PATCH /api/items/a",
    ]);
    expect(r.fetchHosts).toEqual(["api.example.com"]);
    expect(r.envVars).toEqual(["OTHER", "REGION"]);
  });

  it.each([
    ["eval('1')", "high:dynamic_eval"],
    ["new Function('return 1')()", "high:dynamic_eval"],
    ["Function('x')", "high:dynamic_eval"],
    ["setTimeout('alert(1)', 1)", "high:dynamic_eval"],
    ["const m = await import('fs')", "high:dynamic_import"],
    ["({}).constructor.constructor('return this')()", "high:constructor_escape"],
    ["const o = {}; o['constructor']", "high:constructor_escape"],
    ["x.__proto__ = null", "high:constructor_escape"],
    ["return process.env", "high:forbidden_global"],
    ["return globalThis.__request", "high:forbidden_global"],
    ["require('child_process')", "high:forbidden_global"],
    ["Bun.spawn(['ls'])", "high:forbidden_global"],
    ["__request('api', '{}')", "high:forbidden_global"],
    ["\\u0065val('1')", "high:dynamic_eval"],
    ["const k = 'kitsuden_agent_abcdefgh12345678'", "high:secret_literal"],
    ["const k = 'AKIAABCDEFGHIJKLMNOP'", "high:secret_literal"],
    ["const password = 'hunter2hunter2'", "high:secret_literal"],
    ["const u = 'postgres://user:pa55word@db:5432/x'", "high:secret_literal"],
    ["atob('ZXZhbA==')", "medium:obfuscation"],
    ["String.fromCharCode(101, 118)", "medium:obfuscation"],
    ["const a = kitsuden.api; a.get('/api/x')", "medium:api_alias"],
    ["const { api } = kitsuden", "medium:api_alias"],
    ["kitsuden['api'].get('/api/x')", "medium:api_alias"],
    ["new Proxy({}, {})", "medium:reflection"],
    ["const s = 'abc", "medium:unparsable"],
    ["while (true) { break; }", "low:unbounded_loop"],
  ])("%s → %s", (code, expected) => {
    expect(rules(code)).toContain(expected);
  });

  it("a fetch to an undeclared host is a finding; a dynamic one is noted", () => {
    expect(rules("await fetch('https://evil.example.net/x')", ["api.example.com"])).toContain(
      "medium:undeclared_host"
    );
    expect(rules("await fetch('https://a.example.com/x')", ["*.example.com"])).toEqual([]);
    expect(scanCode("await fetch(event.url)").dynamicFetch).toBe(true);
  });

  it("a computed path is not classified (path null)", () => {
    const r = scanCode(
      "await kitsuden.api.get(`/api/items/${event.t}`); await kitsuden.api.delete(p);"
    );
    expect(r.apiCalls).toEqual([
      { method: "GET", path: null, line: 1 },
      { method: "DELETE", path: null, line: 1 },
    ]);
  });

  it("a class method named constructor is not a leak", () => {
    expect(rules("class A { constructor() { this.x = 1; } }; return new A().x;")).toEqual([]);
  });

  it("findings never repeat the secret", () => {
    const r = scanCode("const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';");
    expect(r.passed).toBe(false);
    expect(JSON.stringify(r)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("too large or minified to be reviewed", () => {
    expect(rules("x".repeat(70 * 1024))).toContain("high:oversize");
    expect(rules(`return ${"1+".repeat(800)}1;`)).toContain("medium:long_line");
  });

  it("it is deterministic", () => {
    const code = "const a = await kitsuden.api.get('/api/x'); eval('1'); return a;";
    expect(scanCode(code)).toEqual(scanCode(code));
  });
});

describe("declared capabilities", () => {
  it("they are normalized (order, duplicates, default values)", () => {
    expect(capabilitiesOf({ scopes: ["b", "a", "a", " "], fetchAllow: ["X.com"] })).toEqual({
      scopes: ["a", "b"],
      fetchAllow: ["x.com"],
      timeoutMs: 5000,
      memoryLimitMb: 64,
      maxCalls: 50,
    });
  });

  it("hostCovers: exact and subdomain wildcard", () => {
    expect(hostCovers("a.com", "a.com")).toBe(true);
    expect(hostCovers("*.a.com", "b.a.com")).toBe(true);
    expect(hostCovers("*.a.com", "*.b.a.com")).toBe(true);
    expect(hostCovers("*.a.com", "a.com")).toBe(false);
    expect(hostCovers("b.a.com", "*.a.com")).toBe(false);
  });

  it("diff: scopes covered by a wildcard are not new; removing a denial does widen", () => {
    const active = capabilitiesOf({
      scopes: ["datasets:*:read", "!datasets:secret:read"],
      fetchAllow: ["*.a.com"],
    });
    const d = capabilitiesDiff(
      active,
      capabilitiesOf({
        scopes: ["datasets:clients:read", "kon:blog:create-post"],
        fetchAllow: ["x.a.com", "b.com"],
        timeoutMs: 9000,
      })
    );
    expect(d.newTarget).toBe(false);
    expect(d.scopesAdded).toEqual(["kon:blog:create-post"]);
    expect(d.denialsRemoved).toEqual(["!datasets:secret:read"]);
    expect(d.hostsAdded).toEqual(["b.com"]);
    expect(d.limitsIncreased).toEqual([{ field: "timeoutMs", before: 5000, after: 9000 }]);
  });

  it("with no active version everything declared is new", () => {
    const d = capabilitiesDiff(null, capabilitiesOf({ scopes: ["x:read"] }));
    expect(d.newTarget).toBe(true);
    expect(d.scopesAdded).toEqual(["x:read"]);
  });
});

describe("what it touches", () => {
  it.each([
    ["/api/admin/vault/x", "secrets"],
    ["/api/keys", "secrets"],
    ["/api/v1/agents/a/scopes", "users_roles"],
    ["/api/auth/sign-up/email", "users_roles"],
    ["/api/approvals/settings", "security_config"],
    ["/api/promotion/drafts", "security_config"],
    ["/api/settings?x=1", "security_config"],
    ["/api/data-sets/x", null],
    ["/api/blog", null],
  ])("path %s → %s", (path, touch) => {
    expect(pathTouch(path)).toBe(touch);
  });

  it.each([
    ["admin", "security_config"],
    ["mcp:admin", "security_config"],
    ["kon:*", "security_config"],
    ["secrets:read", "secrets"],
    ["vault:*", "secrets"],
    ["users:write", "users_roles"],
    ["user:act", "users_roles"],
    ["promotion:propose", "security_config"],
    ["datasets:*:read", null],
    ["kon:blog:create-post", null],
  ])("scope %s → %s", (scope, touch) => {
    expect(scopeTouch(scope)).toBe(touch);
  });

  it("variable names that look like secrets", () => {
    for (const n of [
      "API_TOKEN",
      "stripeSecret",
      "DB_PASSWORD",
      "apiKey",
      "PRIVATE_KEY",
      "AUTH_HEADER",
    ]) {
      expect(secretName(n), n).toBe(true);
    }
    for (const n of ["REGION", "LIMIT", "monkey"]) expect(secretName(n), n).toBe(false);
  });
});

describe("the decision table", () => {
  const green = (): DecisionInput => ({
    mode: "turbo",
    config: { turboAllowed: true },
    diff: capabilitiesDiff(capabilitiesOf({}), capabilitiesOf({})),
    tests: { total: 2, passed: 2, failed: 0, errored: 0 },
    approvedScan: true,
    touches: [],
    sensitiveOperation: false,
    unclassifiedCall: false,
  });

  it("turbo only with everything green", () => {
    expect(decidePromotion(green())).toEqual({ route: "turbo", reasons: [] });
  });

  it("suggestion: always a proposal (and shows the rest)", () => {
    const d = decidePromotion({
      ...green(),
      mode: "suggestion",
      tests: { total: 1, passed: 0, failed: 1, errored: 0 },
    });
    expect(d.route).toBe("proposal");
    expect(d.reasons).toEqual(["suggestion_mode", "tests_failed"]);
  });

  it.each<[string, (e: DecisionInput) => DecisionInput]>([
    ["turbo_disabled_globally", (e) => ({ ...e, config: { turboAllowed: false } })],
    ["agent_held_for_approval", (e) => ({ ...e, heldAgent: true })],
    ["new_target", (e) => ({ ...e, diff: capabilitiesDiff(null, capabilitiesOf({})) })],
    ["no_tests", (e) => ({ ...e, tests: { total: 0, passed: 0, failed: 0, errored: 0 } })],
    ["tests_failed", (e) => ({ ...e, tests: { total: 2, passed: 1, failed: 1, errored: 0 } })],
    ["tests_errored", (e) => ({ ...e, tests: { total: 2, passed: 1, failed: 0, errored: 1 } })],
    ["scan_failed", (e) => ({ ...e, approvedScan: false })],
    [
      "scope_escalation",
      (e) => ({
        ...e,
        diff: capabilitiesDiff(capabilitiesOf({}), capabilitiesOf({ scopes: ["x:y"] })),
      }),
    ],
    [
      "scope_escalation",
      (e) => ({
        ...e,
        diff: capabilitiesDiff(capabilitiesOf({ scopes: ["!x:y"] }), capabilitiesOf({})),
      }),
    ],
    [
      "new_outbound_hosts",
      (e) => ({
        ...e,
        diff: capabilitiesDiff(capabilitiesOf({}), capabilitiesOf({ fetchAllow: ["a.com"] })),
      }),
    ],
    [
      "limits_increased",
      (e) => ({
        ...e,
        diff: capabilitiesDiff(capabilitiesOf({}), capabilitiesOf({ maxCalls: 100 })),
      }),
    ],
    ["touches_secrets", (e) => ({ ...e, touches: ["secrets"] })],
    ["touches_users_or_roles", (e) => ({ ...e, touches: ["users_roles"] })],
    ["touches_security_config", (e) => ({ ...e, touches: ["security_config"] })],
    ["sensitive_operation", (e) => ({ ...e, sensitiveOperation: true })],
    ["unclassifiable_api_call", (e) => ({ ...e, unclassifiedCall: true })],
  ])("turbo → proposal for %s", (reason, change) => {
    const d = decidePromotion(change(green()));
    expect(d.route).toBe("proposal");
    expect(d.reasons).toContain(reason);
  });

  it("every reason is in the catalog", () => {
    expect(new Set(FALLBACK_REASONS).size).toBe(FALLBACK_REASONS.length);
  });

  it("removing permissions does not prevent turbo", () => {
    const d = decidePromotion({
      ...green(),
      diff: capabilitiesDiff(
        capabilitiesOf({ scopes: ["x:y"], fetchAllow: ["a.com"], timeoutMs: 9000 }),
        capabilitiesOf({})
      ),
    });
    expect(d).toEqual({ route: "turbo", reasons: [] });
  });
});

describe("configuration", () => {
  it("by default: turbo off", () => {
    expect(DEFAULT_PROMOTION_CONFIG.turboAllowed).toBe(false);
    expect(readPromotionConfig(null)).toEqual(DEFAULT_PROMOTION_CONFIG);
    expect(readPromotionConfig({ watchMinutes: "x" })).toEqual(DEFAULT_PROMOTION_CONFIG);
  });

  it("validates the limits", () => {
    expect(
      mergePromotionConfig(DEFAULT_PROMOTION_CONFIG, { turboAllowed: true, watchMinutes: 5 })
    ).toMatchObject({
      turboAllowed: true,
      watchMinutes: 5,
    });
    expect(() => mergePromotionConfig(DEFAULT_PROMOTION_CONFIG, { watchMinutes: 0 })).toThrow();
    expect(() => mergePromotionConfig(DEFAULT_PROMOTION_CONFIG, { maxErrorRate: 2 })).toThrow();
    expect(() => mergePromotionConfig(DEFAULT_PROMOTION_CONFIG, { turboAllowed: "yes" })).toThrow();
  });
});
