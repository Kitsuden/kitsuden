/**
 * A blog post as a row of the posts list: the fields the list shows, with the three it
 * works out (the author's name, the reading time, whether readers can see it).
 */

/** Minutes to read `content` at 200 words a minute; null when there is nothing to read. */
export function readingMinutes(content: unknown): number | null {
  if (typeof content !== "string" || !content.trim()) return null;
  return Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 200));
}

/**
 * `live`: published and its date has come. `scheduled`: published (or scheduled) for a
 * date still ahead. `hidden`: a draft or an archived post, which readers do not see.
 */
export function postVisibility(
  status: unknown,
  publishedAt: unknown,
  now: Date
): "live" | "scheduled" | "hidden" {
  const date =
    typeof publishedAt === "string" || publishedAt instanceof Date ? new Date(publishedAt) : null;
  const valid = date !== null && !Number.isNaN(date.getTime());
  if (status === "scheduled") return "scheduled";
  if (status !== "published") return "hidden";
  return valid && date > now ? "scheduled" : "live";
}

export function postRow(post: Record<string, unknown>, now: Date): Record<string, unknown> {
  const author = post.author as { name?: string; email?: string } | null | undefined;
  return {
    id: String(post.id ?? ""),
    title: post.title ?? "",
    slug: post.slug ?? "",
    status: post.status ?? "draft",
    locale: String(post.locale || "es").toUpperCase(),
    author: author?.name || author?.email || null,
    readingMinutes: readingMinutes(post.content),
    publishedAt: post.publishedAt ?? null,
    visibility: postVisibility(post.status, post.publishedAt, now),
    updatedAt: post.updatedAt ?? null,
  };
}
