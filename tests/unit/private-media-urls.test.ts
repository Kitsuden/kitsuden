/**
 * Private files: `private/` keys are served only with a valid, unexpired signature
 * ============================================================================
 *
 * `ctx.storage.getSignedDownloadUrl` used to return the public address for every key, so whatever a kon
 * stored (kon-koe: a customer's voice notes and documents) was readable by anyone holding the link.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const store = await import("../../apps/api/src/lib/store");

describe("private keys", () => {
  const before = process.env.KITSUDEN_SECRETS_KEY;
  beforeAll(() => {
    process.env.KITSUDEN_SECRETS_KEY = "private-media-test-key-0123456789abcdef";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.KITSUDEN_SECRETS_KEY;
    else process.env.KITSUDEN_SECRETS_KEY = before;
  });

  it("only keys under private/ are private", () => {
    expect(store.isPrivateKey("private/koe/media/a.ogg")).toBe(true);
    expect(store.isPrivateKey("/private/x")).toBe(true);
    expect(store.isPrivateKey("uploads/a.png")).toBe(false);
    expect(store.isPrivateKey("privately/a.png")).toBe(false);
  });

  it("a public key keeps its public address", async () => {
    expect(await store.signedUrlOf("uploads/a.png")).toBe(store.publicUrlOf("uploads/a.png"));
  });

  it("a private key gets a signed, expiring address that verifies only for that key and time", async () => {
    const url = new URL(await store.signedUrlOf("private/koe/media/a.ogg", 60), "http://x");
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    expect(url.pathname).toBe(`${store.BASE_URL_LOCAL}/private/koe/media/a.ogg`);
    expect(store.verifySignedUrl("private/koe/media/a.ogg", exp, sig)).toBe(true);
    expect(store.verifySignedUrl("private/koe/media/b.ogg", exp, sig)).toBe(false);
    expect(store.verifySignedUrl("private/koe/media/a.ogg", String(Number(exp) + 1), sig)).toBe(
      false
    );
    expect(store.verifySignedUrl("private/koe/media/a.ogg", exp, sig.slice(0, -2) + "AA")).toBe(
      false
    );
    expect(store.verifySignedUrl("private/koe/media/a.ogg", exp, undefined)).toBe(false);
    expect(
      store.verifySignedUrl("private/koe/media/a.ogg", exp, sig, (Number(exp) + 1) * 1000)
    ).toBe(false);
  });

  it("another secrets key does not verify", async () => {
    const url = new URL(await store.signedUrlOf("private/x.pdf", 60), "http://x");
    process.env.KITSUDEN_SECRETS_KEY = "another-test-key-0123456789abcdef-zz";
    expect(
      store.verifySignedUrl(
        "private/x.pdf",
        url.searchParams.get("exp")!,
        url.searchParams.get("sig")!
      )
    ).toBe(false);
    process.env.KITSUDEN_SECRETS_KEY = "private-media-test-key-0123456789abcdef";
  });
});
