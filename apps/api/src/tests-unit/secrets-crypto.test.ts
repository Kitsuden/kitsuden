/**
 * Unit tests for the Secrets Manager (pure crypto — does NOT require PostgreSQL).
 * The CRUD/hot-injection functions are validated in integration (test:all).
 */
import { describe, it, expect, beforeAll } from "bun:test";

// The master key must exist BEFORE the first encryption call
beforeAll(() => {
  process.env.KITSUDEN_SECRETS_KEY = "kitsuden-test-master-key-for-unit-tests-32ch";
});

import { encryptSecret, decryptSecret, isValidSecretKey } from "../services/secrets";

describe("Secrets Manager — AES-256-GCM", () => {
  it("roundtrip encrypt → decrypt", () => {
    const enc = encryptSecret("sk-super-secret-123");
    expect(decryptSecret(enc)).toBe("sk-super-secret-123");
  });

  it("each encryption uses a unique IV (same plaintext ≠ same ciphertext)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.valueEncrypted).not.toBe(b.valueEncrypted);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("detects ciphertext tampering (GCM auth tag)", () => {
    const enc = encryptSecret("original-value");
    const tampered = {
      ...enc,
      valueEncrypted: (enc.valueEncrypted[0] === "a" ? "b" : "a") + enc.valueEncrypted.slice(1),
    };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("detects auth tag tampering", () => {
    const enc = encryptSecret("original-value");
    const tampered = {
      ...enc,
      authTag: (enc.authTag[0] === "0" ? "1" : "0") + enc.authTag.slice(1),
    };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("supports unicode and multiline values", () => {
    const value = "line1\nline2 🔑 ñandú\ttab";
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });

  it("supports long values (10KB)", () => {
    const value = "x".repeat(10_000);
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });
});

describe("Secrets Manager — key validation", () => {
  it("accepts UPPER_SNAKE_CASE", () => {
    expect(isValidSecretKey("OPENAI_API_KEY")).toBe(true);
    expect(isValidSecretKey("STRIPE_SECRET_KEY")).toBe(true);
    // Reserved (audit): they change how the process starts or protects itself
    for (const k of [
      "KITSUDEN_SECRETS_KEY",
      "PATH",
      "NODE_OPTIONS",
      "NODE_ENV",
      "LD_PRELOAD",
      "BETTER_AUTH_SECRET",
      "PGPASSWORD",
      "DATABASE_URL",
    ]) {
      expect(isValidSecretKey(k), k).toBe(false);
    }
    expect(isValidSecretKey("S3_ACCESS_KEY_2")).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(isValidSecretKey("openai_api_key")).toBe(false); // lowercase
    expect(isValidSecretKey("OPENAI-API-KEY")).toBe(false); // hyphens
    expect(isValidSecretKey("2FA_TOKEN")).toBe(false); // starts with a number
    expect(isValidSecretKey("KEY WITH SPACE")).toBe(false);
    expect(isValidSecretKey("K")).toBe(false); // too short
    expect(isValidSecretKey("DROP TABLE;--")).toBe(false); // injection attempt
  });
});
