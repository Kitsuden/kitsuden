/** `/media/<key>` → API `/media/<key>`, the files of the local storage driver */
import type { APIRoute } from "astro";

import { MEDIA_KEY } from "../../lib/media";
import { proxyMedia } from "../../lib/proxy";

export const GET: APIRoute = ({ params, locals }) => {
  const key = params.key ?? "";
  if (!MEDIA_KEY.test(key)) return new Response(null, { status: 404 });
  return proxyMedia(
    locals.kitsuden.apiUrl,
    `/media/${key.split("/").map(encodeURIComponent).join("/")}`
  );
};
