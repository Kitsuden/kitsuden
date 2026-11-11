/**
 * The dashboard's "Recent activity": order and wording.
 *
 * The list was sorted by comparing the DISPLAYED text ("10m ago", "160d ago", "2h ago") as
 * strings, so a dataset from five months ago came before something from two hours ago. It is
 * sorted by the moment it happened. And an agent's log entry was shown with its raw code
 * ("Agent executed: auth_success"): the code gets a label from the dictionary
 * (`activity.<code>`), or a readable version of itself when there is none.
 */

/** Newest first; an entry without a valid date goes last, in the order it came. */
export function newestFirst<T extends { at: string | number | Date | null | undefined }>(
  items: T[]
): T[] {
  const moment = (v: T["at"]) => {
    const n = v == null ? NaN : new Date(v).getTime();
    return Number.isNaN(n) ? -Infinity : n;
  };
  return items
    .map((item, index) => ({ item, index, when: moment(item.at) }))
    .sort((a, b) => (b.when === a.when ? a.index - b.index : b.when > a.when ? 1 : -1))
    .map((x) => x.item);
}

/** `auth_success` → "Auth success": what is shown for a code the dictionary does not know. */
export function readableCode(code: string): string {
  const words = code.replace(/[_.:-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

/** The label of an agent audit action, from `activity.<code>` or from the code itself. */
export function activityLabel(code: string | null | undefined, t: (key: string) => string): string {
  if (!code) return t("activity.unknown");
  const key = `activity.${code}`;
  const text = t(key);
  return text === key ? readableCode(code) : text;
}
