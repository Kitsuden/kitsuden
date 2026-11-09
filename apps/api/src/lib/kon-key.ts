/**
 * A kon's identity: just one, even if it is written two ways
 * ============================================================================
 *
 * The `modules` table and the manifests do NOT use the same form. The
 * kon-games manifest declares `"id": "kon-games"`, and in the database its row is called `games`,
 * from when the core modules carried no prefix. Both forms
 * refer to the SAME kon.
 *
 * `lib/seed-modules.ts` already normalized this way so as not to create a second row
 * when seeding, and wrote it down: without normalizing it would have ended up with "the same kon
 * with two identities and two contradictory states".
 *
 * That is exactly what kept happening in the other two directions:
 *
 *   · WHEN READING (`GET /api/modules`) the kon came out TWICE —`kon-blog`
 *     on next to `blog` off— because the grimoire list built
 *     its key by stripping the prefix and nothing joined them again.
 *   · WHEN WRITING (`PATCH /api/modules/:key`) the `where(key = ...)` was exact,
 *     so turning on the form that had no row INSERTED a second one.
 *
 * That is why the rule lives here and not repeated in each place: each copy is one more
 * chance for one of them to fall behind.
 */

/** Canonical form for comparing: without the `kon-` prefix. */
export function canonicalKey(id: string): string {
  return id.replace(/^kon-/, "");
}

/** Do these two keys name the same kon? */
export function isSameKon(a: string, b: string): boolean {
  return canonicalKey(a) === canonicalKey(b);
}

/**
 * Looks up a kon's entry in a collection, whether it comes with a prefix or without.
 *
 * It prefers the EXACT match: if both rows exist —`games` and
 * `kon-games`—, the one requested wins. Only when there is no exact one does it fall back to the
 * canonical one, which is the case for inherited rows.
 */
export function searchByKonKey<T>(byKey: Map<string, T>, id: string): T | undefined {
  const exact = byKey.get(id);
  if (exact !== undefined) return exact;

  const canonical = canonicalKey(id);
  for (const [k, v] of byKey) {
    if (canonicalKey(k) === canonical) return v;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE ENTRY PER KON IN THE KONS VIEW
// ═══════════════════════════════════════════════════════════════════════════

export interface KonInput {
  key: string;
  grimoireId?: string | null;
  /** ALL the grimoires that include this kon, not just the first. */
  grimoireIds?: string[];
  isGrimoireActive?: boolean;
  enabledByGrimoire?: boolean;
  sidebarBadge?: string | null;
  [key: string]: unknown;
}

/**
 * Merges the entries that come from the grimoires with those of the registry.
 *
 * ── THE TWO VIEWS DO NOT HAVE THE SAME RULE ────────────────────────────────
 *
 * In the GRIMOIRES view a kon can appear in several: `kon-dms` is included by
 * Corporate, SharePoint and VekDocs at once, and that is correct — each one
 * needs it and each one's card must reflect it.
 *
 * In the KONS view that same kon is ONE. Three cards with three
 * switches for the same thing mean nothing, and the first version of
 * the screen even showed them.
 *
 * ── WHY `grimoireIds` AND NOT `grimoireId` ─────────────────────────────────
 *
 * When merging you must keep ONE entry but NOT just one grimoire.
 * The previous version did `grimoireId ?? g.grimoireId`: it kept the
 * first one to arrive and `kon-dms` appeared as if it belonged only to Corporate.
 * With seven shared kons today, that is lying on the badge of seven.
 */
export function mergeByKon<T extends KonInput>(
  ofTheRecord: T[],
  fromGrimoires: T[]
): { record: T[]; grimoireOnly: T[] } {
  const byKon = new Map<string, T>();
  for (const e of ofTheRecord) byKon.set(canonicalKey(e.key), e);

  const grimoireOnly: T[] = [];

  for (const g of fromGrimoires) {
    const alreadyIs = byKon.get(canonicalKey(g.key));

    if (!alreadyIs) {
      g.grimoireIds = g.grimoireId ? [g.grimoireId] : [];
      grimoireOnly.push(g);
      byKon.set(canonicalKey(g.key), g);
      continue;
    }

    alreadyIs.grimoireIds ??= alreadyIs.grimoireId ? [alreadyIs.grimoireId] : [];
    if (g.grimoireId && !alreadyIs.grimoireIds.includes(g.grimoireId)) {
      alreadyIs.grimoireIds.push(g.grimoireId);
    }
    alreadyIs.grimoireId ??= g.grimoireId ?? null;
    alreadyIs.isGrimoireActive = Boolean(alreadyIs.isGrimoireActive || g.isGrimoireActive);
    alreadyIs.enabledByGrimoire = Boolean(alreadyIs.enabledByGrimoire || g.enabledByGrimoire);
    alreadyIs.sidebarBadge ??= g.sidebarBadge ?? null;
  }

  return { record: ofTheRecord, grimoireOnly };
}
