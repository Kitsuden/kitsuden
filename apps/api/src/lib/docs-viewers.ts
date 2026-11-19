/**
 * The API documentation viewers, served from our own origin
 * ============================================================================
 *
 * `/api/docs` (Swagger UI) and `/api/docs/modern` (Scalar) loaded their code
 * from jsDelivr with no pinned version: whatever was published that minute ran
 * on a page where people paste tokens. Now:
 *
 *   - the files come from `apps/api/docs-viewers/` (filled and checked by
 *     `scripts/docs-viewers.mjs` against the pins in `docs-viewers.json`);
 *   - each `<script>`/`<link>` carries its Subresource Integrity;
 *   - the page sends a Content-Security-Policy with a per-request nonce and
 *     `connect-src 'self'`: the viewer can call this API and nothing else
 *     (no telemetry, no font CDN, no third-party request proxy, no AI agent).
 *
 * The asset URL carries the version (`/api/docs/assets/scalar@1.78.1/…`), so it
 * can be cached forever: a new version is a new URL.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pins from "./docs-viewers.json";

export type ViewerId = keyof typeof pins.viewers;

interface PinnedFile {
  from: string;
  sri: string;
}

const viewers = pins.viewers as Record<
  ViewerId,
  { package: string; version: string; files: Record<string, PinnedFile> }
>;

/** `scalar@1.78.1`: the folder name and the URL segment of a viewer. */
export const viewerKey = (id: ViewerId) => `${id}@${viewers[id].version}`;

export const assetUrl = (id: ViewerId, file: string) => `/api/docs/assets/${viewerKey(id)}/${file}`;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Where the viewers are. Several layouts run this code: the API from source
 * (`src/lib`), its bundle (`apps/api/dist`, `dist-node`) and the `kitsuden`
 * package (`dist/`, which carries its own `docs-viewers/`).
 */
function viewersDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.KITSUDEN_DOCS_VIEWERS_DIR,
    join(here, "docs-viewers"),
    join(here, "../docs-viewers"),
    join(here, "../../docs-viewers"),
    join(process.cwd(), "docs-viewers"),
    join(process.cwd(), "apps/api/docs-viewers"),
  ].filter((p): p is string => !!p);
  return candidates.find((d) => existsSync(join(d, viewerKey("scalar")))) ?? null;
}

let dir: string | null | undefined;
const cache = new Map<string, Uint8Array>();

/**
 * The bytes of a pinned viewer file, or `null` if `asset`/`file` is not one of
 * the pins (the name is never used as a path before matching the table) or the
 * file is not on disk.
 */
export function viewerAsset(
  asset: string,
  file: string
): { body: Uint8Array; contentType: string } | null {
  const id = (Object.keys(viewers) as ViewerId[]).find((v) => viewerKey(v) === asset);
  if (!id || !Object.hasOwn(viewers[id].files, file)) return null;
  const contentType = CONTENT_TYPES[file.slice(file.lastIndexOf("."))];
  if (!contentType) return null;
  const key = `${asset}/${file}`;
  let body = cache.get(key);
  if (!body) {
    if (dir === undefined) dir = viewersDir();
    if (!dir) return null;
    const path = resolve(dir, asset, file);
    if (!existsSync(path)) return null;
    body = new Uint8Array(readFileSync(path));
    cache.set(key, body);
  }
  return { body, contentType };
}

/** Are the files there? (No: the page says how to get them instead of a blank screen.) */
export function viewersInstalled(): boolean {
  if (dir === undefined) dir = viewersDir();
  return !!dir;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/** JSON for an inline `<script>`: nothing in it can close the tag. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * The page's policy. `style-src 'unsafe-inline'`: both viewers set inline
 * styles (Scalar's CSP documentation says so); scripts stay nonce-only.
 */
export function viewerCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

function script(id: ViewerId, file: string, nonce: string): string {
  const sri = viewers[id].files[file].sri;
  return `<script src="${assetUrl(id, file)}" integrity="${sri}" crossorigin="anonymous" nonce="${nonce}"></script>`;
}

function stylesheet(id: ViewerId, file: string): string {
  const sri = viewers[id].files[file].sri;
  return `<link rel="stylesheet" href="${assetUrl(id, file)}" integrity="${sri}" crossorigin="anonymous" />`;
}

function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    ${head}
  </head>
  <body style="margin:0">
    ${body}
  </body>
</html>
`;
}

/** Without the files, a page that says why instead of an empty one. */
export function missingViewersPage(): string {
  return page(
    "API documentation",
    "",
    `<main style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">
      <h1>The documentation viewer is not installed</h1>
      <p>This API serves its viewers itself, and their files are missing here.
      From the repository, run <code>node scripts/docs-viewers.mjs</code> and reload.</p>
      <p>The contract is available as JSON: <a href="/api/docs/openapi.json">/api/docs/openapi.json</a>.</p>
    </main>`
  );
}

export interface DocSource {
  title: string;
  slug: string;
  url: string;
}

/** Scalar with one entry per document: the whole API, then each kon. */
export function scalarPage(sources: DocSource[], nonce: string): string {
  const config = {
    sources: sources.map((s, i) => ({ ...s, default: i === 0 })),
    // Everything that would talk to a third party is off; the CSP blocks it anyway.
    telemetry: false,
    withDefaultFonts: false,
    agent: { disabled: true },
    mcp: { disabled: true },
    showDeveloperTools: "never",
    persistAuth: false,
    documentDownloadType: "json",
  };
  return page(
    "Kitsuden API Reference",
    "",
    `<div id="app"></div>
    ${script("scalar", "standalone.js", nonce)}
    <script nonce="${nonce}">Scalar.createApiReference("#app", ${scriptJson(config)});</script>`
  );
}

/** Swagger UI on one document, with the validator badge off (it sends the URL to swagger.io). */
export function swaggerPage(specUrl: string, nonce: string): string {
  const config = {
    url: specUrl,
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: false,
    validatorUrl: "none",
  };
  return page(
    "Kitsuden API Documentation",
    stylesheet("swagger-ui", "swagger-ui.css"),
    `<div id="swagger-ui"></div>
    ${script("swagger-ui", "swagger-ui-bundle.js", nonce)}
    <script nonce="${nonce}">window.ui = SwaggerUIBundle(${scriptJson(config)});</script>`
  );
}
