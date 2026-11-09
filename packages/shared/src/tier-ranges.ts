/**
 * The bands of a CALCULATED tier list
 * ============================================================================
 *
 * A tier list that comes from a figure —an archetype's share, a base
 * stat— is not placed by anyone by hand: it is sorted and cut by percentiles. The
 * cut lives here because two places that cannot see each other use it:
 *
 *   · the LOADER, which writes the tier list and its note;
 *   · the WEB, which draws the letter next to an archetype on the game's home page.
 *
 * While it was only in the loader, the web had nowhere to get it from and the
 * only way out was to copy the numbers. Two copies of a percentile cut
 * diverge as soon as someone touches one, and the home page's letter would stop
 * matching the tier list's without anything failing.
 *
 * The NOTE goes with the bands on purpose: a letter without saying what it means
 * reads as a rating, and this rates nothing — it says how much it is played.
 */

export interface TierBracket {
  id: string;
  label: string;
  color: string;
  /** Percentile it extends to, from 0 to 1. */
  until: number;
}

export const TIERS: TierBracket[] = [
  { id: "s", label: "S", color: "#ff7f7f", until: 0.1 },
  { id: "a", label: "A", color: "#ffbf7f", until: 0.3 },
  { id: "b", label: "B", color: "#ffff7f", until: 0.6 },
  { id: "c", label: "C", color: "#bfff7f", until: 0.85 },
  { id: "d", label: "D", color: "#7fbfff", until: 1 },
];

export const BRACKETS = "S = top 10% · A = next 20% · B = next 30% · C = next 25% · D = bottom 15%";

/**
 * The band of whoever is at position `index` of `total`.
 *
 * `index` is 0 for the first. A tie is resolved outside: the caller passes
 * the position of the FIRST one with that value, so that two equal figures fall in
 * the same letter.
 */
export function bracketByPosition(index: number, total: number): TierBracket {
  if (total <= 0) return TIERS[TIERS.length - 1];
  const position = (index + 1) / total;
  return TIERS.find((t) => position <= t.until) ?? TIERS[TIERS.length - 1];
}
