/**
 * The approvals inbox, apart from its markup: what a key press means, how a proposal is
 * told as a tallao ApprovalCard, and which selected proposals a bulk approval can run.
 */
import { proposalChanges, type Change, type ProposalLike } from "$lib/list/history";

export type InboxAction =
  { type: "move"; id: string } | { type: "approve" } | { type: "reject" } | null;

export interface InboxKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface InboxKeyContext {
  /** The proposals of the list, in the order shown. */
  ids: string[];
  /** The open proposal, or null. */
  currentId: string | null;
  /** The open proposal waits and this person may approve / reject it. */
  canApprove: boolean;
  canReject: boolean;
  /** The key was pressed in a field, or a dialog is in front: shortcuts stay out. */
  blocked: boolean;
}

/**
 * `j` / `k` move to the next / previous proposal (from nothing: the first / the last),
 * `a` approves and `r` rejects the open one. Anything with a modifier is not ours.
 */
export function inboxKeyAction(event: InboxKey, ctx: InboxKeyContext): InboxAction {
  if (ctx.blocked || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "j" || key === "k") {
    if (ctx.ids.length === 0) return null;
    const at = ctx.currentId ? ctx.ids.indexOf(ctx.currentId) : -1;
    const next =
      key === "j"
        ? at < 0
          ? 0
          : Math.min(at + 1, ctx.ids.length - 1)
        : at < 0
          ? ctx.ids.length - 1
          : Math.max(at - 1, 0);
    const id = ctx.ids[next]!;
    return id === ctx.currentId ? null : { type: "move", id };
  }
  if (key === "a") return ctx.canApprove ? { type: "approve" } : null;
  if (key === "r") return ctx.canReject ? { type: "reject" } : null;
  return null;
}

export interface CardProposal extends ProposalLike {
  tool?: string | null;
  operation?: string | null;
  decidedBy?: string | null;
  diff?: (NonNullable<ProposalLike["diff"]> & { arguments?: unknown }) | null;
}

export interface CardProps {
  title: string;
  requester?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  outcome?: string;
  changes?: Change[];
  tool?: string;
  args?: Record<string, unknown>;
  risk?: string;
  riskLevel: "low" | "medium" | "high";
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** What the request would do, as one sentence, from its method and target. */
export function proposalTitle(p: CardProposal, t: Translate): string {
  if (p.tool) return t("inbox.titleTool", { tool: p.tool });
  const target = p.path;
  switch (p.method.toUpperCase()) {
    case "POST":
      return t("inbox.titleCreate", { target });
    case "PUT":
    case "PATCH":
      return t("inbox.titleUpdate", { target });
    case "DELETE":
      return t("inbox.titleDelete", { target });
    default:
      return t("inbox.titleOther", { method: p.method, target });
  }
}

/**
 * A proposal as ApprovalCard props. The card knows four states: a proposal that ran (or
 * failed while running) was approved; the outcome line says which.
 *
 * `ledger`: the proposal has a per-field diff the inbox draws itself (with a checkbox per
 * field), so the card does not repeat it as `changes`.
 */
export function approvalCardProps(
  p: CardProposal,
  t: Translate,
  formatDate: (iso: string | null) => string,
  { ledger = false }: { ledger?: boolean } = {}
): CardProps {
  const status: CardProps["status"] =
    p.status === "pending"
      ? "pending"
      : p.status === "rejected"
        ? "rejected"
        : p.status === "expired"
          ? "expired"
          : "approved";

  let outcome: string | undefined;
  if (status !== "pending") {
    const word =
      p.status === "executed"
        ? t("approvals.status_executed")
        : p.status === "failed"
          ? t("approvals.status_failed")
          : p.status === "executing"
            ? t("approvals.status_executing")
            : p.status === "rejected"
              ? t("approvals.status_rejected")
              : t("approvals.status_expired");
    const who = p.decidedByName ?? p.decidedBy ?? null;
    outcome = who
      ? t("inbox.outcomeBy", { status: word, name: who, date: formatDate(p.decidedAt) })
      : word;
  }

  const isTool = p.diff?.kind === "tool";
  const args = isTool ? p.diff?.arguments : undefined;
  const isDelete = p.method.toUpperCase() === "DELETE";

  return {
    title: proposalTitle(p, t),
    requester: p.agentName ?? t("approvals.agentDeleted"),
    status,
    outcome,
    changes: ledger || isTool || p.diff?.kind === "promotion" ? undefined : proposalChanges(p),
    tool: isTool ? (p.tool ?? undefined) : undefined,
    args:
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined,
    risk: isDelete ? t("inbox.riskDelete") : undefined,
    riskLevel: isDelete ? "high" : "medium",
  };
}

/** Of the checked proposals, the ones that still wait (only those can be approved). */
export function bulkApprovable<T extends { id: string; status: string }>(
  list: readonly T[],
  selected: readonly string[]
): T[] {
  const chosen = new Set(selected);
  return list.filter((p) => chosen.has(p.id) && p.status === "pending");
}

/** "3 approved, 1 failed" from the settled results of a bulk approval. */
export function bulkSummary(results: Array<"executed" | "failed" | "error">): {
  executed: number;
  failed: number;
} {
  const executed = results.filter((r) => r === "executed").length;
  return { executed, failed: results.length - executed };
}
