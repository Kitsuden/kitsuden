/**
 * Who gets a magic link (better-auth `magicLink`, wired in lib/auth.ts)
 * ============================================================================
 *
 * Decided BEFORE anything is queued, and the caller always gets the same
 * `{ status: true }`: answering "no such account" would let anyone test which
 * addresses are registered.
 *
 *   · an account with two-factor sign-in: no. A link only proves that you can
 *     read the mailbox; for those accounts that is one factor, not two.
 *   · no account, and sign-up closed (`KITSUDEN_SIGNUP`, signup-mode.ts) or no
 *     administrator yet (first-run.ts): no. The link could not create the
 *     account anyway (`disableSignUp`), and sending it would turn the API into a
 *     mail cannon aimed at strangers' inboxes.
 *   · anything else: yes.
 *
 * Pure: `firstRunRefuses` is passed in so the rule is testable without a database.
 */

export type MagicLinkRefusal = "two-factor" | "sign-up-closed";

export async function magicLinkRefusal(
  user: { twoFactorEnabled?: boolean | null } | null | undefined,
  options: { signUpClosed: boolean; firstRunRefuses: () => Promise<boolean> }
): Promise<MagicLinkRefusal | null> {
  if (user) return user.twoFactorEnabled ? "two-factor" : null;
  if (options.signUpClosed) return "sign-up-closed";
  return (await options.firstRunRefuses()) ? "sign-up-closed" : null;
}
