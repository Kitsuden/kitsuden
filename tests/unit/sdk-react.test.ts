/**
 * React bindings — contract and guarantees
 * ============================================================================
 *
 * The unit suite runs in Node without a DOM, so what is pinned down here is what can
 * be checked without rendering: that the core stays agnostic, that the hooks are
 * real hooks, and that the three defenses that separate a usable binding
 * from one that produces bugs are in place.
 *
 * Rendering real components is the admin suite's job, which does
 * have a DOM environment.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = resolve(__dirname, "../..");
const REACT_PKG = join(ROOT, "packages/sdk-react");
const INDEX = readFileSync(join(REACT_PKG, "src/index.ts"), "utf8");
const SYNCED = readFileSync(join(REACT_PKG, "src/synced-state.ts"), "utf8");
const PKG = JSON.parse(readFileSync(join(REACT_PKG, "package.json"), "utf8"));
const SDK_PKG = JSON.parse(readFileSync(join(ROOT, "packages/sdk/package.json"), "utf8"));

// ── The core stays agnostic ──────────────────────────────────────────────────

describe("core agnosticism", () => {
  test("the core SDK does NOT depend on React", () => {
    // It is the property that makes Vue, Svelte or vanilla pay nothing.
    const deps = { ...SDK_PKG.dependencies, ...SDK_PKG.peerDependencies };
    expect(Object.keys(deps)).not.toContain("react");
  });

  test("React is a peerDependency of the binding, not a dependency", () => {
    // As a dependency, npm would install a second copy of React and the hooks
    // would break with "invalid hook call".
    expect(PKG.peerDependencies.react).toBeDefined();
    expect(PKG.dependencies?.react).toBeUndefined();
  });

  test("accepts React 18 and 19: the hooks used exist in both", () => {
    expect(PKG.peerDependencies.react).toMatch(/>=\s*18/);
  });
});

// ── They are real hooks ──────────────────────────────────────────────────────

describe("real hooks, not disguised factories", () => {
  test("useKitsudenQuery has state", () => {
    // The previous version was called useXxx and returned { url, fetcher }: neither state nor
    // subscription. Worse than not using the prefix, because rules-of-hooks treats it
    // as a hook and the dev expects state.
    expect(INDEX).toMatch(/export function useKitsudenQuery/);
    // The Usagibase name stays as an alias of the SAME hook: removing it
    // would break whoever already imports it, and a wrapper could lose the state.
    expect(INDEX).toMatch(/export const useUsagiQuery = useKitsudenQuery/);
    expect(INDEX).toMatch(/useState/);
    expect(INDEX).toMatch(/useEffect/);
  });

  test("exposes loading and refreshing separately", () => {
    // Reloading with data already present must not make the interface flicker.
    expect(INDEX).toMatch(/refreshing/);
    expect(INDEX).toMatch(/hadData/);
  });

  test("useUsagiMutation RETURNS the promise as well as storing state", () => {
    // Without this you cannot chain (create and navigate) or catch the error
    // where it is called.
    expect(INDEX).toMatch(/mutate: \(\.\.\.args: TArgs\) => Promise<TResult>/);
    expect(INDEX).toMatch(/throw normalized/);
  });
});

// ── The three defenses ───────────────────────────────────────────────────────

describe("defenses against classic React bugs", () => {
  test("does not update after unmount", () => {
    // Changing page with a request in flight would warn in the console, and with
    // StrictMode twice.
    expect(INDEX).toMatch(/mounted\.current/);
    expect(INDEX).toMatch(/mounted\.current = false/);
  });

  test("discards stale responses by request number", () => {
    // The search box bug: two out-of-order requests and the last one to
    // ARRIVE wins instead of the last one REQUESTED.
    expect(INDEX).toMatch(/requestId/);
    expect(INDEX).toMatch(/id !== requestId\.current/);
  });

  test("deps are passed explicitly, not inferred from the function", () => {
    // An anonymous function changes on every render: comparing it would cause an infinite
    // loop of requests.
    expect(INDEX).toMatch(/deps: readonly unknown\[\]/);
    expect(INDEX).toMatch(/\.\.\.deps\]/);
  });
});

// ── useSyncedState ───────────────────────────────────────────────────────────

describe("useSyncedState", () => {
  test("uses useSyncExternalStore and not useState", () => {
    // With useState+useEffect there is tearing in concurrent mode: two components
    // on the same channel can paint different values in the same frame.
    expect(SYNCED).toMatch(/useSyncExternalStore/);
  });

  test("discards late messages, just like the overlay", () => {
    // The same defense that stops the scoreboard from going backwards live.
    expect(SYNCED).toMatch(/message\.revision <= store\.revision/);
  });

  test("the old snapshot does not overwrite what already arrived over the socket either", () => {
    expect(SYNCED).toMatch(/snap\.revision <= store\.revision/);
  });

  test("several components with the same key SHARE a socket", () => {
    // A list of ten scoreboards would open ten connections without this.
    expect(SYNCED).toMatch(/refCount\+\+/);
    expect(SYNCED).toMatch(/store\.refCount === 1\) connect/);
  });

  test("only closes when nobody is left subscribed", () => {
    // Closing when the first component unmounts would cut the channel for the others.
    expect(SYNCED).toMatch(/store\.refCount === 0/);
  });

  test("emits a NEW snapshot on every change", () => {
    // useSyncExternalStore compares by identity: mutating the same object would mean
    // React never repaints.
    expect(SYNCED).toMatch(/store\.snapshot = \{/);
  });

  test("works in SSR and RSC without breaking hydration", () => {
    // On the server there is no WebSocket; without getServerSnapshot, React throws.
    expect(SYNCED).toMatch(/getServerSnapshot/);
    expect(SYNCED).toMatch(/typeof window === "undefined"/);
  });

  test("reconnects with bounded backoff and only if someone is left", () => {
    expect(SYNCED).toMatch(/Math\.min\(500 \* 2 \*\* store\.retry\+\+, 10_000\)/);
    expect(SYNCED).toMatch(/store\.refCount === 0\) return/);
  });

  test("options are read through a ref", () => {
    // Passing them as an object literal is normal, and it would change identity on
    // every render: without the ref, it would reconnect nonstop.
    expect(SYNCED).toMatch(/optionsRef\.current = options/);
  });
});
