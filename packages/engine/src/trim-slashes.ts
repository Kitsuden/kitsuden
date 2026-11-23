/**
 * Removes every trailing `/` ("https://x.dev//" -> "https://x.dev").
 *
 * A loop instead of `replace(/\/+$/, "")`: that regex is retried at each `/` of a
 * long run and turns quadratic on input like "a" + "/".repeat(n) + "b".
 */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return text.slice(0, end);
}
