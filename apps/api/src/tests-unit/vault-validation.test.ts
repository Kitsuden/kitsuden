/**
 * Unit tests for KITSUDEN Vault (pure validations — does NOT require PostgreSQL).
 * Real DDL (createCollection/addColumn) is validated in integration (test:all).
 */
import { describe, it, expect, afterEach } from "bun:test";

import { vaultTableName, isVaultEnabled, VaultError, VAULT_PREFIX } from "../services/vault";

const originalFlag = process.env.KITSUDEN_VAULT_ENABLED;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.KITSUDEN_VAULT_ENABLED;
  else process.env.KITSUDEN_VAULT_ENABLED = originalFlag;
});

describe("Vault — collection names", () => {
  it("accepts valid snake_case and applies the vault_ prefix", () => {
    expect(vaultTableName("projects")).toBe("vault_projects");
    expect(vaultTableName("crm_leads_2026")).toBe("vault_crm_leads_2026");
  });

  it("rejects uppercase, hyphens, spaces and SQL characters", () => {
    expect(() => vaultTableName("Projects")).toThrow(VaultError);
    expect(() => vaultTableName("crm-leads")).toThrow(VaultError);
    expect(() => vaultTableName("my table")).toThrow(VaultError);
    expect(() => vaultTableName('x"; DROP TABLE auth_users;--')).toThrow(VaultError);
    expect(() => vaultTableName("")).toThrow(VaultError);
    expect(() => vaultTableName("1number")).toThrow(VaultError);
  });

  it("rejects names that exceed the maximum length", () => {
    expect(() => vaultTableName("a".repeat(60))).toThrow(VaultError);
  });

  it("the prefix guarantees isolation from the core", () => {
    // Even if the user tries to name their collection like a core table,
    // the prefix isolates it: it never collides with auth_users or modules.
    expect(vaultTableName("auth_users")).toBe(`${VAULT_PREFIX}auth_users`);
    expect(vaultTableName("modules")).toBe(`${VAULT_PREFIX}modules`);
  });
});

describe("Vault — feature flag", () => {
  it("disabled by default (disruptive, so it is opt-in)", () => {
    delete process.env.KITSUDEN_VAULT_ENABLED;
    expect(isVaultEnabled()).toBe(false);
  });

  it("enabled only with the exact value 'true'", () => {
    process.env.KITSUDEN_VAULT_ENABLED = "true";
    expect(isVaultEnabled()).toBe(true);
    process.env.KITSUDEN_VAULT_ENABLED = "1";
    expect(isVaultEnabled()).toBe(false);
    process.env.KITSUDEN_VAULT_ENABLED = "TRUE";
    expect(isVaultEnabled()).toBe(false);
  });
});

describe("Vault — VaultError", () => {
  it("carries the HTTP status", () => {
    const err = new VaultError(409, "already exists");
    expect(err.status).toBe(409);
    expect(err).toBeInstanceOf(Error);
  });
});
