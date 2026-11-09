import { ProposalPendingError } from "./errors";
import type { CallOptions, Ok, OperationInfo, Outcome } from "./types";

type Call = (
  info: OperationInfo,
  params: Record<string, unknown>,
  options?: CallOptions
) => Promise<Outcome<unknown>>;

const ITEM_FIELDS = ["docs", "data", "items", "rows", "results", "entries"];
/** Where list responses keep their counters, in the order they are looked up. */
const CONTAINERS = ["", "pagination", "meta", "pageInfo"];

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The items of one page (`field` from the generated info; guessed when it is `null`). */
export function itemsOf(data: unknown, field: string | null | undefined): unknown[] {
  if (Array.isArray(data)) return data;
  const o = obj(data);
  if (!o) return [];
  if (field) return Array.isArray(o[field]) ? (o[field] as unknown[]) : [];
  for (const k of ITEM_FIELDS) if (Array.isArray(o[k])) return o[k] as unknown[];
  const arrays = Object.values(o).filter(Array.isArray);
  return arrays.length === 1 ? (arrays[0] as unknown[]) : [];
}

function search(data: unknown, names: string[]): unknown {
  const o = obj(data);
  if (!o) return undefined;
  for (const c of CONTAINERS) {
    const where = c ? obj(o[c]) : o;
    if (!where) continue;
    for (const n of names) if (where[n] !== undefined && where[n] !== null) return where[n];
  }
  return undefined;
}

const number = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Walks the pages of a list operation, moving `page`, `offset` or `cursor`. */
export async function* pages(
  call: Call,
  info: OperationInfo,
  params: Record<string, unknown> = {},
  options?: CallOptions
): AsyncIterableIterator<Ok<unknown>> {
  const paging = info.pagination;
  if (!paging) throw new TypeError(`${info.operationId} is not a list operation`);
  const p: Record<string, unknown> = { ...params };
  let page = number(p.page) ?? 1;
  let offset = number(p.offset) ?? 0;
  for (let round = 0; round < 100_000; round++) {
    if (paging.style === "page") p.page = page;
    if (paging.style === "offset") p.offset = offset;
    const out = await call(info, p, options);
    if (out.kind !== "ok") throw new ProposalPendingError(out);
    yield out;

    const items = itemsOf(out.data, paging.items);
    if (items.length === 0) return;
    const hasMore = search(out.data, ["hasNextPage", "hasMore", "has_more", "hasNext"]);
    if (hasMore === false) return;
    const limit =
      number(paging.limit ? p[paging.limit] : undefined) ??
      number(search(out.data, ["limit", "pageSize", "perPage"]));
    const short = hasMore !== true && limit !== undefined && items.length < limit;

    if (paging.style === "cursor") {
      const next = search(out.data, ["nextCursor", "next_cursor", "cursor"]);
      if (next === undefined || next === null || next === "" || next === p.cursor) return;
      p.cursor = next;
      continue;
    }
    if (short) return;
    if (paging.style === "page") {
      const totalPages = number(search(out.data, ["totalPages", "pages", "pageCount"]));
      if (totalPages !== undefined && page >= totalPages) return;
      page++;
    } else {
      offset += items.length;
      const total = number(search(out.data, ["totalDocs", "total", "totalCount", "count"]));
      if (total !== undefined && offset >= total) return;
    }
  }
}

export async function* iterate(
  call: Call,
  info: OperationInfo,
  params: Record<string, unknown> = {},
  options?: CallOptions
): AsyncIterableIterator<unknown> {
  for await (const page of pages(call, info, params, options)) {
    yield* itemsOf(page.data, info.pagination?.items);
  }
}
