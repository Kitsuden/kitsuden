import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import kitConfig from "./kit.config.js";

export default defineConfig(({ mode }) => ({
  // Tailwind as a Vite plugin: under Vite 8 the PostCSS route failed to resolve
  // `@import "tailwindcss"` (Vite's own CSS import resolver runs first).
  plugins: [tailwindcss(), sveltekit(kitConfig)],
  build: {
    rolldownOptions: {
      output: {
        // BETA.md blocker #4: the production bundle does not include debug noise.
        // In dev the console.* calls remain available. Vite 8 bundles with
        // Rolldown, so this is its minifier option, not esbuild's `drop`. Before,
        // a stale compiled vite.config.js shadowed this file and nothing was dropped.
        minify:
          mode === "production"
            ? { compress: { dropConsole: true, dropDebugger: true } }
            : undefined,
      },
    },
  },
}));
