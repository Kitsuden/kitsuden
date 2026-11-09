// @ts-check
import { defineConfig, envField } from "astro/config";
import node from "@astrojs/node";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Kitsuden starter: Astro configuration
 * ============================================================================
 *
 * The site is server-rendered (`output: "server"`): pages, posts and the
 * sitemap are read from the Kitsuden API on each request, so publishing in the
 * admin shows up without a rebuild.
 *
 * Environment (see `.env.example`):
 *
 *   KITSUDEN_API_URL   where the SERVER reaches the API (read at runtime)
 *   SITE_URL           public origin of this site (canonical URLs, sitemap)
 *   KITSUDEN_SITE_KEY  optional, = SITE_API_KEY of the API (runtime only)
 *   INTI               "true" to build with the optional Inti visual editor
 *
 * Secrets are never baked into the bundle: `KITSUDEN_SITE_KEY` and
 * `INTI_KITSUDEN_TOKEN` are read from `process.env` when the server starts,
 * and they are removed from this process before `astro build` runs.
 */

/** `.env` of this folder, so `SITE_URL` and `INTI` work in astro.config too */
const fromFile = (() => {
  try {
    return Object.fromEntries(
      readFileSync(new URL("./.env", import.meta.url), "utf-8")
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
        .filter((m) => m !== null)
        .map(([, key, value]) => [key, value.replace(/^(["'])(.*)\1$/, "$2")])
    );
  } catch {
    return {};
  }
})();
const env = { ...fromFile, ...process.env };

const SECRETS = ["KITSUDEN_SITE_KEY", "INTI_KITSUDEN_TOKEN", "INTI_TOKEN"];
if (process.argv.includes("build")) {
  for (const key of SECRETS) delete process.env[key];
}

// ─── Inti (optional) ─────────────────────────────────────────────────────────

const withInti = env.INTI === "true";

/**
 * Without Inti the site imports the stubs in `src/inti/` (no `@intijs/*`
 * anywhere in the graph). With `INTI=true` the same imports resolve to
 * `src/inti/live/*`, which do use Inti.
 */
const STUBS = {
  runtime: /[\\/]src[\\/]inti[\\/]runtime(\.ts)?$/,
  toolbar: /[\\/]src[\\/]inti[\\/]EditorToolbar\.astro$/,
};
const LIVE = {
  runtime: fileURLToPath(new URL("./src/inti/live/runtime.ts", import.meta.url)),
  toolbar: fileURLToPath(new URL("./src/inti/live/EditorToolbar.astro", import.meta.url)),
};
const ACTIONS = fileURLToPath(new URL("./src/inti/live/actions.ts", import.meta.url));
const ACTIONS_ENTRY = /[\\/]src[\\/]actions(?:[\\/]index(\.ts)?)?$/;

/** @type {import("vite").Plugin} */
const intiSwitch = {
  name: "starter:inti-switch",
  enforce: "pre",
  async resolveId(id, importer) {
    if (!withInti) return null;
    // Relative imports arrive unresolved: resolve them first, then compare
    const resolved =
      id.startsWith(".") && importer
        ? ((await this.resolve(id, importer, { skipSelf: true }))?.id ?? id)
        : id;
    if (STUBS.runtime.test(resolved)) return LIVE.runtime;
    if (STUBS.toolbar.test(resolved)) return LIVE.toolbar;
    if (ACTIONS_ENTRY.test(resolved)) return ACTIONS;
    return null;
  },
};

/** Loads `@intijs/core` only when asked to, with a clear error if missing */
async function intiIntegrations() {
  if (!withInti) return [];
  let inti;
  try {
    inti = (await import("@intijs/core")).default;
    await import("@intijs/adapter-kitsuden");
  } catch (error) {
    throw new Error(
      "INTI=true but @intijs/core or @intijs/adapter-kitsuden is not installed. " +
        "See README.md, section 'Visual editing with Inti'.\n" +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Read by the editor at build time; not a secret
  process.env.INTI_ADAPTER ||= "kitsuden";
  return [
    inti(),
    {
      name: "starter:inti",
      hooks: {
        "astro:config:setup": ({ injectRoute, addMiddleware }) => {
          // What Astro mounts on its own when it sees `src/actions/index.ts`.
          // That file does not exist on purpose: it would mount the actions
          // (and import Inti) in every build, also without INTI=true.
          injectRoute({
            pattern: "/_actions/[...path]",
            entrypoint: "astro/actions/runtime/entrypoints/route.js",
            prerender: false,
          });
          addMiddleware({
            entrypoint: new URL("./src/inti/live/middleware.ts", import.meta.url),
            order: "pre",
          });
        },
      },
    },
  ];
}

export default defineConfig({
  site: (env.SITE_URL || "http://localhost:4321").replace(/\/+$/, ""),
  output: "server",
  adapter: node({ mode: "standalone" }),
  /**
   * `access: "secret"` is what makes Astro read a variable when the server
   * STARTS instead of writing it into the bundle. The API URL is not secret,
   * but it changes between machines and containers, so it is read at runtime
   * as well.
   */
  env: {
    schema: {
      KITSUDEN_API_URL: envField.string({
        context: "server",
        access: "secret",
        default: "http://localhost:3000",
      }),
      KITSUDEN_SITE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      // Behind a reverse proxy: take the visitor IP from X-Forwarded-For
      // (src/lib/client-ip.ts). Runtime, like the two above.
      KITSUDEN_TRUST_PROXY: envField.boolean({
        context: "server",
        access: "secret",
        default: false,
      }),
      SITE_NAME: envField.string({
        context: "server",
        access: "public",
        default: "Kitsuden Starter",
      }),
      SITE_LOCALE: envField.string({ context: "server", access: "public", default: "en" }),
    },
  },
  integrations: [...(await intiIntegrations())],
  vite: {
    plugins: [intiSwitch],
    define: {
      __INTI__: JSON.stringify(withInti),
    },
  },
});
