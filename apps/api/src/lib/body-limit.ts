/**
 * Maximum size of a request body to `/api/*`.
 * ============================================================================
 *
 * Audit 2026-10-15: there was no `bodyLimit`, and Bun accepts up to 128 MB per
 * request. Any route that does `c.req.json()` —including the public ones
 * (comments, search, registrations)— read into memory whatever it was sent:
 * a few concurrent 100 MB requests are enough to bring the process down.
 *
 * 10 MB by default. Two kinds of exception:
 *
 *   · exact core routes that need more, with a bigger limit OF THEIR OWN
 *     (`ROUTE_LIMITS`). Until 2026-11-04 the whole `/api/media` prefix and
 *     `/api/datasets/import` were simply exempt: folders, config and
 *     `PATCH /api/media/:id` read any size, and the import read everything into
 *     memory (security review 2026-11-03);
 *   · prefixes of installable kons that receive files and apply their own limit
 *     (`PREFIXES_WITH_OWN_LIMIT`).
 */
import type { MiddlewareHandler } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";

const MB = 1024 * 1024;

export const BODY_LIMIT_BYTES = 10 * MB;

/** `POST /api/media/upload`: 20 files of 10 MB, plus the multipart overhead (media.routes.ts). */
export const MEDIA_UPLOAD_MAX_BYTES = 20 * 10 * MB + MB;

/**
 * `POST /api/datasets/import` and `/import/package`: JSON parsed whole in
 * memory, admin only. `DATASET_IMPORT_MAX_MB` (default 100, 1 to 1024) for a
 * bigger package; bigger than that, split it.
 */
export function datasetImportMaxBytes(): number {
  const n = Number(process.env.DATASET_IMPORT_MAX_MB ?? 100);
  return (Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 1024) : 100) * MB;
}

export interface RouteLimit {
  /** Exact path (no prefix match: `/api/media/upload`, not `/api/media/*`). */
  path: string;
  maxBytes: number;
}

/** Core routes with a limit of their own, larger than the global one. */
export function routeLimits(): RouteLimit[] {
  const imports = datasetImportMaxBytes();
  return [
    { path: "/api/media/upload", maxBytes: MEDIA_UPLOAD_MAX_BYTES },
    { path: "/api/datasets/import", maxBytes: imports },
    { path: "/api/datasets/import/package", maxBytes: imports },
  ];
}

/** Prefixes of installable kons that receive files and apply their own limit. */
export const PREFIXES_WITH_OWN_LIMIT = [
  "/api/academy/media",
  "/api/dms",
  "/api/ocr",
  "/api/ocr-training",
];

export function hasOwnLimit(path: string): boolean {
  return PREFIXES_WITH_OWN_LIMIT.some((p) => path === p || path.startsWith(`${p}/`));
}

export function bodyLimit(
  maxBytes = BODY_LIMIT_BYTES,
  routes: RouteLimit[] = routeLimits()
): MiddlewareHandler {
  const limiter = (max: number) =>
    honoBodyLimit({
      maxSize: max,
      onError: (c) => c.json({ error: "Payload Too Large", maxBytes: max }, 413),
    });
  const general = limiter(maxBytes);
  const own = new Map(routes.map((r) => [r.path, limiter(r.maxBytes)]));
  return (c, next) => {
    const path = c.req.path;
    if (hasOwnLimit(path)) return next();
    return (own.get(path) ?? general)(c, next);
  };
}
