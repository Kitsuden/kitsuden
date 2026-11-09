/**
 * Serve a media file of the API from this site's origin (see `lib/media.ts`)
 * ============================================================================
 *
 * Only GET, only paths built by the two proxy routes from validated parts,
 * only image/video/pdf responses, and only a few headers copied. The API's
 * preset route answers with a redirect to the transformed file; it is
 * followed here, on the server.
 */

const ALLOWED_TYPES = /^(image\/(?!svg)[\w.+-]+|video\/[\w.+-]+|application\/pdf)(;|$)/i;
const COPIED = ["content-type", "content-length", "etag", "last-modified"];

export async function proxyMedia(
  apiUrl: string,
  path: string,
  init: { headers?: Record<string, string> } = {}
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl}${path}`, {
      headers: { accept: "image/avif,image/webp,image/*,video/*,*/*;q=0.5", ...init.headers },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (upstream.status === 404 || upstream.status === 400)
    return new Response(null, { status: 404 });
  if (!upstream.ok)
    return new Response(null, {
      status: upstream.status === 429 ? 503 : 502,
      headers: { "retry-after": "60" },
    });

  const type = upstream.headers.get("content-type") ?? "";
  if (!ALLOWED_TYPES.test(type)) {
    await upstream.body?.cancel();
    return new Response(null, { status: 404 });
  }

  const headers = new Headers();
  for (const name of COPIED) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
  headers.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: 200, headers });
}
