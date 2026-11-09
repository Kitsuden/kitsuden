/**
 * Agent safety and accountability — the pure parts
 * ============================================================================
 *
 *   · Deny with an alternative (ROADMAP 3): `decideUnattended`, `pickAlternative`
 *     and the new keys of the approvals configuration (`unattended`,
 *     `unattendedAlternative`, `alternatives`, a legacy rule's `alternative`).
 *   · `KITSUDEN_E_DENIED_UNATTENDED` is in the error catalog.
 *   · `kitsuden.effect(key, fn)` (ROADMAP 1) is part of the sandbox API for the
 *     promotion scanner, its fetch calls are still scanned, and the prologue's
 *     `__effect` is an internal like `__api`.
 *
 * The API behaviour (403 with the alternative, the sandbox ledger, versions and
 * decisions) is in apps/api/src/tests/agent-accountability.test.ts.
 */
import {
  ALTERNATIVE_MAX,
  DEFAULT_APPROVALS_CONFIG,
  DEFAULT_UNATTENDED_ALTERNATIVE,
  KITSUDEN_ERRORS,
  decideApproval,
  decideUnattended,
  invalidRuleReason,
  mergeApprovalsConfig,
  pickAlternative,
  readApprovalsConfig,
  scanCode,
} from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

import { unattendedRun } from "../../apps/api/src/lib/actions/types";

describe("deny with an alternative: the decision", () => {
  it("hold is the default: nothing changes until an admin says deny", () => {
    expect(DEFAULT_APPROVALS_CONFIG.unattended).toBe("hold");
    expect(DEFAULT_APPROVALS_CONFIG.unattendedAlternative).toBeNull();
    expect(DEFAULT_APPROVALS_CONFIG.alternatives).toEqual({});
    expect(decideUnattended({ unattended: true, global: "hold" })).toBe("hold");
  });

  it("only an unattended run is ever denied; the agent's setting wins over the global one", () => {
    expect(decideUnattended({ unattended: false, global: "deny", agent: "deny" })).toBe("hold");
    expect(decideUnattended({ unattended: true, global: "deny" })).toBe("deny");
    expect(decideUnattended({ unattended: true, global: "deny", agent: "hold" })).toBe("hold");
    expect(decideUnattended({ unattended: true, global: "hold", agent: "deny" })).toBe("deny");
    expect(decideUnattended({ unattended: true, global: "hold", agent: null })).toBe("hold");
  });

  it("it never lets through what would be held: the approval table is unchanged", () => {
    // The unattended decision only applies to what decideApproval holds.
    expect(
      decideApproval({ mode: "inherit", globalActive: true, sensitive: true, write: true })
    ).toBe("sensitive");
    expect(
      decideApproval({ mode: "direct", globalActive: true, sensitive: true, write: true })
    ).toBeNull();
  });

  it("the most specific alternative written wins, and there is always one", () => {
    expect(pickAlternative("op", "rule", "agent", "global")).toBe("op");
    expect(pickAlternative(null, undefined, "  agent  ", "global")).toBe("agent");
    expect(pickAlternative(null, "", "   ", "global")).toBe("global");
    expect(pickAlternative(null, null, null, null)).toBe(DEFAULT_UNATTENDED_ALTERNATIVE);
    expect(DEFAULT_UNATTENDED_ALTERNATIVE).toContain("kitsuden_record_decision");
  });
});

describe("deny with an alternative: the configuration", () => {
  const base = DEFAULT_APPROVALS_CONFIG;

  it("accepts the new keys and normalizes them", () => {
    const c = mergeApprovalsConfig(base, {
      unattended: "deny",
      unattendedAlternative: "  Leave a note.  ",
      alternatives: {
        "kon:blog:delete-post": "Unpublish it instead.",
        "mcp:kitsuden_delete_record": " Archive it. ",
      },
      legacyRules: [{ method: "delete", path: "/api/items/**", alternative: " Ask Ana. " }],
    });
    expect(c.unattended).toBe("deny");
    expect(c.unattendedAlternative).toBe("Leave a note.");
    expect(c.alternatives).toEqual({
      "kon:blog:delete-post": "Unpublish it instead.",
      "mcp:kitsuden_delete_record": "Archive it.",
    });
    expect(c.legacyRules).toEqual([
      { method: "DELETE", path: "/api/items/**", alternative: "Ask Ana." },
    ]);
  });

  it("null removes an alternative; rules without one stay as they were", () => {
    const withOne = mergeApprovalsConfig(base, { alternatives: { "mcp:x": "a" } });
    const without = mergeApprovalsConfig(withOne, {
      alternatives: { "mcp:x": null },
      unattendedAlternative: null,
    });
    expect(without.alternatives).toEqual({});
    expect(without.unattendedAlternative).toBeNull();
    expect(
      mergeApprovalsConfig(base, { legacyRules: [{ method: "PATCH", path: "/api/x" }] }).legacyRules
    ).toEqual([{ method: "PATCH", path: "/api/x" }]);
  });

  it("refuses what is not valid, with the reason", () => {
    expect(() => mergeApprovalsConfig(base, { unattended: "maybe" })).toThrow(/hold or deny/);
    expect(() => mergeApprovalsConfig(base, { unattendedAlternative: "" })).toThrow(/empty/);
    expect(() =>
      mergeApprovalsConfig(base, { unattendedAlternative: "x".repeat(ALTERNATIVE_MAX + 1) })
    ).toThrow(/at most/);
    expect(() => mergeApprovalsConfig(base, { alternatives: { "not a key": "x" } })).toThrow(
      /operation key/
    );
    expect(() => mergeApprovalsConfig(base, { alternatives: [] as never })).toThrow(/object/);
    expect(invalidRuleReason({ method: "DELETE", path: "/api/**", alternative: 3 })).toMatch(
      /text/
    );
  });

  it("an older stored configuration (without the new keys) reads with the defaults", () => {
    const c = readApprovalsConfig({ enabled: true, ttlHours: 24, operations: {}, legacyRules: [] });
    expect(c.enabled).toBe(true);
    expect(c.unattended).toBe("hold");
    expect(c.alternatives).toEqual({});
  });

  it("the refusal has its entry in the error catalog: 403, not retryable", () => {
    expect(KITSUDEN_ERRORS.KITSUDEN_E_DENIED_UNATTENDED).toMatchObject({
      status: 403,
      retryable: false,
    });
  });
});

describe("kitsuden.effect for the promotion scanner", () => {
  it("is part of the sandbox API: no finding", () => {
    const r = scanCode(
      `const r = await kitsuden.effect("welcome:" + event.id, async () => {
         return kitsuden.api.post("/api/datasets/x/entries", { a: 1 });
       });
       return r;`
    );
    expect(r.findings).toEqual([]);
    expect(r.passed).toBe(true);
    // What it wraps is still classified.
    expect(r.apiCalls).toEqual([{ method: "POST", path: "/api/datasets/x/entries", line: 2 }]);
  });

  it("the fetch inside an effect is still checked against the declared hosts", () => {
    const r = scanCode(`await kitsuden.effect("k", () => fetch("https://evil.example/x"));`, {
      fetchAllow: ["api.example.com"],
    });
    expect(r.findings.map((f) => f.rule)).toContain("undeclared_host");
  });

  it("the prologue's __effect is internal, like __api", () => {
    const r = scanCode(`return __effect("k", async () => 1);`);
    expect(r.findings.map((f) => f.rule)).toContain("forbidden_global");
    expect(r.passed).toBe(false);
  });
});

describe("which action runs are unattended", () => {
  it("cron, event and HTTP triggers have nobody to come back for a proposal; a manual run does", () => {
    expect(unattendedRun({ trigger: "cron" })).toBe(true);
    expect(unattendedRun({ trigger: "event" })).toBe(true);
    expect(unattendedRun({ trigger: "http" })).toBe(true);
    expect(unattendedRun({ trigger: "manual" })).toBe(false);
  });
});
