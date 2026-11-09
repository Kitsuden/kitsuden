/**
 * In-process check of what was just added to the blog
 * ============================================================================
 *
 * Three things, and none can be taken as good by reading the code:
 *
 *   1. `GET /api/blog/categories` is answered by the CATEGORIES handler and not by the
 *      `/:id` one. In Hono that depends on registration order and the failure gives no
 *      error: the wrong handler answers. It is the same mechanism that left
 *      `/games/new` as a 404.
 *   2. A post can be saved with categories and get them back when re-read. Zod
 *      silently DROPS the keys it does not know, so a misnamed key
 *      does not give a 400: it saves the post without the categories and does not warn. It already happened
 *      with `tags` vs `tagIds`.
 *   3. Simultaneous-edit detection returns 409 and does NOT write. Without
 *      really testing it, «the second save overwrites the first» and «the second
 *      save is rejected» read the same in the code.
 *
 * It runs against the real database and cleans up everything it creates.
 */

import { app } from "../src/index";

let failures = 0;

function check(description: string, condition: boolean, detail = "") {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${description}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

/**
 * The write routes require a session. Instead of fabricating a user —which already
 * broke the settings screen once— it checks what can be checked without a
 * session and says clearly what is left out.
 */
async function main() {
  console.log("\nBlog categories\n");

  // ── 1. The route is not shadowed ─────────────────────────────────────────
  const res = await app.request("/api/blog/categories");
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  check("GET /api/blog/categories responds 200", res.status === 200, `status ${res.status}`);

  /**
   * The acid test for shadowing: if `/:id` had captured the request,
   * «categories» is not a UUID and that handler returns `{ error: "Post not
   * found" }` with a 404. A 200 with `docs` can only be produced by the
   * right handler.
   */
  check(
    "it is answered by the categories handler, not the /:id one",
    Array.isArray(body.docs),
    Array.isArray(body.docs)
      ? `${(body.docs as unknown[]).length} categories`
      : JSON.stringify(body)
  );

  // ── 2. The write ones exist and ask for a session, not a 404 ─────────────
  const withoutSession = await app.request("/api/blog/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "X", slug: "x" }),
  });

  check(
    "POST /api/blog/categories exists and requires a session (401/403, not 404)",
    withoutSession.status === 401 || withoutSession.status === 403,
    `status ${withoutSession.status}`
  );

  const patchWithoutSession = await app.request("/api/blog/categories/no-es-uuid", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "X" }),
  });

  check(
    "PATCH /api/blog/categories/:id exists and requires a session",
    patchWithoutSession.status === 401 || patchWithoutSession.status === 403,
    `status ${patchWithoutSession.status}`
  );

  console.log(
    `\n${failures === 0 ? "No failures." : `${failures} failure(s).`}\n` +
      `Note: saving a post WITH categories and the 409 for concurrent\n` +
      `editing need a session; they are checked in the contract test\n` +
      `(the blog kon's own tests) and against the database in the\n` +
      `manual verification, not here.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
