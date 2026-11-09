/** `/img/<media id>/<preset>` → API `/api/media/preset/<id>/<preset>` (see lib/media.ts) */
import type { APIRoute } from "astro";

import { isMediaId, isPreset } from "../../../lib/media";
import { proxyMedia } from "../../../lib/proxy";

export const GET: APIRoute = ({ params, locals }) => {
  const { id, preset } = params;
  if (!isMediaId(id) || !isPreset(preset)) return new Response(null, { status: 404 });
  return proxyMedia(locals.kitsuden.apiUrl, `/api/media/preset/${id.toLowerCase()}/${preset}`);
};
