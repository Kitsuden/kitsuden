import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [sveltekit()],
  esbuild:
    mode === "production"
      ? {
          // BETA.md blocker #4: the production bundle does not include debug
          // noise. In dev the console.* calls remain available.
          drop: ["console", "debugger"],
        }
      : undefined,
}));
