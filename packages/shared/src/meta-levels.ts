/**
 * The level of a meta archetype: a letter, or why it does not have one
 * ============================================================================
 *
 * A meta table has to say something more than the percentage, because "4.1%"
 * cannot be compared on its own: you need to know whether that is among the top or in the tail.
 * That is the letter.
 *
 * ── WHY NOT ALL OF THEM GET A LETTER ───────────────────────────────────────
 *
 * Because not everything is known about all of them. An archetype with three decks counted
 * can come out 1st or 40th depending on which tournament is looked at, and giving it an "F" would
 * be claiming something the sample does not support. Those that do not reach the minimum
 * keep a LABEL that says what situation they are in:
 *
 *   · **Emerging**     — appeared in this cycle; nothing to compare with yet.
 *   · **Promising**    — small sample, but rising.
 *   · **Unclassified** — small sample and no signal.
 *
 * It is the difference between "it is bad" and "I don't know", and mixing them is the mistake that
 * turns a data table into a disguised opinion.
 *
 * ── THE LETTER IS SHARE, NOT QUALITY ───────────────────────────────────────
 *
 * It comes from the percentile of SHARE —how much it is played—, which is what the sources
 * publish. It is not win rate: nobody we read from publishes who wins, so
 * a wins column here would be made up. The legend says so.
 */

export interface MetaLevel {
  id: string;
  label: string;
  color: string;
  /** Its band in the tier list (1, 2 or 3), or `null` if it does not appear in it. */
  tier: 1 | 2 | 3 | null;
  /** `true` for A–F; `false` for the labels. */
  isLetter: boolean;
  /** What it means, for the legend. */
  description: string;
}

/**
 * The six letters, by share percentile.
 *
 * The FIRST THREE are the tier list: A = Tier 1, B = Tier 2, C = Tier 3. The cuts
 * are where they are so that Tier 1 is a handful of decks —what
 * really dominates— and not half the table.
 */
export const LETTERS: Array<MetaLevel & { until: number }> = [
  {
    id: "a",
    label: "A",
    color: "#ff7f7f",
    tier: 1,
    isLetter: true,
    until: 0.1,
    description: "The most played 10%. It is what you will run into.",
  },
  {
    id: "b",
    label: "B",
    color: "#ffbf7f",
    tier: 2,
    isLetter: true,
    until: 0.25,
    description: "Next 15%. Seen often.",
  },
  {
    id: "c",
    label: "C",
    color: "#ffff7f",
    tier: 3,
    isLetter: true,
    until: 0.45,
    description: "Next 20%. Present, not dominant.",
  },
  {
    id: "d",
    label: "D",
    color: "#bfff7f",
    tier: null,
    isLetter: true,
    until: 0.65,
    description: "Next 20%. Rarely seen.",
  },
  {
    id: "e",
    label: "E",
    color: "#7fdfbf",
    tier: null,
    isLetter: true,
    until: 0.85,
    description: "Next 20%. Marginal.",
  },
  {
    id: "f",
    label: "F",
    color: "#7fbfff",
    tier: null,
    isLetter: true,
    until: 1,
    description: "Bottom 15%. Almost never played.",
  },
];

export const TAGS: Record<"promising" | "emerging" | "unclassified", MetaLevel> = {
  emerging: {
    id: "emerging",
    label: "Emerging",
    color: "#c39bff",
    tier: null,
    isLetter: false,
    description: "Appeared in this cycle: there is no earlier window to compare it with.",
  },
  promising: {
    id: "promising",
    label: "Promising",
    color: "#9bd2ff",
    tier: null,
    isLetter: false,
    description: "Small sample so far, but its share has risen since the earlier window.",
  },
  unclassified: {
    id: "unclassified",
    label: "Unclassified",
    color: "#8a8a99",
    tier: null,
    isLetter: false,
    description: "Not enough decks have been counted to give it a meaningful letter.",
  },
};

/** All levels, in the order they are read and filtered. */
export const LEVELS: MetaLevel[] = [
  ...LETTERS.map(({ until: _until, ...n }) => n),
  TAGS.promising,
  TAGS.emerging,
  TAGS.unclassified,
];

/**
 * How many decks are needed to deserve a letter.
 *
 * 1% of what was counted, with a floor of five. The percentage makes the
 * criterion independent of the dump's size —a minimum of
 * five out of 450 decks is not the same as out of 40,000— and the floor prevents one deck
 * from being enough in a small sample.
 */
export const minForLetter = (sample: number): number => Math.max(5, Math.round(sample * 0.01));

export interface GradableArchetype {
  id: string;
  quota: number;
  decks: number;
  /** Points it rose or fell; `null` if there is no earlier window. */
  difference: number | null;
}

/**
 * How many archetypes fit in each letter.
 *
 * The cuts are the percentiles, **but each letter gets at least one
 * while archetypes remain**. Without that floor, the percentile breaks on small
 * fields: with two archetypes, the most played falls at 50% and comes out with a D
 * while being the one in charge. The percentage stops making sense when there is nothing
 * to split it over, and the order still does.
 *
 * With 35 archetypes it splits 4 · 5 · 7 · 7 · 7 · 5, which is the shape of
 * a real tier list: a short Tier 1.
 */
function letterQuotas(total: number): number[] {
  const quotaLimits: number[] = [];
  let used = 0;

  for (const letter of LETTERS) {
    const remain = total - used;
    if (remain <= 0) {
      quotaLimits.push(0);
      continue;
    }
    const byPercentile = Math.round(letter.until * total) - used;
    const quotaLimit = Math.min(remain, Math.max(1, byPercentile));
    quotaLimits.push(quotaLimit);
    used += quotaLimit;
  }

  return quotaLimits;
}

/** Which letter the one at position `index` falls in (0 = the first). */
function letterOf(index: number, quotaLimits: number[]): number {
  let until = 0;
  for (let i = 0; i < quotaLimits.length; i++) {
    until += quotaLimits[i];
    if (index < until) return i;
  }
  return LETTERS.length - 1;
}

export const LEVELS_NOTE =
  "The letter comes from the percentile of SHARE —what percentage of the decks seen are of that archetype—," +
  " not from how many games it wins: our sources publish what is played, not who wins." +
  " A = Tier 1 (most played 10%) · B = Tier 2 (next 15%) · C = Tier 3 (next 20%) ·" +
  " D, E and F are the rest, and each letter gets at least one archetype while any remain." +
  " Those that do not reach the minimum of counted decks carry a label instead of a letter.";

/**
 * The level of each archetype, by its id.
 *
 * `sample` is the total of decks counted in the window; the minimum comes from it.
 * The percentile is calculated ONLY among those that reach the minimum: if
 * those with three decks also entered, an "A" would stop meaning "among the most
 * played" and would come to mean "of those we have data on, the best".
 *
 * Two equal shares share a letter, as in the tier list.
 */
export function metaLevels(
  archetypes: GradableArchetype[],
  sample: number
): Map<string, MetaLevel> {
  const min = minForLetter(sample);
  const withLetter = archetypes
    .filter((a) => a.decks >= min)
    .sort((x, y) => y.quota - x.quota || x.id.localeCompare(y.id));
  const quotas = withLetter.map((a) => a.quota);
  const quotaLimits = letterQuotas(withLetter.length);

  const map = new Map<string, MetaLevel>();

  withLetter.forEach((a, i) => {
    // A tie inherits the letter of the FIRST one with that share: same figure, same
    // letter, even if the quota cut falls right in the middle of the tied ones.
    const { until: _until, ...level } = LETTERS[letterOf(quotas.indexOf(quotas[i]), quotaLimits)];
    map.set(a.id, level);
  });

  for (const a of archetypes) {
    if (map.has(a.id)) continue;
    if (a.difference === null) map.set(a.id, TAGS.emerging);
    else if (a.difference > 0) map.set(a.id, TAGS.promising);
    else map.set(a.id, TAGS.unclassified);
  }

  return map;
}
