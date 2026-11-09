/**
 * The engine and the API read scopes with the same rules
 * ============================================================================
 *
 * `hasScope` lives in the API (`services/agent-auth.ts`) and decides whether an agent
 * can use a tool. `scopeConcede` lives in the engine and decides whether a
 * scope grants a policy action. They have to be written twice because the engine
 * cannot import from the app.
 *
 * Two copies of a security rule are a recipe for one to fall behind: the day
 * someone adds a wildcard to one and not the other, an agent
 * will be able to do through one door what the other denies it. This test runs the
 * same table of cases through both.
 */

import { scopeConcede } from "@kitsuden/engine";
import { describe, expect, it, vi } from "vitest";

// `agent-auth.ts` imports the database and the audit module on load. Only the pure
// function matters here, so they are replaced with empty modules.
vi.mock("../../apps/api/src/db", () => ({ db: {} }));
vi.mock("../../apps/api/src/services/agent-audit", () => ({
  logAuthSuccess: () => undefined,
  logAuthFailure: () => undefined,
  logRateLimited: () => undefined,
  logAgentAction: () => undefined,
}));

import { hasScope } from "../../apps/api/src/services/agent-auth";

const CASES: [scopes: string[], required: string][] = [
  [["esports:manage"], "esports:manage"],
  [["esports:manage"], "esports:view"],
  [["esports:*"], "esports:view"],
  [["esports:*"], "tierlist:view"],
  [["*:view"], "esports:view"],
  [["*:view"], "esports:manage"],
  [["admin:*"], "any:thing"],
  [["admin"], "any:thing"],
  [[], "esports:manage"],
  [["read:*"], "read:users"],
  [["read:*"], "write:users"],
  [["esports"], "esports:manage"],
  [["esports:man"], "esports:manage"],
  [["gate:access-admin"], "gate:access-admin"],
  // Wildcard in the middle and denials (both read the rule from shared)
  [["datasets:*:read"], "datasets:clients:read"],
  [["datasets:*:read"], "datasets:clients:write"],
  [["admin", "!esports:manage"], "esports:manage"],
  [["esports:*", "!esports:manage"], "esports:view"],
  [["*:*"], "any:thing"],
];

describe("same answers in the engine and in the API", () => {
  for (const [scopes, required] of CASES) {
    it(`[${scopes.join(", ") || "no scopes"}] → ${required}`, () => {
      const api = hasScope({ scopes } as never, required);
      expect(scopeConcede(scopes, required), "the engine and the API disagree").toBe(api);
    });
  }
});
