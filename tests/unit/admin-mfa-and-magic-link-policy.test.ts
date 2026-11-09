/**
 * The two pure rules behind two-factor sign-in and magic links
 * ============================================================================
 *
 *   · `KITSUDEN_ADMIN_MFA` (apps/api/src/lib/admin-mfa.ts): off by default, a typo
 *     counts as `required`, and when on only an admin session without a second
 *     factor is stopped, never better-auth's own routes.
 *   · who gets a magic link (apps/api/src/lib/magic-link-policy.ts): never an
 *     account with two-factor, never a stranger when sign-up is closed or there is
 *     no admin yet.
 *   · the magic link's extra destinations go through the same allow-list as
 *     `callbackURL` (link-target.ts).
 *
 * The flows themselves (enrol, sign in with a code, sign in with a link) run
 * against Postgres in apps/api/src/tests/auth-two-factor-magic-link.test.ts.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { adminMfaGate, adminMfaMode, mfaGateApplies } from "../../apps/api/src/lib/admin-mfa";
import { setLinkTarget } from "../../apps/api/src/lib/link-target";
import { magicLinkRefusal } from "../../apps/api/src/lib/magic-link-policy";

describe("KITSUDEN_ADMIN_MFA", () => {
  it("is optional when unset or `optional`", () => {
    expect(adminMfaMode({})).toBe("optional");
    expect(adminMfaMode({ KITSUDEN_ADMIN_MFA: " Optional " })).toBe("optional");
  });

  it("is required when `required`, and a typo counts as required", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(adminMfaMode({ KITSUDEN_ADMIN_MFA: "required" })).toBe("required");
    expect(adminMfaMode({ KITSUDEN_ADMIN_MFA: "requird" })).toBe("required");
    warn.mockRestore();
  });

  it("never applies to better-auth or the panel's public reads", () => {
    expect(mfaGateApplies("/api/auth/two-factor/enable")).toBe(false);
    expect(mfaGateApplies("/api/auth/get-session")).toBe(false);
    expect(mfaGateApplies("/api/system/auth-providers")).toBe(false);
    expect(mfaGateApplies("/api/system/init-check")).toBe(false);
    expect(mfaGateApplies("/api/settings")).toBe(true);
    expect(mfaGateApplies("/api/datasets")).toBe(true);
  });
});

describe("the admin MFA gate", () => {
  type User = { role: string; twoFactorEnabled: boolean } | null;

  function appWith(user: User, env: Record<string, string>) {
    const getSession = vi.fn(async (..._args: unknown[]) => (user ? { user } : null));
    const app = new Hono();
    app.use("*", adminMfaGate(getSession, env));
    app.get("*", (c) => c.json({ ok: true }));
    return { app, getSession };
  }

  const withCookie = { headers: { Cookie: "better-auth.session_token=x" } };
  const required = { KITSUDEN_ADMIN_MFA: "required" };

  it("off: reads no session at all", async () => {
    const { app, getSession } = appWith({ role: "admin", twoFactorEnabled: false }, {});
    expect((await app.request("/api/settings", withCookie)).status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("on: an admin without a second factor gets 403 MFA_REQUIRED", async () => {
    const { app } = appWith({ role: "admin", twoFactorEnabled: false }, required);
    const res = await app.request("/api/settings", withCookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "MFA_REQUIRED",
      code: "KITSUDEN_E_FORBIDDEN",
    });
  });

  it("on: the admin reads fresh (no cookie cache) before being refused", async () => {
    const { app, getSession } = appWith({ role: "admin", twoFactorEnabled: false }, required);
    await app.request("/api/settings", withCookie);
    expect(getSession.mock.calls.map((call) => call[1])).toEqual([false, true]);
  });

  it("on: an enrolled admin, an editor, a user and a cookieless request pass", async () => {
    for (const user of [
      { role: "admin", twoFactorEnabled: true },
      { role: "editor", twoFactorEnabled: false },
      { role: "user", twoFactorEnabled: false },
    ]) {
      const { app } = appWith(user, required);
      expect((await app.request("/api/settings", withCookie)).status).toBe(200);
    }
    const { app, getSession } = appWith({ role: "admin", twoFactorEnabled: false }, required);
    expect((await app.request("/api/settings")).status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("on: the admin without a second factor still reaches enrolment", async () => {
    const { app } = appWith({ role: "admin", twoFactorEnabled: false }, required);
    expect((await app.request("/api/auth/two-factor/enable", withCookie)).status).toBe(200);
  });
});

describe("who gets a magic link", () => {
  const open = { signUpClosed: false, firstRunRefuses: async () => false };

  it("an existing account without two-factor: yes", async () => {
    expect(await magicLinkRefusal({ twoFactorEnabled: false }, open)).toBeNull();
  });

  it("an account with two-factor: never (a link is one factor)", async () => {
    expect(await magicLinkRefusal({ twoFactorEnabled: true }, open)).toBe("two-factor");
  });

  it("a stranger with sign-up open: yes", async () => {
    expect(await magicLinkRefusal(null, open)).toBeNull();
  });

  it("a stranger with sign-up closed: no, and first-run is not even asked", async () => {
    const firstRunRefuses = vi.fn(async () => false);
    expect(await magicLinkRefusal(null, { signUpClosed: true, firstRunRefuses })).toBe(
      "sign-up-closed"
    );
    expect(firstRunRefuses).not.toHaveBeenCalled();
  });

  it("a stranger before the first admin exists: no", async () => {
    expect(
      await magicLinkRefusal(undefined, { signUpClosed: false, firstRunRefuses: async () => true })
    ).toBe("sign-up-closed");
  });
});

describe("magic link destinations", () => {
  const PANEL = "https://panel.example.com";
  const TRUSTED = ["https://panel.example.com", "https://site.example.com"];
  const link = (q: string) => `https://api.example.com/api/auth/magic-link/verify?token=t&${q}`;
  const extra = ["newUserCallbackURL", "errorCallbackURL"];

  it("a foreign errorCallbackURL is sent to the panel root", () => {
    const out = new URL(
      setLinkTarget(
        link("callbackURL=%2F&errorCallbackURL=https%3A%2F%2Fevil.tld%2F"),
        PANEL,
        TRUSTED,
        extra
      )
    );
    expect(out.searchParams.get("errorCallbackURL")).toBe(`${PANEL}/`);
    expect(out.searchParams.get("callbackURL")).toBe(`${PANEL}/`);
  });

  it("an absent extra destination stays absent; a relative one lands on the panel", () => {
    const out = new URL(
      setLinkTarget(link("callbackURL=%2F&newUserCallbackURL=%2Fwelcome"), PANEL, TRUSTED, extra)
    );
    expect(out.searchParams.has("errorCallbackURL")).toBe(false);
    expect(out.searchParams.get("newUserCallbackURL")).toBe(`${PANEL}/welcome`);
  });

  it("without `extra`, only callbackURL is touched (verification and reset links)", () => {
    const out = new URL(
      setLinkTarget(
        link("callbackURL=%2F&errorCallbackURL=https%3A%2F%2Fevil.tld%2F"),
        PANEL,
        TRUSTED
      )
    );
    expect(out.searchParams.get("errorCallbackURL")).toBe("https://evil.tld/");
  });
});
