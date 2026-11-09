/**
 * Agent permissions: broad + fine-grained, union, and the denial that wins
 * ============================================================================
 *
 * The rule lives ONCE in `@kitsuden/shared` (agent-permission.ts) and is
 * used by the API (`hasScope`), the engine (`scopeConcede`, `can`), the kon SDK
 * (`grantsByScopes`) and the MCP tools. Its truth table is pinned down here.
 */
import {
  AGENT_PRESETS,
  BROAD_CORE_SCOPES,
  accessToDataset,
  grantsByScopes,
  concedeScope,
  operationCost,
  defineOperation,
  operationDenial,
  invalidScopeReason,
  normalizeScopes,
  patternCovers,
  scopeCovers,
} from "@kitsuden/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("patternCovers: wildcards", () => {
  const cases: [string, string, boolean][] = [
    ["crm:*", "crm:contacts", true],
    ["crm:*", "crm:a:b", true],
    ["crm:*", "crmx:a", false],
    ["crm:*", "crm", false],
    ["*:read", "posts:read", true],
    ["*:read", "datasets:clients:read", true],
    ["*:read", "posts:write", false],
    ["datasets:*:read", "datasets:clients:read", true],
    ["datasets:*:read", "datasets:clients:write", false],
    ["datasets:*:read", "datasets:a:b:read", false],
    ["kon:*", "kon:blog:create-post", true],
    ["kon:blog:*", "kon:blog:create-post", true],
    ["kon:blog:*", "kon:blocks:create-page", false],
    ["kon:*:create-post", "kon:blog:create-post", true],
    // What it did not cover before, it does not cover now (nothing widens by surprise)
    ["*:*", "any:thing", false],
    ["*", "any:thing", false],
    ["esports", "esports:manage", false],
    ["esports:man", "esports:manage", false],
  ];
  for (const [pattern, req, expected] of cases) {
    it(`${pattern} → ${req}: ${expected}`, () =>
      expect(patternCovers(pattern, req)).toBe(expected));
  }
});

describe("concedeScope: union, admin and denials", () => {
  it("admin covers everything", () => {
    expect(concedeScope(["admin"], "kon:crm:delete-contact")).toBe(true);
    expect(concedeScope(["admin:*"], "datasets:x:delete")).toBe(true);
  });
  it("a fine-grained scope takes nothing from a broad one (union)", () => {
    expect(concedeScope(["crm:*", "kon:blog:create-post"], "crm:contacts")).toBe(true);
    expect(concedeScope(["crm:*", "kon:blog:create-post"], "kon:blog:create-post")).toBe(true);
  });
  it("a denial wins over any grant, admin included", () => {
    expect(concedeScope(["admin", "!kon:crm:delete-contact"], "kon:crm:delete-contact")).toBe(
      false
    );
    expect(concedeScope(["admin", "!kon:crm:delete-contact"], "kon:crm:create-contact")).toBe(true);
    expect(concedeScope(["kon:crm:*", "!kon:crm:*"], "kon:crm:create-contact")).toBe(false);
    expect(concedeScope(["datasets:*:read", "!datasets:payroll:*"], "datasets:payroll:read")).toBe(
      false
    );
    expect(concedeScope(["datasets:*:read", "!datasets:payroll:*"], "datasets:clients:read")).toBe(
      true
    );
  });
  it("a denial alone grants nothing", () => {
    expect(concedeScope(["!kon:crm:delete-contact"], "kon:crm:create-contact")).toBe(false);
    expect(scopeCovers("!kon:crm:*", "kon:crm:x")).toBe(false);
  });
});

describe("accessToDataset", () => {
  it("granted, denied or no decision (the policy decides)", () => {
    expect(accessToDataset(["datasets:clients:read"], "clients", "read")).toBe("granted");
    expect(accessToDataset(["datasets:clients:read"], "clients", "write")).toBeNull();
    expect(accessToDataset(["datasets:clients:read"], "others", "read")).toBeNull();
    expect(accessToDataset(["datasets:*:write"], "others", "write")).toBe("granted");
    expect(accessToDataset(["admin", "!datasets:clients:delete"], "clients", "delete")).toBe(
      "denied"
    );
    expect(accessToDataset(["admin", "!datasets:clients:delete"], "clients", "write")).toBe(
      "granted"
    );
    expect(accessToDataset([], "clients", "read")).toBeNull();
  });
});

describe("SDK: grantsByScopes with fine-grained, broad, resource and denial", () => {
  const op = defineOperation({
    id: "create-post",
    method: "POST",
    route: "/",
    summary: "Create",
    description: "Creates an entry.",
    access: "session",
    input: { body: z.object({ t: z.string() }) },
    output: { status: 201, schema: z.object({}) },
    permission: {
      policy: { resource: "blog_post", action: "create" },
      resourceScope: (_e, resource) =>
        (resource as { slug?: string } | undefined)?.slug
          ? `datasets:${(resource as { slug: string }).slug}:write`
          : null,
    },
    handle: () => ({}),
  });
  const input = { params: undefined, query: undefined, body: { t: "x" } };

  it("the fine-grained scope grants ONLY that operation", () => {
    expect(grantsByScopes(["kon:blog:create-post"], "kon-blog", op).granted).toBe(true);
    expect(grantsByScopes(["kon:blog:update-post"], "kon-blog", op).granted).toBe(false);
  });
  it("the kon's broad scopes and wildcards", () => {
    expect(grantsByScopes(["blog:*"], "kon-blog", op).by).toBe("blog:*");
    expect(grantsByScopes(["kon:*"], "kon-blog", op).granted).toBe(true);
  });
  it("the resource scope (with the resource loaded)", () => {
    expect(grantsByScopes(["datasets:x:write"], "kon-blog", op, input, { slug: "x" }).granted).toBe(
      true
    );
    expect(grantsByScopes(["datasets:x:write"], "kon-blog", op, input, { slug: "y" }).granted).toBe(
      false
    );
  });
  it("the denial wins: by fine-grained, by kon, by alias and by resource", () => {
    expect(grantsByScopes(["admin", "!kon:blog:create-post"], "kon-blog", op)).toEqual({
      granted: false,
      deniedBy: "!kon:blog:create-post",
    });
    expect(operationDenial(["admin", "!kon:blog:*"], "kon-blog", op)).toBe("!kon:blog:*");
    expect(operationDenial(["admin", "!blog:*"], "kon-blog", op)).toBe("!blog:*");
    expect(
      grantsByScopes(["admin", "!datasets:x:*"], "kon-blog", op, input, { slug: "x" }).granted
    ).toBe(false);
  });
  it("cost: 1 by default, the declared one if any, and it is validated on declaration", () => {
    expect(operationCost(op)).toBe(1);
    expect(operationCost({ cost: 5 })).toBe(5);
    expect(() => defineOperation({ ...op, id: "pricey", cost: -1 })).toThrow(/cost/);
  });
});

describe("validating what gets stored", () => {
  it("accepts broad ones, fine-grained ones and denials", () => {
    for (const s of [
      "admin",
      "mcp:connect",
      "content:edit",
      "crm:*",
      "kon:blog:create-post",
      "datasets:clients:read",
      "datasets:*:read",
      "!kon:crm:delete-contact",
      "!datasets:payroll:*",
    ]) {
      expect(invalidScopeReason(s), s).toBeNull();
    }
  });
  it("rejects what means nothing or is confusing", () => {
    for (const s of ["", "Admin", "*", "*:*", "!admin", "!x", "a b:c", "a:b:c:d:e:f", 3]) {
      expect(invalidScopeReason(s), String(s)).not.toBeNull();
    }
  });
  it("normalizes (no duplicates) and throws with the reason", () => {
    expect(normalizeScopes(["mcp:read", "mcp:read", " kon:blog:* "])).toEqual([
      "mcp:read",
      "kon:blog:*",
    ]);
    expect(() => normalizeScopes(["!admin"])).toThrow(/Invalid scope/);
    expect(() => normalizeScopes("admin")).toThrow(/array/);
  });
  it("the presets and the core's broad scopes are valid", () => {
    for (const p of AGENT_PRESETS) expect(() => normalizeScopes([...p.scopes])).not.toThrow();
    expect(() => normalizeScopes([...BROAD_CORE_SCOPES])).not.toThrow();
  });
});
