/**
 * How the explorer's table lays out its columns.
 *
 * The table opened on a uuid column, showed relations as raw ids and had no `aria-sort`.
 * These rules decide, from the column names alone, what is hidden by default, what comes
 * first and how a relation is shown. They are pure so they can be tested.
 */

export interface ColumnLike {
  name: string;
  type?: string;
}

/** A column that only identifies the row: `id`, `uuid`, `_id`. */
export function isIdColumn(name: string): boolean {
  return /^(_?id|uuid|guid)$/i.test(name);
}

/** A foreign key by its name: `author_id`, `authorId` (not `id` itself). */
export function isRelationColumn(name: string): boolean {
  return name.endsWith("_id") || (name.endsWith("Id") && name !== "id");
}

/** Hidden until the user asks for them in the column chooser: the row's own identifiers. */
export function defaultHiddenColumns(columns: ColumnLike[]): Set<string> {
  // A table made only of identifiers keeps them: an empty table explains nothing.
  const ids = columns.filter((c) => isIdColumn(c.name)).map((c) => c.name);
  return ids.length === columns.length ? new Set() : new Set(ids);
}

/** Names that title a row, best first. */
const TITLE_NAMES = [
  "title",
  "name",
  "display_name",
  "displayName",
  "full_name",
  "fullName",
  "label",
  "subject",
  "headline",
  "email",
  "username",
  "slug",
  "key",
];

/** The column that names a row, or null when none of the known names is there. */
export function titleColumn(columns: ColumnLike[]): string | null {
  for (const candidate of TITLE_NAMES) {
    const found = columns.find((c) => c.name === candidate);
    if (found) return found.name;
  }
  // No known name: the first text column that is neither an identifier nor a relation.
  const text = columns.find(
    (c) =>
      !isIdColumn(c.name) &&
      !isRelationColumn(c.name) &&
      ["text", "string", "varchar", "email"].includes(c.type ?? "")
  );
  return text?.name ?? null;
}

/**
 * Display order: the title column first, identifiers last, everything else as the schema
 * gives it.
 */
export function orderColumns<T extends ColumnLike>(columns: T[]): T[] {
  const title = titleColumn(columns);
  const rank = (c: T) => (c.name === title ? 0 : isIdColumn(c.name) ? 2 : 1);
  return columns
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/** The header text of a column: `author_id` → "Author", `createdAt` → "Created At". */
export function columnLabel(name: string): string {
  const base = isRelationColumn(name) ? name.replace(/_id$/, "").replace(/Id$/, "") : name;
  return base
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

const DISPLAY_KEYS = ["title", "name", "displayName", "display_name", "label", "email", "slug"];

function displayOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of DISPLAY_KEYS) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** A long identifier cut to something a cell can hold: `5605b478…`. */
export function shortId(value: unknown): string {
  const text = String(value);
  return text.length > 10 ? `${text.slice(0, 8)}…` : text;
}

/**
 * What a relation cell shows: the related record's display field when the data has it,
 * a short id otherwise.
 *
 * The data can carry it in three ways: the looked-up label (`labels`, from the related
 * table's options), the related record embedded next to the key (`author` beside
 * `author_id`, or the value itself being an object), or a sibling `<base>Name` /
 * `<base>_name` / `<base>Title` column.
 */
export function relationDisplay(
  row: Record<string, unknown>,
  column: string,
  labels?: Record<string, string>
): string {
  const raw = row[column];
  if (raw === null || raw === undefined || raw === "") return "-";

  const own = displayOf(raw);
  if (own) return own;

  const looked = labels?.[String(raw)];
  if (looked) return looked;

  const base = column.replace(/_id$/, "").replace(/Id$/, "");
  const embedded = displayOf(row[base]);
  if (embedded) return embedded;

  for (const suffix of ["Name", "_name", "Title", "_title", "Label", "_label"]) {
    const sibling = row[`${base}${suffix}`];
    if (typeof sibling === "string" && sibling.trim()) return sibling;
  }

  if (typeof raw === "object") {
    const id = (raw as Record<string, unknown>).id;
    return id === undefined ? "-" : shortId(id);
  }
  return shortId(raw);
}

/** The `aria-sort` of a header for its current direction. */
export function ariaSort(
  dir: "asc" | "desc" | null | undefined
): "ascending" | "descending" | "none" {
  return dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
}

/** What names a row in an accessible label ("Actions for …"). */
export function rowTitle(row: Record<string, unknown>, columns: ColumnLike[]): string {
  const title = titleColumn(columns);
  const value = title ? row[title] : undefined;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return row.id === undefined || row.id === null ? "" : shortId(row.id);
}
