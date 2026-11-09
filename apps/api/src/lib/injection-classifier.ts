/**
 * Prompt injection classifier: a SECOND opinion (plan D5)
 * ============================================================================
 *
 * The defense against a manipulated agent is human approval of anything
 * sensitive. This complements it, it does not replace it: with
 * `INJECTION_CLASSIFIER_URL`, each new proposal is sent in the background
 * (queue `kitsuden-injection-classifier`) to a local text classifier and its
 * verdict is stored in `agent_proposals.injection_check`, so that the reviewer
 * sees it next to the diff. It never approves or rejects: a classifier has
 * false negatives, and one that decided alone would be a single point of failure.
 *
 * The service: a small utility model on your network (e.g. a DeBERTa for
 * injection detection served by text-embeddings-inference or a custom
 * server). Contract: `POST {url}` with `{ "inputs": "<text>" }` and response
 * `{ label, score }` or `[{ label, score }, …]` (the Hugging Face
 * classification format). The highest-scoring label is taken.
 */

import { eq } from "drizzle-orm";

import { PermanentError, queue, type QueueJob } from "../../../../packages/engine/src/queue";
import { db } from "../db";
import { agentProposals } from "../db/schema-core";

import { logger } from "./logger";

export const CLASSIFIER_QUEUE = "kitsuden-injection-classifier";
const MAX_TEXT = 20_000;

export function configuredClassifier(): boolean {
  return Boolean(process.env.INJECTION_CLASSIFIER_URL);
}

/** Enqueues the classification of a new proposal (if there is a classifier). */
export async function enqueueClassification(proposalId: string): Promise<void> {
  if (!configuredClassifier()) return;
  try {
    await queue.dispatch(CLASSIFIER_QUEUE, "proposal", { proposalId }, { attempts: 4 });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), proposalId },
      "[classifier] could not enqueue"
    );
  }
}

/** All the text a model could have put into the request. */
export function textOf(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 12 || output.join(" ").length > MAX_TEXT) return output;
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const v of value) textOf(v, output, depth + 1);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) textOf(v, output, depth + 1);
  }
  return output;
}

/** The highest-scoring label of a classification response. */
export function verdictOf(response: unknown): { label: string; score: number } | null {
  const list = (Array.isArray(response) ? response.flat() : [response]) as Array<{
    label?: unknown;
    score?: unknown;
  }>;
  const valid = list.filter(
    (x) => typeof x?.label === "string" && typeof x?.score === "number"
  ) as Array<{
    label: string;
    score: number;
  }>;
  if (!valid.length) return null;
  return valid.reduce((a, b) => (b.score > a.score ? b : a));
}

export async function classifyProposal(job: QueueJob): Promise<void> {
  const id = (job.payload as { proposalId?: string })?.proposalId;
  if (!id) throw new PermanentError("job without a proposal");
  const [p] = await db
    .select({ body: agentProposals.body, path: agentProposals.path, tool: agentProposals.tool })
    .from(agentProposals)
    .where(eq(agentProposals.id, id))
    .limit(1);
  if (!p) return;
  const text = textOf(p.body).join("\n").slice(0, MAX_TEXT).trim();
  if (!text) return;
  const res = await fetch(process.env.INJECTION_CLASSIFIER_URL!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the classifier responded ${res.status}`);
  const v = verdictOf(await res.json());
  if (!v) throw new PermanentError("the classifier did not return { label, score }");
  await db
    .update(agentProposals)
    .set({
      injectionCheck: { label: v.label, score: v.score, checkedAt: new Date().toISOString() },
    })
    .where(eq(agentProposals.id, id));
}

export function registerClassifier(): void {
  queue.handle(CLASSIFIER_QUEUE, classifyProposal, { concurrency: 2 });
}
