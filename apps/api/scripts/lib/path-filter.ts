/**
 * `--only` and `--skip` for scripts/schemathesis.ts
 * ============================================================================
 *
 * Until 2026-11-22 `--only` (and `--solo`) took a regular expression built from the
 * command line, which CodeQL reports as regex injection. They now take a
 * comma-separated list of OpenAPI paths, compared as strings:
 *
 *   /api/dc            that path and everything under it (`/api/dc/...`)
 *   /api/dc/import$    that path only
 *
 * The kons CI used a negative lookahead to leave three paths out; that is now
 * `--skip=/api/dc/blueprints$,/api/dc/blueprints/{id}$,/api/dc/import$`.
 */

/** Characters that only make sense in a regex: an old-style filter is refused, not misread. */
const REGEX_SYNTAX = /[\^()?|\\[\]+]/;

export function looksLikeRegex(value: string): boolean {
  return REGEX_SYNTAX.test(value);
}

function items(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matches(item: string, path: string): boolean {
  if (item.endsWith("$")) return path === item.slice(0, -1);
  const prefix = item.endsWith("/") ? item.slice(0, -1) : item;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether `path` is tested: in `only` (when given) and not in `skip`. */
export function pathFilter(only?: string, skip?: string): (path: string) => boolean {
  const keep = items(only);
  const drop = items(skip);
  return (path) =>
    (keep.length === 0 || keep.some((i) => matches(i, path))) &&
    !drop.some((i) => matches(i, path));
}
