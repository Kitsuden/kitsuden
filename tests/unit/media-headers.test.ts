/**
 * `/media` has to be embeddable from another site
 * ============================================================================
 *
 * `secureHeaders()` sets `Cross-Origin-Resource-Policy: same-origin` on everything.
 * For the API that is fine; for `/media` it is a silent disaster: the browser
 * receives the whole image with a 200 and refuses to paint it, without a single error
 * on the page. It happened with the self-hosted card images.
 *
 * This test reproduces the same setup as `apps/api/src/index.ts` and
 * checks both halves: that `/media` comes out `cross-origin` and that the API
 * STILL comes out `same-origin` — opening the policy for everything would be fixing
 * the images by breaking the API's protection.
 */
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { describe, expect, it } from "vitest";

const BASE = "/media";
const app = new Hono();
const safe = secureHeaders();
const ofMedia = secureHeaders({ crossOriginResourcePolicy: "cross-origin" });
app.use("*", (c, next) => (c.req.path.startsWith(`${BASE}/`) ? ofMedia : safe)(c, next));
// The /media handler sets its own header: it must not be lost
app.get(
  `${BASE}/*`,
  () => new Response("img", { headers: { "Cache-Control": "public, max-age=31536000, immutable" } })
);
app.get("/api/something", (c) => c.json({ ok: true }));
// «/medialibrary» starts with «/media» but is not «/media/»: it must not be opened
app.get("/medialibrary", (c) => c.text("x"));

const headers = async (route: string) => (await app.request(route)).headers;

describe("/media headers", () => {
  it("an image can be embedded from another site", async () => {
    expect((await headers("/media/cards/x.webp")).get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin"
    );
  });

  it("the API stays protected", async () => {
    expect((await headers("/api/something")).get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin"
    );
  });

  it("the rest of the security headers remain on /media", async () => {
    const h = await headers("/media/cards/x.webp");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("the cache the handler sets is not lost", async () => {
    expect((await headers("/media/cards/x.webp")).get("Cache-Control")).toContain("immutable");
  });

  it("a similar prefix is NOT opened", async () => {
    expect((await headers("/medialibrary")).get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin"
    );
  });
});
