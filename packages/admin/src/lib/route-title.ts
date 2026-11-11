/**
 * Which menu entry a route belongs to. (What a page is called comes from the page itself,
 * through `<Page>` and `$lib/page-meta.svelte.ts`.)
 */

/** A menu entry: its own path plus other paths that belong to it. */
export interface NavTarget {
  path: string;
  aliases?: string[];
}

function under(base: string, path: string): boolean {
  if (base === "/") return path === "/";
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Whether `path` belongs to the entry. A whole segment has to match: `/agents` lights up
 * on `/agents/123`, not on `/agents-old`. The dashboard is `/` and its alias `/dashboard`;
 * Datasets is `/g/kon-datasets` and everything under `/datasets`.
 */
export function navItemMatches(item: NavTarget, path: string): boolean {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return [item.path, ...(item.aliases ?? [])].some((base) => under(base, clean));
}
