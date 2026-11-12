/**
 * What the current page says about itself, for the shell: the crumbs it adds after its
 * section (a dataset, a record). The top bar's Breadcrumb and `<title>` are built from the
 * section plus these, so a page names itself once (through `<Page>`), not in three places.
 */
import type { Crumb } from "./nav";

interface Meta {
  /** The pathname the crumbs belong to: a stale entry never labels another page. */
  path: string;
  crumbs: Crumb[];
  /** The page's own title (its h1): names a kon's page that has no sidebar entry. */
  title?: string;
}

const state = $state<{ meta: Meta | null }>({ meta: null });

export const pageMeta = {
  /** The crumbs the page at `path` declared, or none. */
  crumbsFor(path: string): Crumb[] {
    return state.meta && state.meta.path === path ? state.meta.crumbs : [];
  },
  /** The title the page at `path` declared, if any. */
  titleFor(path: string): string | undefined {
    return state.meta && state.meta.path === path ? state.meta.title : undefined;
  },
  set(path: string, crumbs: Crumb[], title?: string): void {
    const same =
      state.meta?.path === path &&
      state.meta.title === title &&
      JSON.stringify(state.meta.crumbs) === JSON.stringify(crumbs);
    if (!same) state.meta = { path, crumbs, title };
  },
  clear(path: string): void {
    if (state.meta?.path === path) state.meta = null;
  },
};
