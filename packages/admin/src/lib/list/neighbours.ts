/**
 * Previous / next on a record page: the list remembers the ids of the page it showed (per
 * list, for this tab), and the record page finds its neighbours there. A record opened from
 * a link, with no list behind it, simply has no neighbours.
 */
const key = (listId: string) => `kitsuden-admin-neighbours:${listId}`;

type KeyValue = Pick<Storage, "getItem" | "setItem">;

function session(storage?: KeyValue): KeyValue | null {
  if (storage) return storage;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function rememberNeighbours(listId: string, ids: string[], storage?: KeyValue): void {
  try {
    session(storage)?.setItem(key(listId), JSON.stringify(ids));
  } catch {
    /* no storage: no previous / next */
  }
}

export function neighboursOf(
  listId: string,
  id: string,
  storage?: KeyValue
): { previous: string | null; next: string | null; position: number; total: number } {
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(session(storage)?.getItem(key(listId)) ?? "[]");
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    ids = [];
  }
  const at = ids.indexOf(id);
  return {
    previous: at > 0 ? ids[at - 1]! : null,
    next: at >= 0 && at < ids.length - 1 ? ids[at + 1]! : null,
    position: at,
    total: ids.length,
  };
}
