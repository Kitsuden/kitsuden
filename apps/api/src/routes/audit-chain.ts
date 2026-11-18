/**
 * /api/admin/audit — verify the agent audit hash chain
 * ============================================================================
 *
 *   GET /api/admin/audit/verify   walks the chain (or `fromSeq..toSeq`) and says
 *                                 whether every row still hashes, links and
 *                                 carries a valid MAC; the first bad seq if not
 *   GET /api/admin/audit/head     the newest link (seq, row_hash, mac): the value
 *                                 to anchor outside the database
 *
 * Human administrators only: `/api/admin/*` goes through `requireAdminRole`,
 * and an agent stays out (HUMANS_ONLY): the log it would check records it.
 * Design: lib/audit-chain.ts and docs/agents/audit-chain.md. The same check
 * from a shell: `bun run scripts/verify-audit.ts` (apps/api).
 */

import { defineOperation } from "@kitsuden/shared";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { auditChainHead, verifyAuditChain } from "../lib/audit-chain";
import { registerCoreOperations } from "../lib/core-operations";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { requireAdminRole } from "../middleware/auth-guard";

import { humansOnly } from "./approvals";

export const AUDIT_CHAIN_ROUTE = "/api/admin/audit";

const fromAdmin = {
  access: "session" as const,
  permission: { roles: ["admin"] },
  before: [requireAdminRole as unknown as MiddlewareHandler, humansOnly],
  mcp: {
    exclude: "Operations panel for administrators: a human checks the agents' audit log.",
  },
  tags: ["audit"],
};
const Obj = z.record(z.string(), z.unknown());
const Seq = z.coerce.number().int().min(1).optional();

export const auditChainOperations: AnyOperation[] = [
  defineOperation({
    ...fromAdmin,
    id: "verify-audit-chain",
    method: "GET",
    route: "/verify",
    summary: "Verify the agent audit chain (admin)",
    description:
      "Recomputes every chained row of the agent audit log: seq without gaps, prev_hash, row_hash and MAC, and the checkpoint the chain starts from after a retention prune. Answers ok, rows checked, the first bad seq and the reason (hash_mismatch, mac_mismatch, seq_gap, prev_hash_mismatch, checkpoint_mismatch), the number of legacy (unchained) rows and the head.",
    input: { query: z.object({ fromSeq: Seq, toSeq: Seq }) },
    output: { schema: Obj },
    handle: async ({ query }) => {
      const q = query as { fromSeq?: number; toSeq?: number };
      return (await verifyAuditChain({ fromSeq: q.fromSeq, toSeq: q.toSeq })) as unknown as Record<
        string,
        unknown
      >;
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "audit-chain-head",
    method: "GET",
    route: "/head",
    summary: "Head of the agent audit chain (admin)",
    description:
      "The newest link of the agent audit chain (seq, row_hash, mac, key version, time), or null if nothing was chained yet. Store it outside the database (a ticket, a log service, a signed commit) to detect later the removal of the newest rows.",
    output: { schema: z.object({ head: Obj.nullable() }) },
    handle: async () => ({
      head: (await auditChainHead()) as unknown as Record<string, unknown> | null,
    }),
  }),
];

registerCoreOperations({
  konId: "kon-audit",
  mountPath: AUDIT_CHAIN_ROUTE,
  description: "The agent audit hash chain: verify it and read its head (administrators only).",
  operations: auditChainOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const auditChainRoutes = operationsRouter("kon-audit", auditChainOperations, context);
