/**
 * Egress policy (lib/egress-policy.ts): parsing, the layer order, IP/CIDR
 * matching on resolved addresses, the port floor, and the hot-reloaded
 * platform file that fails closed.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetEgressPolicyCache,
  actionEgressProblem,
  actionRules,
  decideEgress,
  normalizeTarget,
  parsePlatformPolicy,
  parseRule,
  platformEgressPolicy,
  resolutionCouldAllow,
  type PlatformEgressPolicy,
} from "../lib/egress-policy";

const open = (over: Partial<PlatformEgressPolicy> = {}): PlatformEgressPolicy => ({
  defaultAction: "deny",
  denyAlways: [],
  allowAlways: [],
  ports: [],
  ...over,
});

const ENV = [
  "KITSUDEN_EGRESS_POLICY_FILE",
  "KITSUDEN_EGRESS_DENY_ALWAYS",
  "KITSUDEN_EGRESS_ALLOW_ALWAYS",
  "KITSUDEN_EGRESS_PORTS",
  "KITSUDEN_EGRESS_DEFAULT",
];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  _resetEgressPolicyCache();
});

describe("targets and rules", () => {
  test("normalizes hosts, wildcards, IPs and CIDRs; refuses junk", () => {
    expect(normalizeTarget("API.Example.com.")).toBe("api.example.com");
    expect(normalizeTarget("*.example.com")).toBe("*.example.com");
    expect(normalizeTarget("*")).toBe("*");
    expect(normalizeTarget("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(normalizeTarget("[fd00::]/8")).toBe("fd00::/8");
    expect(normalizeTarget("::1")).toBe("::1");
    expect(normalizeTarget("10.0.0.0/33")).toBeNull();
    expect(normalizeTarget("https://a.com")).toBeNull();
    expect(normalizeTarget("a.com:443")).toBeNull();
    expect(normalizeTarget("a b.com")).toBeNull();
  });

  test("a rule needs an action and a target or ports", () => {
    expect(parseRule({ action: "allow" })).toBeTypeOf("string");
    expect(parseRule({ action: "maybe", target: "a.com" })).toBeTypeOf("string");
    expect(parseRule({ action: "deny", ports: [25] })).toEqual({ action: "deny", ports: [25] });
    expect(parseRule({ action: "allow", target: "a.com", ports: [443, 443, 80] })).toEqual({
      action: "allow",
      target: "a.com",
      ports: [80, 443],
    });
    expect(parseRule({ action: "allow", target: "a.com", ports: [0] })).toBeTypeOf("string");
  });

  test("an action cannot choose its own default", () => {
    expect(actionEgressProblem({ defaultAction: "allow", rules: [] })).toContain("operator");
    expect(actionEgressProblem({ rules: [{ action: "allow", target: "a.com" }] })).toBeNull();
    expect(actionEgressProblem({ rules: "a.com" })).toBeTypeOf("string");
  });

  test("fetchAllow hosts become allow rules of the action layer", () => {
    expect(actionRules({ fetchAllow: ["A.com", "*.b.com", "bad host"] })).toEqual([
      { action: "allow", target: "a.com" },
      { action: "allow", target: "*.b.com" },
    ]);
  });
});

describe("the decision", () => {
  const req = (hostname: string, port = 443, addresses?: string[]) => ({
    hostname,
    port,
    addresses,
  });

  test("default deny; an action allow opens only its host", () => {
    const rules = actionRules({ fetchAllow: ["api.a.com"] });
    expect(decideEgress(open(), rules, req("api.a.com")).allowed).toBe(true);
    expect(decideEgress(open(), rules, req("x.a.com")).allowed).toBe(false);
    expect(decideEgress(open(), [], req("api.a.com")).layer).toBe("default");
  });

  test("a wildcard covers subdomains only", () => {
    const rules = actionRules({ fetchAllow: ["*.a.com"] });
    expect(decideEgress(open(), rules, req("x.a.com")).allowed).toBe(true);
    expect(decideEgress(open(), rules, req("a.com")).allowed).toBe(false);
    expect(decideEgress(open(), rules, req("xa.com")).allowed).toBe(false);
  });

  test("inside the action layer a deny beats an allow, whatever the order", () => {
    const rules = [
      { action: "allow" as const, target: "*.a.com" },
      { action: "deny" as const, target: "admin.a.com" },
    ];
    expect(decideEgress(open(), rules, req("admin.a.com")).layer).toBe("action_deny");
    expect(decideEgress(open(), rules, req("api.a.com")).allowed).toBe(true);
  });

  test("platform denyAlways beats every action allow; allowAlways opens for every action", () => {
    const platform = open({
      denyAlways: [{ action: "deny", target: "evil.a.com" }],
      allowAlways: [{ action: "allow", target: "status.example.org" }],
    });
    const rules = actionRules({ fetchAllow: ["*.a.com"] });
    expect(decideEgress(platform, rules, req("evil.a.com")).layer).toBe("deny_always");
    expect(decideEgress(platform, [], req("status.example.org")).layer).toBe("allow_always");
  });

  test("ports: per rule, and the platform floor", () => {
    const rules = [{ action: "allow" as const, target: "a.com", ports: [443] }];
    expect(decideEgress(open(), rules, req("a.com", 443)).allowed).toBe(true);
    expect(decideEgress(open(), rules, req("a.com", 8443)).allowed).toBe(false);
    const floor = open({ ports: [443] });
    expect(
      decideEgress(floor, actionRules({ fetchAllow: ["a.com"] }), req("a.com", 22)).layer
    ).toBe("ports");
    // a port-only deny matches any host
    const smtp = [
      { action: "deny" as const, ports: [25] },
      { action: "allow" as const, target: "*" },
    ];
    expect(decideEgress(open(), smtp, req("mail.a.com", 25)).allowed).toBe(false);
    expect(decideEgress(open(), smtp, req("mail.a.com", 443)).allowed).toBe(true);
  });

  test("CIDR rules match the RESOLVED addresses, IPv4 and IPv6", () => {
    const platform = open({ denyAlways: [{ action: "deny", target: "203.0.113.0/24" }] });
    const rules = actionRules({ fetchAllow: ["api.a.com"] });
    expect(decideEgress(platform, rules, req("api.a.com", 443, ["198.51.100.7"])).allowed).toBe(
      true
    );
    expect(
      decideEgress(platform, rules, req("api.a.com", 443, ["198.51.100.7", "203.0.113.9"])).layer
    ).toBe("deny_always");
    const v6 = open({ denyAlways: [{ action: "deny", target: "2001:db8::/32" }] });
    expect(decideEgress(v6, rules, req("api.a.com", 443, ["2001:db8::1"])).allowed).toBe(false);
    // an IPv4 rule never matches an IPv6 address
    expect(decideEgress(platform, rules, req("api.a.com", 443, ["2001:db8::1"])).allowed).toBe(
      true
    );
    // an IP literal URL is matched directly
    expect(
      decideEgress(platform, [{ action: "allow", target: "*" }], req("203.0.113.4")).allowed
    ).toBe(false);
  });

  test("a CIDR allow lets a name through only after resolution", () => {
    const rules = [{ action: "allow" as const, target: "198.51.100.0/24" }];
    expect(decideEgress(open(), rules, req("svc.a.com")).allowed).toBe(false);
    expect(resolutionCouldAllow(open(), rules)).toBe(true);
    expect(resolutionCouldAllow(open(), actionRules({ fetchAllow: ["a.com"] }))).toBe(false);
    expect(decideEgress(open(), rules, req("svc.a.com", 443, ["198.51.100.20"])).allowed).toBe(
      true
    );
  });

  test("no platform policy (invalid file) denies everything", () => {
    const d = decideEgress(null, [{ action: "allow", target: "*" }], req("a.com"));
    expect(d).toEqual({ allowed: false, layer: "invalid_policy" });
  });
});

describe("the platform layer", () => {
  test("env lists and the default", () => {
    process.env.KITSUDEN_EGRESS_DENY_ALWAYS = "metadata.google.internal, 169.254.0.0/16";
    process.env.KITSUDEN_EGRESS_ALLOW_ALWAYS = "status.example.org";
    process.env.KITSUDEN_EGRESS_PORTS = "443,80";
    const p = platformEgressPolicy()!;
    expect(p.defaultAction).toBe("deny");
    expect(p.denyAlways.map((r) => r.target)).toEqual([
      "metadata.google.internal",
      "169.254.0.0/16",
    ]);
    expect(p.allowAlways.map((r) => r.target)).toEqual(["status.example.org"]);
    expect(p.ports).toEqual([443, 80]);
  });

  test("the file validates every key", () => {
    expect(parsePlatformPolicy("{")).toBe("not valid JSON");
    expect(parsePlatformPolicy('{"denyAlways":[{"action":"allow","target":"a.com"}]}')).toContain(
      "deny"
    );
    expect(parsePlatformPolicy('{"extra":1}')).toContain("unknown key");
    expect(parsePlatformPolicy('{"defaultAction":"allow"}')).toMatchObject({
      defaultAction: "allow",
    });
  });

  test("hot reload: a change applies without restart; an invalid edit keeps the last valid; never valid = deny all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const file = join(dir, "policy.json");
    try {
      process.env.KITSUDEN_EGRESS_POLICY_FILE = file;
      // never valid → fail closed
      writeFileSync(file, "{ not json");
      expect(platformEgressPolicy(1_000)).toBeNull();

      writeFileSync(file, JSON.stringify({ denyAlways: [{ action: "deny", target: "a.com" }] }));
      utimesSync(file, new Date(), new Date(Date.now() + 5_000));
      expect(platformEgressPolicy(10_000)!.denyAlways[0]!.target).toBe("a.com");

      // a change is seen after the recheck interval
      writeFileSync(file, JSON.stringify({ denyAlways: [{ action: "deny", target: "b.com" }] }));
      utimesSync(file, new Date(), new Date(Date.now() + 10_000));
      expect(platformEgressPolicy(10_500)!.denyAlways[0]!.target).toBe("a.com"); // within 1 s: cached
      expect(platformEgressPolicy(12_000)!.denyAlways[0]!.target).toBe("b.com");

      // an invalid edit keeps b.com in force
      writeFileSync(file, '{"denyAlways": "oops"}');
      utimesSync(file, new Date(), new Date(Date.now() + 15_000));
      expect(platformEgressPolicy(14_000)!.denyAlways[0]!.target).toBe("b.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file that was never valid denies everything", () => {
    process.env.KITSUDEN_EGRESS_POLICY_FILE = join(tmpdir(), `does-not-exist-${Date.now()}.json`);
    expect(platformEgressPolicy()).toBeNull();
  });
});
