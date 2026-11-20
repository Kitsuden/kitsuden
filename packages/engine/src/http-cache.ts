/**
 * Conditional GETs: ETag and If-None-Match
 * ============================================================================
 *
 * A site or an agent that polls a resource should pay a 304 with no body when nothing changed. The page
 * builder did it with its own helpers; any kon can now do it the same way:
 *
 *     handle: async (_input, { c }) => {
 *       const body = await load();
 *       return conditionalJson(c, body, { lastModified: body.updatedAt, cacheControl: "no-cache" });
 *     }
 *
 * The ETag is WEAK (`W/"…"`): the JSON is serialized again on every request, so two equal answers are
 * semantically the same, not byte for byte. RFC 9110 asks for the weak comparison on GET, which is what
 * `etagMatches` does.
 */

import { createHash } from "node:crypto";

/** The weak ETag of a JSON body. */
export function weakEtag(body: unknown): string {
  return `W/"${createHash("sha1").update(JSON.stringify(body)).digest("base64url")}"`;
}

/** Does an `If-None-Match` header name this ETag (weak comparison; `*` matches any)? */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

interface ConditionalContext {
  req: { header(name: string): string | undefined };
  header(name: string, value: string): void;
  json(body: unknown, status?: number): Response;
  body(data: null, status: 304): Response;
}

export interface ConditionalOptions {
  /** Sent as `Last-Modified` when given. */
  lastModified?: Date | string | null;
  /** Sent as `Cache-Control` when given (`no-cache`: the client must ask, and may get a 304). */
  cacheControl?: string;
  /** Status of a full answer (default 200). */
  status?: number;
}

/**
 * Answers `body` as JSON with its ETag, or `304 Not Modified` with no body when the request's
 * `If-None-Match` already names it. Only for safe reads: never for a write's response.
 */
export function conditionalJson(
  c: ConditionalContext,
  body: unknown,
  options: ConditionalOptions = {}
): Response {
  const etag = weakEtag(body);
  c.header("ETag", etag);
  if (options.cacheControl) c.header("Cache-Control", options.cacheControl);
  if (options.lastModified) {
    const date = new Date(options.lastModified);
    if (!Number.isNaN(date.getTime())) c.header("Last-Modified", date.toUTCString());
  }
  if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
  return c.json(body, options.status ?? 200);
}
