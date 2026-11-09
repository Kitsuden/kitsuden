/**
 * The vocabulary of a deck's analysis. ONE, for both sides.
 * ============================================================================
 *
 * Which bars a deck's profile has, what the "skill ceiling" measures, which
 * roles a card can play. Both of these need it at once:
 *
 *   · the card-game loader (in the site repository), which uses it to build
 *     the SCHEMA of the editorial dataset that the panel fills in;
 *   · the site's deck-analysis page code, which uses it to know which fields to read
 *     and what name to draw them with.
 *
 * If they lived duplicated, adding a bar on one side would leave it without a
 * label on the other —or worse: saved and never drawn—, which is exactly the
 * failure that makes a panel field look like it does not save. Same reason
 * `renderBlocks` lives here.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is not data: it is the BOXES. What goes inside is written by the team and
 * is their opinion. A deck's figures —share, lists, most-included
 * cards— come from the source and live elsewhere.
 */

export interface AnalysisMeasure {
  key: string;
  label: string;
  /** What it means, for the bar's footer */
  note?: string;
}

/** The seven bars of the profile, in reading order. */
export const DECK_BARS: AnalysisMeasure[] = [
  { key: "attack", label: "Attack" },
  { key: "control", label: "Control" },
  { key: "consistency", label: "Consistency" },
  { key: "board_breaking", label: "Board breaking" },
  { key: "versatility", label: "Versatility" },
  { key: "resilience", label: "Resilience" },
  { key: "recovery", label: "Recovery" },
];

/** How much the deck depends on whoever pilots it. */
export const SKILL_MEASURES: AnalysisMeasure[] = [
  {
    key: "decision_density",
    label: "Decision density",
    note: "Weighty decisions per game",
  },
  {
    key: "timing_sensitivity",
    label: "Timing sensitivity",
    note: "Sequencing and response windows",
  },
  {
    key: "matchup_variance",
    label: "Variation per opponent",
    note: "How much the plan changes depending on the matchup",
  },
  {
    key: "error_punishment",
    label: "Punishment of mistakes",
    note: "How costly it is to get it wrong",
  },
  { key: "autopilot_factor", label: "Autopilot", note: "How much the deck does on its own" },
];

/** What is valued about a card within its deck. */
export const CARD_MEASURES: AnalysisMeasure[] = [
  { key: "versatility", label: "Versatility" },
  { key: "power_level", label: "Power" },
  { key: "consistency_impact", label: "Weight in consistency" },
  { key: "meta_relevance", label: "Relevance in the meta" },
  { key: "replaceability", label: "Replaceability" },
];

/** The deck archetypes that repeat in any card game. */
export const DECK_TYPES = [
  "Aggro",
  "Mid-Range",
  "Control",
  "Combo",
  "Combo-Control",
  "Toolbox",
  "OTK / FTK",
  "Stun / Prison",
  "Burn",
];

export const GRADES = ["Excellent", "Good", "Normal", "Weak", "Bad"];

export const LEARNING_CURVES = ["Gentle", "Moderate", "Demanding", "Very demanding"];

/** The roles a card can have within the deck. */
export const CARD_ROLES = [
  "Main hitter",
  "Key card",
  "Defender",
  "Play starter",
  "Best card",
  "Tech",
];

/** The phases in which a deck's resilience is measured. */
export const ENDURANCE_PHASES = [
  "Early game",
  "Mid game",
  "Late game",
  "Graveyard recycling (to hand)",
  "Graveyard recycling (to deck/extra)",
  "Summoning from the graveyard",
  "Comeback",
];

/**
 * The factors the grade is composed of, with their weight.
 *
 * They come proposed because they are the ones used in the genre, but the weight
 * is decided by whoever signs the analysis: the final grade is theirs, not this file's.
 */
export const GRADE_FACTORS = [
  "Consistency",
  "Power ceiling",
  "Prize trade",
  "Matchup spread",
  "Resilience",
  "Speed",
  "Disruption",
  "Resource efficiency",
  "Flexibility",
  "Skill ceiling",
];

/**
 * The grade composed from the factors and their weights.
 *
 * It is calculated and not written by hand because a hand-written weighted
 * average drifts as soon as a weight is touched, and then the grade stops
 * meaning what the table underneath it says. It returns `null` when there are
 * no weighted factors: a grade with nothing to calculate it from is not invented.
 */
export function weightedScore(
  factors: Array<{ weight?: unknown; score?: unknown }>
): number | null {
  let weight = 0;
  let sum = 0;
  for (const f of factors) {
    const w = Number(f?.weight);
    const s = Number(f?.score);
    if (!Number.isFinite(w) || !Number.isFinite(s) || w <= 0) continue;
    weight += w;
    sum += w * s;
  }
  return weight > 0 ? Number((sum / weight).toFixed(2)) : null;
}
