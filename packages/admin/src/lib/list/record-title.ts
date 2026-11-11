/**
 * What a record is called in a list, a breadcrumb or a search result: the field the model
 * names as its title, else the usual suspects, else the first short text, else its id.
 */
const USUAL = ["title", "name", "label", "displayName", "display_name", "subject", "slug", "email"];

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

export function recordTitle(
  row: Record<string, unknown> | null | undefined,
  preferred?: string | null
): string {
  if (!row) return "";
  // A dataset entry keeps its fields under `data`.
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  for (const source of [row, data]) {
    if (preferred && text(source[preferred])) return text(source[preferred])!;
  }
  for (const source of [row, data]) {
    for (const key of USUAL) if (text(source[key])) return text(source[key])!;
  }
  for (const source of [data, row]) {
    for (const [key, value] of Object.entries(source)) {
      if (key === "id" || key.endsWith("_id") || key.endsWith("Id")) continue;
      if (
        typeof value === "string" &&
        value.trim() &&
        value.length <= 80 &&
        !/^\d{4}-\d\d-\d\dT/.test(value)
      )
        return value.trim();
    }
  }
  return text(row.id) ?? "";
}
