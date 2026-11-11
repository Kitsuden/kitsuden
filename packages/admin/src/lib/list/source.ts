/**
 * A record source: where a list and its record pages read and write. One interface, three
 * origins, so the list template and the record page are written once:
 *
 *   explorerSource  a table of a kon (generic kons), through /api/explorer or the kon's own base
 *   datasetSource   the entries of a dataset
 *   modelSource     a model declared with defineModel
 *
 * The query each API understands is built by the pure functions at the top (tested in
 * source.test.ts); the sources below only fetch.
 */
import type { ModelDescriptor } from "@kitsuden/shared";

import { api, type ApiError } from "$lib/api";
import {
  columnLabel,
  isIdColumn,
  isRelationColumn,
  titleColumn,
} from "$lib/data-explorer/table-columns";
import { explorerEndpoint, sortParams } from "$lib/explorer-endpoint";
import { resolveRelatedTable } from "$lib/explorer-relations";
import { knownTables } from "$lib/explorer-tables";

import type { FieldDefinition } from "../../types/datasets";

import type { SnapshotLike } from "./history";
import { dateRangeOf, type FieldKind, type FieldOption, type ListField } from "./model-filters";
import { recordTitle } from "./record-title";
import { SEARCH_KEY, type ListFilters, type ListSort } from "./url-state";

export type Row = Record<string, unknown>;

export interface ListQuery {
  filters: ListFilters;
  sort: ListSort | null;
  page: number;
  pageSize: number;
}

export interface ListResult {
  rows: Row[];
  total: number;
}

export interface BulkAction {
  id: string;
  label: string;
  /** Asked before running; "{n}" is the number of selected records. */
  confirm?: string;
  danger?: boolean;
  run: (ids: string[], rows: Row[]) => Promise<void>;
}

export interface RowAction {
  id: string;
  label: string;
  confirm?: string;
  danger?: boolean;
  visible?: (row: Row) => boolean;
  run: (row: Row) => Promise<void>;
}

export interface RecordSource {
  /** Stable id of the list: names its saved views and its remembered neighbours. */
  id: string;
  /** Plural ("Players") and singular ("Player") names. */
  label: string;
  singular: string;
  fields: ListField[];
  /** The form of a record (DynamicForm fields). */
  formFields: FieldDefinition[];
  titleField: string | null;
  /** The API searches text; without it the list has no search box. */
  searchable: boolean;
  /** The API compares dates: date fields get a range chip. */
  dateFilters: boolean;
  /** The sort a list opens with, when the API has one worth stating. */
  defaultSort?: ListSort | null;
  bulkActions?: BulkAction[];
  rowActions?: RowAction[];
  /**
   * A kon table: its record page shows, inline, the rows of the kon's other tables that
   * point at the record (InlineRelationPanel finds them from the foreign keys).
   */
  inline?: { konId: string; table: string };

  rowId(row: Row): string;
  title(row: Row): string;
  /** The value of a field of a row (dataset entries keep theirs under `data`). */
  value(row: Row, key: string): unknown;
  list(query: ListQuery): Promise<ListResult>;
  get(id: string): Promise<Row | null>;
  create(values: Row): Promise<Row>;
  update(id: string, values: Row): Promise<Row>;
  remove(id: string): Promise<void>;
  /** The form values of a record, and the API path a person or an agent would call. */
  formValues(row: Row): Row;
  apiPath(id?: string): string;
  /** Who and when, as far as the row says. */
  about(row: Row): { created?: string; updated?: string; createdBy?: string; updatedBy?: string };
  /**
   * `true`: an update sends every field (a dataset entry's `data` is stored whole);
   * otherwise only the fields that changed.
   */
  fullUpdate?: boolean;
  /** Earlier versions of the record, when the API keeps them (a dataset entry's snapshots). */
  snapshots?(id: string): Promise<SnapshotLike[]>;
}

// ── Pure: the query each API understands ─────────────────────────────────────────────

const filterEntries = (filters: ListFilters) =>
  Object.entries(filters).filter(
    ([key, v]) => key !== SEARCH_KEY && v !== "" && v !== null && v !== undefined
  );

const searchOf = (filters: ListFilters) =>
  typeof filters[SEARCH_KEY] === "string" ? (filters[SEARCH_KEY] as string).trim() : "";

/**
 * /api/explorer/<table>: `search` across columns and one `filter[field]` per filter (see
 * apps/api/src/lib/explorer-query.ts). A date range becomes `gte` / `lte` on the day's ends;
 * `fixed` is the filter a view always applies (a "Drafts" tab), which the user cannot undo.
 */
export function explorerParams(
  query: ListQuery,
  fields: ListField[],
  fixed: Record<string, unknown> = {}
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.pageSize));
  params.set("page", String(query.page));
  const search = searchOf(query.filters);
  if (search) params.set("search", search);
  if (query.sort) {
    params.set("sort", query.sort.key);
    params.set("dir", query.sort.direction);
  }
  const kinds = new Map(fields.map((f) => [f.key, f.kind]));
  for (const [key, value] of filterEntries(query.filters)) {
    const kind = kinds.get(key);
    if ((kind === "date" || kind === "datetime") && typeof value === "string") {
      const { from, to } = dateRangeOf(value);
      if (from) params.set(`filter[${key}][gte]`, `${from}T00:00:00`);
      if (to) params.set(`filter[${key}][lte]`, `${to}T23:59:59.999`);
    } else params.set(`filter[${key}]`, String(value));
  }
  for (const [key, value] of Object.entries(fixed)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(`filter[${key}]`, String(value));
  }
  return params;
}

/**
 * A kon's own list route (`/api/directory/employees`): its dialect is the older one, a
 * search text and ONE filter (`filter_field` + `filter_op` + `filter_value`). The view's
 * fixed filter wins that slot; otherwise the first filter the user set. The filters that
 * did not fit are returned so the caller can apply them to the page it got.
 */
export function legacyParams(
  endpoint: string,
  query: ListQuery,
  fixed: Record<string, unknown> = {}
): { params: URLSearchParams; unsent: Array<[string, string | boolean]> } {
  const params = new URLSearchParams();
  params.set("limit", String(query.pageSize));
  params.set("page", String(query.page));
  const search = searchOf(query.filters);
  if (search) params.set("search", search);
  if (query.sort) {
    const sort = sortParams(endpoint, [
      { column: query.sort.key, direction: query.sort.direction },
    ]);
    for (const [key, value] of Object.entries(sort)) params.set(key, value);
  }
  const user = filterEntries(query.filters);
  const fixedEntry = Object.entries(fixed).find(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );
  const sent: [string, unknown] | undefined = fixedEntry ?? user[0];
  if (sent) {
    params.set("filter_field", sent[0]);
    params.set("filter_op", "equals");
    params.set("filter_value", String(sent[1]));
  }
  return { params, unsent: fixedEntry ? user : user.slice(1) };
}

/**
 * /api/datasets/<id>/search: `q` (the title), `status`, and `filters=field:value,…` for the
 * fields inside `data`, with limit/offset.
 */
export function datasetSearchParams(query: ListQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.pageSize));
  params.set("offset", String((query.page - 1) * query.pageSize));
  const search = searchOf(query.filters);
  if (search) params.set("q", search);
  const parts: string[] = [];
  for (const [key, value] of filterEntries(query.filters)) {
    if (key === "status") params.set("status", String(value));
    // `,` separates filters and `:` splits field from value: a value with either cannot
    // be expressed in this syntax, so it is left to match nothing rather than be mangled.
    else parts.push(`${key}:${String(value).replace(/,/g, " ")}`);
  }
  if (parts.length > 0) params.set("filters", parts.join(","));
  return params;
}

/** A model route: limit/offset, `sort=-field`, and equality on its filterable fields. */
export function modelParams(query: ListQuery, descriptor: ModelDescriptor): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.pageSize));
  params.set("offset", String((query.page - 1) * query.pageSize));
  if (query.sort && descriptor.sortable.includes(query.sort.key)) {
    params.set("sort", `${query.sort.direction === "desc" ? "-" : ""}${query.sort.key}`);
  }
  for (const [key, value] of filterEntries(query.filters)) {
    if (descriptor.filterable.includes(key)) params.set(key, String(value));
  }
  return params;
}

// ── Pure: fields ─────────────────────────────────────────────────────────────────────

const TIMESTAMPS = new Set(["created_at", "updated_at", "createdAt", "updatedAt", "deleted_at"]);

/** A JSON Schema property of /api/explorer/schema/json/<table> as a field. */
export function fieldFromJsonSchema(
  name: string,
  prop: Record<string, unknown>,
  required: boolean,
  primaryKey: string
): ListField {
  const relation = prop["x-relation"] as { table?: string } | undefined;
  let kind: FieldKind = "text";
  if (relation) kind = "relation";
  else if (Array.isArray(prop.enum) && prop.enum.length > 0) kind = "select";
  else if (prop.format === "date-time" || prop.format === "date") kind = "datetime";
  else if (prop.format === "email") kind = "email";
  else if (prop.format === "uri") kind = "url";
  else if (prop.format === "uuid") kind = "id";
  else if (prop.type === "boolean") kind = "boolean";
  else if (prop.type === "integer" || prop.type === "number") kind = "number";
  else if (prop.type === "object" || prop.type === "array") kind = "json";
  else if (
    typeof prop.maxLength !== "number" &&
    /(description|content|body|notes|bio)$/i.test(name)
  )
    kind = "longtext";

  const readonly = prop.readOnly === true || name === primaryKey || TIMESTAMPS.has(name);
  return {
    key: name,
    label: columnLabel(name),
    kind,
    options: Array.isArray(prop.enum)
      ? prop.enum.map((v) => ({ value: String(v), label: String(v) }))
      : undefined,
    sortable: kind !== "json",
    filterable: true,
    hidden: name === primaryKey || kind === "id" || kind === "json" || kind === "longtext",
    readonly,
    required: required && !readonly,
    relationTable: relation?.table,
    description: typeof prop.description === "string" ? prop.description : undefined,
  };
}

/** Fields guessed from rows, for a route that has no schema to ask. */
export function fieldsFromRows(rows: Row[]): ListField[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).map((name) => {
    const sample = rows.map((r) => r[name]).find((v) => v !== null && v !== undefined);
    let kind: FieldKind = "text";
    if (typeof sample === "boolean") kind = "boolean";
    else if (typeof sample === "number") kind = "number";
    else if (sample && typeof sample === "object") kind = "json";
    else if (typeof sample === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(sample))
      kind = "datetime";
    else if (isIdColumn(name)) kind = "id";
    // `departmentId`: a relation by its name; its records are looked up afterwards.
    else if (isRelationColumn(name)) kind = "relation";
    const readonly = isIdColumn(name) || TIMESTAMPS.has(name);
    return {
      key: name,
      label: columnLabel(name),
      kind,
      sortable: kind !== "json",
      // Nothing says the route filters by this column.
      filterable: false,
      hidden: kind === "id" || kind === "json",
      readonly,
    };
  });
}

const FORM_TYPE: Record<FieldKind, string> = {
  text: "text",
  longtext: "textarea",
  number: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  select: "select",
  multiselect: "multiselect",
  relation: "select",
  json: "json",
  image: "image",
  url: "url",
  email: "email",
  id: "text",
};

/** The form of a record: every field the API lets a person set, as DynamicForm fields. */
export function formFieldsFrom(fields: ListField[]): FieldDefinition[] {
  return fields
    .filter((f) => !f.readonly)
    .map((f, order) => {
      // A relation whose records could not be listed is typed in (its id), not dropped.
      const choice = f.kind === "relation" && (f.options?.length ?? 0) === 0;
      return {
        id: f.key,
        key: f.key,
        label: f.label,
        type: choice ? "text" : FORM_TYPE[f.kind],
        helpText: f.description,
        order,
        isRequired: f.required === true,
        isUnique: false,
        hidden: false,
        options: f.options?.map((o) => ({ label: o.label, value: o.value })),
      } as unknown as FieldDefinition;
    });
}

const DATASET_KIND: Record<string, FieldKind> = {
  text: "text",
  string: "text",
  textarea: "longtext",
  richtext: "longtext",
  number: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  timestamp: "datetime",
  image: "image",
  media: "image",
  file: "url",
  url: "url",
  email: "email",
  select: "select",
  multiselect: "multiselect",
  json: "json",
  relation: "relation",
  kpi: "number",
  repeater: "json",
};

/** A dataset's schema as list fields (the entry's own `status` first among the filters). */
export function fieldsFromDataset(schema: FieldDefinition[], statusLabel: string): ListField[] {
  const own: ListField[] = [...schema]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((f) => {
      const kind = DATASET_KIND[f.type as string] ?? "text";
      return {
        key: f.key,
        label: f.label,
        kind,
        options: f.options?.map((o) => ({ value: String(o.value), label: o.label })),
        // The search route orders by itself and compares numbers, not dates.
        sortable: false,
        filterable: kind === "select" || kind === "boolean",
        hidden: f.hidden === true || kind === "json" || kind === "longtext",
        required: f.isRequired === true,
        description: f.helpText,
      };
    });
  return [
    ...own,
    {
      key: "status",
      label: statusLabel,
      kind: "select",
      options: ["published", "draft", "archived"].map((v) => ({ value: v, label: v })),
      sortable: false,
      filterable: true,
      readonly: true,
    },
    {
      key: "updatedAt",
      label: columnLabel("updatedAt"),
      kind: "datetime",
      sortable: false,
      filterable: false,
      readonly: true,
    },
  ];
}

const MODEL_KIND: Record<string, FieldKind> = {
  text: "text",
  longText: "longtext",
  integer: "number",
  number: "number",
  boolean: "boolean",
  date: "datetime",
  enum: "select",
  json: "json",
  uuid: "id",
};

export function fieldsFromModel(descriptor: ModelDescriptor): ListField[] {
  return descriptor.fields.map((f) => {
    const kind = MODEL_KIND[f.type] ?? "text";
    return {
      key: f.key,
      label: columnLabel(f.key),
      kind,
      options: f.values?.map((v) => ({ value: v, label: v })),
      sortable: descriptor.sortable.includes(f.key),
      filterable: descriptor.filterable.includes(f.key),
      hidden: kind === "json" || kind === "longtext",
      required: f.required,
      description: f.description,
    };
  });
}

// ── Fetching ─────────────────────────────────────────────────────────────────────────

const rowsOf = (body: unknown): Row[] => {
  const b = body as { data?: unknown; docs?: unknown } | unknown[];
  if (Array.isArray(b)) return b as Row[];
  if (Array.isArray(b?.data)) return b.data as Row[];
  if (Array.isArray(b?.docs)) return b.docs as Row[];
  return [];
};

const totalOf = (body: unknown, fallback: number): number => {
  const b = body as {
    pagination?: { total?: number };
    totalDocs?: number;
    total?: number;
  } | null;
  return Number(b?.pagination?.total ?? b?.totalDocs ?? b?.total ?? fallback) || 0;
};

/** DELETE answers 204 or a body; either is fine. */
async function del(path: string): Promise<void> {
  try {
    await api.delete(path);
  } catch (error) {
    // `api` reads JSON from every answer: an empty 204 is a success, not a failure.
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

const aboutOf = (row: Row) => {
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const name = (v: unknown) =>
    v && typeof v === "object" ? (text((v as Row).name) ?? text((v as Row).email)) : text(v);
  return {
    created: text(row.createdAt ?? row.created_at),
    updated: text(row.updatedAt ?? row.updated_at),
    createdBy: name(row.createdByName ?? row.created_by_name ?? row.createdBy ?? row.created_by),
    updatedBy: name(row.updatedByName ?? row.updated_by_name ?? row.updatedBy ?? row.updated_by),
  };
};

export interface ExplorerSourceInput {
  konId: string;
  viewId: string;
  table: string;
  label: string;
  singular: string;
  /** The kon's own base (`/api/directory`), when it declares one. */
  apiEndpoint?: string;
  /** The filter a view always applies (`defaultFilter` in the kon's manifest). */
  fixedFilter?: Record<string, unknown>;
  bulkActions?: BulkAction[];
  rowActions?: RowAction[];
}

/**
 * A kon's table. Its fields come from the table's JSON Schema (/api/explorer/schema/json),
 * its relation choices from the related table's options; a kon with its own API base has
 * no schema to ask, so the fields are read from the first rows.
 */
export async function explorerSource(input: ExplorerSourceInput): Promise<RecordSource> {
  const endpoint = explorerEndpoint(input.apiEndpoint, input.table);
  const generic = endpoint.startsWith("/api/explorer/");
  let primaryKey = "id";
  let fields: ListField[] = [];

  if (generic) {
    try {
      const schema = await api.get<{
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
        "x-kitsuden"?: { primaryKey?: string };
      }>(`/api/explorer/schema/json/${input.table}`);
      primaryKey = schema["x-kitsuden"]?.primaryKey || "id";
      const required = new Set(schema.required ?? []);
      fields = Object.entries(schema.properties ?? {}).map(([name, prop]) =>
        fieldFromJsonSchema(name, prop, required.has(name), primaryKey)
      );
    } catch {
      fields = [];
    }
  }
  if (fields.length === 0) {
    // No schema: look at a few rows. An empty table has no columns to show yet.
    try {
      const sample = await api.get<unknown>(`${endpoint}?limit=5&page=1`);
      fields = fieldsFromRows(rowsOf(sample));
    } catch {
      fields = [];
    }
  }

  // Relation choices: only from tables the explorer really has.
  const tables = await knownTables();
  await Promise.all(
    fields
      .filter((f) => f.kind === "relation" || (f.kind === "id" && isRelationColumn(f.key)))
      .map(async (f) => {
        const related =
          f.relationTable && tables.has(f.relationTable)
            ? f.relationTable
            : resolveRelatedTable(f.key, input.table, tables);
        if (!related) return;
        try {
          const r = await api.get<{ options?: Array<{ value: unknown; label: string }> }>(
            `/api/explorer/${related}/options`
          );
          f.kind = "relation";
          f.hidden = false;
          f.relationTable = related;
          f.options = (r.options ?? []).map((o) => ({ value: String(o.value), label: o.label }));
        } catch {
          /* the column stays an id */
        }
      })
  );

  const title = titleColumn(fields.map((f) => ({ name: f.key, type: f.kind })));
  const source: RecordSource = {
    id: `kon:${input.konId}:${input.viewId}:${input.table}`,
    label: input.label,
    singular: input.singular,
    fields,
    formFields: formFieldsFrom(fields),
    titleField: title,
    searchable: true,
    dateFilters: generic,
    bulkActions: input.bulkActions,
    rowActions: input.rowActions,
    inline: generic ? { konId: input.konId, table: input.table } : undefined,
    rowId: (row) => String(row[primaryKey] ?? row.id ?? ""),
    title: (row) => recordTitle(row, title),
    value: (row, key) => row[key],
    async list(query) {
      if (generic) {
        const body = await api.get<unknown>(
          `${endpoint}?${explorerParams(query, fields, input.fixedFilter)}`
        );
        const rows = rowsOf(body);
        return { rows, total: totalOf(body, rows.length) };
      }
      const { params, unsent } = legacyParams(endpoint, query, input.fixedFilter);
      const body = await api.get<unknown>(`${endpoint}?${params}`);
      // What this route could not filter is applied to the page it returned.
      const rows = rowsOf(body).filter((row) =>
        unsent.every(([key, value]) => String(row[key]) === String(value))
      );
      return { rows, total: totalOf(body, rows.length) };
    },
    async get(id) {
      if (generic) {
        // The explorer has no "get one" route: ask the list for the row with this key.
        const body = await api.get<unknown>(
          `${endpoint}?limit=1&page=1&filter[${primaryKey}]=${encodeURIComponent(id)}`
        );
        return rowsOf(body).find((r) => String(r[primaryKey]) === id) ?? null;
      }
      try {
        const row = await api.get<Row>(`${endpoint}/${encodeURIComponent(id)}`);
        // Some routes wrap the record (`{ data: {...} }`).
        const inner = (row as { data?: unknown }).data;
        return inner && typeof inner === "object" && !Array.isArray(inner) && !(primaryKey in row)
          ? (inner as Row)
          : row;
      } catch (error) {
        const status = (error as ApiError).status;
        if (status !== 404 && status !== 405) throw error;
        // A kon route without "get one": find it in the list by its key.
        const body = await api.get<unknown>(
          `${endpoint}?limit=1&filter_field=${primaryKey}&filter_op=equals&filter_value=${encodeURIComponent(id)}`
        );
        return rowsOf(body).find((r) => String(r[primaryKey]) === id) ?? null;
      }
    },
    create: (values) => api.post<Row>(endpoint, values),
    update: (id, values) => api.patch<Row>(`${endpoint}/${encodeURIComponent(id)}`, values),
    remove: (id) => del(`${endpoint}/${encodeURIComponent(id)}`),
    formValues: (row) => ({ ...row }),
    apiPath: (id) => (id ? `${endpoint}/${id}` : endpoint),
    about: aboutOf,
  };
  return source;
}

export interface DatasetLike {
  id: string;
  name: string;
  slug?: string;
  schema?: FieldDefinition[];
  displayConfig?: { titleField?: string } | null;
}

/** The entries of a dataset: fields from its schema, list and search through /search. */
export function datasetSource(
  dataset: DatasetLike,
  labels: { status: string; entry: string }
): RecordSource {
  const schema = Array.isArray(dataset.schema) ? dataset.schema : [];
  const fields = fieldsFromDataset(schema, labels.status);
  const base = `/api/datasets/${dataset.id}`;
  const titleField =
    dataset.displayConfig?.titleField ??
    schema.find((f) => ["text", "string"].includes(f.type as string))?.key ??
    null;
  const dataOf = (row: Row): Row =>
    row.data && typeof row.data === "object" ? (row.data as Row) : {};
  const body = (values: Row) => ({
    title: String(recordTitle({ data: values }, titleField) || "").slice(0, 200) || undefined,
    data: values,
  });

  return {
    id: `dataset:${dataset.id}`,
    label: dataset.name,
    singular: labels.entry,
    fields,
    formFields: schema,
    titleField,
    searchable: true,
    dateFilters: false,
    rowId: (row) => String(row.id ?? ""),
    title: (row) => recordTitle(row, titleField) || String(row.title ?? ""),
    value: (row, key) => (key === "status" || key === "updatedAt" ? row[key] : dataOf(row)[key]),
    async list(query) {
      const r = await api.get<unknown>(`${base}/search?${datasetSearchParams(query)}`);
      const rows = rowsOf(r);
      return { rows, total: totalOf(r, rows.length) };
    },
    async get(id) {
      try {
        return await api.get<Row>(`${base}/entries/${encodeURIComponent(id)}`);
      } catch (error) {
        if ((error as ApiError).status === 404) return null;
        throw error;
      }
    },
    create: (values) => api.post<Row>(`${base}/entries`, body(values)),
    update: (id, values) =>
      api.patch<Row>(`${base}/entries/${encodeURIComponent(id)}`, body(values)),
    remove: (id) => del(`${base}/entries/${encodeURIComponent(id)}`),
    formValues: (row) => {
      // `_snapshots` is the entry's own history, not a field.
      const { _snapshots: _history, ...data } = dataOf(row);
      return data;
    },
    apiPath: (id) => (id ? `${base}/entries/${id}` : `${base}/entries`),
    about: aboutOf,
    fullUpdate: true,
    async snapshots(id) {
      const r = await api.get<{ snapshots?: SnapshotLike[] }>(
        `${base}/entries/${encodeURIComponent(id)}/snapshots`
      );
      return r.snapshots ?? [];
    },
  };
}

/** A model declared with defineModel, at its collection route (`base`). */
export function modelSource(kon: string, base: string, descriptor: ModelDescriptor): RecordSource {
  const fields: ListField[] = [
    ...fieldsFromModel(descriptor),
    {
      key: "createdAt",
      label: columnLabel("createdAt"),
      kind: "datetime",
      sortable: descriptor.sortable.includes("createdAt"),
      filterable: false,
      readonly: true,
    },
  ];
  return {
    id: `model:${kon}/${descriptor.name}`,
    // `tag` is the model's name for people ("Cupping sessions"); `name` is its identifier.
    label: descriptor.tag || descriptor.plural,
    singular: columnLabel(descriptor.name.replace(/-/g, "_")),
    fields,
    formFields: formFieldsFrom(fields),
    titleField: descriptor.title,
    // A model route has no text search (only equality on its filterable fields).
    searchable: false,
    dateFilters: false,
    rowId: (row) => String(row.id ?? ""),
    title: (row) => recordTitle(row, descriptor.title),
    value: (row, key) => row[key],
    async list(query) {
      const r = await api.get<{ data?: Row[]; total?: number }>(
        `${base}?${modelParams(query, descriptor)}`
      );
      return { rows: r.data ?? [], total: Number(r.total ?? r.data?.length ?? 0) };
    },
    async get(id) {
      try {
        const r = await api.get<Row>(`${base}/${encodeURIComponent(id)}`);
        const inner = (r as { data?: unknown }).data;
        return inner && typeof inner === "object" && !("id" in r) ? (inner as Row) : r;
      } catch (error) {
        if ((error as ApiError).status === 404) return null;
        throw error;
      }
    },
    // A new record sends only what was filled in: an empty field takes the model's default.
    create: (values) =>
      api.post<Row>(
        base,
        Object.fromEntries(
          Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== "")
        )
      ),
    update: (id, values) => api.patch<Row>(`${base}/${encodeURIComponent(id)}`, values),
    remove: (id) => del(`${base}/${encodeURIComponent(id)}`),
    formValues: (row) => ({ ...row }),
    apiPath: (id) => (id ? `${base}/${id}` : base),
    about: aboutOf,
  };
}

export interface MemorySourceInput {
  id: string;
  label: string;
  singular: string;
  fields: ListField[];
  titleField?: string | null;
  rows: () => Row[] | Promise<Row[]>;
  rowId?: (row: Row) => string;
  bulkActions?: BulkAction[];
  rowActions?: RowAction[];
  remove?: (id: string) => Promise<void>;
}

/** Rows that match the search text and every filter, in memory. */
export function filterRows(rows: Row[], filters: ListFilters, fields: ListField[]): Row[] {
  const search = searchOf(filters).toLowerCase();
  const kinds = new Map(fields.map((f) => [f.key, f.kind]));
  return rows.filter((row) => {
    if (search) {
      const haystack = Object.values(row)
        .filter((v) => typeof v === "string" || typeof v === "number")
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    for (const [key, value] of filterEntries(filters)) {
      const kind = kinds.get(key);
      const actual = row[key];
      if ((kind === "date" || kind === "datetime") && typeof value === "string") {
        const { from, to } = dateRangeOf(value);
        const day = typeof actual === "string" ? actual.slice(0, 10) : "";
        if (!day || (from && day < from) || (to && day > to)) return false;
      } else if (typeof value === "boolean") {
        if (Boolean(actual) !== value) return false;
      } else if (String(actual ?? "") !== String(value)) return false;
    }
    return true;
  });
}

export function sortRows(rows: Row[], sort: ListSort | null): Row[] {
  if (!sort) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === "number" && typeof y === "number") return sign * (x - y);
    return sign * String(x).localeCompare(String(y), undefined, { numeric: true });
  });
}

/**
 * A list the API returns whole (agents, actions, vault collections): search, filters, sort
 * and pages happen here, with the same template and the same URL state as the others.
 */
export function memorySource(input: MemorySourceInput): RecordSource {
  const rowId = input.rowId ?? ((row: Row) => String(row.id ?? ""));
  const readonly = async (): Promise<Row> => {
    throw new Error("read-only list");
  };
  return {
    id: input.id,
    label: input.label,
    singular: input.singular,
    fields: input.fields,
    formFields: [],
    titleField: input.titleField ?? null,
    searchable: true,
    dateFilters: true,
    bulkActions: input.bulkActions,
    rowActions: input.rowActions,
    rowId,
    title: (row) => recordTitle(row, input.titleField),
    value: (row, key) => row[key],
    async list(query) {
      const all = sortRows(filterRows(await input.rows(), query.filters, input.fields), query.sort);
      const start = (query.page - 1) * query.pageSize;
      return { rows: all.slice(start, start + query.pageSize), total: all.length };
    },
    async get(id) {
      return (await input.rows()).find((row) => rowId(row) === id) ?? null;
    },
    create: readonly,
    update: readonly,
    remove: input.remove ?? (async () => void (await readonly())),
    formValues: (row) => ({ ...row }),
    apiPath: () => "",
    about: aboutOf,
  };
}

export type { FieldOption };
