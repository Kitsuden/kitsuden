/**
 * Test environment for the admin.
 *
 * jsdom does not implement the Web Animations API, and Svelte uses it for
 * `animate:`/`transition:`. Without this polyfill, mounting any component with
 * an animated list blows up with `element.animate is not a function` — which is
 * not a component failure but an environment one, and confusing them costs an afternoon.
 */

import "@testing-library/jest-dom/vitest";

if (typeof Element !== "undefined" && !Element.prototype.animate) {
  // Returns an already finished animation: the tests check the resulting
  // DOM, not the intermediate frames.
  Element.prototype.animate = function animate() {
    return {
      cancel() {},
      finish() {},
      pause() {},
      play() {},
      reverse() {},
      addEventListener() {},
      removeEventListener() {},
      currentTime: 0,
      playState: "finished",
      finished: Promise.resolve(),
      onfinish: null,
    } as unknown as Animation;
  };
}

// jsdom also lacks ResizeObserver, which several layout components use.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
