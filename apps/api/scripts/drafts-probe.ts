/**
 * Does anything unpublished leak through any public read?
 * ============================================================================
 *
 * Creates a blog draft and a games draft, asks through ALL the public
 * paths WITHOUT a session, and deletes what it created.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * Because the first time `GET /api/blog` was fixed, THAT route was checked and
 * it was reported that the leak was closed. It was open in five others. Testing
 * the door you just fixed says nothing about the others, and the
 * unit test looks at the code, not at what the deployed server answers.
 *
 * It runs against the running installation:
 *
 *     bun scripts/drafts-probe.ts
 */

import { eq, sql } from "drizzle-orm";

import { blogPosts } from "../../../packages/kons/kon-blog/src/schema";
import { games } from "../../../packages/kons/kon-games/games.schema";
import { db } from "../src/db";

const BASE = process.env.PROBE_BASE_URL || "http://localhost:3000";
const MARK = `secret-${Date.now()}`;

let leaks = 0;

async function look(name: string, route: string) {
  const res = await fetch(`${BASE}${route}`);
  const body = await res.text();
  const leak = body.includes(MARK);
  if (leak) leaks++;
  console.log(
    `  ${leak ? "LEAK " : "ok   "} ${name.padEnd(34)} [${res.status}] ${
      leak ? "RETURNS THE DRAFT" : "does not return it"
    }`
  );
}

// ── Author: an existing one is reused ───────────────────────────────────────
// Creating test users once broke the settings screen.
const rows: any = await db.execute(sql`SELECT id FROM auth_users LIMIT 1`);
const author = (Array.isArray(rows) ? rows : rows.rows)[0]?.id as string | undefined;
if (!author) {
  console.error("There is no user in auth_users; the test post cannot be created.");
  process.exit(1);
}

const slugPost = `probe-post-${Date.now()}`;
const gameSlug = `probe-game-${Date.now()}`;

const [post] = await db
  .insert(blogPosts)
  .values({
    title: MARK,
    slug: slugPost,
    authorId: author,
    status: "draft",
    content: MARK,
  })
  .returning();

const [game] = await db
  .insert(games)
  .values({ title: MARK, slug: gameSlug, status: "draft", excerpt: MARK })
  .returning();

console.log("\nPublic reads, WITHOUT a session\n");

console.log("  kon-blog");
await look("GET /api/blog", "/api/blog");
await look("GET /api/blog?status=draft", "/api/blog?status=draft");
await look("GET /api/blog?status=all", "/api/blog?status=all");
await look("GET /api/blog/slug/:slug", `/api/blog/slug/${slugPost}`);
await look("GET /api/blog/:id", `/api/blog/${post.id}`);
await look("GET /api/blog/seo/:slug", `/api/blog/seo/${slugPost}`);
await look("GET /api/blog/seo?preview=true", `/api/blog/seo/${slugPost}?preview=true`);
await look("GET /api/blog/geo/:slug", `/api/blog/geo/${slugPost}`);
await look("GET /api/blog/geo?preview=true", `/api/blog/geo/${slugPost}?preview=true`);

console.log("\n  kon-games");
await look("GET /api/games", "/api/games");
await look("GET /api/games?status=draft", "/api/games?status=draft");
await look("GET /api/games/slug/:slug", `/api/games/slug/${gameSlug}`);
await look("GET /api/games/:id", `/api/games/${game.id}`);

await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
await db.delete(games).where(eq(games.id, game.id));
console.log("\n  ok   cleanup");

console.log(`\n${leaks === 0 ? "No leaks." : `${leaks} LEAK(S).`}\n`);
process.exit(leaks === 0 ? 0 : 1);
