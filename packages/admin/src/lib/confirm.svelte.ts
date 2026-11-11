/**
 * One confirmation dialog for the whole panel.
 *
 * `confirmDialog()` returns a promise, so a caller that used the browser's `confirm()`
 * keeps its shape: `if (!(await confirmDialog({ … }))) return;`. The dialog itself is
 * tallao's ConfirmDialog, mounted once by `ConfirmHost` in the root layout: role, focus
 * trap, Escape and focus back on the trigger come from there.
 */
export interface ConfirmOptions {
  title: string;
  /** What will happen, in a sentence. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` (the default) for anything that deletes or revokes. */
  variant?: "primary" | "danger";
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const state = $state<{ current: Pending | null }>({ current: null });

/** The request on screen, for ConfirmHost. */
export function pendingConfirm(): Pending | null {
  return state.current;
}

/** Asks; resolves `true` on confirm and `false` on Cancel, Escape, the X or a click outside. */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === "string" ? { title: options } : options;
  // A second question while one is open: the first counts as cancelled.
  state.current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    state.current = { ...opts, resolve };
  });
}

/** Called by ConfirmHost with the user's answer. */
export function settleConfirm(ok: boolean): void {
  const current = state.current;
  if (!current) return;
  state.current = null;
  current.resolve(ok);
}
