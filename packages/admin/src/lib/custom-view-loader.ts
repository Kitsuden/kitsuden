/**
 * Loader for framework-agnostic admin views
 * ============================================================================
 *
 * Replaces `component-loader.ts`, which did
 * `import("../../../packages/grimoires/<x>/admin.svelte")`. That had three
 * problems, and only one was the framework:
 *
 *   1. It forced writing Svelte to extend the admin.
 *   2. Being a dynamic import with a template, Vite resolved it as a glob:
 *      the admin bundled the view of ALL the kons even if nobody
 *      opened them.
 *   3. The package map was hand-written in the admin's code,
 *      so a third party could not contribute a view without editing the host.
 *
 * Here an ALREADY COMPILED ARTIFACT is loaded by URL, at runtime. The admin's
 * bundler sees nothing foreign, each extension brings its runtime inside, and the isolation
 * is provided by the custom element's Shadow DOM.
 *
 * The DOM dependencies are injected on purpose: that way the deduplication,
 * error and lifecycle logic can be tested without a browser.
 */

import { CustomViewError, resolveCustomView, type CustomViewDescriptor } from "@kitsuden/shared";

export interface CustomViewLoaderDeps {
  /** Imports an ESM module by URL. In the browser, `import(url)`. */
  importModule: (url: string) => Promise<unknown>;
  /** Is that custom element already registered? */
  isElementDefined: (name: string) => boolean;
  /**
   * Waits for the element to be registered. A bundle may register it
   * asynchronously (top-level await), so looking right after the
   * import is not enough.
   */
  whenElementDefined: (name: string) => Promise<void>;
  /** Milliseconds before giving up waiting for the registration. */
  defineTimeoutMs?: number;
}

export interface LoadedCustomView {
  /** Name of the tag to instantiate, e.g. `broadcast-scoreboard`. */
  tag: string;
  url: string;
}

/** The browser's real dependencies. */
export function browserDeps(): CustomViewLoaderDeps {
  return {
    importModule: (url) => import(/* @vite-ignore */ url),
    isElementDefined: (name) => Boolean(customElements.get(name)),
    whenElementDefined: (name) => customElements.whenDefined(name).then(() => undefined),
  };
}

export function createCustomViewLoader(deps: CustomViewLoaderDeps) {
  const timeoutMs = deps.defineTimeoutMs ?? 10_000;

  /**
   * Imports in flight or resolved, by URL.
   *
   * The PROMISE is stored, not the result: if two views of the same bundle
   * open at the same time, they must share a single download. Caching only the
   * result would let two parallel requests through.
   */
  const modules = new Map<string, Promise<unknown>>();

  function importOnce(url: string): Promise<unknown> {
    const existing = modules.get(url);
    if (existing) return existing;

    const promise = deps.importModule(url).catch((err) => {
      // Failures are NOT cached: if the artifact is fixed and deployed
      // again, the next attempt must be able to recover without reloading
      // the whole page.
      modules.delete(url);
      throw new CustomViewError(
        `Could not load the artifact "${url}": ${err instanceof Error ? err.message : String(err)}`,
        "LOAD_FAILED"
      );
    });

    modules.set(url, promise);
    return promise;
  }

  async function waitForDefinition(tag: string): Promise<void> {
    if (deps.isElementDefined(tag)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CustomViewError(
              `The artifact loaded but never registered <${tag}>. ` +
                `Check that it calls customElements.define("${tag}", …).`,
              "NOT_REGISTERED"
            )
          ),
        timeoutMs
      );
    });

    try {
      await Promise.race([deps.whenElementDefined(tag), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    /**
     * Loads the view and returns the tag ready to instantiate.
     * Idempotent: calling it twice does not download anything again.
     */
    async load(descriptor: CustomViewDescriptor, baseUrl = ""): Promise<LoadedCustomView> {
      // Validates BEFORE touching the network: a malformed descriptor must fail
      // with a message saying what to fix, not with a 404.
      const { url } = resolveCustomView(descriptor, baseUrl);

      // If the element is already registered (another view of the same bundle, or a
      // hot reload), there is no need to import anything.
      if (deps.isElementDefined(descriptor.element)) {
        return { tag: descriptor.element, url };
      }

      await importOnce(url);
      await waitForDefinition(descriptor.element);

      return { tag: descriptor.element, url };
    },

    /** Has this artifact already been requested? For diagnostics and tests. */
    isLoaded(url: string): boolean {
      return modules.has(url);
    },

    /** Forces the next `load` to download again. Useful in development. */
    invalidate(url: string): void {
      modules.delete(url);
    },

    reset(): void {
      modules.clear();
    },

    /** How many distinct artifacts have been requested. */
    get size(): number {
      return modules.size;
    },
  };
}

export type CustomViewLoader = ReturnType<typeof createCustomViewLoader>;

/** The admin's shared instance. */
let shared: CustomViewLoader | null = null;

export function customViewLoader(): CustomViewLoader {
  if (!shared) shared = createCustomViewLoader(browserDeps());
  return shared;
}
