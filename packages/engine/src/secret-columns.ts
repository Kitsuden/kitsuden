/**
 * Columns that hold a LIVE secret (token, password, hash of a key), by NAME.
 *
 * One rule for every generic surface: the data explorer never returns, filters or
 * sorts by them (`apps/api/src/lib/explorable-tables.ts` re-exports this), and the
 * record history never stores their values (`record-history.ts`). By name, in
 * snake_case and camelCase, so it works for tables that do not exist yet.
 * `tokens_in`/`tokens_out` (an LLM's counters) do not match: they do not end in token.
 *
 * A pure module (no imports) so the engine's own files can use it without reaching
 * into the API.
 */
const SECRET_COLUMN = /(^|_|[a-z])(token|password|secret|token_?hash|password_?hash|key_?hash)$/i;

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN.test(name);
}
