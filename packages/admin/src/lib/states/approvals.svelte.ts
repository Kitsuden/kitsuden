/**
 * The counter of pending proposals shown by the menu.
 *
 * It is requested on entry and every 30 s while someone from the team is in the panel;
 * the inbox refreshes it on deciding. A failure (no permission, API down) keeps the
 * last value: the counter is no reason to show an error.
 */
import { countPendingProposals } from "$lib/services/approvals";

const status = $state({ pendingItems: 0 });
let interval: ReturnType<typeof setInterval> | null = null;

export const approvals = {
  get pendingItems() {
    return status.pendingItems;
  },
  async refresh(): Promise<void> {
    try {
      status.pendingItems = await countPendingProposals();
    } catch {
      /* the last one stays */
    }
  },
  /** Starts watching; returns how to stop. */
  watch(ms = 30_000): () => void {
    void this.refresh();
    if (!interval) interval = setInterval(() => void this.refresh(), ms);
    return () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
  },
};
