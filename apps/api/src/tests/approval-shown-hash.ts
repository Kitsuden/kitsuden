/**
 * Approving as the panel does: with the `operationHash` it was shown
 * ============================================================================
 *
 * Since migration 0087 an approval must carry the `operationHash` of the
 * proposal the human was shown (lib/operation-hash.ts, docs/agents/approvals.md
 * "Binding"). The panel reads it from the proposal detail and sends it back.
 * Suites that test something else (the ledger, uploads, promotion, signers)
 * approve through this helper so that their requests look like the panel's;
 * approval-binding.test.ts tests the binding itself (missing, wrong, tampered).
 */

import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentProposals } from "../db/schema";

const APPROVE = /^\/api\/approvals\/proposals\/([0-9a-f-]{36})\/approve$/i;

/**
 * The body of `method path`, with the proposal's current `operationHash` added
 * when it is an approval that does not carry one. Anything else is returned as is.
 */
export async function withShownHash(method: string, path: string, body: unknown): Promise<unknown> {
  const m = method.toUpperCase() === "POST" ? APPROVE.exec(path) : null;
  if (!m) return body;
  const given = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if ("operationHash" in (given as Record<string, unknown>)) return body;
  const [row] = await db
    .select({ hash: agentProposals.operationHash })
    .from(agentProposals)
    .where(eq(agentProposals.id, m[1]!))
    .limit(1);
  return row?.hash ? { ...(given as Record<string, unknown>), operationHash: row.hash } : body;
}
