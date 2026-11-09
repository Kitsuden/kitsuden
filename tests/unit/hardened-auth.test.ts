/**
 * Authentication does not become open to account takeover again
 * ============================================================================
 *
 * ── WHAT THE AUDIT FOUND ───────────────────────────────────────────────────
 *
 * `better-auth` 1.4.19, with the exact configuration described by the advisory
 * GHSA-g38m-r43w-p2q7 («account takeover via OAuth auto-link to unverified
 * pre-registered email»):
 *
 *   · email and password signup enabled,
 *   · login with GitHub, Google and Discord,
 *   · account linking by default.
 *
 * The attack: someone registers your email with their password, you sign in later
 * with Google, the accounts get linked and that person gets into yours.
 *
 * ── WHAT CLOSES IT, AND WHAT DOES NOT ──────────────────────────────────────
 *
 * The VERSION closes it: since 1.6.11 better-auth requires the local user
 * to have a verified email before linking. Requiring verification at signup
 * does NOT mitigate it —the advisory says so expressly: the attacker's row is marked
 * as verified during linking—. That is why this test guards both
 * things separately and does not let one pass for the other.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (...route: string[]) => readFileSync(join(ROOT, ...route), "utf-8");

const AUTH = read("apps", "api", "src", "lib", "auth.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const LOCK = read("pnpm-lock.yaml");

/** Compares x.y.z versions without dependencies. */
function smaller(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

describe("the better-auth version", () => {
  it("everything resolved in the lockfile includes the patch (≥1.6.11)", () => {
    const versions = [
      ...new Set([...LOCK.matchAll(/better-auth@(\d+\.\d+\.\d+)/g)].map((m) => m[1])),
    ];

    expect(versions.length, "better-auth was not found in the lockfile").toBeGreaterThan(0);

    const vulnerable = versions.filter((v) => smaller(v, "1.6.11"));
    expect(
      vulnerable,
      `The lockfile resolves better-auth ${vulnerable.join(", ")}, below 1.6.11: ` +
        `account takeover through OAuth linking is open again.`
    ).toEqual([]);
  });

  it("package.json files pin the branch with a tilde, not a caret", () => {
    /**
     * `pnpm update` wrote `^1.6.31` even though `~` was requested. With a caret, a
     * future `pnpm update` jumps to the next minor, as 1.7 did when it changed how
     * linked accounts are identified. A security update cannot sneak in an
     * incompatible change.
     */
    for (const route of [
      ["apps", "api", "package.json"],
      ["packages", "admin", "package.json"],
      ["packages", "kitsuden", "package.json"],
    ]) {
      const specifier = JSON.parse(read(...route)).dependencies?.["better-auth"];
      expect(specifier, `${route.join("/")} does not declare better-auth`).toBeDefined();
      expect(
        specifier.startsWith("~"),
        `${route.join("/")} declares «${specifier}»: it has to use a tilde`
      ).toBe(true);
    }
  });
});

describe("account linking", () => {
  it("nobody disables the local email check", () => {
    expect(
      /requireLocalEmailVerified\s*:\s*false/.test(AUTH),
      "requireLocalEmailVerified: false reopens exactly the account takeover of the advisory."
    ).toBe(false);
  });

  it("Discord is never a trusted provider", () => {
    /**
     * A trusted provider links even if the email has not been verified, and
     * Discord hands out unverified addresses.
     */
    const trust = AUTH.match(/trustedProviders\s*:\s*\[([^\]]*)\]/);
    expect(trust, "trustedProviders has to be declared explicitly").not.toBeNull();
    expect(trust![1]).not.toMatch(/discord/i);
  });
});

describe("verification and recovery", () => {
  it("password signup requires verifying the email", () => {
    expect(AUTH).toMatch(/requireEmailVerification\s*:\s*true/);
  });

  it("both emails are WIRED UP, not just written", () => {
    /**
     * The recovery template existed and nothing sent it. Declaring the
     * option is not enough: it has to enqueue the template that exists.
     */
    expect(AUTH).toMatch(/sendResetPassword\s*:/);
    expect(AUTH).toContain('"system.password-recovery"');
    expect(AUTH).toMatch(/sendVerificationEmail\s*:/);
    expect(AUTH).toContain('"system.email-verification"');

    const emails = read("apps", "api", "src", "mail", "system-mails.ts");
    expect(emails).toContain('name: "system.email-verification"');
    expect(emails).toMatch(/registerAll\(\[[^\]]*verificationMail/);
  });

  it("a password reset closes open sessions", () => {
    expect(AUTH).toMatch(/revokeSessionsOnPasswordReset\s*:\s*true/);
  });

  it("an email that cannot be enqueued leaves an error trace", () => {
    /**
     * `emailQueue.add` returns null if Valkey does not respond. Without checking it,
     * a lost verification leaves no signal.
     */
    const helper = AUTH.slice(
      AUTH.indexOf("async function enqueueEmail"),
      AUTH.indexOf("export const auth")
    );
    expect(helper.length, "enqueueEmail was not found").toBeGreaterThan(0);
    expect(helper).toContain("if (!job)");
    expect(helper).toContain("logger.error");
  });
});

describe("the first administrator", () => {
  it("comes out of signup verified, or is left locked out of their own instance", () => {
    const high = INDEX.slice(
      INDEX.indexOf('app.post("/api/system/setup"'),
      INDEX.indexOf('app.route("/api/system", systemRoutes)')
    );

    expect(high.length, "the first administrator's signup was not found").toBeGreaterThan(0);

    const promotions = high.match(/\.set\(\{[^}]*role: "admin"[^}]*\}\)/g) ?? [];
    expect(promotions.length, "the admin promotion was not found").toBeGreaterThan(0);

    for (const p of promotions) {
      expect(
        p.includes("emailVerified: true"),
        `«${p}» promotes to admin without verifying the email: with mandatory ` +
          `verification, SetupView signs in and the installer gets «Email not verified».`
      ).toBe(true);
    }
  });
});
