/**
 * Findings from the core audit, one per block.
 *
 * These are the PURE rules that close each hole; the end-to-end test
 * (the real app, with real identities) is the authorization matrix:
 * `scripts/authorization-matrix.ts` + `tests/unit/authorization-matrix.test.ts`.
 */
import { describe, expect, it } from "bun:test";

import { validateBearerToken } from "../lib/actions/handlers/webhook-in-handler";
import { onlyEditableSettings } from "../routes/crud";
import { queryWouldSkipIsolation, canUseBatch } from "../routes/datasets-query";
import { parseAgentApiKey } from "../services/agent-auth";
import { canViewTable } from "../services/graphify";

describe("Graphify: without the admin role, only tables with forced RLS", () => {
  // Before: ANY account read through /api/graph/<table> everything that was not
  // in the deny-list — newsletter subscribers, CRM contacts,
  // employees, orders, `data_sources` with their password, actions with their
  // webhook secrets…
  const forcedItems = new Set(["data_entries", "vault_projects", "builder_builds"]);

  it("a user does not see tables without RLS", () => {
    for (const t of [
      "nl_members",
      "crm_contacts",
      "data_sources",
      "actions",
      "audit_logs",
      "media",
    ]) {
      expect(canViewTable(t, { isAdmin: false }, forcedItems), t).toBe(false);
      expect(canViewTable(t, {}, forcedItems), t).toBe(false);
    }
  });

  it("a user only sees Vault collections isolated by Postgres", () => {
    expect(canViewTable("vault_projects", {}, forcedItems)).toBe(true);
    // Audit: kon tables with forced RLS trim
    // COLUMNS on their route; graph does SELECT * and bypassed that trimming.
    const fromKons = new Set([...forcedItems, "directory_employees", "dms_document_files"]);
    for (const t of [
      "data_entries",
      "builder_builds",
      "directory_employees",
      "dms_document_files",
    ]) {
      expect(canViewTable(t, {}, fromKons), t).toBe(false);
    }
    // A vault_ table without forced RLS does not either
    expect(canViewTable("vault_without_rls", {}, forcedItems)).toBe(false);
  });

  it("admin sees what is exposed; the deny-list applies to everyone", () => {
    expect(canViewTable("crm_contacts", { isAdmin: true }, forcedItems)).toBe(true);
    expect(canViewTable("auth_sessions", { isAdmin: true }, new Set(["auth_sessions"]))).toBe(
      false
    );
    expect(canViewTable("kitsuden_secrets", { isAdmin: true }, forcedItems)).toBe(false);
  });
});

describe("POST /api/datasets/:id/query respects per-row isolation", () => {
  const byOwner = {
    readAccess: "authenticated",
    writeAccess: "authenticated",
    enableRLS: true,
    rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
  } as never;

  it("dataset by owner + normal user: the query would be rejected", () => {
    expect(queryWouldSkipIsolation(byOwner, { id: "u1", role: "user" })).toBe(true);
  });

  it("admin, or dataset without rules: it is queried", () => {
    expect(queryWouldSkipIsolation(byOwner, { id: "a1", role: "admin" })).toBe(false);
    expect(
      queryWouldSkipIsolation({ readAccess: "public", rlsRules: [] } as never, {
        id: "u1",
        role: "user",
      })
    ).toBe(false);
    expect(queryWouldSkipIsolation(null, { id: "u1", role: "user" })).toBe(false);
  });
});

describe("PATCH /api/settings: column allowlist", () => {
  it("drops id, updatedAt and anything unknown", () => {
    const clean = onlyEditableSettings({
      id: "other-id",
      updatedAt: "2020-01-01",
      siteName: "My site",
      social: { twitch: "x" },
      anything: 1,
    });
    expect(clean).toEqual({ siteName: "My site", social: { twitch: "x" } });
  });

  it("a body that is not an object does not break", () => {
    expect(onlyEditableSettings(null)).toEqual({});
    expect(onlyEditableSettings("x")).toEqual({});
  });
});

describe("incoming webhook with Bearer: constant-time comparison", () => {
  const req = (auth: string) => ({
    method: "POST",
    path: "/",
    headers: { authorization: auth },
    body: {},
  });

  it("accepts the exact secret and rejects the rest (prefixes included)", () => {
    expect(validateBearerToken(req("Bearer s3cret-long"), { secret: "s3cret-long" })).toBe(true);
    expect(validateBearerToken(req("Bearer s3cret-lon"), { secret: "s3cret-long" })).toBe(false);
    expect(validateBearerToken(req("Bearer s3cret-longX"), { secret: "s3cret-long" })).toBe(false);
    expect(validateBearerToken(req(""), { secret: "s3cret-long" })).toBe(false);
  });
});

describe("agent key with `_` in the secret (base64url)", () => {
  // Before it was split on `_`: with a `_` inside the secret —half of the
  // issued keys— keyId and secret came out wrong and the key never authenticated.
  it("separates type, keyId and secret even if the secret contains `_` and `-`", () => {
    const p = parseAgentApiKey("kitsuden_agent_claude-desktop_0123456789abcdef_ab_cd-ef_gh");
    expect(p).toEqual({
      type: "claude-desktop",
      keyId: "0123456789abcdef",
      secret: "ab_cd-ef_gh",
      isLegacy: false,
    });
  });

  it("without `_` in the secret, same as before", () => {
    expect(parseAgentApiKey("kitsuden_agent_custom_0123456789abcdef_abcDEF123")?.secret).toBe(
      "abcDEF123"
    );
  });
});

describe("POST /api/data-sets: the default owner rule uses the marker that rls-builder understands", () => {
  it("is __USER_ID__ (before {{current_user_id}}, which was compared literally and never matched)", async () => {
    const { DATASET_RLS_OWNER } = await import("../routes/crud");
    const { buildDrizzleWhere } = await import("../lib/rls-builder");
    expect(DATASET_RLS_OWNER).toBe("__USER_ID__");
    // It is the marker that rls-builder replaces with the session id (its
    // USER_ID_PLACEHOLDER); the remaining values are compared literally.
    const source = await Bun.file(
      new URL("../../../../packages/shared/src/rls-builder.ts", import.meta.url)
    ).text();
    expect(source).toContain('const USER_ID_PLACEHOLDER = "__USER_ID__"');
  });
});

describe("POST /api/datasets/batch authorizes itself", () => {
  it("only admin or an agent with the admin scope", () => {
    expect(canUseBatch({ role: "admin" }, undefined)).toBe(true);
    expect(canUseBatch({ role: "editor" }, undefined)).toBe(false);
    expect(canUseBatch({ role: "user" }, undefined)).toBe(false);
    expect(canUseBatch(null, undefined)).toBe(false);
    // an agent without `admin` does not pass even if its synthetic user says otherwise
    expect(canUseBatch({ role: "admin" }, { scopes: ["datasets:write"] })).toBe(false);
    expect(canUseBatch({ role: "agent" }, { scopes: ["admin"] })).toBe(true);
  });
});

describe("dataset row reads: one bucket per client, lower", () => {
  it("GET entries (any dataset) uses ENTRIES_READ; the rest do not", async () => {
    const { configByPattern, INPUT_READ } = await import("../lib/rate-limiter");
    expect(configByPattern("GET", "/api/data-sets/abc/entries")).toBe(INPUT_READ);
    expect(configByPattern("GET", "/api/datasets/abc/entries/x")).toBe(INPUT_READ);
    expect(configByPattern("POST", "/api/data-sets/abc/entries")).toBeNull();
    expect(configByPattern("GET", "/api/data-sets/abc")).toBeNull();
    expect(INPUT_READ.limit).toBeLessThan(300);
    // the key does NOT include the route: sweeping 50 datasets spends the same bucket
    const c = {
      req: { header: () => undefined, path: "/api/data-sets/a/entries" },
      env: { ip: { address: "203.0.113.9" } },
    } as never;
    const c2 = {
      req: { header: () => undefined, path: "/api/data-sets/b/entries" },
      env: { ip: { address: "203.0.113.9" } },
    } as never;
    expect(INPUT_READ.keyGenerator!(c)).toBe(INPUT_READ.keyGenerator!(c2));
  });
});

describe("explorer: no tokens or passwords in responses, nor member_signins", () => {
  it("removes secret columns in snake and camel case, leaves the normal ones", async () => {
    const { withoutSecretColumns, isSecretColumn, FORBIDDEN_TABLES } =
      await import("../lib/explorable-tables");
    expect(FORBIDDEN_TABLES.has("member_signins")).toBe(true);
    const row = {
      email: "a@x",
      unsub_token: "t",
      confirmToken: "t",
      password: "p",
      token_hash: "h",
      ingest_token: "i",
      tokens_in: 5,
      title: "x",
    };
    expect(withoutSecretColumns({ data: [row] })).toEqual({
      data: [{ email: "a@x", tokens_in: 5, title: "x" }],
    });
    expect(isSecretColumn("tokensOut")).toBe(false);
    expect(isSecretColumn("keyHash")).toBe(true);
  });
});
