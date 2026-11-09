import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    include: ["src/**/*.{test,spec}.{js,ts}"],
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{js,ts,svelte}"],
      exclude: [
        "src/**/*.{test,spec}.{js,ts}",
        "src/test-setup.ts",
        "src/**/_*",
        "src/composables/**",
        "src/_legacy_vue_archive/**",
      ],
    },
  },
  resolve: {
    // Without this, Svelte 5 resolves its SERVER build under vitest and mounting a
    // component fails with `mount(...) is not available on the server`. It is the
    // reason @testing-library/svelte was installed and unused: the
    // harness existed but never got to start.
    conditions: ["browser"],
    alias: {
      $lib: path.resolve(__dirname, "./src/lib"),
      $components: path.resolve(__dirname, "./src/components"),
      $views: path.resolve(__dirname, "./src/views"),
      $types: path.resolve(__dirname, "./src/types"),
      $stores: path.resolve(__dirname, "./src/stores"),
      // SvelteKit runtime mocks for unit tests
      "$app/navigation": path.resolve(__dirname, "./src/tests/mocks/app-navigation.ts"),
      "$app/stores": path.resolve(__dirname, "./src/tests/mocks/app-stores.ts"),
    },
  },
});
