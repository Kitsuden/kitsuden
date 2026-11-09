/**
 * Framework-agnostic admin views
 * ============================================================================
 *
 * The contract that lets a kon contribute a custom view WITHOUT writing
 * Svelte and without entering the admin's build.
 *
 * The previous mechanism did `import("…/admin.svelte")` from the admin: that
 * puts foreign source code into the host's compilation graph. It has three
 * consequences, all bad:
 *
 *   1. Whoever extends is forced to use the admin's framework.
 *   2. Vite resolves the dynamic import as a glob, so the admin ends up
 *      bundling the view of ALL kons even if nobody opens them.
 *   3. Two kons with different versions of a dependency break the host's
 *      build — and that happens even if both use Svelte.
 *
 * The agnostic form reverses the relationship: the kon publishes an ALREADY
 * COMPILED ARTIFACT (with its runtime inside, whether React, Svelte, Vue or
 * nothing) and the admin loads it by URL at runtime. The admin's bundler sees
 * nothing foreign.
 *
 * This module is deliberately pure: it validates and resolves descriptors,
 * without touching the DOM. That way it can be tested without a browser, and
 * the part that does touch the DOM is reduced to a few lines.
 */

// ── Descriptor ───────────────────────────────────────────────────────────────

export interface CustomViewDescriptor {
  /** Kon that contributes the view. Determines where the artifact is served from. */
  konId: string;
  /** Name of the custom element. It must contain a hyphen (required by the spec). */
  element: string;
  /** Path of the bundle, relative to the root of the kon's package. */
  src: string;
}

export interface ResolvedCustomView {
  descriptor: CustomViewDescriptor;
  /** Absolute URL (relative to the host) to load the module from. */
  url: string;
}

export class CustomViewError extends Error {
  constructor(
    message: string,
    readonly code:
      "INVALID_ELEMENT" | "INVALID_SRC" | "INVALID_KON" | "LOAD_FAILED" | "NOT_REGISTERED"
  ) {
    super(message);
    this.name = "CustomViewError";
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * A valid custom element name: lowercase, starts with a letter and CONTAINS a
 * hyphen. The hyphen is not style — it is what separates user elements from
 * native ones, and the browser rejects registration without it.
 */
const ELEMENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** Names reserved by the spec that look valid but are not. */
const RESERVED_ELEMENT_NAMES = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-src",
  "font-face-uri",
  "font-face-format",
  "font-face-name",
  "missing-glyph",
]);

export function isValidElementName(name: string): boolean {
  return ELEMENT_NAME.test(name) && !RESERVED_ELEMENT_NAMES.has(name);
}

/**
 * A safe `src`: relative, inside the kon's package and with an allowed
 * extension.
 *
 * This is where path traversal is cut off. The `src` comes from a `kon.json`,
 * which in a marketplace is third-party content: without this check, a
 * `../../../../etc/passwd` or an absolute URL to another domain turns the
 * extension point into a vulnerability. It is validated on the CLIENT and again
 * on the SERVER — whoever serves the file cannot trust this layer.
 */
export function isSafeAssetPath(src: string, options: { allowHtml?: boolean } = {}): boolean {
  if (!src || typeof src !== "string") return false;
  // No absolute or protocol-relative URLs: the artifact is served by the
  // host itself, not by a third-party CDN that could change under your feet.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false;
  if (src.startsWith("//")) return false;
  if (src.startsWith("/")) return false;
  // No escaping the package, no null bytes, no Windows separators.
  if (src.includes("..")) return false;
  if (src.includes("\0") || src.includes("\\")) return false;
  // Only front-end artifacts, never sources or manifests.
  //
  // `.html` is separate and is NOT allowed by default: an HTML page served
  // from the same origin as the admin can read its session cookies, so
  // it is only enabled for GRAPHICS (OBS overlays) and with a restrictive
  // CSP on top. Admin views are Web Components: they do not
  // need it, and granting it would widen the surface for no reason.
  return options.allowHtml ? /\.(js|mjs|css|map|html)$/.test(src) : /\.(js|mjs|css|map)$/.test(src);
}

/**
 * The admin artifacts a kon may hand out: what its declared views need, and
 * nothing else from its package.
 *
 * Until 2026-11-04 `GET /api/kons/:konId/admin-asset/*` served ANY `.js`,
 * `.mjs`, `.css` or `.map` in the kon's directory, without a session: server
 * code compiled to JS, a `config.js`, the source maps of everything
 * (security review 2026-11-03). Now a path is served only if it is:
 *
 *   · the `src` of a view declared in `admin.views[]`, or its `.map`;
 *   · under the directory of such a `src`, when that is not the package root
 *     (`./admin/scoreboard.js` → anything under `admin/`: its chunks, styles
 *     and maps);
 *   · under `dist/admin/`, the conventional output of a view's build.
 *
 * `requested` and each `src` are relative paths already checked by
 * `isSafeAssetPath` (no `..`, no absolute path).
 */
export const ADMIN_ASSET_DIR = "dist/admin/";

export function isDeclaredAdminAsset(requested: string, declaredSrcs: readonly string[]): boolean {
  const clean = (p: string) => p.replace(/^(\.\/)+/, "");
  const path = clean(requested);
  if (!path || path.endsWith("/")) return false;
  if (path.startsWith(ADMIN_ASSET_DIR)) return true;
  for (const raw of declaredSrcs) {
    if (typeof raw !== "string" || !isSafeAssetPath(raw)) continue;
    const src = clean(raw);
    if (path === src || path === `${src}.map`) return true;
    const slash = src.lastIndexOf("/");
    if (slash > 0 && path.startsWith(src.slice(0, slash + 1))) return true;
  }
  return false;
}

/** The `src` of every view a manifest declares in `admin.views[]`. */
export function declaredViewSources(manifest: unknown): string[] {
  const views = (manifest as { admin?: { views?: unknown } } | null)?.admin?.views;
  if (!Array.isArray(views)) return [];
  return views
    .map((v) => (v as { src?: unknown } | null)?.src)
    .filter((src): src is string => typeof src === "string" && src.length > 0);
}

/** Kon id usable in a path: no separators or line breaks. */
export function isValidKonId(id: string): boolean {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** URL under which the API serves a kon's admin artifacts. */
export function adminAssetUrl(konId: string, src: string, baseUrl = ""): string {
  const clean = src.replace(/^\.\//, "");
  return `${baseUrl}/api/kons/${konId}/admin-asset/${clean}`;
}

/**
 * Validates a descriptor and returns the load URL.
 * Throws `CustomViewError` with an actionable code instead of an opaque error:
 * whoever writes the view needs to know WHAT is wrong.
 */
export function resolveCustomView(
  descriptor: CustomViewDescriptor,
  baseUrl = ""
): ResolvedCustomView {
  if (!isValidKonId(descriptor.konId)) {
    throw new CustomViewError(`Invalid kon id: "${descriptor.konId}"`, "INVALID_KON");
  }
  if (!isValidElementName(descriptor.element)) {
    throw new CustomViewError(
      `"${descriptor.element}" is not a valid custom element name. ` +
        `It must be lowercase and contain a hyphen, e.g. "${descriptor.konId}-panel".`,
      "INVALID_ELEMENT"
    );
  }
  if (!isSafeAssetPath(descriptor.src)) {
    throw new CustomViewError(
      `"${descriptor.src}" is not a valid artifact path. It must be relative ` +
        `to the kon's package and end in .js, .mjs, .css or .map.`,
      "INVALID_SRC"
    );
  }

  return { descriptor, url: adminAssetUrl(descriptor.konId, descriptor.src, baseUrl) };
}

/**
 * Extracts the descriptor of a view declared in `kon.json`.
 * Returns `null` if the view is not of the agnostic type — so the caller can
 * fall back to the legacy path or to the generic DataExplorer without handling errors.
 */
export function descriptorFromView(
  konId: string,
  view: { type?: string; element?: string; src?: string }
): CustomViewDescriptor | null {
  if (view?.type !== "element") return null;
  if (!view.element || !view.src) return null;
  return { konId, element: view.element, src: view.src };
}

// ── Context the view receives ────────────────────────────────────────────────

/**
 * What the admin hands to a custom element when mounting it, through the
 * `context` property. It is the public CONTRACT: changing it breaks third-party
 * views, so it is versioned.
 */
export interface AdminViewContext {
  /** Contract version. A view can reject what it does not understand. */
  version: 1;
  konId: string;
  viewId: string;
  /** API base so the view can make its own calls. */
  apiBase: string;
  /** Active theme, in case the view wants to branch beyond CSS. */
  theme: "light" | "dark";
  locale: string;
  /**
   * The session token is NOT handed over. The view calls the API with the
   * browser's cookies, like the rest of the admin: passing a token to
   * third-party code would make it exfiltratable.
   */
}

export function createViewContext(init: {
  konId: string;
  viewId: string;
  apiBase?: string;
  theme?: "light" | "dark";
  locale?: string;
}): AdminViewContext {
  return {
    version: 1,
    konId: init.konId,
    viewId: init.viewId,
    apiBase: init.apiBase ?? "/api",
    theme: init.theme ?? "dark",
    locale: init.locale ?? "es",
  };
}
