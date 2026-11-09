/**
 * A public installation does not start up misconfigured
 * ============================================================================
 *
 * A production audit found that `BETTER_AUTH_URL` was written
 * as localhost in the compose and that no mail transport reached the
 * container. Both things started without error and failed afterwards: social
 * login with a return trip to the wrong machine, and password recovery
 * printed to a console.
 *
 * These tests pin down what step [0/6] of startup has to reject, and
 * above all what it must NOT do: write a secret to the log.
 */

import { describe, expect, it } from "vitest";

import { publicConfigProblems } from "../../apps/api/src/lib/public-config";

const SECRET = "x".repeat(48);

/** A correct public configuration. Each test breaks just one thing. */
const GOOD = {
  BETTER_AUTH_URL: "https://cms.example.com",
  ADMIN_URL: "https://cms.example.com",
  APP_URL: "https://cms.example.com",
  ALLOWED_ORIGINS: "https://cms.example.com",
  RESEND_API_KEY: "re_test_not_real",
  MAIL_FROM: "Kitsuden <noreply@example.com>",
  BETTER_AUTH_SECRET: SECRET,
  KITSUDEN_SECRETS_KEY: "k".repeat(64),
};

const variables = (env: Record<string, string | undefined>) =>
  publicConfigProblems(env).map((p) => p.variable);

describe("public configuration", () => {
  it("a correct configuration has no problems", () => {
    expect(publicConfigProblems(GOOD)).toEqual([]);
  });

  it("the compose default values do NOT pass", () => {
    /**
     * It is exactly what had been deployed: if this passed, the startup
     * step would be decorative.
     */
    const defaultValue = {
      BETTER_AUTH_URL: "http://localhost:3000",
      ADMIN_URL: "http://localhost:3001",
      APP_URL: "http://localhost:3001",
      ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:3000,http://localhost:3001",
      MAIL_FROM: "noreply@localhost",
      BETTER_AUTH_SECRET: SECRET,
    };

    const v = variables(defaultValue);
    expect(v).toContain("BETTER_AUTH_URL");
    expect(v).toContain("ADMIN_URL");
    expect(v).toContain("ALLOWED_ORIGINS");
    expect(v).toContain("MAIL_FROM");
    expect(v).toContain("RESEND_API_KEY / SMTP_HOST");
  });

  it("http with a real domain is also rejected", () => {
    expect(variables({ ...GOOD, BETTER_AUTH_URL: "http://cms.example.com" })).toEqual([
      "BETTER_AUTH_URL",
    ]);
  });

  it("127.0.0.1 and *.localhost count as local", () => {
    expect(variables({ ...GOOD, ADMIN_URL: "https://127.0.0.1" })).toContain("ADMIN_URL");
    expect(variables({ ...GOOD, APP_URL: "https://panel.localhost" })).toContain("APP_URL");
  });

  it("a single local origin among several is enough to reject", () => {
    expect(
      variables({ ...GOOD, ALLOWED_ORIGINS: "https://cms.example.com,http://localhost:5173" })
    ).toEqual(["ALLOWED_ORIGINS"]);
  });

  it("without a mail transport it is rejected, even if everything else is fine", () => {
    const { RESEND_API_KEY: _removed, ...withoutEmail } = GOOD;
    expect(variables(withoutEmail)).toEqual(["RESEND_API_KEY / SMTP_HOST"]);
  });

  it("SMTP also counts as a real transport", () => {
    const { RESEND_API_KEY: _removed, ...withoutResend } = GOOD;
    expect(variables({ ...withoutResend, SMTP_HOST: "smtp.example.com" })).toEqual([]);
  });

  it("forcing MAIL_DRIVER=log is rejected even with a key", () => {
    /**
     * The resolution is the Mailer's own: an explicit driver beats the
     * key. If the check only looked at whether RESEND_API_KEY exists, it would say «there is
     * mail» while the application prints to the console.
     */
    expect(variables({ ...GOOD, MAIL_DRIVER: "log" })).toEqual(["RESEND_API_KEY / SMTP_HOST"]);
  });

  it("a short secret is rejected", () => {
    expect(variables({ ...GOOD, BETTER_AUTH_SECRET: "short" })).toEqual(["BETTER_AUTH_SECRET"]);
  });

  it("without its own KITSUDEN_SECRETS_KEY it is rejected (security review 2026-11-03)", () => {
    expect(variables({ ...GOOD, KITSUDEN_SECRETS_KEY: undefined })).toEqual([
      "KITSUDEN_SECRETS_KEY",
    ]);
    expect(variables({ ...GOOD, KITSUDEN_SECRETS_KEY: "  " })).toEqual(["KITSUDEN_SECRETS_KEY"]);
    const reason = publicConfigProblems({ ...GOOD, KITSUDEN_SECRETS_KEY: undefined })[0]!.reason;
    expect(reason).toContain("rekey-secrets.ts");
  });

  it("no message contains a secret", () => {
    /**
     * These messages end up in the container log. It is tested with recognizable
     * values so that, if any slips in, the test finds it.
     */
    const secret = "SECRET-THAT-MUST-NOT-LEAK-" + "z".repeat(10);
    const key = "re_KEY_THAT_MUST_NOT_LEAK";

    const messages = publicConfigProblems({
      BETTER_AUTH_URL: "http://localhost:3000",
      MAIL_FROM: "noreply@localhost",
      BETTER_AUTH_SECRET: secret,
      RESEND_API_KEY: key,
      MAIL_DRIVER: "log",
    })
      .map((p) => p.reason)
      .join("\n");

    expect(messages).not.toContain(secret);
    expect(messages).not.toContain(key);
  });
});

/**
 * The five ways of getting the origins list wrong
 *
 * It is where a real deployment falls over, and quietly: the site loads fully and
 * only login and comments fail — exactly what nobody tests when
 * deploying. It happened with all three sites at once.
 */
describe("ALLOWED_ORIGINS in a real deployment", () => {
  it("empty does not pass: no site could talk to the API", () => {
    expect(variables({ ...GOOD, ALLOWED_ORIGINS: "" })).toContain("ALLOWED_ORIGINS");
    expect(variables({ ...GOOD, ALLOWED_ORIGINS: undefined })).toContain("ALLOWED_ORIGINS");
    expect(publicConfigProblems({ ...GOOD, ALLOWED_ORIGINS: "" })[0].reason).toMatch(/is empty/);
  });

  it("http where the site is https does not pass: they are different origins", () => {
    const p = publicConfigProblems({
      ...GOOD,
      APP_URL: "https://example.com",
      ALLOWED_ORIGINS: "http://example.com",
    });
    expect(p.map((x) => x.reason).join(" ")).toMatch(/is not https/);
  });

  it("a trailing slash does not pass: an origin does not carry one and would never match", () => {
    const p = publicConfigProblems({
      ...GOOD,
      APP_URL: "https://cms.example.com",
      ALLOWED_ORIGINS: "https://cms.example.com/",
    });
    expect(p.map((x) => x.reason).join(" ")).toMatch(/slash or path/);
  });

  it("forgetting the main site does not pass even if the panel is there", () => {
    // The real failure: the panel worked and the main site was left without login
    const p = publicConfigProblems({
      ...GOOD,
      APP_URL: "https://example.com",
      BETTER_AUTH_URL: "https://example.com",
      ADMIN_URL: "https://cms.example.com",
      ALLOWED_ORIGINS: "https://cms.example.com",
    });
    expect(p.map((x) => x.reason).join(" ")).toMatch(/does not include https:\/\/example\.com/);
  });

  it("all three sites set correctly pass", () => {
    expect(
      publicConfigProblems({
        ...GOOD,
        APP_URL: "https://example.com",
        BETTER_AUTH_URL: "https://example.com",
        ADMIN_URL: "https://cms.example.com",
        ALLOWED_ORIGINS:
          "https://example.com,https://other-site.example,https://third-site.example,https://cms.example.com",
      })
    ).toEqual([]);
  });
});
