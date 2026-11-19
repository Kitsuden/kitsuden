#!/usr/bin/env bun
/**
 * Verify the agent audit hash chain from a shell
 * ============================================================================
 *
 *   cd apps/api && bun run scripts/verify-audit.ts [--from <seq>] [--to <seq>] [--expect-head <row_hash>]
 *
 * Walks `agent_audit_logs` (lib/audit-chain.ts): gapless `seq`, every
 * `prev_hash`, every `row_hash` recomputed from the stored fields, every MAC,
 * and the checkpoint left by a retention prune. Prints the result as JSON and
 * exits 1 when anything does not verify.
 *
 * `--expect-head` compares the chain head with a value you anchored outside the
 * database (e.g. yesterday's `[audit] chain head` log line): the only way to
 * notice that the newest rows were removed all together.
 *
 * Reads DATABASE_URL and KITSUDEN_SECRETS_KEY (and KITSUDEN_SECRETS_KEY_OLD
 * after a rotation) like the API. See docs/agents/audit-chain.md.
 */

import { auditChainHead, verifyAuditChain } from "../src/lib/audit-chain";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function seq(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a positive integer`);
    process.exit(2);
  }
  return n;
}

const result = await verifyAuditChain({ fromSeq: seq("--from"), toSeq: seq("--to") });
let ok = result.ok;
const expected = flag("--expect-head")?.toLowerCase();
let headMatches: boolean | undefined;
if (expected) {
  const head = await auditChainHead();
  // The anchored link must still be in the chain with the same hash: the head
  // may have moved on since, so look the anchored row up by its hash.
  headMatches = head?.rowHash === expected || (await anchoredStillThere(expected));
  ok = ok && headMatches;
}

console.log(
  JSON.stringify({ ...result, ...(expected ? { anchoredHeadFound: headMatches } : {}) }, null, 2)
);
process.exit(ok ? 0 : 1);

async function anchoredStillThere(hash: string): Promise<boolean> {
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  const r = (await db.execute(
    sql`SELECT 1 FROM agent_audit_logs WHERE row_hash = ${hash}
        UNION ALL SELECT 1 FROM agent_audit_checkpoints WHERE row_hash = ${hash} LIMIT 1`
  )) as unknown as { rows?: unknown[] } | unknown[];
  const rows = Array.isArray(r) ? r : (r.rows ?? []);
  return rows.length > 0;
}
