/**
 * Saved views of a list (a named set of search, filters, sort, density and columns), per
 * user. The store is a small interface so it can move from the browser to the API without
 * touching the lists; `browserViewStore` is the localStorage implementation.
 */
export interface StoredView {
  name: string;
  /** The query string of the list without the page (see `listStateQuery`). */
  query: string;
}

export interface ViewStore {
  list(listId: string): StoredView[];
  save(listId: string, view: StoredView): StoredView[];
  rename(listId: string, name: string, next: string): StoredView[];
  remove(listId: string, name: string): StoredView[];
}

type KeyValue = Pick<Storage, "getItem" | "setItem">;

export const MAX_VIEWS = 30;

const valid = (v: unknown): v is StoredView =>
  !!v &&
  typeof (v as StoredView).name === "string" &&
  (v as StoredView).name.trim() !== "" &&
  typeof (v as StoredView).query === "string";

export function browserViewStore(userId: string, storage?: KeyValue): ViewStore {
  const store = (): KeyValue | null => {
    if (storage) return storage;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  const key = (listId: string) => `kitsuden-admin-views:${userId || "anon"}:${listId}`;

  const read = (listId: string): StoredView[] => {
    try {
      const parsed: unknown = JSON.parse(store()?.getItem(key(listId)) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch {
      return [];
    }
  };
  const write = (listId: string, views: StoredView[]): StoredView[] => {
    const kept = views.slice(0, MAX_VIEWS);
    try {
      store()?.setItem(key(listId), JSON.stringify(kept));
    } catch {
      /* a full or blocked storage keeps the views for this visit only */
    }
    return kept;
  };

  return {
    list: read,
    save(listId, view) {
      const name = view.name.trim();
      if (!name) return read(listId);
      // Saving under an existing name replaces that view, in place.
      const views = read(listId);
      const at = views.findIndex((v) => v.name === name);
      const next = { name, query: view.query };
      return write(listId, at >= 0 ? views.map((v, i) => (i === at ? next : v)) : [...views, next]);
    },
    rename(listId, name, next) {
      const clean = next.trim();
      const views = read(listId);
      if (!clean || views.some((v) => v.name === clean && v.name !== name)) return views;
      return write(
        listId,
        views.map((v) => (v.name === name ? { ...v, name: clean } : v))
      );
    },
    remove(listId, name) {
      return write(
        listId,
        read(listId).filter((v) => v.name !== name)
      );
    },
  };
}

/** The saved view the current query corresponds to, or null. */
export function currentView(views: StoredView[], query: string): string | null {
  return views.find((v) => v.query === query)?.name ?? null;
}
