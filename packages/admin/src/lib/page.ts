/**
 * Small page helpers: the document title and state kept in the query string.
 */
import { goto } from "$app/navigation";

/** "<Page> · Kitsuden", for `<svelte:head><title>`. */
export function pageTitle(name?: string | null): string {
  const clean = name?.trim();
  return clean ? `${clean} · Kitsuden` : "Kitsuden";
}

/** `url` with the given query parameters set (`null`, `undefined` or "" removes one). */
export function withQuery(url: URL, params: Record<string, string | null | undefined>): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") next.searchParams.delete(key);
    else next.searchParams.set(key, value);
  }
  return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * Writes state (a tab, the open record) to the query string as a history entry, so
 * back/forward and a shared link restore it. No scroll jump, focus stays where it is.
 */
export function setQuery(
  url: URL,
  params: Record<string, string | null | undefined>,
  { replace = false }: { replace?: boolean } = {}
): Promise<void> {
  const target = withQuery(url, params);
  if (target === `${url.pathname}${url.search}${url.hash}`) return Promise.resolve();
  return goto(target, { keepFocus: true, noScroll: true, replaceState: replace });
}

/** The value of `?key=` when it is one of `allowed`, otherwise `fallback`. */
export function queryChoice<T extends string>(
  url: URL,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = url.searchParams.get(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}
