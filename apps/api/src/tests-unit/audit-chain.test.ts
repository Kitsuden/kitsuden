/**
 * Audit hash chain (lib/audit-chain.ts), the pure parts: canonical form, row
 * hash, MAC and the walk over rows. The database side is in
 * src/tests/audit-chain.test.ts.
 */

import { describe, expect, test } from "bun:test";

import {
  auditKeyFromMaster,
  auditKeyring,
  canonicalJson,
  GENESIS_HASH,
  macOf,
  rowHash,
  startState,
  verifyRows,
  type AuditedFields,
  type StoredChainRow,
} from "../lib/audit-chain";

const env = { KITSUDEN_SECRETS_KEY: "unit-test-secrets-key-not-real-0123456789" };

type ChainRow = AuditedFields & StoredChainRow & { seq: number; prevHash: string; rowHash: string };

function chain(n: number, keyEnv: Record<string, string> = env): ChainRow[] {
  const key = auditKeyFromMaster(keyEnv.KITSUDEN_SECRETS_KEY!);
  const rows: ChainRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const f: AuditedFields = {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      seq: i,
      createdAt: new Date(Date.UTC(2026, 10, 18, 12, 0, i)),
      agentId: "agent-1",
      keyId: null,
      action: "tool_call",
      resource: "tool",
      resourceId: `t${i}`,
      details: { b: 2, a: [1, { z: true, y: null }] },
      ipAddress: null,
      userAgent: null,
      durationMs: i,
      success: true,
      errorMessage: null,
      prevHash: prev,
    };
    const hash = rowHash(f);
    rows.push({ ...f, rowHash: hash, mac: macOf(key.key, hash), keyVersion: key.version });
    prev = hash;
  }
  return rows;
}

describe("canonical form", () => {
  test("key order does not change the hash; values do", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
    );
    const [r] = chain(1);
    const same = { ...r!, details: { a: [1, { y: null, z: true }], b: 2 } };
    expect(rowHash(same)).toBe(r!.rowHash!);
    expect(rowHash({ ...r!, details: { a: [1], b: 2 } })).not.toBe(r!.rowHash!);
  });
});

describe("walking the chain", () => {
  const keyring = auditKeyring(env);

  test("an intact chain verifies", () => {
    const state = startState(1, GENESIS_HASH);
    expect(verifyRows(chain(5), state, keyring)).toBeNull();
    expect(state.checked).toBe(5);
  });

  test("an edited field is found at its seq", () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, resourceId: "changed" };
    expect(verifyRows(rows, startState(1, GENESIS_HASH), keyring)).toMatchObject({
      reason: "hash_mismatch",
      firstBadSeq: 3,
    });
  });

  test("a removed row is a gap; a re-linked forgery fails its MAC", () => {
    const rows = chain(5);
    expect(
      verifyRows([...rows.slice(0, 2), ...rows.slice(3)], startState(1, GENESIS_HASH), keyring)
    ).toMatchObject({
      reason: "seq_gap",
      firstBadSeq: 3,
    });
    // An attacker without the key recomputes the hash but cannot sign it.
    const forged = { ...rows[1]!, resourceId: "forged" };
    forged.rowHash = rowHash(forged);
    const f = verifyRows([rows[0]!, forged], startState(1, GENESIS_HASH), keyring);
    expect(f).toMatchObject({ reason: "mac_mismatch", firstBadSeq: 2 });
  });

  test("a chain signed with another key does not verify", () => {
    const other = chain(3, {
      KITSUDEN_SECRETS_KEY: "another-key-entirely-not-the-same-9876543210",
    });
    const f = verifyRows(other, startState(1, GENESIS_HASH), keyring);
    expect(f?.reason).toBe("mac_mismatch");
  });

  test("after a rotation the old key still verifies older rows", () => {
    const old = chain(2);
    const ring = auditKeyring({
      KITSUDEN_SECRETS_KEY: "the-new-secrets-key-after-rotation-000000",
      KITSUDEN_SECRETS_KEY_OLD: env.KITSUDEN_SECRETS_KEY,
    });
    expect(verifyRows(old, startState(1, GENESIS_HASH), ring)).toBeNull();
  });
});
