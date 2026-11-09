/**
 * Agent NHI — Canonical prefix `kitsuden_agent_` + sunset of the legacy `grm_agent_`
 * ============================================================================
 * The rebrand (vek → varco → kitsuden) unified the prefix of agent identities
 * and keys.
 * These tests pin down the contract:
 *   1. EVERYTHING that is GENERATED uses `kitsuden_agent_` (uniformity).
 *   2. What was already ISSUED with `grm_agent_` still parses until the sunset
 *      2026-08-01 (we do not invalidate live tokens all at once).
 */

import { describe, expect, test } from "bun:test";

import {
  generateAgentId,
  parseAgentId,
  isValidAgentId,
  getAgentTypeFromId,
} from "../utils/id-generator";

describe("Agent IDs — canonical generation", () => {
  test("generateAgentId ALWAYS emits kitsuden_agent_", () => {
    const { id, prefix } = generateAgentId({ type: "claude-desktop" });
    expect(id.startsWith("kitsuden_agent_claude-desktop_")).toBe(true);
    expect(prefix).toBe("kitsuden_agent");
    expect(id).not.toContain("grm_");
  });

  test("round-trip: what is generated parses back into its components", () => {
    const { id, hash } = generateAgentId({ type: "scraper" });
    const parsed = parseAgentId(id);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe("kitsuden_agent");
    expect(parsed!.type).toBe("scraper");
    expect(parsed!.hash).toBe(hash);
  });
});

describe("Agent IDs — legacy compatibility (sunset 2026-08-01)", () => {
  test("parses legacy grm_agent_ IDs that were already issued", () => {
    const parsed = parseAgentId("grm_agent_claude-desktop_a1b2c3d4e5f67890");
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe("grm_agent");
    expect(parsed!.type).toBe("claude-desktop");
    expect(parsed!.hash).toBe("a1b2c3d4e5f67890");
  });

  test("isValidAgentId accepts both prefixes", () => {
    expect(isValidAgentId("kitsuden_agent_worker_abc123")).toBe(true);
    expect(isValidAgentId("grm_agent_worker_abc123")).toBe(true);
  });

  test("getAgentTypeFromId works with both prefixes", () => {
    expect(getAgentTypeFromId("kitsuden_agent_mcp-server_deadbeef")).toBe("mcp-server");
    expect(getAgentTypeFromId("grm_agent_mcp-server_deadbeef")).toBe("mcp-server");
  });

  // NOTE: `getAgentTypeFromApiKey` is not asserted here. `agent-auth.test.ts`
  // stubs it via `mock.module("../utils/id-generator")`, which in bun patches the
  // module registry GLOBALLY and irreversibly (`mock.restore()` does not
  // undo it) and merges onto the real module. Any assertion on it
  // would depend on the order files run in. Its prefix contract is
  // identical to that of `getAgentTypeFromId`, covered above.
});

describe("Agent IDs — rejection of garbage", () => {
  test("foreign prefixes do not parse", () => {
    // Earlier brands (vek/varco): they were NEVER accepted as an agent prefix;
    // the only legacy in sunset is `grm_agent_`.
    expect(parseAgentId("vek_agent_claude_abc123")).toBeNull();
    expect(parseAgentId("varco_agent_claude_abc123")).toBeNull();
    expect(parseAgentId("random_token_here")).toBeNull();
    expect(parseAgentId("kitsuden_agent_")).toBeNull();
    expect(isValidAgentId("bearer kitsuden_agent_x_y")).toBe(false);
  });

  test("the expected type is validated", () => {
    const { id } = generateAgentId({ type: "worker" });
    expect(isValidAgentId(id, "worker")).toBe(true);
    expect(isValidAgentId(id, "scraper")).toBe(false);
  });
});

describe("Brand uniformity", () => {
  test("no generated prefix contains old brands (vek/varco/vroce/grm)", () => {
    for (const type of ["claude-desktop", "worker", "scraper", "mcp-server"]) {
      const { id } = generateAgentId({ type });
      expect(id).not.toMatch(/vek|varco|vroce|grm_/);
      expect(id.startsWith("kitsuden_")).toBe(true);
    }
  });
});
