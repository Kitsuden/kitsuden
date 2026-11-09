/**
 * The pure contract of human approval (@kitsuden/shared)
 *
 * The decision table (operation → agent → global), the legacy route
 * patterns, the configuration validation and the defaults (OFF).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPROVALS_CONFIG,
  KITSUDEN_ERRORS,
  buildProblem,
  mcpToolKey,
  decideApproval,
  isWriteMethod,
  isApprovalMode,
  isReadOnly,
  agentSignature,
  canSign,
  mergeApprovalsConfig,
  defaultSensitiveMcpTool,
  readApprovalsConfig,
  patternRegex,
  legacyHouseRule,
  type ApprovalMode,
} from "../../packages/shared/src/index";

describe("the decision table", () => {
  const cases: [ApprovalMode, boolean, boolean, boolean, string | null][] = [
    // mode, global, sensitive, write → reason
    ["direct", true, true, true, null],
    ["direct", false, true, true, null],
    ["propose", true, false, true, "propose_only"],
    ["propose", true, true, true, "sensitive"],
    ["propose", true, false, false, null],
    ["propose", true, true, false, "sensitive"],
    // The global is the MASTER switch: when off, not even propose holds anything.
    ["propose", false, false, true, null],
    ["propose", false, true, true, null],
    ["inherit", true, true, true, "sensitive"],
    ["inherit", true, false, true, null],
    ["inherit", true, true, false, "sensitive"],
    ["inherit", false, true, true, null],
    ["inherit", false, false, true, null],
  ];
  for (const [mode, globalActive, sensitive, write, expected] of cases) {
    it(`${mode}, global ${globalActive ? "on" : "off"}, ${sensitive ? "sensitive" : "normal"} ${write ? "write" : "read"} → ${expected ?? "directo"}`, () => {
      expect(decideApproval({ mode, globalActive, sensitive, write })).toBe(expected);
    });
  }

  it("holding in propose: selective (the default) lets readOnly POSTs through; strict does not", () => {
    expect(DEFAULT_APPROVALS_CONFIG.proposeRetention).toBe("selective");
    const base = {
      mode: "propose" as const,
      globalActive: true,
      sensitive: false,
      write: true,
      readOnly: true,
    };
    expect(decideApproval(base)).toBeNull();
    expect(decideApproval({ ...base, retention: "selective" })).toBeNull();
    expect(decideApproval({ ...base, retention: "strict" })).toBe("propose_only");
    // readOnly does not lower sensitive nor matter outside propose
    expect(decideApproval({ ...base, sensitive: true })).toBe("sensitive");
    expect(decideApproval({ ...base, mode: "inherit", retention: "strict" })).toBeNull();
  });

  it("isReadOnly: GET always; POST only if it declares so", () => {
    expect(isReadOnly({ method: "GET" })).toBe(true);
    expect(isReadOnly({ method: "POST" })).toBe(false);
    expect(isReadOnly({ method: "POST", readOnly: true })).toBe(true);
    expect(isReadOnly({ method: "PATCH", readOnly: true })).toBe(false);
  });

  it("by default it is OFF and every agent is on inherit: nothing is held", () => {
    expect(DEFAULT_APPROVALS_CONFIG.enabled).toBe(false);
    for (const sensitive of [true, false]) {
      for (const write of [true, false]) {
        expect(
          decideApproval({
            mode: "inherit",
            globalActive: DEFAULT_APPROVALS_CONFIG.enabled,
            sensitive,
            write,
          })
        ).toBeNull();
      }
    }
  });

  it("write = POST/PUT/PATCH/DELETE", () => {
    expect(["POST", "put", "PATCH", "delete"].every(isWriteMethod)).toBe(true);
    expect(["GET", "HEAD", "OPTIONS"].some(isWriteMethod)).toBe(false);
    expect(isApprovalMode("propose")).toBe(true);
    expect(isApprovalMode("admin")).toBe(false);
  });
});

describe("legacy route rules", () => {
  it("* is one segment and ** is the rest", () => {
    expect(patternRegex("/api/**").test("/api/items/clients/1")).toBe(true);
    expect(patternRegex("/api/games/*").test("/api/games/zelda")).toBe(true);
    expect(patternRegex("/api/games/*").test("/api/games/zelda/blocks")).toBe(false);
    expect(patternRegex("/api/games/*/blocks/**").test("/api/games/z/blocks/1/editorial")).toBe(
      true
    );
    // No expressions sneaking in through the pattern
    expect(patternRegex("/api/a.b").test("/api/axb")).toBe(false);
  });

  it("exact method or *, and the trailing slash does not count", () => {
    const r = { method: "DELETE", path: "/api/**" };
    expect(legacyHouseRule(r, "delete", "/api/items/x/1")).toBe(true);
    expect(legacyHouseRule(r, "PATCH", "/api/items/x/1")).toBe(false);
    expect(legacyHouseRule({ method: "*", path: "/api/crm/*" }, "POST", "/api/crm/contacts/")).toBe(
      true
    );
  });

  it("by default: every DELETE under /api is sensitive also outside the SDK", () => {
    expect(DEFAULT_APPROVALS_CONFIG.legacyRules).toEqual([{ method: "DELETE", path: "/api/**" }]);
  });
});

describe("validating and merging the configuration", () => {
  const base = DEFAULT_APPROVALS_CONFIG;

  it("changes only what is sent; null returns an operation to what was declared", () => {
    const a = mergeApprovalsConfig(base, {
      enabled: true,
      operations: { "kon:blog:delete-post": false },
    });
    expect(a).toMatchObject({
      enabled: true,
      ttlHours: 168,
      operations: { "kon:blog:delete-post": false },
    });
    const b = mergeApprovalsConfig(a, {
      operations: { "kon:blog:delete-post": null, "mcp:kitsuden_insert_record": true },
    });
    expect(b.operations).toEqual({ "mcp:kitsuden_insert_record": true });
    expect(base.operations).toEqual({}); // the base is not mutated
  });

  it("rejects with the reason whatever is not valid", () => {
    expect(() => mergeApprovalsConfig(base, { enabled: "yes" })).toThrow(/enabled/);
    expect(() => mergeApprovalsConfig(base, { proposeRetention: "everything" })).toThrow(
      /proposeRetention/
    );
    expect(mergeApprovalsConfig(base, { proposeRetention: "strict" }).proposeRetention).toBe(
      "strict"
    );
    expect(() => mergeApprovalsConfig(base, { ttlHours: 0 })).toThrow(/ttlHours/);
    expect(() => mergeApprovalsConfig(base, { ttlHours: 721 })).toThrow(/ttlHours/);
    expect(() => mergeApprovalsConfig(base, { operations: { admin: true } })).toThrow(
      /operation key/
    );
    expect(() => mergeApprovalsConfig(base, { operations: { "kon:blog:x": "yes" } })).toThrow(
      /true, false or null/
    );
    expect(() =>
      mergeApprovalsConfig(base, { legacyRules: [{ method: "TRACE", path: "/api/x" }] })
    ).toThrow(/method/);
    expect(() =>
      mergeApprovalsConfig(base, { legacyRules: [{ method: "GET", path: "/other" }] })
    ).toThrow(/\/api\//);
  });

  it("normalizes the rules (method in uppercase, no spaces)", () => {
    const c = mergeApprovalsConfig(base, {
      legacyRules: [{ method: " patch ", path: " /api/games/* " }],
    });
    expect(c.legacyRules).toEqual([{ method: "PATCH", path: "/api/games/*" }]);
  });

  it("what is stored is read defensively: something broken becomes the defaults", () => {
    expect(readApprovalsConfig(null)).toEqual(base);
    expect(readApprovalsConfig({ enabled: "broken" })).toEqual(base);
    expect(readApprovalsConfig({ enabled: true }).enabled).toBe(true);
  });
});

describe("core MCP tools and the error catalog", () => {
  it("by default the ones that delete are sensitive", () => {
    expect(defaultSensitiveMcpTool("kitsuden_delete_record")).toBe(true);
    expect(defaultSensitiveMcpTool("kitsuden_insert_record")).toBe(false);
    expect(mcpToolKey("kitsuden_delete_record")).toBe("mcp:kitsuden_delete_record");
  });

  it("KITSUDEN_E_APPROVAL_REQUIRED is a non-retryable 202; UNSUPPORTED a 403", () => {
    expect(KITSUDEN_ERRORS.KITSUDEN_E_APPROVAL_REQUIRED).toMatchObject({
      status: 202,
      retryable: false,
    });
    expect(KITSUDEN_ERRORS.KITSUDEN_E_APPROVAL_UNSUPPORTED).toMatchObject({
      status: 403,
      retryable: false,
    });
    const p = buildProblem({
      code: "KITSUDEN_E_APPROVAL_REQUIRED",
      extensions: { proposal: { id: "x" } },
    });
    expect(p).toMatchObject({ status: 202, retry_after: null, proposal: { id: "x" } });
    expect(p.docs).toMatch(/#kitsuden_e_approval_required$/);
  });
});

describe("an agent's human signer (agentSignature)", () => {
  const valid = { userId: "u-signer", valid: true };
  const agent = (extra: Record<string, unknown> = {}) => ({
    role: "agent",
    scopes: ["blog:*"],
    ...extra,
  });

  it("a human: what was asked, as is", () => {
    expect(agentSignature({ role: "editor" }, "other", "requested")).toMatchObject({
      ok: true,
      author: "other",
      why: "human",
    });
  });

  it("without a signer: as before (blog accepts what was asked; datasets, ownerless except for admin)", () => {
    expect(agentSignature(agent(), "x", "requested")).toMatchObject({ ok: true, author: "x" });
    expect(agentSignature(agent(), undefined, "requested")).toMatchObject({
      ok: true,
      author: null,
    });
    expect(agentSignature(agent(), "x", "nobody")).toMatchObject({ ok: true, author: null });
    expect(agentSignature(agent({ scopes: ["admin"] }), "x", "nobody")).toMatchObject({
      ok: true,
      author: "x",
    });
  });

  it("with a signer: they sign; another author only with admin", () => {
    expect(agentSignature(agent({ sponsor: valid }), undefined, "requested")).toMatchObject({
      ok: true,
      author: "u-signer",
      why: "sponsor",
    });
    expect(agentSignature(agent({ sponsor: valid }), "u-signer", "nobody")).toMatchObject({
      ok: true,
      author: "u-signer",
    });
    expect(agentSignature(agent({ sponsor: valid }), "other", "requested")).toMatchObject({
      ok: false,
      code: "KITSUDEN_E_FORBIDDEN",
    });
    expect(
      agentSignature(agent({ sponsor: valid, scopes: ["admin"] }), "other", "requested")
    ).toMatchObject({ ok: true, author: "other" });
  });

  it("signer who is no longer valid: 403 SPONSOR_INVALID until reassigned", () => {
    const low = { userId: "u-departed", valid: false, reason: "not_staff" };
    expect(agentSignature(agent({ sponsor: low }), undefined, "requested")).toMatchObject({
      ok: false,
      code: "KITSUDEN_E_AGENT_SPONSOR_INVALID",
    });
    expect(agentSignature(agent({ sponsor: low }), "u-departed", "nobody")).toMatchObject({
      ok: false,
      code: "KITSUDEN_E_AGENT_SPONSOR_INVALID",
    });
    expect(canSign("editor")).toBe(true);
    expect(canSign("user")).toBe(false);
  });
});
