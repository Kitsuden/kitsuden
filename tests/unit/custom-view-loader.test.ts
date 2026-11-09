/**
 * Custom view loader — deduplication, laziness and errors
 * ============================================================================
 *
 * The DOM dependencies are injected, so this runs in Node without a
 * browser. What is pinned down here is the behavior that makes the extension
 * point usable: that it is not downloaded twice, that it is not downloaded if
 * nobody opens the view, and that a failure says WHAT to fix.
 */

import { describe, expect, test, vi } from "vitest";

import { createCustomViewLoader } from "../../packages/admin/src/lib/custom-view-loader";

const BROADCAST = {
  konId: "kon-broadcast",
  element: "broadcast-scoreboard",
  src: "./admin/scoreboard.js",
};

/** Simulates the browser: an element registry and a controllable importer. */
function harness(
  options: {
    /** What the import does: registers the element, fails, or registers nothing. */
    onImport?: (url: string, define: (tag: string) => void) => Promise<void>;
  } = {}
) {
  const defined = new Set<string>();
  const waiters = new Map<string, (() => void)[]>();
  const imports: string[] = [];

  const define = (tag: string) => {
    defined.add(tag);
    for (const resolve of waiters.get(tag) ?? []) resolve();
    waiters.delete(tag);
  };

  const onImport = options.onImport ?? (async (_url, def) => def(BROADCAST.element)); // by default: registers

  const loader = createCustomViewLoader({
    importModule: async (url) => {
      imports.push(url);
      await onImport(url, define);
      return {};
    },
    isElementDefined: (name) => defined.has(name),
    whenElementDefined: (name) =>
      defined.has(name)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.set(name, [...(waiters.get(name) ?? []), resolve]);
          }),
    defineTimeoutMs: 50,
  });

  return { loader, imports, defined, define };
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe("loading", () => {
  test("imports the artifact and returns the tag to instantiate", async () => {
    const { loader, imports } = harness();

    const result = await loader.load(BROADCAST);

    expect(result.tag).toBe("broadcast-scoreboard");
    expect(result.url).toBe("/api/kons/kon-broadcast/admin-asset/admin/scoreboard.js");
    expect(imports).toEqual(["/api/kons/kon-broadcast/admin-asset/admin/scoreboard.js"]);
  });

  test("it is lazy: it downloads nothing until the view is requested", () => {
    const { loader, imports } = harness();
    // Building the loader must not touch the network — if the user never opens the
    // view, its bundle must not weigh on the admin load.
    expect(imports).toEqual([]);
    expect(loader.size).toBe(0);
  });

  test("waits for the element's asynchronous registration", async () => {
    // A bundle can register the element after an await: looking right after
    // the import would give a false negative.
    const { loader } = harness({
      onImport: async (_url, define) => {
        setTimeout(() => define(BROADCAST.element), 5);
      },
    });

    const result = await loader.load(BROADCAST);
    expect(result.tag).toBe("broadcast-scoreboard");
  });
});

// ── Deduplication ────────────────────────────────────────────────────────────

describe("deduplication", () => {
  test("two loads of the same artifact download only once", async () => {
    const { loader, imports } = harness();

    await loader.load(BROADCAST);
    await loader.load(BROADCAST);

    expect(imports).toHaveLength(1);
  });

  test("CONCURRENT loads share a single download", async () => {
    // Caching only the result would let two parallel requests through:
    // that is why the in-flight promise is cached.
    const { loader, imports } = harness({
      onImport: async (_url, define) => {
        await new Promise((r) => setTimeout(r, 10));
        define(BROADCAST.element);
      },
    });

    await Promise.all([loader.load(BROADCAST), loader.load(BROADCAST), loader.load(BROADCAST)]);

    expect(imports).toHaveLength(1);
  });

  test("if the element is already registered, it does not even import", async () => {
    const { loader, imports, define } = harness();
    define(BROADCAST.element); // e.g. another view of the same bundle already loaded it

    await loader.load(BROADCAST);

    expect(imports).toEqual([]);
  });

  test("invalidate forces a new download", async () => {
    const { loader, imports } = harness();
    const { url } = await loader.load(BROADCAST);

    loader.invalidate(url);
    // The element is still registered, so to observe the download a clean
    // loader is needed; what is checked is the cache state.
    expect(loader.isLoaded(url)).toBe(false);
    expect(imports).toHaveLength(1);
  });
});

// ── Errors ───────────────────────────────────────────────────────────────────

describe("errors", () => {
  test("an invalid descriptor fails BEFORE touching the network", async () => {
    const { loader, imports } = harness();

    await expect(loader.load({ ...BROADCAST, src: "../../../etc/passwd" })).rejects.toThrow(
      /is not a valid artifact path/
    );
    // Not a single request: the error is one of configuration, not network.
    expect(imports).toEqual([]);
  });

  test("an element without a hyphen is rejected with a message saying how to fix it", async () => {
    const { loader } = harness();
    await expect(loader.load({ ...BROADCAST, element: "scoreboard" })).rejects.toThrow(
      /must be lowercase and contain a hyphen/i
    );
  });

  test("an artifact that does not exist gives LOAD_FAILED with the URL", async () => {
    const { loader } = harness({
      onImport: async () => {
        throw new Error("404");
      },
    });

    await expect(loader.load(BROADCAST)).rejects.toThrow(/Could not load the artifact/);
  });

  test("a failure is NOT cached: a fixed deployment recovers on its own", async () => {
    let attempt = 0;
    const { loader, imports } = harness({
      onImport: async (_url, define) => {
        attempt++;
        if (attempt === 1) throw new Error("404");
        define(BROADCAST.element);
      },
    });

    await expect(loader.load(BROADCAST)).rejects.toThrow();
    // Second attempt after fixing the artifact: it must work without reloading
    // the whole page.
    const result = await loader.load(BROADCAST);

    expect(result.tag).toBe("broadcast-scoreboard");
    expect(imports).toHaveLength(2);
  });

  test("a bundle that loads but does not register the element says so explicitly", async () => {
    const { loader } = harness({
      onImport: async () => {
        // It loads fine, but forgets customElements.define.
      },
    });

    await expect(loader.load(BROADCAST)).rejects.toThrow(/never registered <broadcast-scoreboard>/);
  });

  test("the non-registration error leaves no dangling timers", async () => {
    vi.useFakeTimers();
    try {
      const { loader } = harness({ onImport: async () => {} });
      const promise = loader.load(BROADCAST).catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      const err = await promise;
      expect(String(err)).toMatch(/never registered/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
