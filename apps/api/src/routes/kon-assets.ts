/**
 * Kon admin artifacts
 * ============================================================================
 *
 * Serves the already-compiled bundle of a custom view under a stable URL:
 *
 *   GET /api/kons/:konId/admin-asset/<path>
 *
 * It is the piece that makes the admin extension point framework-agnostic: the
 * kon publishes an artifact, the admin loads it with `import(url)` at
 * RUNTIME, and the host's bundler never sees foreign code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY
 *
 * This route turns a string from a `kon.json` — which in a marketplace is
 * third-party content — into a file read. That is exactly the shape of a
 * path traversal, so the defense is explicit and layered:
 *
 *   1. The kon id is validated against a pattern allowlist, and it also
 *      has to resolve to a REAL kon that is already loaded. No path is
 *      built from user text.
 *   2. The requested path is validated (no `..`, no absolute paths, no null bytes) and
 *      restricted to front-end extensions.
 *   3. After normalizing, it checks that the final path is still INSIDE the
 *      kon's directory. This is the check that catches whatever slips past
 *      the first two (symbolic links, odd encodings).
 *   4. An admin asset must be something a DECLARED view needs: its `src`, a
 *      file next to it, or `dist/admin/` (`isDeclaredAdminAsset`). The route has
 *      no session, so the rest of the package (server code compiled to JS,
 *      source maps) is not handed out (security review 2026-11-03).
 *
 * Client-side validation (`@kitsuden/shared`) does NOT count here: whoever serves
 * the file cannot trust whoever requests it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import { Readable } from "node:stream";

import {
  declaredViewSources,
  isDeclaredAdminAsset,
  isSafeAssetPath,
  isValidKonId,
} from "@kitsuden/shared";
import { Hono, type Context } from "hono";

import { konRoute } from "../lib/installed-kons";
import { logger } from "../lib/logger";
import { readKonManifest, resolveWorkspaceRoot } from "../lib/module-loader";

const app = new Hono();

/** MIME types of the only artifacts that are served. */
const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  // Only for graphics: see the CSP applied when serving it.
  ".html": "text/html; charset=utf-8",
};

/** 5 MB. An admin panel that weighs more is a bug, not a use case. */
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/**
 * Directory on disk of a kon.
 *
 * It is looked up by folder name within the known roots instead of
 * concatenating the id into a path: this way the id never takes part in building
 * an arbitrary path.
 */
async function konDirectory(konId: string): Promise<string | null> {
  const root = await resolveWorkspaceRoot();
  // First the folder of the INSTALLED kon (kitsuden.kons.json / KITSUDEN_KONS):
  // it can live in packages/kons, in node_modules or be linked from another repo.
  // The id is only used to LOOK UP in that list, never to build the path.
  const installed = konRoute(konId);
  const candidates = [
    ...(installed ? [installed] : []),
    join(root, "packages", "kons", konId),
    // Core kons live outside packages/kons and their id has a prefix.
    join(root, "packages", "core", konId.replace(/^kon-/, "")),
  ];

  for (const dir of candidates) {
    try {
      const info = await stat(dir);
      if (info.isDirectory()) return await realpath(dir);
    } catch {
      // Next candidate.
    }
  }
  return null;
}

/** What kind of artifact each route serves. It determines extensions and headers. */
type AssetKind = "admin-asset" | "graphics";

/**
 * Serves a file from a kon's package applying the three layers of defense.
 *
 * Shared between `admin-asset` and `graphics` on purpose: duplicating the
 * containment logic would be the easiest way for one of the two to fall behind.
 */
async function serveFromKon(c: Context, kind: AssetKind) {
  const konId = c.req.param("konId")!;

  // ── Layer 1: shape of the id ──
  if (!isValidKonId(konId)) {
    return c.json({ error: "Invalid kon id" }, 400);
  }

  // Hono hands over the wildcard already decoded; it is normalized again in case
  // it arrives doubly encoded (`%252e%252e`).
  const raw = c.req.path.split(`/${kind}/`)[1] ?? "";
  let requested: string;
  try {
    requested = decodeURIComponent(raw);
  } catch {
    return c.json({ error: "Invalid asset path" }, 400);
  }

  // ── Layer 2: shape of the path ──
  // `.html` is only allowed for graphics: a page on the same origin as the
  // admin can read its cookies, so it is not handed out to admin views.
  const allowHtml = kind === "graphics";
  if (!isSafeAssetPath(requested, { allowHtml })) {
    logger.warn({ konId, requested, kind }, "[kon-assets] artifact path rejected");
    return c.json({ error: "Invalid asset path" }, 400);
  }

  const konDir = await konDirectory(konId);
  if (!konDir) return c.json({ error: "Kon not found" }, 404);

  // ── Layer 4: only what a declared view needs ──
  // Same answer as a missing file: which other files the package has is not
  // the caller's business.
  if (kind === "admin-asset") {
    const declared = declaredViewSources(await readKonManifest(konDir));
    if (!isDeclaredAdminAsset(requested, declared)) {
      logger.warn({ konId, requested }, "[kon-assets] not part of a declared admin view");
      return c.json({ error: "Not found" }, 404);
    }
  }

  // For graphics, the containment root is `graphics/`, not the whole package.
  // The scope is narrowed instead of checking a prefix in the request: this way
  // no path can serve HTML from another point of the kon, and the URL stays
  // clean (`/graphics/overlay.html`, without repeating the segment).
  const baseDir = kind === "graphics" ? join(konDir, "graphics") : konDir;

  const target = resolve(baseDir, requested);

  // ── Layer 3: real containment after normalizing ──
  // This is the check that really matters: even if the earlier ones failed,
  // here the resolved file is required to hang from the kon's directory.
  if (target !== baseDir && !target.startsWith(baseDir + sep)) {
    logger.warn({ konId, requested, target }, "[kon-assets] path traversal attempt");
    return c.json({ error: "Invalid asset path" }, 400);
  }

  const ext = extname(target).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return c.json({ error: "Unsupported asset type" }, 400);
  if (ext === ".html" && kind !== "graphics") {
    return c.json({ error: "Unsupported asset type" }, 400);
  }

  let info;
  try {
    // `realpath` resolves symbolic links: a symlink inside the package
    // pointing outside would get around the prefix check above.
    const real = await realpath(target);
    if (real !== baseDir && !real.startsWith(baseDir + sep)) {
      logger.warn({ konId, requested, real }, "[kon-assets] symlink outside the kon");
      return c.json({ error: "Invalid asset path" }, 400);
    }
    info = await stat(real);
    if (!info.isFile()) return c.json({ error: "Not found" }, 404);
  } catch {
    return c.json({ error: "Not found" }, 404);
  }

  if (info.size > MAX_ASSET_BYTES) {
    return c.json({ error: "Asset too large" }, 413);
  }

  // ETag by (mtime, size): enough to revalidate and avoids reading the file.
  const etag = `W/"${info.mtimeMs.toString(36)}-${info.size.toString(36)}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304 });
  }

  const headers: Record<string, string> = {
    "content-type": mime,
    "content-length": String(info.size),
    etag,
    // Short and revalidatable: an admin view is iterated on often during
    // development, and a long cache would make it seem that changes do not apply.
    "cache-control": "public, max-age=0, must-revalidate",
    // The artifact is third-party: it is marked as non-sniffable so the
    // browser does not reinterpret it as something else.
    "x-content-type-options": "nosniff",
  };

  if (kind === "graphics") {
    // A graphic is THIRD-PARTY HTML served from the API origin. If
    // someone opens it in the browser where they have an admin session, it shares
    // an origin with it. The CSP limits the damage: no external resources, no
    // connections outside the host itself, and it cannot embed the admin.
    headers["content-security-policy"] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'", // overlays carry inline style/logic
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'", // it only talks to this API, never exfiltrates elsewhere
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
    // OBS needs to load it, but nobody should be able to frame it.
    headers["x-frame-options"] = "DENY";
  }

  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
  return new Response(stream, { headers });
}

/** Admin views: Web Components and their styles. */
app.get("/:konId/admin-asset/*", (c) => serveFromKon(c, "admin-asset"));

/**
 * Graphics for broadcast: the page pasted into an OBS Browser Source.
 *
 * It is the equivalent of the `graphics/` of a NodeCG bundle, with two
 * differences: here they sit behind a strict CSP, and the state they consume travels
 * over a channel with permissions instead of a global JSON with no access control.
 */
app.get("/:konId/graphics/*", (c) => serveFromKon(c, "graphics"));

export default app;
