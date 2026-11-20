/**
 * Audit 2026-11-19: the engine's scope checks follow the core rule
 * ============================================================================
 *
 * `missingScopes` (actions.ts) guards `meta.requiredScopes` of engine actions.
 * It returned "nothing missing" for any list with `admin` and never read `!`
 * denials, so `['admin', '!kon:crm:*']` ran an action every core gate refused.
 * It now delegates to `concedeScope` (@kitsuden/shared).
 *
 * `actsAsUserIn(kon, { wholeKon: true })` is the variant for a policy that is
 * the only authorization of many operations (koe's `use`): a key scoped to one
 * operation must not open the others through the policy fallback.
 */

import { concedeScope } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

import { missingScopes } from "../../packages/engine/src/actions";
import { actsAsUserIn } from "../../packages/engine/src/effective-actor";

describe("missingScopes honors denials like concedeScope", () => {
  it("a denial beats admin", () => {
    expect(missingScopes(["kon:crm:export"], ["admin", "!kon:crm:*"])).toEqual(["kon:crm:export"]);
    expect(missingScopes(["kon:crm:export"], ["admin:*", "!kon:crm:export"])).toEqual([
      "kon:crm:export",
    ]);
  });

  it("a denial beats a wildcard grant", () => {
    expect(missingScopes(["kon:crm:export"], ["kon:crm:*", "!kon:crm:export"])).toEqual([
      "kon:crm:export",
    ]);
  });

  it("agrees with concedeScope on a table of cases", () => {
    const cases: [string, string[]][] = [
      ["kon:crm:export", ["admin", "!kon:crm:*"]],
      ["kon:crm:export", ["kon:crm:*"]],
      ["crm:write", ["*:write"]],
      ["crm:write", ["admin"]],
      ["crm:write", ["!crm:write"]],
      ["crm:write", []],
      ["datasets:clients:read", ["datasets:*:read"]],
    ];
    for (const [required, granted] of cases) {
      expect(missingScopes([required], granted).length === 0).toBe(concedeScope(granted, required));
    }
  });
});

describe("actsAsUserIn with { wholeKon: true }", () => {
  const strict = actsAsUserIn("koe", { wholeKon: true });
  const loose = actsAsUserIn("koe");
  const agent = (scopes: string[]) => ({ id: "agent-1", role: "agent", scopes });

  it("a fine operation scope no longer passes the policy", () => {
    expect(loose(agent(["kon:koe:list-conversations"]))).toBe(true); // unchanged default
    expect(strict(agent(["kon:koe:list-conversations"]))).toBe(false);
    expect(strict(agent(["koe:read"]))).toBe(false);
  });

  it("whole-kon scopes, user:act and admin pass; denials win", () => {
    expect(strict(agent(["koe:*"]))).toBe(true);
    expect(strict(agent(["kon:koe:*"]))).toBe(true);
    expect(strict(agent(["user:act"]))).toBe(true);
    expect(strict(agent(["admin"]))).toBe(true);
    expect(strict(agent(["admin", "!koe:*"]))).toBe(false);
    expect(strict(agent(["user:act", "!user:act"]))).toBe(false);
  });

  it("humans still pass and nobody without an id does", () => {
    expect(strict({ id: "u1", role: "user" })).toBe(true);
    expect(strict({ role: "user" })).toBe(false);
    expect(strict(null)).toBe(false);
  });
});
