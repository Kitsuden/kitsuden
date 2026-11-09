/**
 * Verification and recovery emails lead somewhere
 * ============================================================================
 *
 * Wiring up `sendResetPassword` and `sendVerificationEmail` on the server was
 * not enough: the panel had no «forgot your password?», no form to
 * set the new one, no way to resend the verification. With mandatory
 * verification, someone with the right password got «Email not verified»
 * and no button. It was the usual family —complete code on one side and
 * nothing calling it on the other—, this time created by the fix itself.
 *
 * ── WHY EVERYTHING LIVES IN THE LOGIN ──────────────────────────────────────
 *
 * Without a session, `+layout.svelte` paints `LoginView` on ANY route. A separate
 * `/reset-password` page would never get seen. better-auth returns to the root
 * with `?token=`, and the login recognizes it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const LOGIN = readFileSync(
  join(ROOT, "packages", "admin", "src", "views", "auth", "LoginView.svelte"),
  "utf-8"
);
const STORE = readFileSync(
  join(ROOT, "packages", "admin", "src", "lib", "auth.svelte.ts"),
  "utf-8"
);
const LAYOUT = readFileSync(
  join(ROOT, "packages", "admin", "src", "routes", "+layout.svelte"),
  "utf-8"
);

describe("recovery from the panel login", () => {
  it("the store calls better-auth 1.6's real endpoints", () => {
    /**
     * The names changed between versions (`/forget-password` became
     * `/request-password-reset`). An old name gives no type error: it gives a
     * 404 when the button is pressed.
     */
    expect(STORE).toContain("/api/auth/request-password-reset");
    expect(STORE).toContain("/api/auth/reset-password");
    expect(STORE).toContain("/api/auth/send-verification-email");
    expect(STORE).not.toContain("/api/auth/forget-password");
  });

  it("signIn keeps the error code", () => {
    expect(STORE).toMatch(/\.code\s*=\s*body\.code/);
  });

  it("the login offers to resend the verification when needed", () => {
    expect(LOGIN).toContain('"EMAIL_NOT_VERIFIED"');
    expect(LOGIN).toContain("resendVerification(");
  });

  it("the login offers recovering the password and setting the new one", () => {
    expect(LOGIN).toContain("requestPasswordReset(");
    expect(LOGIN).toContain("resetPassword(");
    expect(LOGIN).toContain('params.get("token")');
  });

  it("the send notice does not reveal whether the account exists", () => {
    const forgetting = LOGIN.slice(LOGIN.indexOf("async function handleForgot"));
    const body = forgetting.slice(0, forgetting.indexOf("async function handleNew"));
    /**
     * Since the panel has dictionaries (en/es), the notice is not written in
     * the component: it is requested with t("loginView.<key>"). The key is resolved in
     * both languages and the same neutral wording is required in both.
     */
    const key = body.match(/\bt\("loginView\.(\w+)"\)/g)?.map((m) => m.slice(13, -2)) ?? [];
    const textIn = (language: string) =>
      key
        .map((k) => {
          const dic = readFileSync(
            join(ROOT, "packages", "admin", "src", "lib", "i18n", `${language}.ts`),
            "utf-8"
          );
          return dic.match(new RegExp(`^    ${k}:\\s*"(.*)",$`, "m"))?.[1] ?? "";
        })
        .join(" ");
    expect(textIn("es")).toMatch(/Si existe una cuenta/);
    expect(textIn("en")).toMatch(/If an account exists/);
  });

  it("the link returns to the root, which is where the login can see it", () => {
    /**
     * If someone changes `redirectTo` to a route of its own without touching the layout,
     * the email link lands on a login that ignores the token.
     */
    expect(LAYOUT).toContain("<LoginView />");
    expect(STORE).toMatch(/redirectTo:\s*`\$\{window\.location\.origin\}\/`/);
  });

  it("after changing the password, the token leaves the URL", () => {
    const next = LOGIN.slice(LOGIN.indexOf("async function handleNew"));
    expect(next.slice(0, 1500)).toContain("history.replaceState");
  });
});
