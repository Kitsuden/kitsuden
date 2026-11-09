/**
 * Extraction of the real Postgres error.
 * ============================================================================
 *
 * Drizzle wraps the driver's error and its `.message` can arrive EMPTY. The
 * result is "statement 8 failed" with no reason, which is the worst way
 * to fail in a migration: it leaves you staring at correct SQL with no idea what is wrong.
 *
 * The real reason lives in `cause` or in pg's own fields (`detail`,
 * `hint`, `code`). This function walks them until it finds them.
 */
export function detailError(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  for (let cur: unknown = e; cur && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    const o = cur as { message?: string; detail?: string; hint?: string; code?: string };
    if (o.message) parts.push(o.message);
    if (o.detail) parts.push(`detail: ${o.detail}`);
    if (o.hint) parts.push(`hint: ${o.hint}`);
    if (o.code) parts.push(`code: ${o.code}`);
  }

  return parts.length > 0 ? [...new Set(parts)].join("\n  ") : String(e);
}
