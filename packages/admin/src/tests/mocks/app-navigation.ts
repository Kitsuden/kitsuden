/**
 * Mock of `$app/navigation` for unit tests.
 *
 * The alias to this file was already in vitest.config.ts, but the file was never
 * created: any test that imported —even transitively— a
 * component with `goto` failed to resolve, without running a single case.
 */

export const goto = async (_url: string | URL) => {};
export const invalidate = async (_dep?: string) => {};
export const invalidateAll = async () => {};
export const preloadData = async (_href: string) => ({});
export const preloadCode = async (..._urls: string[]) => {};
export const pushState = (_url: string, _state: unknown) => {};
export const replaceState = (_url: string, _state: unknown) => {};
export const afterNavigate = (_cb: unknown) => {};
export const beforeNavigate = (_cb: unknown) => {};
export const onNavigate = (_cb: unknown) => {};
export const disableScrollHandling = () => {};
