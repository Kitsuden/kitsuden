import { defineConfig } from "tsup";

/**
 * The published build. In the workspace the package is used from its sources (`main`/`exports`
 * point at src/); `pnpm publish` swaps them for these files (`publishConfig` in package.json),
 * so the CLI installed from npm imports JavaScript, not TypeScript.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "generators/react": "src/generators/react.ts",
    "generators/vue": "src/generators/vue.ts",
    "generators/svelte": "src/generators/svelte.ts",
    "generators/types": "src/generators/types.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
});
