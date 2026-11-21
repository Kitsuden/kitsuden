/**
 * Hardening 2026-11-20: the mailer sends to exactly the addresses it was given.
 *
 * `formatAddress` wrote a display name unquoted, so `{ name: "Ada, eve@evil.test" }`
 * became a second recipient, and the mailer passed any string to the driver.
 * Now names with special characters are quoted and `send` refuses an entry that
 * is not one well-formed address.
 */
import { describe, expect, it } from "vitest";

import {
  Mailer,
  formatAddress,
  isValidAddress,
  memoryDriver,
  type Mailable,
} from "../../packages/engine/src/mail";

describe("formatAddress", () => {
  it("leaves plain names as they were", () => {
    expect(formatAddress({ address: "a@b.com", name: "Kitsuden" })).toBe("Kitsuden <a@b.com>");
    expect(formatAddress({ address: "a@b.com", name: "Ada L." })).toBe("Ada L. <a@b.com>");
    expect(formatAddress("a@b.com")).toBe("a@b.com");
  });

  it("quotes a name that would add a recipient", () => {
    const out = formatAddress({ address: "a@b.com", name: 'Ada, "x" eve@evil.test' });
    expect(out).toBe('"Ada, \\"x\\" eve@evil.test" <a@b.com>');
    expect(isValidAddress(out)).toBe(true);
  });

  it("drops line breaks from the name", () => {
    expect(formatAddress({ address: "a@b.com", name: "Ada\r\nBcc: eve@evil.test" })).not.toMatch(
      /[\r\n]/
    );
  });
});

describe("isValidAddress", () => {
  it("accepts one address", () => {
    for (const a of ["a@b.com", "Kitsuden <no-reply@kitsuden.dev>", '"A, B" <a@b.com>', "x@y.z"]) {
      expect(isValidAddress(a), a).toBe(true);
    }
  });

  it("refuses lists, line breaks and garbage", () => {
    for (const a of [
      "a@b.com, eve@evil.test",
      "a@b.com\r\nBcc: eve@evil.test",
      '["a@b.com","eve@evil.test"]',
      "Ada <a@b.com> <eve@evil.test>",
      "not an address",
      "",
    ]) {
      expect(isValidAddress(a), a).toBe(false);
    }
  });
});

describe("Mailer.send", () => {
  const welcome: Mailable<{ to: unknown }> = {
    name: "welcome",
    envelope: (d) => ({ to: d.to as string, subject: "Hi" }),
    content: () => ({ html: "<p>Hi</p>" }),
  };

  function mailer() {
    const driver = memoryDriver();
    const m = new Mailer({ driver, from: { address: "no-reply@kitsuden.dev", name: "Kitsuden" } });
    m.register(welcome);
    return { m, driver };
  }

  it("sends to a single address", async () => {
    const { m, driver } = mailer();
    const r = await m.send("welcome", { to: "ada@example.com" });
    expect(r.ok).toBe(true);
    expect(driver.outbox).toHaveLength(1);
  });

  it("refuses a recipient that is a list in one string", async () => {
    const { m, driver } = mailer();
    const r = await m.send("welcome", { to: "ada@example.com, eve@evil.test" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid email address/);
    expect(driver.outbox).toHaveLength(0);
  });
});
