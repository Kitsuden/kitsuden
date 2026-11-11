/**
 * The filters of a list, generated from the fields of its model (what Django calls
 * `list_filter`, with no line written per model): a choice field becomes a select chip, a
 * boolean a yes/no chip, a date a date-range chip and a relation a select over the related
 * records.
 */
import type { FilterShape } from "./url-state";

export type FieldKind =
  | "text"
  | "longtext"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "relation"
  | "json"
  | "image"
  | "url"
  | "email"
  | "id";

export interface FieldOption {
  value: string;
  label: string;
}

/** A field of a model as lists and record pages see it, whatever the origin of the model. */
export interface ListField {
  key: string;
  label: string;
  kind: FieldKind;
  /** The choices of a select, or the related records of a relation once loaded. */
  options?: FieldOption[];
  sortable?: boolean;
  /** `false`: the API cannot filter by it. */
  filterable?: boolean;
  /** Not in the default columns (identifiers, long text, JSON); the chooser can show it. */
  hidden?: boolean;
  /** Set by the API, never by a form (ids, timestamps). */
  readonly?: boolean;
  required?: boolean;
  /** For a relation: the table (or dataset) it points to. */
  relationTable?: string;
  description?: string;
}

/** tallao FilterDef, the part generated here. */
export interface GeneratedFilter extends FilterShape {
  label: string;
  options?: FieldOption[];
  hidden?: boolean;
  range?: boolean;
}

export interface FilterRules {
  /** The API can compare dates (a range chip); otherwise date fields get no filter. */
  dateRange?: boolean;
  /** How many chips sit in the bar; the rest wait under "Add filter". */
  visible?: number;
}

/** More than this many choices is a lookup, not a chip. */
export const MAX_FILTER_OPTIONS = 50;

export function filtersFromFields(
  fields: ListField[],
  { dateRange = true, visible = 3 }: FilterRules = {}
): GeneratedFilter[] {
  const out: GeneratedFilter[] = [];
  for (const field of fields) {
    if (field.filterable === false) continue;
    const base = { key: field.key, label: field.label };
    if (field.kind === "boolean") {
      out.push({ ...base, type: "boolean" });
    } else if (field.kind === "select" || field.kind === "relation") {
      const options = field.options ?? [];
      if (options.length === 0 || options.length > MAX_FILTER_OPTIONS) continue;
      out.push({ ...base, type: "select", options });
    } else if ((field.kind === "date" || field.kind === "datetime") && dateRange) {
      out.push({ ...base, type: "date", range: true });
    }
  }
  // Choices first (the ones people reach for), then yes/no, then dates.
  const rank = (f: GeneratedFilter) => (f.type === "select" ? 0 : f.type === "boolean" ? 1 : 2);
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map(({ f }, i) => (i < visible ? f : { ...f, hidden: true }));
}

/** The value of a date-range chip ("2026-01-01..2026-01-31", or one date) as its two ends. */
export function dateRangeOf(value: string): { from: string | null; to: string | null } {
  const [from, to] = value.includes("..") ? value.split("..") : [value, value];
  const day = (text: string | undefined) =>
    text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  return { from: day(from), to: day(to) };
}
