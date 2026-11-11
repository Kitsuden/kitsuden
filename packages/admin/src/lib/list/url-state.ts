/**
 * The state of a list, kept in the URL so a link reproduces it: search, filters, sort,
 * page, density and the visible columns.
 *
 *   ?q=ana&f.status=draft&f.featured=true&sort=-updated_at&page=2&density=compact&cols=name,status
 *
 * Filters carry an `f.` prefix: a field called `page` or `sort` cannot collide with the
 * list's own parameters, and parameters the list does not own (`tab`, `view`) are kept.
 * Only what differs from the defaults is written, so a plain list has a plain address.
 */
export type ListDensity = "comfortable" | "compact";

export interface ListSort {
  key: string;
  direction: "asc" | "desc";
}

/** Applied filters by key, with the search text under `q` (tallao FilterBar's `value`). */
export type ListFilters = Record<string, string | boolean>;

export interface ListState {
  filters: ListFilters;
  sort: ListSort | null;
  page: number;
  density: ListDensity;
  /** Keys of the visible columns, or null for the list's default set. */
  columns: string[] | null;
}

export interface ListDefaults {
  sort?: ListSort | null;
  density?: ListDensity;
}

/** The declared filters: only these are read from the URL. */
export interface FilterShape {
  key: string;
  type: "select" | "boolean" | "date" | "text";
}

export const SEARCH_KEY = "q";
const FILTER_PREFIX = "f.";
const OWN_KEYS = new Set([SEARCH_KEY, "sort", "page", "density", "cols"]);

const sameSort = (a: ListSort | null | undefined, b: ListSort | null | undefined) =>
  (a?.key ?? null) === (b?.key ?? null) && (a?.direction ?? null) === (b?.direction ?? null);

export function parseSort(raw: string | null): ListSort | null {
  if (!raw) return null;
  const desc = raw.startsWith("-");
  const key = desc ? raw.slice(1) : raw;
  return /^[A-Za-z_][\w.]*$/.test(key) ? { key, direction: desc ? "desc" : "asc" } : null;
}

export const formatSort = (sort: ListSort): string =>
  `${sort.direction === "desc" ? "-" : ""}${sort.key}`;

/** The list's state from a query string; anything malformed falls back to the default. */
export function readListState(
  params: URLSearchParams,
  filters: FilterShape[],
  defaults: ListDefaults = {}
): ListState {
  const value: ListFilters = {};
  const q = params.get(SEARCH_KEY)?.trim();
  if (q) value[SEARCH_KEY] = q;
  for (const def of filters) {
    const raw = params.get(`${FILTER_PREFIX}${def.key}`);
    if (raw === null || raw === "") continue;
    if (def.type === "boolean") {
      if (raw === "true" || raw === "false") value[def.key] = raw === "true";
    } else value[def.key] = raw;
  }

  const page = Number(params.get("page"));
  const cols = params.get("cols");
  const density = params.get("density");
  return {
    filters: value,
    sort: params.has("sort") ? parseSort(params.get("sort")) : (defaults.sort ?? null),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    density:
      density === "compact" || density === "comfortable"
        ? density
        : (defaults.density ?? "comfortable"),
    columns: cols ? cols.split(",").filter(Boolean) : null,
  };
}

/**
 * The query string of a list state, in a fixed order (so two equal states give the same
 * string). `page: false` leaves the page out: a saved view is not "page 3 of drafts".
 */
export function listStateQuery(
  state: ListState,
  defaults: ListDefaults = {},
  { page = true }: { page?: boolean } = {}
): string {
  const params = new URLSearchParams();
  const q = state.filters[SEARCH_KEY];
  if (typeof q === "string" && q.trim()) params.set(SEARCH_KEY, q.trim());
  for (const key of Object.keys(state.filters).sort()) {
    if (key === SEARCH_KEY) continue;
    const v = state.filters[key];
    if (v === "" || v === null || v === undefined) continue;
    params.set(`${FILTER_PREFIX}${key}`, String(v));
  }
  if (!sameSort(state.sort, defaults.sort ?? null)) {
    // An explicit "no sort" over a default sort is written as an empty value.
    params.set("sort", state.sort ? formatSort(state.sort) : "");
  }
  if (page && state.page > 1) params.set("page", String(state.page));
  if (state.density !== (defaults.density ?? "comfortable")) params.set("density", state.density);
  if (state.columns && state.columns.length > 0) params.set("cols", state.columns.join(","));
  return params.toString();
}

/** `url` with the list's parameters replaced by `state`; other parameters stay. */
export function withListState(url: URL, state: ListState, defaults: ListDefaults = {}): string {
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (!OWN_KEYS.has(key) && !key.startsWith(FILTER_PREFIX)) kept.append(key, value);
  }
  for (const [key, value] of new URLSearchParams(listStateQuery(state, defaults))) {
    kept.set(key, value);
  }
  const query = kept.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

/** Whether anything narrows the list (a search or a filter): "no results" vs "empty". */
export function hasFilters(state: ListState): boolean {
  return Object.values(state.filters).some((v) => v !== "" && v !== null && v !== undefined);
}
