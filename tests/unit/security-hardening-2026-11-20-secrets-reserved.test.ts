/**
 * Hardening 2026-11-20: the secrets manager refuses more runtime security knobs.
 *
 * Secrets are injected into `process.env` and several settings are re-read from
 * there at runtime: the approvals cache lifetime, the idempotency fail mode, the
 * OAuth token lifetimes and limits, the metrics token, the injection classifier
 * and the AI providers' base URLs (a new base URL receives the provider key that
 * `.env` holds). They are set in `.env`, not from the panel.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("the database is not available in this test");
      },
    }
  ),
  isLiteMode: false,
}));

const { isValidSecretKey, reservedSecretKey } = await import("../../apps/api/src/services/secrets");

describe("reserved secret keys", () => {
  it("refuses the runtime security knobs", () => {
    for (const k of [
      "APPROVALS_CACHE_SECONDS",
      "APPROVALS_MAX_UPLOAD_MB",
      "IDEMPOTENCY_FAIL_MODE",
      "OAUTH_ACCESS_TOKEN_TTL",
      "OAUTH_REQUIRE_PAR",
      "OAUTH_ISSUER_URL",
      "AGENT_KEY_DEFAULT_EXPIRY_DAYS",
      "METRICS_TOKEN",
      "INJECTION_CLASSIFIER_URL",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "OLLAMA_BASE_URL",
    ]) {
      expect(reservedSecretKey(k), k).toBe(true);
      expect(isValidSecretKey(k), k).toBe(false);
    }
  });

  it("still accepts ordinary secrets", () => {
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "MY_KON_TOKEN"]) {
      expect(isValidSecretKey(k), k).toBe(true);
    }
  });
});
