/**
 * CSRF: cookie writes only from one of our origins (earlier audit).
 *
 * Before, any page on a sibling site (same registrable domain, so
 * `SameSite=Lax` does send the cookie) could make a «simple» POST —with no
 * preflight— to the API with the visitor's session.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  requireOriginOnWrites,
  allowedWriteOrigin,
} from "../../apps/api/src/middleware/write-origin";

const ALLOWED = ["https://site.example", "https://panel.site.example"];

function app(withSession: boolean) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    if (withSession) (c as any).set("session", { id: "s1" });
    await next();
  });
  a.use(
    "*",
    requireOriginOnWrites(() => ALLOWED)
  );
  a.all("*", (c) => c.text("done"));
  return a;
}

describe("allowedWriteOrigin", () => {
  const base = { withCookie: true, allowedOnes: ALLOWED, host: "api.site.example" };

  it("reads: always", () => {
    expect(allowedWriteOrigin({ ...base, method: "GET", origin: "https://evil.example" })).toBe(
      true
    );
  });

  it("write without a cookie (agent with Bearer, SSR): it is not CSRF", () => {
    expect(
      allowedWriteOrigin({
        ...base,
        withCookie: false,
        method: "POST",
        origin: "https://evil.example",
      })
    ).toBe(true);
  });

  it("write with a cookie from another origin: NO", () => {
    expect(allowedWriteOrigin({ ...base, method: "POST", origin: "https://evil.example" })).toBe(
      false
    );
    // a sibling site that is not on the list: same-site for the browser
    expect(
      allowedWriteOrigin({
        ...base,
        method: "DELETE",
        origin: "https://wiki.site.example",
      })
    ).toBe(false);
    expect(allowedWriteOrigin({ ...base, method: "POST", origin: "null" })).toBe(false);
    // the Referer counts if Origin is missing
    expect(
      allowedWriteOrigin({ ...base, method: "PATCH", referer: "https://evil.example/x?y" })
    ).toBe(false);
  });

  it("write with a cookie from an origin on the list or from the same host: yes", () => {
    expect(allowedWriteOrigin({ ...base, method: "POST", origin: "https://site.example" })).toBe(
      true
    );
    expect(
      allowedWriteOrigin({ ...base, method: "POST", origin: "https://api.site.example" })
    ).toBe(true);
    // no Origin or Referer: a non-browser client
    expect(allowedWriteOrigin({ ...base, method: "POST" })).toBe(true);
  });
});

describe("requireOriginOnWrites (middleware)", () => {
  it("403 to a POST with a session from another origin; 200 from ours", async () => {
    const bad = await app(true).request("http://api.site.example/api/comments", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: "x",
    });
    expect(bad.status).toBe(403);

    const good = await app(true).request("http://api.site.example/api/comments", {
      method: "POST",
      headers: { origin: "https://site.example" },
    });
    expect(good.status).toBe(200);
  });

  it("without a session it does not intervene (the route's authorization decides)", async () => {
    const r = await app(false).request("http://api.site.example/api/comments", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(r.status).toBe(200);
  });
});
