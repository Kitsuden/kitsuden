/**
 * Every internal panel link has to point to a route that exists
 * ============================================================================
 *
 * A broken `href` in an app with file-based routing gives no compile
 * error, no console warning, nothing: it gives a 404 inside the panel, with the
 * sidebar painted around it. It looks like the screen is «not built
 * yet» rather than the link being wrong.
 *
 * What there was the day this test was written, all reachable with one click:
 *
 *   · `/games/new`, `/posts/new`, `/crm/deals/new`, `/academy/courses/new` —
 *     creation pages that NEVER existed: in this panel you create with a modal.
 *     Someone wrote the buttons copying a convention from another project.
 *   · `/posts`, `/media`, `/blocks`, `/games` — routes from before everything
 *     moved to live under `/g/<kon>`.
 *   · `/login` — the form is painted by the layout when there is no session; there is no
 *     route. Logging out led to a 404.
 *   · `/academy` and `/booking` redirected to `/g/grimoire-academy-lms` and
 *     `/g/grimoire-booking`: ids from before the grimoire → kon rename.
 *
 * ── REDIRECTS ARE WORSE THAN A LINK ────────────────────────────────────────
 *
 * A broken `href` fails where it is written. A broken `redirect()` fails at the
 * destination, so the 404 shows up on a URL the user did not type and that
 * is not in the code that was touched. That is why both are checked.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listFiles } from "./helpers/files";
import { konStatus } from "./helpers/known-kons";

const ROOT = join(__dirname, "..", "..");
const ROUTES_DIR = join(ROOT, "packages", "admin", "src", "routes");

/** Routes that SvelteKit really publishes, as segments. */
function publishedRoutes(): string[][] {
  const routes: string[][] = [];

  function traverse(dir: string, segments: string[]) {
    const inputs = readdirSync(dir, { withFileTypes: true });
    // A `+page.ts` without `.svelte` is still a route: it is a redirect.
    if (inputs.some((e) => e.name === "+page.svelte" || e.name === "+page.ts")) {
      routes.push(segments);
    }
    for (const e of inputs) {
      if (!e.isDirectory()) continue;
      // `(x)` groups do not appear in the URL.
      const name = e.name.startsWith("(") ? null : e.name;
      traverse(join(dir, e.name), name ? [...segments, name] : segments);
    }
  }

  traverse(ROUTES_DIR, []);
  return routes;
}

function resolves(target: string, routes: string[][]): boolean {
  const clean = target.split("?")[0]!.split("#")[0]!;
  const segments = clean.split("/").filter(Boolean);

  return routes.some(
    (r) =>
      r.length === segments.length &&
      r.every((s, i) => s === segments[i] || s.startsWith("[") || s === "[...rest]")
  );
}

interface Link {
  target: string;
  where: string;
}

function internalLinks(): Link[] {
  const foundItems: Link[] = [];
  const base = join(ROOT, "packages", "admin", "src");

  const patterns = [
    /href="(\/[^"{}]*)"/g,
    /goto\(\s*["'](\/[^"'{}]*)["']/g,
    /window\.location\.href\s*=\s*["'](\/[^"'{}]*)["']/g,
    /redirect\(\s*30[1278]\s*,\s*["'](\/[^"'{}]*)["']/g,
    /**
     * Destinations declared as a PROPERTY of an object:
     *
     *     { key: "posts", label: "Posts", href: "/posts" }
     *
     * and painted later with `href={stat.href}`. It was missing, and that is why this test
     * passed green while SIX of the home panel's cards —all
     * the ones seen on entering— led to a 404. A literal attribute is the
     * least common way of writing a link in this code.
     */
    /href:\s*[`"'](\/[^`"'{}]*)[`"']/g,
  ];

  for (const file of listFiles(base, ".svelte", ".ts")) {
    const source = readFileSync(file, "utf-8");
    const relativeValue = file
      .slice(ROOT.length + 1)
      .split(/[\\/]/)
      .join("/");

    for (const pattern of patterns) {
      for (const m of source.matchAll(pattern)) {
        const target = m[1]!;
        // `/api/...` is served by the API, not the panel router. `/uploads` and
        // `/media` are served files, not routes either.
        if (/^\/(api|uploads|assets|favicon)/.test(target)) continue;
        const line = source.slice(0, m.index).split("\n").length;
        foundItems.push({ target, where: `${relativeValue}:${line}` });
      }
    }
  }

  return foundItems;
}

/**
 * Ids that `/g/[id]` knows how to resolve.
 *
 * ── WHY THIS SEPARATE CHECK ────────────────────────────────────────────────
 *
 * Because `/g/[id]` and `/g/[id]/[viewId]` accept ANYTHING: the structural
 * check above takes `/g/whatever/either` as fine. That is how
 * `/g/grimoire-academy-lms` and `/g/grimoire-booking` went undetected,
 * ids from before the rename, which only failed on click.
 *
 * An id is valid if it is a kon on disk (`packages/kons/<id>`) or a custom view
 * registered in `grimoire-loader.ts` — that is where the system tools live,
 * like `system-tools-editor`, which are not kons and are legitimate destinations.
 */
function validKonIds(): Set<string> {
  const valid = new Set<string>();

  const base = join(ROOT, "packages", "kons");
  if (existsSync(base)) {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith("kon-")) continue;
      valid.add(e.name);
      valid.add(e.name.replace(/^kon-/, ""));
    }
  }

  // Keys of the custom views registry: `"system-tools-editor": () => …`
  const loader = readFileSync(
    join(ROOT, "packages", "admin", "src", "lib", "grimoire-loader.ts"),
    "utf-8"
  );
  for (const m of loader.matchAll(/^\s*"?([a-z0-9-]+)"?:\s*\(\)\s*=>/gim)) {
    const key = m[1]!;
    valid.add(key);
    // `system-tools-editor` covers the URL `/g/system-tools/editor`.
    const script = key.lastIndexOf("-");
    if (script > 0) valid.add(key.slice(0, script));
  }

  return valid;
}

describe("internal panel links", () => {
  const routes = publishedRoutes();
  const links = internalLinks();
  const validIds = validKonIds();

  it("/g/<id> destinations point to a kon or view that exists", () => {
    const invalid = links
      .filter((e) => e.target.startsWith("/g/"))
      .map((e) => ({ ...e, id: e.target.split("/")[2]!.split("?")[0]! }))
      .filter((e) => !validIds.has(e.id))
      // A kon that is not installed (they live in kitsuden-kons) is valid if it exists in
      // the sibling repo, or if there is no way to know.
      .filter((e) => !(e.id.startsWith("kon-") && konStatus(e.id) !== "does-not-exist"))
      .map((e) => `${e.where}  →  ${e.target}  (id "${e.id}" does not exist)`);

    expect(
      invalid,
      `These links go to /g/<id> with an id that corresponds to no kon ` +
        `nor to any registered view:\n\n${invalid.join("\n")}\n\n` +
        `The structural check does NOT detect them: /g/[id] accepts any ` +
        `segment, so they resolve in the test and fail on click.`
    ).toEqual([]);
  });

  it("routes and links were found", () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(links.length).toBeGreaterThan(10);
  });

  it("all point to an existing route", () => {
    const broken = links
      .filter((e) => !resolves(e.target, routes))
      .map((e) => `${e.where}  →  ${e.target}`);

    expect(
      broken,
      `These panel links lead to a 404:\n\n${broken.join("\n")}\n\n` +
        `The panel routes are in packages/admin/src/routes. The kon ` +
        `screens all live under /g/<konKey>[/<viewId>]; there are no separate ` +
        `creation pages (you create with a modal), so a link to something/new ` +
        `does not exist by design.`
    ).toEqual([]);
  });
});
