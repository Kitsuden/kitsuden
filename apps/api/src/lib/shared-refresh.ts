/**
 * A value that is expensive to build, built once at a time and served stale
 * while it refreshes.
 *
 * Made for the admin registry: a cold build introspects every kon table and
 * took 18–120 s. Each request that arrived meanwhile started its own build,
 * they competed for the database pool, and Bun cut them at 10 s. Here:
 *
 *  - Callers that arrive while a build runs wait for THAT build.
 *  - Once a value exists, an expired one is returned at once and the next one
 *    is built in the background.
 *  - `clear()` drops the value; a build that started before it still answers
 *    whoever awaits it, but is not kept.
 */
export interface SharedRefresh<T> {
  get(): Promise<T>;
  clear(): void;
}

export function createSharedRefresh<T>(
  build: () => Promise<T>,
  options: {
    ttlMs: number;
    now?: () => number;
    onBackgroundError?: (err: unknown) => void;
  }
): SharedRefresh<T> {
  const now = options.now ?? Date.now;
  let value: T | null = null;
  let builtAt = 0;
  let running: Promise<T> | null = null;
  let generation = 0;

  function start(): Promise<T> {
    if (running) return running;
    const startedIn = generation;
    const current = build()
      .then((result) => {
        if (startedIn === generation) {
          value = result;
          builtAt = now();
        }
        return result;
      })
      .finally(() => {
        if (running === current) running = null;
      });
    running = current;
    return current;
  }

  return {
    async get() {
      if (value !== null) {
        if (now() - builtAt >= options.ttlMs) {
          start().catch((err) => options.onBackgroundError?.(err));
        }
        return value;
      }
      return start();
    },
    clear() {
      value = null;
      builtAt = 0;
      generation++;
      running = null;
    },
  };
}
