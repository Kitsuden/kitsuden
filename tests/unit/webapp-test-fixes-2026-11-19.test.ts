/**
 * Fixes from the 2026-11-19 web app test of the admin with every kon on
 * ============================================================================
 *
 * Each block pins one bug that test found, so it does not come back:
 *
 *  - The admin registry built itself once per request while cold (18–120 s
 *    each, cut by Bun at 10 s): now one build at a time, served stale while
 *    the next one is built.
 *  - Media › Settings bound inputs to `undefined` and Svelte 5 threw.
 *  - Accounting › Reimbursable expenses called `/conta/matters`, renamed to
 *    `/conta/projects`, and sent `matterId`, which the API no longer takes.
 *  - Kon views in `pnpm dev` loaded their bundle and called the API on the
 *    ADMIN's origin (404): the host never passed the API's origin.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSharedRefresh } from "../../apps/api/src/lib/shared-refresh";
import {
  withFieldDefaults,
  withoutEmptyFields,
} from "../../packages/admin/src/lib/media-storage-fields";
import { resolveCustomView } from "../../packages/shared/src/admin-view";

const ROOT = join(__dirname, "..", "..");
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** A build whose end the test decides. */
function controllableBuild() {
  let calls = 0;
  const pending: ((value: string) => void)[] = [];
  const build = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        calls++;
        pending.push(resolve);
      })
  );
  return {
    build,
    calls: () => calls,
    finish: (value: string) => pending.shift()?.(value),
  };
}

describe("createSharedRefresh (admin registry)", () => {
  it("callers that arrive during a cold build share it", async () => {
    const b = controllableBuild();
    const shared = createSharedRefresh(b.build, { ttlMs: 60_000 });

    const all = Promise.all([shared.get(), shared.get(), shared.get(), shared.get(), shared.get()]);
    expect(b.calls()).toBe(1);

    b.finish("v1");
    expect(await all).toEqual(["v1", "v1", "v1", "v1", "v1"]);
  });

  it("serves the expired value at once and rebuilds in the background", async () => {
    let now = 0;
    const b = controllableBuild();
    const shared = createSharedRefresh(b.build, { ttlMs: 1000, now: () => now });

    const first = shared.get();
    b.finish("v1");
    await first;

    now = 5000; // expired
    expect(await shared.get()).toBe("v1"); // without waiting for the rebuild
    expect(b.calls()).toBe(2);
    expect(await shared.get()).toBe("v1"); // still one rebuild in flight
    expect(b.calls()).toBe(2);

    b.finish("v2");
    await vi.waitFor(async () => expect(await shared.get()).toBe("v2"));
  });

  it("a build started before clear() answers its caller but is not kept", async () => {
    const b = controllableBuild();
    const shared = createSharedRefresh(b.build, { ttlMs: 60_000 });

    const old = shared.get();
    shared.clear(); // e.g. a kon was installed meanwhile
    const fresh = shared.get();
    expect(b.calls()).toBe(2);

    b.finish("before-clear");
    b.finish("after-clear");
    expect(await old).toBe("before-clear");
    expect(await fresh).toBe("after-clear");
    expect(await shared.get()).toBe("after-clear");
  });

  it("a failed cold build is not cached: the next call tries again", async () => {
    let attempt = 0;
    const shared = createSharedRefresh(
      async () => {
        attempt++;
        if (attempt === 1) throw new Error("pool exhausted");
        return "ok";
      },
      { ttlMs: 60_000 }
    );
    await expect(shared.get()).rejects.toThrow("pool exhausted");
    expect(await shared.get()).toBe("ok");
  });

  it("the admin registry uses it", () => {
    const registry = source("apps/api/src/services/admin-registry.ts");
    expect(registry).toContain("createSharedRefresh(() => rebuildAdminRegistry()");
  });
});

describe("Media › Settings storage fields", () => {
  const providers = [
    {
      id: "minio",
      fields: [
        { key: "endpoint", type: "url" },
        { key: "accessKey", type: "text" },
        { key: "secretKey", type: "password" },
        { key: "publicUrl", type: "url" },
        { key: "useSSL", type: "checkbox" },
      ],
    },
  ];

  it("gives every field of the provider a value, without touching the ones set", () => {
    const filled = withFieldDefaults(
      { provider: "minio", endpoint: "http://minio:9000" } as Record<string, unknown> & {
        provider: string;
      },
      providers
    );
    expect(filled).toEqual({
      provider: "minio",
      endpoint: "http://minio:9000",
      accessKey: "",
      secretKey: "",
      publicUrl: "",
      useSSL: false,
    });
  });

  it("an unknown provider is left as it is", () => {
    const storage = { provider: "ftp" };
    expect(withFieldDefaults(storage, providers)).toBe(storage);
  });

  it("drops the empty strings again before saving, so publicUrl does not fail validation", () => {
    expect(
      withoutEmptyFields({ provider: "minio", publicUrl: "", secretKey: "", useSSL: false })
    ).toEqual({ provider: "minio", useSSL: false });
  });

  it("the Media view uses both", () => {
    const view = source("packages/admin/src/views/Media.svelte");
    expect(view).toContain("withFieldDefaults(");
    expect(view).toContain("withoutEmptyFields(config.storage)");
  });
});

describe("Accounting › Reimbursable expenses", () => {
  it("lists projects at /conta/projects, not the removed /conta/matters", () => {
    const api = source("packages/admin/src/lib/api.ts");
    expect(api).not.toContain("/conta/matters");
    expect(api).toContain('"/conta/projects"');
  });

  it("the form sends projectId, which the disbursement API takes", () => {
    const form = source("packages/admin/src/views/conta/DisbursementForm.svelte");
    expect(form).toContain("getContaProjects()");
    expect(form).not.toMatch(/\bmatterId\b/);
  });
});

describe("Kon views on a separate API origin (pnpm dev)", () => {
  it("with the API's origin, the bundle URL points at the API", () => {
    const { url } = resolveCustomView(
      { konId: "kon-wiki", element: "wiki-creator", src: "./admin/wiki-creator.js" },
      "http://localhost:3001"
    );
    expect(url).toBe("http://localhost:3001/api/kons/kon-wiki/admin-asset/admin/wiki-creator.js");
  });

  it("the host passes the API's origin to the loader and to the view's context", () => {
    const host = source("packages/admin/src/lib/components/admin/CustomViewHost.svelte");
    expect(host).toContain("import.meta.env.VITE_API_URL");
    expect(host).toContain("customViewLoader().load(actual, API_ORIGIN)");
    expect(host).toContain("apiBase = `${API_ORIGIN}/api`");
  });
});

describe("Application role privileges (startup script and migrations)", () => {
  const start = source("docker/start-with-check.sh");

  it("an APP_DB_USER not named kitsuden_app inherits what migrations grant to kitsuden_app", () => {
    // 24 migrations grant their SECURITY DEFINER functions to the literal role.
    expect(start).toMatch(/CREATE ROLE kitsuden_app NOLOGIN/);
    expect(start).toMatch(/GRANT kitsuden_app TO "\$\{APP_USER\}"/);
    // …and the role exists BEFORE migrating, or those GRANTs are skipped.
    expect(start.indexOf("GRANT kitsuden_app TO")).toBeLessThan(
      start.indexOf('DATABASE_URL="$DB_ADMIN_URL" bun run scripts/migrate.ts')
    );
  });

  it("the blanket GRANT does not reopen the audit chain (0088)", () => {
    const afterGrant = start.slice(
      start.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES")
    );
    expect(afterGrant).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON agent_audit_logs/);
    expect(afterGrant).toMatch(/REVOKE ALL ON agent_audit_checkpoints/);
    expect(afterGrant).toMatch(/GRANT SELECT ON agent_audit_checkpoints/);
  });

  it("trace partitions keep only their owner: at start and when rotation creates one", () => {
    const afterGrant = start.slice(
      start.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES")
    );
    expect(afterGrant).toContain("kitsuden_traces_private_partition(t)");
    const migration = source("apps/api/src/db/migrations/0090_trace_partitions_private.sql");
    const rotate = migration.slice(migration.indexOf("FUNCTION kitsuden_traces_rotate"));
    expect(rotate).toContain("PERFORM kitsuden_traces_private_partition(v_name)");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION kitsuden_traces_private_partition\(text\) FROM PUBLIC/
    );
  });
});

describe("MCP over stdio: kitsuden_toggle_module", () => {
  it("uses the route the API serves (PATCH /modules/:key), not the missing /toggle", () => {
    const standalone = source("packages/mcp-server/src/standalone.ts");
    const handler = standalone.slice(standalone.indexOf('case "kitsuden_toggle_module"'));
    const body = handler.slice(0, handler.indexOf("case ", 10));
    expect(body).not.toContain("/toggle`");
    expect(body).toMatch(/apiRequest\(`\/modules\/\$\{encodeURIComponent\(key\)\}`, "PATCH"/);
  });
});

describe("A kon enabled from the panel is known like one loaded at startup", () => {
  const deferred = source("apps/api/src/lib/deferred-kons.ts");

  it("registers its router (pathKon: agent denials on legacy routes, traces, API docs)", () => {
    // Both branches: a KonDefinition and a legacy bare Hono.
    expect((deferred.match(/registerKonRouter\(\s*kon\.id,/g) ?? []).length).toBe(2);
  });

  it("the API docs include the kons activated after startup", () => {
    expect(deferred).toContain("definitions.set(kon.id, exported)");
    const docs = source("apps/api/src/routes/docs-dynamic.ts");
    expect(docs).toContain("hotLoadedKonDefinitions()");
  });
});
