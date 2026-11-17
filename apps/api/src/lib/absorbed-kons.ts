/**
 * Kons that became part of the core
 * ============================================================================
 *
 * A kon that moved into Kitsuden keeps its id, routes, scopes and tables, and the core serves them. An
 * installation that still has the old kon in `packages/kons` must not mount it a second time on the same
 * path: the loader skips it and says how to remove it. Its data is the core's now; nothing is lost.
 */

export const ABSORBED_KONS: Record<string, { since: string; docs: string }> = {
  "kon-analytics": { since: "0.9.0", docs: "docs/analytics.md" },
};

/** Why an installed kon is not mounted, or `null` when it is not one the core absorbed. */
export function absorbedReason(konId: string): string | null {
  const entry = ABSORBED_KONS[konId];
  if (!entry) return null;
  const short = konId.replace(/^kon-/, "");
  return `${konId} is part of Kitsuden since ${entry.since} (${entry.docs}): the installed kon is not mounted. Remove it with "kitsuden kon remove ${short}"; its data stays.`;
}
