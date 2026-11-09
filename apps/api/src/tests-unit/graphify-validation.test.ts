/**
 * Unit tests of the Graphify Engine (pure validations — does NOT require PostgreSQL).
 * resolveRelation/listRows/getRelatedRows are validated in integration (test:all).
 */
import { describe, it, expect } from "bun:test";

import { isTableExposed, GraphifyError } from "../services/graphify";

describe("Graphify: deny-list of sensitive tables", () => {
  it("exposes business tables", () => {
    expect(isTableExposed("modules")).toBe(true);
    expect(isTableExposed("data_entries")).toBe(true);
    expect(isTableExposed("games")).toBe(true);
    expect(isTableExposed("vault_projects")).toBe(true); // Vault collections yes
  });

  it("blocks authentication tables", () => {
    expect(isTableExposed("auth_users")).toBe(false);
    expect(isTableExposed("auth_sessions")).toBe(false);
    expect(isTableExposed("auth_accounts")).toBe(false);
    expect(isTableExposed("auth_verifications")).toBe(false);
  });

  it("blocks credentials and secrets", () => {
    expect(isTableExposed("api_keys")).toBe(false);
    expect(isTableExposed("kitsuden_secrets")).toBe(false);
    expect(isTableExposed("agent_tokens")).toBe(false);
    expect(isTableExposed("agent_api_keys")).toBe(false);
  });

  it("blocks system prefixes", () => {
    expect(isTableExposed("pg_stat_activity")).toBe(false);
    expect(isTableExposed("drizzle_migrations")).toBe(false);
    expect(isTableExposed("_internal")).toBe(false);
    expect(isTableExposed("auth_anything_new")).toBe(false); // the prefix covers future ones
  });
});

describe("Graphify — GraphifyError", () => {
  it("carries the HTTP status", () => {
    const err = new GraphifyError(403, "not exposed");
    expect(err.status).toBe(403);
    expect(err.message).toBe("not exposed");
    expect(err.name).toBe("GraphifyError");
    expect(err).toBeInstanceOf(Error);
  });
});
