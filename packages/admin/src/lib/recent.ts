/**
 * Recently opened records, from real navigation: the shell pushes every detail page the
 * user lands on (a page that adds crumbs after its section). Kept per user in the browser
 * behind a small interface, so the store can move to the API later.
 */
export interface RecentItem {
  path: string;
  label: string;
  /** The section it belongs to ("Datasets"), shown next to the label. */
  section?: string;
  at: number;
}

export const MAX_RECENT = 8;

/** `list` with `item` first, one entry per path, at most `max`. */
export function pushRecent(list: RecentItem[], item: RecentItem, max = MAX_RECENT): RecentItem[] {
  if (!item.path || !item.label.trim()) return list;
  return [item, ...list.filter((r) => r.path !== item.path)].slice(0, max);
}

export interface RecentStore {
  list(): RecentItem[];
  push(item: Omit<RecentItem, "at">): void;
}

type KeyValue = Pick<Storage, "getItem" | "setItem">;

function valid(value: unknown): value is RecentItem {
  const r = value as RecentItem | null;
  return !!r && typeof r.path === "string" && r.path.startsWith("/") && typeof r.label === "string";
}

/** The browser store of one user (`userId` keeps two accounts on one machine apart). */
export function recentStore(userId: string, storage?: KeyValue): RecentStore {
  const key = `kitsuden-admin-recent:${userId || "anon"}`;
  const store = (): KeyValue | null => {
    if (storage) return storage;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  const list = (): RecentItem[] => {
    try {
      const parsed: unknown = JSON.parse(store()?.getItem(key) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX_RECENT) : [];
    } catch {
      return [];
    }
  };
  return {
    list,
    push(item) {
      try {
        store()?.setItem(key, JSON.stringify(pushRecent(list(), { ...item, at: Date.now() })));
      } catch {
        /* a full or blocked storage only loses the history */
      }
    },
  };
}
