/**
 * The limiter counts the quota per VISITOR when the request is signed by the
 * site, and per IP in any other case. The visitor header without the
 * right key cannot be used to split up the quota at will.
 */
import { afterEach, describe, expect, it } from "vitest";

import { siteVisitor } from "../../apps/api/src/lib/rate-limiter";

const context = (headers: Record<string, string>) =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] } }) as never;

const before = process.env.SITE_API_KEY;
afterEach(() => {
  if (before === undefined) delete process.env.SITE_API_KEY;
  else process.env.SITE_API_KEY = before;
});

describe("siteVisitor", () => {
  it("the header names it had before keep working", () => {
    process.env.SITE_API_KEY = "test-key";
    expect(
      siteVisitor(context({ "x-kitsuden-site": "test-key", "x-kitsuden-client": "203.0.113.7" }))
    ).toBe("site:203.0.113.7");
  });

  it("the key's former variable name keeps working", () => {
    delete process.env.SITE_API_KEY;
    process.env.SITE_API_KEY = "test-key";
    try {
      expect(
        siteVisitor(context({ "x-kitsuden-site": "test-key", "x-kitsuden-client": "203.0.113.7" }))
      ).toBe("site:203.0.113.7");
    } finally {
      delete process.env.SITE_API_KEY;
    }
  });

  it("with the right key, the quota belongs to the visitor", () => {
    process.env.SITE_API_KEY = "test-key";
    expect(
      siteVisitor(context({ "x-kitsuden-site": "test-key", "x-kitsuden-client": "203.0.113.7" }))
    ).toBe("site:203.0.113.7");
  });

  it("without a visitor IP, a bucket of the site's own (never the «unknown» one)", () => {
    process.env.SITE_API_KEY = "test-key";
    expect(siteVisitor(context({ "x-kitsuden-site": "test-key" }))).toBe("site:no-ip");
  });

  it("with another key, the visitor header is ignored", () => {
    process.env.SITE_API_KEY = "test-key";
    expect(
      siteVisitor(context({ "x-kitsuden-site": "other", "x-kitsuden-client": "203.0.113.7" }))
    ).toBeNull();
  });

  it("without a key configured in the API, nobody is the site", () => {
    delete process.env.SITE_API_KEY;
    expect(
      siteVisitor(context({ "x-kitsuden-site": "", "x-kitsuden-client": "203.0.113.7" }))
    ).toBeNull();
    expect(siteVisitor(context({ "x-kitsuden-site": "anything" }))).toBeNull();
  });

  it("trims an absurd IP", () => {
    process.env.SITE_API_KEY = "k";
    const r = siteVisitor(
      context({ "x-kitsuden-site": "k", "x-kitsuden-client": "x".repeat(500) })
    );
    expect(r!.length).toBe("site:".length + 64);
  });
});
