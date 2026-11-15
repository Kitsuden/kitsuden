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
const beforeOld = process.env.SITIO_API_CLAVE;
afterEach(() => {
  if (before === undefined) delete process.env.SITE_API_KEY;
  else process.env.SITE_API_KEY = before;
  if (beforeOld === undefined) delete process.env.SITIO_API_CLAVE;
  else process.env.SITIO_API_CLAVE = beforeOld;
});

/**
 * The two cases below are about the 0.8 names (`x-kitsuden-sitio`, `x-kitsuden-cliente`,
 * `SITIO_API_CLAVE`). The 0.9 rename rewrote them to the new names too, so for a while they
 * tested the new names twice and the old ones not at all, while the limiter really had
 * stopped reading them.
 */
describe("siteVisitor", () => {
  it("the header names it had before keep working", () => {
    process.env.SITE_API_KEY = "test-key";
    expect(
      siteVisitor(context({ "x-kitsuden-sitio": "test-key", "x-kitsuden-cliente": "203.0.113.7" }))
    ).toBe("site:203.0.113.7");
  });

  it("the key's former variable name keeps working", () => {
    delete process.env.SITE_API_KEY;
    process.env.SITIO_API_CLAVE = "test-key";
    expect(
      siteVisitor(context({ "x-kitsuden-site": "test-key", "x-kitsuden-client": "203.0.113.7" }))
    ).toBe("site:203.0.113.7");
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

  it("a key that is a prefix of the real one, or extends it, is not the site", () => {
    /** The comparison pads both keys to one length: the length check must still refuse these. */
    process.env.SITE_API_KEY = "test-key";
    for (const sent of ["test-ke", "test-key\0", "test-key-longer"]) {
      expect(
        siteVisitor(context({ "x-kitsuden-site": sent, "x-kitsuden-client": "203.0.113.7" }))
      ).toBeNull();
    }
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
