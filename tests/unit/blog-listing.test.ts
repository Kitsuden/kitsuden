/**
 * Which posts are shown, and who can see them
 * ============================================================================
 *
 * Three failures that looked the same from the outside —"the list does not show
 * what it should"— and had three different causes in three different layers.
 *
 * ── 1. DRAFTS WERE PUBLIC ──────────────────────────────────────────────────
 *
 * `GET /api/blog` accepted `?status=` without looking at who was asking. Checked
 * against a real installation, without any cookie:
 *
 *     GET /api/blog?status=draft
 *     → {"docs":[{"title":"test post","content":"hello\nthis is…
 *
 * Anyone on the internet read all the drafts in full —title, body, author—
 * by changing one word in the URL. Nothing had to be broken: the default
 * value was `published`, so the route looked correct as long as nobody
 * wrote another. **A safe default is not a permission.**
 *
 * ── 2. "SCHEDULED" SHOWED THE DRAFTS ───────────────────────────────────────
 *
 * `defaultFilter` comes from `kon.json` and `generateExplorerConfig` did not
 * copy it. Both views —Drafts and Scheduled— point to `blog_posts`,
 * so without a filter both asked for the whole table and showed the same thing.
 *
 * ── 3. "ALL POSTS" SHOWED NONE ─────────────────────────────────────────────
 *
 * The screen requests `/api/blog`, which by default returns only what is
 * published. With one draft and nothing published, it came out empty — and
 * "empty" reads as "there are no posts", which is exactly the opposite of what
 * was happening.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const ROUTES = join(ROOT, "packages", "kons", "kon-blog", "src", "routes.ts");
const LOADER = join(ROOT, "packages", "admin", "src", "lib", "grimoire-loader.ts");
const EXPLORER = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "admin",
  "DataExplorer.svelte"
);
const POSTS_VIEW = join(ROOT, "packages", "admin", "src", "views", "content", "PostsView.svelte");

describe("who can see unpublished posts", () => {
  const routes = withoutComments(readFileSync(ROUTES, "utf-8"));
  // The blog is an SDK kon: `GET /` is the `listar-entradas` operation, and
  // `acceso: "optional"` is what mounts `optionalAuth`.
  const listing = routes.slice(
    routes.indexOf('id: "listar-entradas"'),
    routes.indexOf('id: "obtener-por-slug"')
  );

  it("the listing checks who is asking", () => {
    expect(listing.length, "the GET / handler was not found").toBeGreaterThan(0);

    expect(
      /(acceso|access): "(opcional|optional)"/.test(listing) ||
        listing.includes("auth.optionalAuth"),
      "`GET /api/blog` has to go through `optionalAuth`. Without that there is no way " +
        "to know whether the asker can see drafts, and the route ends up " +
        "serving them to anyone."
    ).toBe(true);
  });

  it("the requested status is NOT used as is", () => {
    /**
     * The original failure fit on one line:
     *
     *     const status = (c.req.query("status") || "published") as …
     *
     * The `as` is the dangerous part: it convinces the compiler that whatever
     * string comes from the URL is one of the four valid states. TypeScript stops
     * looking exactly where it needed to look.
     */
    expect(
      /const status = \(c\.req\.query\("status"\)/.test(listing),
      "the URL's `status` cannot go straight into the query: it has to be " +
        "checked first that the asker has a right to that status."
    ).toBe(false);

    expect(
      listing.includes("puedeVerloTodo"),
      "it has to be distinguished who is allowed to request statuses other than " + "`published`."
    ).toBe(true);
  });

  it("the cache separates public from private", () => {
    /**
     * Without separating them, the leak comes back through another door and
     * leaves no trace in the route: if an editor opens "All Posts" before anyone
     * else, the response with drafts is cached under the same key and served to
     * the world.
     */
    const key = listing.slice(listing.indexOf("const cacheKey"), listing.indexOf("const cached"));

    expect(
      /priv|pub|puedeVerloTodo/.test(key),
      "the cache key has to include the privilege of whoever asks. If " +
        "not, the first cached response is served to everyone alike and the " +
        "drafts leak through the cache."
    ).toBe(true);
  });

  it("an unknown status does not blow up the query", () => {
    /**
     * With the previous code, `?status=all` reached
     * `eq(blogPosts.status, "all")` as is. `status` is an ENUM in Postgres, so
     * the query died with "invalid input value for enum blog_status" and the
     * API answered **500**. Verified against a real installation.
     */
    expect(
      listing.includes("ESTADOS.includes"),
      "the requested status has to be validated against the list before it reaches " +
        "the query: the column is an enum and an unknown value does not give an " +
        "empty list, it gives a 500."
    ).toBe(true);
  });
});

describe("the kon's tabs show different things", () => {
  const loader = readFileSync(LOADER, "utf-8");
  const explorer = readFileSync(EXPLORER, "utf-8");

  it("`defaultFilter` survives the trip through the config generator", () => {
    const from = loader.indexOf("      default:");
    const grid = loader.slice(from, loader.indexOf("    }", from));

    expect(
      grid.includes("defaultFilter"),
      "the `grid` branch of `generateExplorerConfig` has to copy " +
        "`defaultFilter`. Without it, two views on the same table ask for the " +
        'same thing and show the same thing — "Scheduled" with the drafts inside.'
    ).toBe(true);
  });

  it("the view's filter is applied and wins over the user's", () => {
    expect(explorer).toContain("viewFilter");

    const load = explorer.slice(explorer.indexOf("async function loadData"));
    const iUser = load.indexOf("Object.entries(activeFilters)");
    const iView = load.indexOf("Object.entries(viewFilter)");

    expect(iView, "the view's filter is not applied in the query").toBeGreaterThan(-1);
    expect(
      iView > iUser,
      "the view's filter goes AFTER the viewer's: the API only admits " +
        "one filter per request, so the order is the precedence. Before, " +
        'any hand-written filter would turn "Drafts" into "all".'
    ).toBe(true);
  });

  it("switching tabs reloads even though the table does not change", () => {
    /**
     * The reload effect depends on `activeTable`. Drafts and Scheduled
     * share a table, so jumping from one to the other did not fire and the
     * grid kept the previous one's rows — now that the filter is
     * in place, that would be showing drafts under the title "Scheduled".
     */
    expect(
      explorer.includes("viewAlreadyLoaded"),
      "there has to be a reload tied to `activeViewId`, not just to the table."
    ).toBe(true);
  });
});

describe("the tab names say what they show", () => {
  const kon = JSON.parse(
    readFileSync(join(ROOT, "packages", "kons", "kon-blog", "kon.json"), "utf-8")
  ) as {
    postStatuses: string[];
    admin: { views: Array<{ id: string; title: string; defaultFilter?: { status?: string } }> };
  };

  it("each declared status has its tab", () => {
    /**
     * Before there were three tabs —All Posts, Drafts, Scheduled— for four
     * states: `published` and `archived` had none. And since "All Posts"
     * brought only the published ones, the result was that a draft showed up in
     * two places and an archived one in none.
     */
    const withTab = new Set(
      kon.admin.views.map((v) => v.defaultFilter?.status).filter(Boolean) as string[]
    );
    const withoutTab = kon.postStatuses.filter((e) => !withTab.has(e));

    expect(
      withoutTab,
      "These statuses have no tab of their own: " +
        withoutTab.join(", ") +
        ". A post in that status can only be found in «All», and from the outside it " +
        "reads as if it did not exist."
    ).toEqual([]);
  });

  it("no filtered tab promises to show everything", () => {
    /**
     * The name is the promise. "All Posts" bringing only published ones was
     * the reason the screen came out empty and it looked like there were no posts:
     * the title said one thing and the filter did another.
     */
    for (const v of kon.admin.views) {
      const filters = !!v.defaultFilter?.status;
      const promisesEverything = /^(todos|all)\b/i.test(v.title);

      expect(
        filters && promisesEverything,
        "The view «" +
          v.title +
          "» filters by " +
          String(v.defaultFilter?.status) +
          " but its name promises all the posts."
      ).toBe(false);
    }
  });
});

describe('"All Posts" shows all the posts', () => {
  const view = readFileSync(POSTS_VIEW, "utf-8");

  it("explicitly asks for all statuses", () => {
    expect(
      view.includes('queryParams={{ status: "all" }}'),
      "`/api/blog` returns only what is published by default. A screen that " +
        'is called "All Posts" has to ask for the rest, or it lies in the title.'
    ).toBe(true);
  });
});
