/**
 * LIKE/ILIKE patterns built from user text.
 */

/**
 * Escapes LIKE's wildcards (`%`, `_`) and its escape character (`\`, Postgres'
 * default), so the text matches literally.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
