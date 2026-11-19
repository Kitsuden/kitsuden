/**
 * The canonical operation hash and the approval MAC (lib/operation-hash.ts)
 * ============================================================================
 *
 * What the binding of an approval depends on: the same operation always gives
 * the same hash, whatever order `jsonb` returns the keys in; any change to what
 * would execute changes it; and the MAC only verifies for exactly what was
 * signed, with the same key.
 */

import { describe, expect, it } from "bun:test";

import {
  OPERATION_HASH_VERSION,
  approvalMac,
  canonicalJson,
  decisionsHash,
  operationDocument,
  operationHash,
  sameJson,
  sha256Hex,
  verifyApprovalMac,
  type ApprovalBinding,
  type OperationInput,
} from "../lib/operation-hash";
import { deriveSubkey } from "../lib/secrets-key";

const base: OperationInput = {
  channel: "rest",
  method: "patch",
  path: "/api/datasets/1/entries/2?x=1",
  contentType: "application/json",
  body: { title: "Hello", data: { b: 2, a: [1, { z: true, y: null }] } },
  tool: null,
  operationKey: "kon:blog:update-post",
  files: [],
};

describe("canonicalJson", () => {
  it("sorts object keys at every depth and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}'
    );
  });

  it("gives the same text for the same value in any key order", () => {
    const one = { x: 1, y: { p: "a", q: [1, 2] } };
    const two = JSON.parse('{"y":{"q":[1,2],"p":"a"},"x":1}');
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it("keeps array order (it is meaningful)", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("follows JSON.stringify for undefined, non-finite numbers, dates and strings", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, () => 1])).toBe("[null,null]");
    expect(canonicalJson({ n: NaN, i: Infinity, z: -0 })).toBe('{"i":null,"n":null,"z":0}');
    expect(canonicalJson(new Date("2026-01-02T03:04:05.000Z"))).toBe('"2026-01-02T03:04:05.000Z"');
    expect(canonicalJson('say "hi"\n ')).toBe(JSON.stringify('say "hi"\n '));
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(null)).toBe("null");
  });

  it("escapes keys like JSON (a key cannot forge structure)", () => {
    expect(canonicalJson({ 'a":1,"b': 2 })).toBe('{"a\\":1,\\"b":2}');
  });

  it("round-trips: parsing the canonical text gives an equal value", () => {
    const v = { z: [1, "two", { three: 3 }], a: null, m: { k: false } };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });

  it("refuses circular structures and BigInt instead of hashing something else", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(/BigInt/);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});

describe("operationHash", () => {
  it("is a stable sha256 of the canonical document", () => {
    const h = operationHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha256Hex(canonicalJson(operationDocument(base))));
    expect(operationDocument(base).v).toBe(OPERATION_HASH_VERSION);
  });

  it("does not depend on key order (what jsonb gives back)", () => {
    const reordered = JSON.parse(JSON.stringify({ data: base.body, x: 1 })).data;
    const flipped = { data: { a: reordered.data.a, b: reordered.data.b }, title: "Hello" };
    expect(operationHash({ ...base, body: flipped })).toBe(operationHash(base));
  });

  it("normalises the method case and absent optional values", () => {
    expect(operationHash({ ...base, method: "PATCH" })).toBe(operationHash(base));
    const a = operationHash({ ...base, tool: undefined, contentType: undefined, files: undefined });
    const b = operationHash({ ...base, tool: null, contentType: null, files: [] });
    expect(a).toBe(b);
  });

  it("changes with every part of the operation", () => {
    const h = operationHash(base);
    const variants: Partial<OperationInput>[] = [
      { channel: "mcp" },
      { method: "PUT" },
      { path: "/api/datasets/1/entries/2?x=2" },
      { path: "/api/datasets/1/entries/3?x=1" },
      { contentType: "application/merge-patch+json" },
      { body: { ...(base.body as object), title: "Hello!" } },
      { body: { title: "Hello", data: { b: 2, a: [{ z: true, y: null }, 1] } } },
      { body: null },
      { tool: "kitsuden_update_record" },
      { operationKey: "kon:blog:delete-post" },
      { files: ["a".repeat(64)] },
    ];
    const seen = new Set([h]);
    for (const v of variants) {
      const other = operationHash({ ...base, ...v });
      expect(other).not.toBe(h);
      seen.add(other);
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  it("depends on the order of the held files", () => {
    const f1 = "1".repeat(64);
    const f2 = "2".repeat(64);
    expect(operationHash({ ...base, files: [f1, f2] })).not.toBe(
      operationHash({ ...base, files: [f2, f1] })
    );
  });

  it("tells a null body from an empty object or string", () => {
    const none = operationHash({ ...base, body: null });
    expect(operationHash({ ...base, body: undefined })).toBe(none);
    expect(operationHash({ ...base, body: {} })).not.toBe(none);
    expect(operationHash({ ...base, body: "" })).not.toBe(none);
  });
});

describe("decisionsHash", () => {
  const diff = { target: { kind: "update" }, fields: [{ field: "title", change: "update" }] };
  const decisions = [{ field: "title", decision: "accept", edited: true, value: "X" }];

  it("covers the decisions and the diff they apply to", () => {
    const h = decisionsHash(decisions, diff);
    expect(decisionsHash(decisions, diff)).toBe(h);
    expect(decisionsHash([{ ...decisions[0], value: "Y" }], diff)).not.toBe(h);
    expect(decisionsHash([{ ...decisions[0], decision: "reject" }], diff)).not.toBe(h);
    expect(decisionsHash(decisions, { ...diff, fields: [] })).not.toBe(h);
    expect(decisionsHash(null, null)).toBe(decisionsHash(undefined, undefined));
  });
});

describe("approvalMac", () => {
  const key = Buffer.alloc(32, 7);
  const binding: ApprovalBinding = {
    proposalId: "6f0b5a5e-0000-4000-8000-000000000001",
    operationHash: operationHash(base),
    decidedBy: "user-1",
    decidedAt: new Date("2026-11-17T10:00:00.123Z"),
    decisionsHash: decisionsHash(null, null),
  };

  it("verifies exactly what was signed", () => {
    const mac = approvalMac(key, binding);
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApprovalMac(key, binding, mac)).toBe(true);
  });

  it("fails for any change of id, hash, approver, time, decisions or key", () => {
    const mac = approvalMac(key, binding);
    const changed: ApprovalBinding[] = [
      { ...binding, proposalId: "6f0b5a5e-0000-4000-8000-000000000002" },
      { ...binding, operationHash: "0".repeat(64) },
      { ...binding, operationHash: null },
      { ...binding, decidedBy: "user-2" },
      { ...binding, decidedAt: new Date("2026-11-17T10:00:00.124Z") },
      { ...binding, decisionsHash: decisionsHash([], null) },
    ];
    for (const b of changed) expect(verifyApprovalMac(key, b, mac)).toBe(false);
    expect(verifyApprovalMac(Buffer.alloc(32, 8), binding, mac)).toBe(false);
  });

  it("rejects a missing or malformed MAC without throwing", () => {
    expect(verifyApprovalMac(key, binding, null)).toBe(false);
    expect(verifyApprovalMac(key, binding, undefined)).toBe(false);
    expect(verifyApprovalMac(key, binding, "zz")).toBe(false);
    expect(verifyApprovalMac(key, binding, "A".repeat(64))).toBe(false);
  });

  it("signs a legacy proposal (no hash) too", () => {
    const legacy = { ...binding, operationHash: null };
    expect(verifyApprovalMac(key, legacy, approvalMac(key, legacy))).toBe(true);
  });
});

describe("the approval subkey", () => {
  it("is derived per label, never the master value, and needs a master value", () => {
    const env = { KITSUDEN_SECRETS_KEY: "k".repeat(64) };
    const a = deriveSubkey("approval-mac", env)!;
    expect(a.length).toBe(32);
    expect(deriveSubkey("approval-mac", env)!.equals(a)).toBe(true);
    expect(deriveSubkey("other-purpose", env)!.equals(a)).toBe(false);
    expect(deriveSubkey("approval-mac", { KITSUDEN_SECRETS_KEY: "j".repeat(64) })!.equals(a)).toBe(
      false
    );
    expect(a.toString("utf8")).not.toContain("kkkk");
    expect(deriveSubkey("approval-mac", {})).toBeNull();
  });
});

describe("sameJson", () => {
  it("compares values, not key order; undefined counts as null", () => {
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson(undefined, null)).toBe(true);
  });
});
