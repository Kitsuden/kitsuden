/**
 * Images from the Kitsuden media library
 * ============================================================================
 *
 * Every image is served from THIS site's origin, through two small proxy
 * routes (`src/pages/img/...` and `src/pages/media/...`):
 *
 *   /img/<media id>/<preset>   → API /api/media/preset/<id>/<preset>
 *   /media/<key>               → API /media/<key> (local storage files)
 *
 * Why not link the API directly: the API answers everything under `/api/*`
 * with `Cross-Origin-Resource-Policy: same-origin`, so a browser downloads a
 * preset image from another origin and then refuses to paint it (only
 * `/media/*` is cross-origin). It also keeps the API URL private: the server
 * may reach it on an internal address the browser cannot see.
 */

/** Presets defined by kon-media (`transform.routes.ts`) */
export const PRESETS = ["thumbnail", "small", "medium", "large", "hero"] as const;
export type Preset = (typeof PRESETS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isMediaId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
export const isPreset = (value: unknown): value is Preset =>
  typeof value === "string" && (PRESETS as readonly string[]).includes(value);

/** Same-origin URL of a media item in a preset size, or `null` if the id is not one */
export function mediaUrl(id: unknown, preset: Preset = "large"): string | null {
  return isMediaId(id) ? `/img/${id.toLowerCase()}/${preset}` : null;
}

/** A `/media/<key>` path the proxy accepts: no `..`, no odd characters */
export const MEDIA_KEY = /^(?!.*\.\.)[A-Za-z0-9._\-/]{1,300}$/;

/**
 * Any image reference a block may hold, turned into something the browser can
 * load: a media id, a `/media/...` or `/api/media/...` path of the API, or an
 * absolute https URL (an external image the editor linked on purpose).
 * Anything else (javascript:, data:, relative junk) is dropped.
 */
export function imageSrc(value: unknown, preset: Preset = "large"): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  const byId = mediaUrl(v, preset);
  if (byId) return byId;

  const presetPath = v.match(/^\/api\/media\/preset\/([^/?#]+)\/([a-z]+)/);
  if (presetPath) return isPreset(presetPath[2]) ? mediaUrl(presetPath[1], presetPath[2]) : null;

  if (v.startsWith("/media/")) {
    const key = v.slice("/media/".length).split(/[?#]/)[0];
    return MEDIA_KEY.test(key) ? `/media/${key}` : null;
  }

  try {
    // Plain http would be mixed content on an https site
    const url = new URL(v);
    if (url.protocol === "https:") return url.href;
  } catch {
    // not a URL
  }
  return null;
}
