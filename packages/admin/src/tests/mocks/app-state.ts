/**
 * Mock of `$app/state` for unit tests. See app-navigation.ts.
 *
 * Plain objects: the tests check the DOM the components produce, not
 * SvelteKit's navigation. (SvelteKit 3 removed `$app/stores`; the panel reads
 * `page` from `$app/state`.)
 */

export const page = {
  url: new URL("http://localhost/"),
  params: {} as Record<string, string>,
  route: { id: null as string | null },
  status: 200,
  error: null,
  data: {} as Record<string, unknown>,
  form: undefined,
  state: {},
};

export const navigating = { current: null };
export const updated = { current: false, check: async () => false };
