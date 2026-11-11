/**
 * Which proposal to show after one was decided.
 *
 * Deciding left the reviewer on the proposal just closed, so working through a queue was
 * "decide, look for the next row, click it" every time. After a decision the inbox moves to
 * the next one that still waits: the one below in the list, or the one above when the
 * decided proposal was the last.
 */
export interface Decidable {
  id: string;
  status: string;
}

/**
 * The id of the next pending proposal after `decidedId`, in the order of `list` as it was
 * on screen when the decision was made; null when nothing else is pending.
 */
export function nextPendingAfter(list: readonly Decidable[], decidedId: string): string | null {
  const at = list.findIndex((p) => p.id === decidedId);
  const pending = (p: Decidable) => p.id !== decidedId && p.status === "pending";
  if (at < 0) return list.find(pending)?.id ?? null;
  const below = list.slice(at + 1).find(pending);
  if (below) return below.id;
  // Nothing below: the closest one above.
  for (let i = at - 1; i >= 0; i--) {
    if (pending(list[i]!)) return list[i]!.id;
  }
  return null;
}
