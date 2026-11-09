/**
 * Mock of `$app/stores` for unit tests. See app-navigation.ts.
 *
 * They are minimal readable stores: the tests check the DOM the components
 * produce, not SvelteKit's navigation.
 */

type Subscriber<T> = (value: T) => void;

function readable<T>(value: T) {
  return {
    subscribe(run: Subscriber<T>) {
      run(value);
      return () => {};
    },
  };
}

export const page = readable({
  url: new URL("http://localhost/"),
  params: {} as Record<string, string>,
  route: { id: null as string | null },
  status: 200,
  error: null,
  data: {} as Record<string, unknown>,
  form: undefined,
  state: {},
});

export const navigating = readable(null);
export const updated = { ...readable(false), check: async () => false };
