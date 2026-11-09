import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * SvelteKit configuration for the admin package.
 *
 * Note: the `typecheck` script runs svelte-check with
 * `--diagnostic-sources "js,svelte"`. CSS diagnostics are intentionally
 * excluded because svelte-check does not run PostCSS/Tailwind, which causes
 * false-positive warnings for `@apply` and `line-clamp`. Vite still validates
 * and processes CSS during `pnpm run build`.
 */
/**
 * The origin of the API when it is not the panel's own (`VITE_API_URL` at build
 * time); empty in the Docker image, where nginx/Caddy serve both on one origin.
 */
function apiOrigin() {
  const raw = process.env.VITE_API_URL;
  if (!raw) return [];
  try {
    return [new URL(raw).origin];
  } catch {
    return [];
  }
}

/** More hosts the panel may call (`KITSUDEN_PANEL_CONNECT_SRC`, space or comma separated). */
const extraConnect = (process.env.KITSUDEN_PANEL_CONNECT_SRC ?? "").split(/[\s,]+/).filter(Boolean);

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    /**
     * Content-Security-Policy as a <meta> in the built pages, with the HASH of
     * the inline script that starts the app (security review 2026-11-03).
     * Before, nginx and Caddy allowed every inline script ('unsafe-inline') and
     * `eval` ('unsafe-eval') because nothing could name this one script.
     *
     * The proxies still send their header (docker/nginx-admin.conf,
     * docker/Caddyfile): a browser enforces EVERY policy it receives, so an
     * inline script must pass both, and only this one carries the hash. The
     * header keeps what a <meta> cannot set (frame-ancestors) and the rest.
     *
     * Only scripts and connections here: `style-src` stays out on purpose,
     * because SvelteKit would add style hashes and that disables the
     * 'unsafe-inline' that Svelte's style attributes and transitions need.
     * Custom kon views are loaded with `import()` from the API, so its origin
     * (when it is another one) is allowed for scripts too.
     */
    csp: {
      mode: "hash",
      directives: {
        "script-src": ["self", ...apiOrigin()],
        "connect-src": ["self", ...apiOrigin(), ...extraConnect],
        "object-src": ["none"],
        "base-uri": ["self"],
      },
    },
    alias: {
      $lib: "src/lib",
      $components: "src/lib/components",
      $views: "src/views",
      $stores: "src/stores",
      $types: "src/types",
    },
  },
};

export default config;
