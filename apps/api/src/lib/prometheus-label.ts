/**
 * A Prometheus label value: the exposition format escapes backslash, double quote and
 * line feed, backslash first so the other escapes are not doubled.
 */
export function prometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
