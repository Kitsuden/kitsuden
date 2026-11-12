/**
 * Kons SDK coverage: every mounted route has a contract for agents
 * ============================================================================
 *
 * Every mounted route (the inventory is the `MATRIX` table of the authorization
 * matrix, which already forces every mounted route to be classified) has to be in ONE
 * of these places:
 *
 *   1. An OPERATION of the kons SDK (`defineOperation`): then it has its OpenAPI 3.1
 *      operation with real schemas —the document is VALIDATED here with a real
 *      validator— and it is an MCP tool or is excluded with a written reason.
 *   2. An operation of a kon that is not installed here: kons live in another
 *      repository, and the committed snapshot of the SDK's OpenAPI keeps their contract.
 *   3. The legacy list (`apps/api/src/lib/legacy-routes.ts`): routes from before the
 *      SDK. That list can ONLY SHRINK: a new undeclared route fails here, one already
 *      moved to the SDK does too (it has to be removed), and the cap
 *      `LEGACY_ROUTES_CAP` does not go up without deciding it.
 *
 * It only needs the core: it runs in a clean clone, with no kons installed. The report
 * MEASURED on the mounted app (what really comes out in /api/docs/openapi.json) comes
 * from `apps/api/scripts/operations-coverage.ts`.
 *
 * Regenerate the legacy list (only to REMOVE what has been migrated):
 *
 *   UPDATE_LEGACY_ROUTES=1 pnpm vitest run --config=tests/unit/vitest.config.ts tests/unit/operation-coverage.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  grantsByScopes,
  isRedirect,
  exclusionMcp,
  scopesThatGrant,
  type KonDefinition,
} from "@kitsuden/shared";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";

import { LEGACY_ROUTES, LEGACY_ROUTES_CAP } from "../../apps/api/src/lib/legacy-routes";
import { OAUTH_PROTOCOL_ROUTES } from "../../apps/api/src/lib/oauth/config";
import {
  commonComponents,
  mcpTool,
  openApiOperation,
  requestFromArguments,
} from "../../apps/api/src/lib/operations-openapi";
import { MATRIX } from "../../apps/api/src/middleware/authorization-matrix";
import { notificationsKon } from "../../apps/api/src/routes/agent-notifications";
import { agentsKon } from "../../apps/api/src/routes/agent-permissions";
import { approvalsKon, proposalsKon } from "../../apps/api/src/routes/approvals";
import { memoryKon } from "../../apps/api/src/routes/brain-memory";
import { modelsKon } from "../../apps/api/src/routes/models";
import { oauthKon } from "../../apps/api/src/routes/oauth-panel";
import { adminPromotionKon, promotionKon } from "../../apps/api/src/routes/promotion";
import { queueKon } from "../../apps/api/src/routes/queue";
import { recordHistoryKon } from "../../apps/api/src/routes/record-history";
import { tracesKon } from "../../apps/api/src/routes/traces";
import { kon as blocksKon } from "../../packages/core/blocks/index";
import { kon as datasetsKon } from "../../packages/core/datasets/index";
import { kon as mediaKon } from "../../packages/core/media/index";
import { operationsOf, type AnyOperation } from "../../packages/engine/src/operations";

const ROOT = resolve(__dirname, "../..");
const UPDATE = process.env.UPDATE_LEGACY_ROUTES === "1";

/** What the core declares with the SDK. Installed kons have their own tests. */
const SDK_KONS: KonDefinition[] = [
  blocksKon,
  mediaKon,
  datasetsKon,
  agentsKon as unknown as KonDefinition,
  // The approval inbox (humans only) and the state of the proposals for the agent.
  approvalsKon as unknown as KonDefinition,
  proposalsKon as unknown as KonDefinition,
  memoryKon as unknown as KonDefinition,
  promotionKon as unknown as KonDefinition,
  adminPromotionKon as unknown as KonDefinition,
  modelsKon as unknown as KonDefinition,
  // Consent and connections of the panel. The PROTOCOL endpoints go apart (see below).
  oauthKon as unknown as KonDefinition,
  queueKon as unknown as KonDefinition,
  tracesKon as unknown as KonDefinition,
  notificationsKon as unknown as KonDefinition,
  // Who changed a row of any table (core migration 0076).
  recordHistoryKon as unknown as KonDefinition,
];

interface MountedOp {
  konId: string;
  mountPath: string;
  op: AnyOperation;
  key: string;
}

const mounted: MountedOp[] = SDK_KONS.flatMap((kon) => {
  const mountPath = (kon.mountPath ?? `/api/${kon.id.replace(/^kon-/, "")}`).replace(/\/+$/, "");
  return operationsOf(kon).map((op) => ({
    konId: kon.id,
    mountPath,
    op,
    key: `${op.method} ${op.route === "/" ? mountPath : `${mountPath}${op.route}`}`,
  }));
});
const sdkKeys = new Set(mounted.map((m) => m.key));

/** The real routes: what the matrix forces to be classified (without the `ALL`s of `app.use`). */
const inventory = Object.keys(MATRIX).filter((k) => !k.startsWith("ALL "));

/** The routes whose contract is in the committed snapshot, kons not installed here included. */
function snapshotKeys(): Set<string> {
  const doc = JSON.parse(
    readFileSync(join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json"), "utf8")
  ) as { servers?: { url: string }[]; paths: Record<string, Record<string, unknown>> };
  const base = new URL(doc.servers?.[0]?.url ?? "http://localhost/").pathname.replace(/\/+$/, "");
  const keys = new Set<string>();
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const method of Object.keys(operations)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const route = `${base}${path}`.replace(/\{([^}]+)\}/g, ":$1");
      keys.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return keys;
}

describe("SDK operations", () => {
  it("the core declares operations", () => {
    expect(mounted.length).toBeGreaterThan(20);
  });

  it("each operation is mounted and classified in the authorization matrix", () => {
    const outside = mounted.filter((m) => !MATRIX[m.key]).map((m) => m.key);
    expect(outside, "operation declared that the matrix does not know (wrong path?)").toEqual([]);
  });

  it("the OpenAPI 3.1 generated from the operations is VALID (real validator)", async () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "Kitsuden kon SDK operations", version: "test" },
      servers: [{ url: "http://localhost:3000/api" }],
      paths: {} as Record<string, Record<string, unknown>>,
      components: commonComponents(),
    };
    for (const m of mounted) {
      const g = openApiOperation(m.konId, m.mountPath, m.op);
      (doc.paths[g.path] ??= {})[g.method] = g.operation;
    }
    const r = await new Validator().validate(doc);
    expect(r.errors ?? [], JSON.stringify(r.errors, null, 1)?.slice(0, 3000)).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("each OpenAPI operation has real schemas: input, output and errors", () => {
    const missing: string[] = [];
    for (const m of mounted) {
      const { operation: operation } = openApiOperation(m.konId, m.mountPath, m.op);
      const responses = operation.responses as Record<
        string,
        { content?: Record<string, { schema?: unknown }> }
      >;
      const success = responses[String(m.op.output.status ?? 200)];
      if (!success) missing.push(`${m.key}: no success response`);
      else if (
        m.op.output.status !== 204 &&
        !isRedirect(m.op.output.status) &&
        !Object.values(success.content ?? {})[0]?.schema
      )
        missing.push(`${m.key}: response without a schema`);
      if (m.op.input?.body && !operation.requestBody)
        missing.push(`${m.key}: body without requestBody`);
      if (!Object.keys(responses).some((s) => Number(s) >= 400))
        missing.push(`${m.key}: no errors`);
      const ext = operation["x-kitsuden-operation"] as { scope?: string; sensitive?: unknown };
      if (!ext?.scope || typeof ext.sensitive !== "boolean")
        missing.push(`${m.key}: no scope/sensitive`);
    }
    expect(missing).toEqual([]);
  });

  it("each operation is an MCP tool or is excluded with a reason", () => {
    const names = new Set<string>();
    for (const m of mounted) {
      const reason = exclusionMcp(m.op);
      const tool = mcpTool(m.konId, m.mountPath, m.op);
      if (reason !== null) {
        expect(reason.trim().length, `${m.key}: empty reason`).toBeGreaterThan(10);
        expect(tool).toBeNull();
        continue;
      }
      expect(tool, m.key).not.toBeNull();
      expect(tool!.inputSchema.type).toBe("object");
      expect(tool!.name).toMatch(/^[a-z0-9_-]{1,64}$/);
      expect(names.has(tool!.name), `repeated name: ${tool!.name}`).toBe(false);
      names.add(tool!.name);
    }
  });

  it("the tool's arguments build the REST request of its operation", () => {
    const edit = mounted.find((m) => m.key === "PATCH /api/page-builder/blocks/:id")!;
    const p = requestFromArguments(edit.mountPath, edit.op, {
      id: "0c6e1c2e-0000-4000-8000-000000000003",
      body: { content: { headline: "x" } },
      idempotency_key: "test-key-1",
    });
    expect(p.url).toBe(
      "http://kitsuden.internal/api/page-builder/blocks/0c6e1c2e-0000-4000-8000-000000000003"
    );
    expect(p.init.method).toBe("PATCH");
    expect(JSON.parse(String(p.init.body))).toEqual({ content: { headline: "x" } });
    expect(p.init.headers["idempotency-key"]).toBe("test-key-1");
  });

  it("scopes: fine, broad per kon and declared ones grant; a foreign one does not", () => {
    const create = mounted.find((m) => m.key === "POST /api/page-builder/pages")!;
    const [fine] = scopesThatGrant(create.konId, create.op);
    expect(fine).toMatch(/^kon:blocks:/);
    expect(grantsByScopes([fine!], create.konId, create.op).granted).toBe(true);
    expect(grantsByScopes(["kon:blocks:*"], create.konId, create.op).granted).toBe(true);
    expect(grantsByScopes(["blocks:*"], create.konId, create.op).granted).toBe(true);
    expect(grantsByScopes(["admin"], create.konId, create.op).granted).toBe(true);
    expect(grantsByScopes(["kon:blog:create-entry"], create.konId, create.op).granted).toBe(false);
    expect(grantsByScopes([], create.konId, create.op).granted).toBe(false);
  });
});

describe("inventory: every mounted route is an SDK operation or listed legacy", () => {
  // The routes of the OAuth protocol (forms, 302, RFC 6749 errors): their contract is
  // the MCP specification, not the SDK. Closed list in apps/api/src/lib/oauth/config.ts.
  const snapshot = snapshotKeys();
  const withoutContract = inventory.filter(
    (k) => !sdkKeys.has(k) && !snapshot.has(k) && !OAUTH_PROTOCOL_ROUTES.includes(k)
  );

  it.runIf(UPDATE)("regenerates the legacy list", () => {
    const file = join(ROOT, "apps/api/src/lib/legacy-routes.ts");
    const current = readFileSync(file, "utf8");
    const header = current.slice(0, current.indexOf("export const LEGACY_ROUTES"));
    const list = [...withoutContract].sort();
    writeFileSync(
      file,
      `${header}export const LEGACY_ROUTES: readonly string[] = ${JSON.stringify(list, null, 2)};\n\n` +
        `/** It can only go DOWN. Raising it is deciding that a new route is born without a contract. */\n` +
        `export const LEGACY_ROUTES_CAP = ${list.length};\n`
    );
  });

  it.skipIf(UPDATE)("no mounted route is left without a contract and unlisted", () => {
    const legacy = new Set(LEGACY_ROUTES);
    const newOnes = withoutContract.filter((k) => !legacy.has(k));
    expect(
      newOnes,
      "Mounted routes that are neither an SDK operation nor on the legacy list. " +
        "Declare them with defineOperation (docs/kons/README.md)."
    ).toEqual([]);
  });

  it.skipIf(UPDATE)("the legacy list only shrinks", () => {
    const stale = LEGACY_ROUTES.filter((k) => sdkKeys.has(k) || !inventory.includes(k));
    expect(stale, "already migrated or unmounted: remove them from legacy-routes.ts").toEqual([]);
    expect(LEGACY_ROUTES.length).toBeLessThanOrEqual(LEGACY_ROUTES_CAP);
  });
});
