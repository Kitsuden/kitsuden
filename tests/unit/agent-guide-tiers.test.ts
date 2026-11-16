/**
 * The tiered agent guide (`GET /llms.txt`)
 * ============================================================================
 *
 *   · No query: an INDEX (rules, building something new, recipes, one line per kon),
 *     not every route of every kon.
 *   · `?kon=<id>[,<id>]`: only those kons' routes; `kon-` prefix optional; an unknown
 *     id is a 404 that lists the valid ones.
 *   · `?full=1`: the index sections plus every route (what it served before).
 *   · Same input, same bytes (kons by id, routes by path then method), an ETag that is
 *     the hash of the body, and a 304 on `If-None-Match`.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentGuideResponse,
  etagMatches,
  generateAgentGuide,
  generateKonGuide,
  guideEtag,
} from "../../apps/api/src/lib/agent-guide";
import type { KonRoute } from "../../apps/api/src/lib/kon-routes";

const BASE = "https://api.example.com/api";

function route(
  konId: string,
  method: string,
  relativePath: string,
  summary: string,
  body?: z.ZodType
): KonRoute {
  const mountPath = `/api/${konId.replace(/^kon-/, "")}`;
  return {
    konId,
    method,
    path: `${mountPath}${relativePath === "/" ? "" : relativePath}`,
    relativePath,
    mountPath,
    auth: method === "GET" ? "optional" : "required",
    summary,
    validation: body ? [{ target: "json", schema: body } as KonRoute["validation"][number]] : [],
  };
}

/** A CRUD kon like the ones `kitsuden make kon` writes, plus a few extra routes. */
function crudKon(konId: string, noun: string, extras: number): KonRoute[] {
  const item = z.object({
    title: z.string(),
    body: z.string().optional(),
    status: z.enum(["draft", "published"]).optional(),
    tags: z.array(z.string()).optional(),
  });
  const list: KonRoute[] = [
    route(konId, "GET", "/", `List ${noun}s`),
    route(konId, "POST", "/", `Create a ${noun}`, item),
    route(konId, "GET", "/:id", `Get one ${noun}`),
    route(konId, "PATCH", "/:id", `Update a ${noun}`, item.partial()),
    route(konId, "DELETE", "/:id", `Delete a ${noun}`),
  ];
  for (let i = 0; i < extras; i++) {
    list.push(
      route(
        konId,
        i % 2 ? "POST" : "GET",
        `/${noun}s/:id/step-${i}`,
        `Step ${i} of the ${noun} workflow, with a description long enough to be realistic`,
        i % 2 ? z.object({ note: z.string(), at: z.string().optional() }) : undefined
      )
    );
  }
  return list;
}

/** A realistic installation: 14 kons, about 160 routes. */
const REALISTIC: KonRoute[] = [
  ...crudKon("kon-blog", "post", 12),
  ...crudKon("kon-esports", "tournament", 30),
  ...crudKon("kon-tierlist", "list", 8),
  ...crudKon("kon-broadcast", "overlay", 14),
  ...crudKon("kon-crm", "contact", 10),
  ...crudKon("kon-booking", "slot", 9),
  ...crudKon("kon-forms", "form", 6),
  ...crudKon("kon-media", "asset", 7),
  ...crudKon("kon-agile", "issue", 15),
  ...crudKon("kon-shop", "product", 11),
  ...crudKon("kon-wiki", "page", 6),
  ...crudKon("kon-datasets", "dataset", 5),
  ...crudKon("kon-notify", "channel", 3),
  ...crudKon("kon-analytics", "view", 2),
];

const SMALL: KonRoute[] = [
  route("kon-blog", "POST", "/", "Create a post", z.object({ title: z.string() })),
  route("kon-blog", "GET", "/", "List posts"),
  route("kon-blog", "GET", "/:id", "Get one post"),
  route("kon-blog", "GET", "/*", "Catch-all"),
  route("kon-esports", "GET", "/tournaments", "List tournaments"),
];

describe("index", () => {
  const index = generateAgentGuide({ baseUrl: BASE, routes: SMALL });

  it("has the header, rules, build path and recipes", () => {
    expect(index).toContain("# Kitsuden — agent guide");
    expect(index).toContain("## Rules an agent tends to break");
    expect(index).toContain("## Building something new");
    expect(index).toContain("kitsuden make kon <name>");
    expect(index).toContain('--fields "title:string!,price:number,published:boolean"');
    expect(index).toContain("kitsuden make model <name> --kon <kon>");
    expect(index).toContain("kitsuden makemigrations");
    expect(index).toContain("docs/kons/README.md");
    expect(index).toContain("## Recipes");
    expect(index).toContain("kitsuden_create_dataset");
    expect(index).toContain("KITSUDEN_E_APPROVAL_REQUIRED");
  });

  it("lists one line per kon, sorted, with its route count and link, and no routes", () => {
    expect(index).toContain(
      `- kon-blog — 3 routes · GET ${BASE}/llms.txt?kon=kon-blog\n- kon-esports — 1 route · GET ${BASE}/llms.txt?kon=kon-esports`
    );
    expect(index).not.toContain("## Kon routes");
    expect(index).not.toContain("`POST /api/blog`");
  });

  it("the build section stays short", () => {
    const section = index.split("## Building something new")[1]!.split("\n## ")[0]!;
    expect(section.trim().split("\n").length).toBeLessThan(25);
  });

  it("without routes it explains them; with none mounted it says so", () => {
    expect(generateAgentGuide({ baseUrl: BASE })).toContain("generated when serving");
    expect(generateAgentGuide({ baseUrl: BASE, routes: [] })).toContain("No kon mounted");
  });
});

describe("?kon=", () => {
  it("returns only that kon's routes, sorted by path then method, wildcards left out", () => {
    const r = generateKonGuide({ baseUrl: BASE, routes: SMALL, kons: ["blog"] });
    expect(r.body).toContain("### kon-blog");
    expect(r.body).not.toContain("kon-esports");
    expect(r.body).not.toContain("## Rules");
    expect(r.body).not.toContain("Catch-all");
    const lines = r.body!.split("\n").filter((l) => l.startsWith("- `"));
    expect(lines.map((l) => l.split("`")[1])).toEqual([
      "GET /api/blog",
      "POST /api/blog",
      "GET /api/blog/:id",
    ]);
    expect(r.body).toContain("· body: title");
  });

  it("accepts the kon- prefix, a list and any order, and answers the same bytes", () => {
    const a = generateKonGuide({ baseUrl: BASE, routes: SMALL, kons: ["esports", "kon-blog"] });
    const b = generateKonGuide({ baseUrl: BASE, routes: SMALL, kons: ["kon-blog", "esports"] });
    expect(a.body).toBe(b.body);
    expect(a.body!.indexOf("### kon-blog")).toBeLessThan(a.body!.indexOf("### kon-esports"));
  });

  it("an unknown kon is a 404 that lists the valid ids", () => {
    const r = agentGuideResponse({ baseUrl: BASE, routes: SMALL, query: { kon: "blog,nope" } });
    expect(r.status).toBe(404);
    expect(r.body).toContain("Unknown kon: nope.");
    expect(r.body).toContain("Mounted kons: kon-blog, kon-esports.");
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

describe("?full=1", () => {
  it("is the index sections plus every route", () => {
    const full = agentGuideResponse({ baseUrl: BASE, routes: SMALL, query: { full: "1" } }).body!;
    expect(full).toContain("## Building something new");
    expect(full).toContain("## Kon routes");
    expect(full).toContain("### kon-blog");
    expect(full).toContain("### kon-esports");
    expect(full).not.toContain("?kon=kon-blog\n");
  });

  it("?kon= wins over ?full=", () => {
    const r = agentGuideResponse({
      baseUrl: BASE,
      routes: SMALL,
      query: { kon: "blog", full: "1" },
    });
    expect(r.body).not.toContain("## Rules");
  });
});

describe("caching", () => {
  it("identical input gives identical bytes, whatever the order routes were mounted in", () => {
    const shuffled = [...REALISTIC].reverse();
    for (const query of [{}, { full: "1" }, { kon: "esports,blog" }]) {
      const a = agentGuideResponse({ baseUrl: BASE, routes: REALISTIC, query });
      const b = agentGuideResponse({ baseUrl: BASE, routes: shuffled, query });
      expect(a.body).toBe(b.body);
      expect(a.headers.etag).toBe(b.headers.etag);
    }
  });

  it("ETag is the body's hash, with Cache-Control, and If-None-Match gives a 304", () => {
    const first = agentGuideResponse({ baseUrl: BASE, routes: SMALL, query: {} });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe(guideEtag(first.body!));
    expect(first.headers["cache-control"]).toBe("public, max-age=300");
    expect(first.headers["content-type"]).toBe("text/markdown; charset=utf-8");

    const again = agentGuideResponse({
      baseUrl: BASE,
      routes: SMALL,
      query: {},
      ifNoneMatch: first.headers.etag,
    });
    expect(again.status).toBe(304);
    expect(again.body).toBeNull();

    const other = agentGuideResponse({
      baseUrl: BASE,
      routes: SMALL,
      query: { full: "1" },
      ifNoneMatch: first.headers.etag,
    });
    expect(other.status).toBe(200);
  });

  it("If-None-Match: lists, weak tags and *", () => {
    expect(etagMatches(`"x", W/"abc"`, `"abc"`)).toBe(true);
    expect(etagMatches("*", `"abc"`)).toBe(true);
    expect(etagMatches(`"abd"`, `"abc"`)).toBe(false);
    expect(etagMatches(undefined, `"abc"`)).toBe(false);
  });

  it("through Hono, as index.ts serves it", async () => {
    const app = new Hono();
    app.get("/llms.txt", (c) => {
      const r = agentGuideResponse({
        baseUrl: BASE,
        routes: SMALL,
        query: { kon: c.req.query("kon"), full: c.req.query("full") },
        ifNoneMatch: c.req.header("if-none-match"),
      });
      return r.status === 304 ? c.body(null, 304, r.headers) : c.body(r.body, r.status, r.headers);
    });
    const ok = await app.request("/llms.txt?kon=kon-blog%2Cesports");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("### kon-esports");
    const etag = ok.headers.get("etag")!;
    const cached = await app.request("/llms.txt?kon=kon-blog%2Cesports", {
      headers: { "if-none-match": etag },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect((await app.request("/llms.txt?kon=zzz")).status).toBe(404);
  });
});

describe("size", () => {
  it("the index is a fraction of the full document on a realistic installation", () => {
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    const index = bytes(generateAgentGuide({ baseUrl: BASE, routes: REALISTIC }));
    const full = bytes(generateAgentGuide({ baseUrl: BASE, routes: REALISTIC, view: "full" }));
    const oneKon = bytes(
      generateKonGuide({ baseUrl: BASE, routes: REALISTIC, kons: ["esports"] }).body!
    );
    process.stdout.write(
      `llms.txt sizes (${REALISTIC.length} routes, 14 kons): index ${index} B, full ${full} B, ?kon=esports ${oneKon} B\n`
    );
    expect(index).toBeLessThan(full / 2);
  });
});
