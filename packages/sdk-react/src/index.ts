/**
 * @kitsuden/sdk-react — React bindings
 * ============================================================================
 *
 * **The core SDK remains agnostic.** This package is ONE binding among several
 * possible ones; React is a `peerDependency`, so anyone using Vue, Svelte or
 * nothing at all does not install it or pay for it.
 *
 * What existed before was called `useXxx` but **was not a hook**: it returned
 * `{ url, fetcher }`, with no state or subscription. That is worse than not
 * using the prefix — `react-hooks/rules-of-hooks` treats it as a hook and warns
 * where it should not, and any React dev expects state and does not find it.
 *
 * Here the hooks are real hooks: they have state, they cancel on unmount and
 * they do not update components that are already unmounted.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface QueryState<T> {
  data: T | null;
  error: Error | null;
  /** First load. */
  loading: boolean;
  /** Reload with data already present — so the interface does not flicker. */
  refreshing: boolean;
  refetch: () => void;
}

export interface MutationState<TArgs extends unknown[], TResult> {
  mutate: (...args: TArgs) => Promise<TResult>;
  data: TResult | null;
  error: Error | null;
  pending: boolean;
  reset: () => void;
}

// ── Query ────────────────────────────────────────────────────────────────────

/**
 * Runs an asynchronous query and exposes its state.
 *
 * Details that separate a usable hook from one that produces bugs:
 *
 * - **`deps` governs reloading.** It is passed explicitly instead of trying to
 *   compare the function: an anonymous function changes on every render and
 *   would cause an infinite loop of requests.
 * - **No update after unmount.** Without the guard, navigating away with a
 *   request in flight logs a warning to the console and, with StrictMode, twice.
 * - **Stale responses are discarded.** If two requests arrive out of order,
 *   the last one REQUESTED wins, not the last to arrive — the classic search
 *   box bug that shows results for something you are no longer typing.
 */
export function useKitsudenQuery<T>(
  queryFn: () => Promise<T>,
  deps: readonly unknown[] = [],
  options: { enabled?: boolean } = {}
): QueryState<T> {
  const enabled = options.enabled ?? true;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const mounted = useRef(true);
  /** Request number: only the most recent one can write the state. */
  const requestId = useRef(0);
  const fnRef = useRef(queryFn);
  fnRef.current = queryFn;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const id = ++requestId.current;
    const hadData = data !== null;
    if (hadData) setRefreshing(true);
    else setLoading(true);

    fnRef
      .current()
      .then((result) => {
        // Unmounted, or a response arrived from a request that was already superseded.
        if (!mounted.current || id !== requestId.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!mounted.current || id !== requestId.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!mounted.current || id !== requestId.current) return;
        setLoading(false);
        setRefreshing(false);
      });
    // NOTE for anyone enabling `react-hooks/exhaustive-deps` in THEIR project:
    // `data` is left out on purpose — it only decides loading vs refreshing, and
    // putting it here would trigger the query again with every response, in a
    // loop. This repo does not have the plugin (the admin is Svelte), so no
    // `eslint-disable` is added for a rule that does not exist here: it would be a
    // lint error in itself.
  }, [enabled, tick, ...deps]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, refreshing, refetch };
}

// ── Mutation ─────────────────────────────────────────────────────────────────

/**
 * Wraps a write.
 *
 * `mutate` **returns the promise** as well as storing the state: without that
 * you cannot chain (create and then navigate) or catch the error at the call
 * site, which is usually where it is needed.
 */
export function useKitsudenMutation<TArgs extends unknown[], TResult>(
  mutationFn: (...args: TArgs) => Promise<TResult>,
  options: { onSuccess?: (data: TResult) => void; onError?: (error: Error) => void } = {}
): MutationState<TArgs, TResult> {
  const [data, setData] = useState<TResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fnRef = useRef(mutationFn);
  fnRef.current = mutationFn;
  const optsRef = useRef(options);
  optsRef.current = options;

  const mutate = useCallback(async (...args: TArgs): Promise<TResult> => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      if (mounted.current) setData(result);
      optsRef.current.onSuccess?.(result);
      return result;
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (mounted.current) setError(normalized);
      optsRef.current.onError?.(normalized);
      // It is rethrown: the caller must be able to catch it where it happens.
      throw normalized;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setPending(false);
  }, []);

  return { mutate, data, error, pending, reset };
}

// ── Previous names ───────────────────────────────────────────────────────────

/**
 * @deprecated Name from when the project was called Usagibase. Use
 * `useKitsudenQuery`. Kept so as not to break anyone who already imports it.
 */
export const useUsagiQuery = useKitsudenQuery;

/** @deprecated Use `useKitsudenMutation`. */
export const useUsagiMutation = useKitsudenMutation;

export * from "./synced-state.js";
