/**
 * Signed private media addresses percent-encode the key (H24, 2026-11-20).
 *
 * `signedUrlOf` put the key into the path as it was. A `?`, `#` or `%` in a key
 * ended the path early: the address named another key (or none) and its
 * signature never verified. Each segment is now percent-encoded, and the path
 * decodes back to exactly the key the signature covers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const store = await import("../../apps/api/src/lib/store");

describe("signed private media addresses", () => {
  const before = process.env.KITSUDEN_SECRETS_KEY;
  beforeAll(() => {
    process.env.KITSUDEN_SECRETS_KEY = "signed-media-encoding-test-key-0123456789";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.KITSUDEN_SECRETS_KEY;
    else process.env.KITSUDEN_SECRETS_KEY = before;
  });

  it.each([
    "private/koe/a?b.ogg",
    "private/koe/a#b.pdf",
    "private/koe/100%.pdf",
    "private/a b.png",
  ])("%s: the path decodes to the key and the signature verifies", async (key) => {
    const url = new URL(await store.signedUrlOf(key, 60), "http://x");
    const path = decodeURIComponent(url.pathname.slice(store.BASE_URL_LOCAL.length + 1));
    expect(path).toBe(key);
    expect(url.hash).toBe("");
    expect(
      store.verifySignedUrl(path, url.searchParams.get("exp")!, url.searchParams.get("sig")!)
    ).toBe(true);
  });

  it("a plain key keeps the same address as before", async () => {
    const url = new URL(await store.signedUrlOf("private/koe/media/a.ogg", 60), "http://x");
    expect(url.pathname).toBe(`${store.BASE_URL_LOCAL}/private/koe/media/a.ogg`);
  });
});
