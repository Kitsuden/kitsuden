/**
 * Public contract of the Admin Registry
 * ============================================================================
 *
 * `GET /api/admin/registry` is what lets someone build their own panel in
 * React, Vue or whatever. That is only true if the contract does not change
 * silently, so it is pinned down here: the version is declared, and the
 * route's three responses include it.
 *
 * The assertions about the route are STATIC (they read the source) on purpose.
 * Spinning up the app in the unit suite would drag in bun's global mocks,
 * which in this repo have already caused phantom failures.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ADMIN_REGISTRY_VERSION,
  CONTRACT_HEADER,
  assertSupportedContract,
} from "../../packages/shared/src/admin-registry-contract";

const ROOT = resolve(__dirname, "../..");
const ROUTE = readFileSync(join(ROOT, "apps/api/src/routes/admin-registry.ts"), "utf8");

describe("contract version", () => {
  test("is declared and is a positive integer", () => {
    expect(Number.isInteger(ADMIN_REGISTRY_VERSION)).toBe(true);
    expect(ADMIN_REGISTRY_VERSION).toBeGreaterThan(0);
  });

  test("the header has the agreed name", () => {
    expect(CONTRACT_HEADER).toBe("X-Kitsuden-Contract");
  });
});

describe("the route publishes the version", () => {
  test("the three success responses include `contract`", () => {
    // full registry, a specific kon and refresh. If someone adds a fourth
    // response without a version, a third-party client will not be able to validate it.
    const occurrences = ROUTE.match(/contract:\s*ADMIN_REGISTRY_VERSION/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  test("it also goes in a header, to decide without parsing the body", () => {
    expect(ROUTE).toContain("CONTRACT_HEADER");
    expect(ROUTE).toMatch(/admin-registry\/v\$\{ADMIN_REGISTRY_VERSION\}/);
  });

  test("the version is imported from the shared contract, not written by hand", () => {
    // A loose literal would drift out of sync with the contract as soon as it is bumped.
    expect(ROUTE).toMatch(/from ["']@kitsuden\/shared["']/);
    expect(ROUTE).not.toMatch(/contract:\s*\d/);
  });
});

describe("negotiation from the client", () => {
  test("accepts a response of the current version", () => {
    expect(() => assertSupportedContract({ contract: ADMIN_REGISTRY_VERSION })).not.toThrow();
  });

  test("accepts an OLDER version: the new client reads the old server", () => {
    expect(() => assertSupportedContract({ contract: 1 }, 5)).not.toThrow();
  });

  test("rejects a NEWER version with a message saying what to do", () => {
    expect(() => assertSupportedContract({ contract: 9 }, 1)).toThrow(/Update the client/);
  });

  test("rejects a response without a version, which would be a pre-v1 Kitsuden", () => {
    expect(() => assertSupportedContract({ kons: [] })).toThrow(
      /does not declare a contract version/
    );
    expect(() => assertSupportedContract(null)).toThrow(/does not declare a contract version/);
    expect(() => assertSupportedContract({ contract: "1" })).toThrow(
      /does not declare a contract version/
    );
  });
});

describe("shape of the contract — what a third-party panel can assume", () => {
  test("the view type includes the agnostic mechanism", () => {
    const contract = readFileSync(
      join(ROOT, "packages/shared/src/admin-registry-contract.ts"),
      "utf8"
    );
    // If "element" disappears, third-party custom views stop existing.
    expect(contract).toMatch(/"grid" \| "kanban" \| "calendar" \| "custom" \| "element"/);
  });

  test("the evolution rules are written next to the contract", () => {
    const contract = readFileSync(
      join(ROOT, "packages/shared/src/admin-registry-contract.ts"),
      "utf8"
    );
    // Without this, "versioned" is just a number nobody knows when to bump.
    expect(contract).toMatch(/Evolution rules/);
    expect(contract).toMatch(/adding optional fields/);
  });
});
