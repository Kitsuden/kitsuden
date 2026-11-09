/**
 * Promotion of code written by agents (suggestion / turbo)
 * ============================================================================
 *
 * Against the REAL app (test Postgres with the app role, real QuickJS
 * sandbox), real agents and real human accounts:
 *
 *   · suggestion → proposal in the inbox → a human approves → it activates (and the
 *     snapshot of what was running before is kept to roll back);
 *   · turbo with everything green → activates by itself;
 *   · each turbo fallback → proposal with its reason: new scopes, new
 *     host, secrets / users and roles / security configuration,
 *     sensitive operation, failed or errored test, failed scan, new
 *     action, global cap off;
 *   · an agent (not even with `admin`) does not approve or activate its own; an editor does not
 *     approve;
 *   · resubmitting the same draft duplicates nothing;
 *   · with ENABLE_CODE_ACTIONS off the tests run and the activation says so;
 *   · the watchdog rolls back by itself on errors; an admin rolls back by hand;
 *   · a base that changed underneath is not activated (stale_base);
 *   · RLS: an agent does not see another's drafts (not even with the policy alone).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import {
  actions,
  agentAuditLogs,
  agentIdentities,
  agentProposals,
  approvalSettings,
  codeVersions,
} from "../db/schema";
import { app } from "../index";
import { _forgetNegatives } from "../lib/promotion";
import { createAgent } from "../services/agent-auth";

import { ensureAppRole, enterAs, generateTestId, testIp, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let admin = { cookie: "", userId: "" };
let editor = { cookie: "", userId: "" };
const agents: string[] = [];
const createdActions: string[] = [];

interface Ag {
  id: string;
  token: string;
}

interface VersionView {
  id: string;
  status: string;
  mode: string;
  versionNumber: number;
  contentHash: string;
  activatedBy: string | null;
  activationError: string | null;
  rollbackReason: string | null;
  previousVersionId: string | null;
  target: { actionId: string | null; slug: string };
  decision: { route: string; reasons: string[] };
  proposal: { id: string } | null;
  testReport: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    cases: { status: string; mismatches: string[] }[];
  };
  scanReport: { passed: boolean; findings: { rule: string; severity: string }[] };
  capabilityDiff: { scopesAdded: string[]; hostsAdded: string[]; newTarget: boolean };
  watch: { state?: string; executions?: number; errors?: number } | null;
}

async function newAgent(scopes: string[]): Promise<Ag> {
  const { agent, plainApiKey } = await createAgent({
    name: `promo-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  agents.push(agent.id);
  return { id: agent.id, token: plainApiKey };
}

async function request(
  auth: { cookie?: string; token?: string },
  method: string,
  path: string,
  body?: unknown,
  headersValue: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, ...headersValue };
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

const asAdmin = (method: string, path: string, body?: unknown) =>
  request({ cookie: admin.cookie }, method, path, body);

async function json<T>(r: Response, status: number | number[]): Promise<T> {
  const text = await r.text();
  const statuses = Array.isArray(status) ? status : [status];
  expect(statuses, text.slice(0, 1500)).toContain(r.status);
  return JSON.parse(text) as T;
}

const SUM = "return { total: (event.a ?? 0) + (event.b ?? 0) };";
const TEST_SUM = [{ name: "adds", event: { a: 2, b: 3 }, expect: { result: { total: 5 } } }];

/** A code action created by the admin (as it would exist before code promotion). */
async function action(
  code = "return { v: 1 };",
  config: Record<string, unknown> = {}
): Promise<{ id: string; slug: string }> {
  const slug = `promo-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const r = await asAdmin("POST", "/api/actions", {
    name: slug,
    slug,
    type: "code",
    trigger: "manual",
    config: { code, ...config },
  });
  const a = await json<{ id: string }>(r, 201);
  createdActions.push(a.id);
  return { id: a.id, slug };
}

async function codeOf(
  id: string
): Promise<{ code: string; status: string; config: Record<string, unknown> }> {
  const [a] = await db.select().from(actions).where(eq(actions.id, id)).limit(1);
  const config = (a!.config ?? {}) as Record<string, unknown>;
  return { code: String(config.code ?? ""), status: a!.status, config };
}

async function propose(
  ag: Ag,
  body: Record<string, unknown>,
  status: number | number[] = 201,
  headers: Record<string, string> = {}
) {
  const r = await request({ token: ag.token }, "POST", "/api/promotion/drafts", body, headers);
  return json<{ version: VersionView; duplicate: boolean }>(r, status);
}

async function configure(change: Record<string, unknown>) {
  await json(await asAdmin("PUT", "/api/approvals/promotion/settings", change), 200);
}

async function mode(agentId: string, m: "suggestion" | "turbo") {
  await json(
    await asAdmin("PUT", `/api/approvals/promotion/agents/${agentId}/mode`, { mode: m }),
    200
  );
}

interface McpSession {
  token: string;
  ip: string;
  sessionId: string;
  close: () => void;
}
const sessions: McpSession[] = [];

async function mcpSession(ag: Ag): Promise<McpSession> {
  // A test IP per session: the global limiter is per IP and, with the whole
  // suite, the other MCP tests have already used up the «unknown» minute.
  const ip = testIp();
  const res = await app.request(
    new Request("http://localhost:3000/api/mcp", {
      headers: { Authorization: `Bearer ${ag.token}`, "X-Forwarded-For": ip },
    })
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const s: McpSession = {
    token: ag.token,
    ip,
    sessionId: text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!,
    close: () => void reader.cancel().catch(() => {}),
  };
  sessions.push(s);
  return s;
}

let idRpc = 1;
async function rpc(
  s: McpSession,
  method: string,
  params: unknown
): Promise<Record<string, unknown>> {
  const res = await app.request(
    new Request(`http://localhost:3000/api/mcp?sessionId=${s.sessionId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": s.ip,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: idRpc++, method, params }),
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function readVersion(id: string) {
  const [v] = await db.select().from(codeVersions).where(eq(codeVersions.id, id)).limit(1);
  return v!;
}

async function actionsValue(resourceId: string): Promise<string[]> {
  const rows = await db
    .select({ action: agentAuditLogs.action })
    .from(agentAuditLogs)
    .where(eq(agentAuditLogs.resourceId, resourceId));
  return rows.map((f) => f.action);
}

describe("code promotion", () => {
  let suggester: Ag;
  let turbo: Ag;
  let other: Ag;
  let withAdmin: Ag;

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    await ensureAppRole();
    admin = await enterAs(app, {
      email: `promo-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Promo Admin",
      role: "admin",
    });
    editor = await enterAs(app, {
      email: `promo-editor-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Promo Editor",
      role: "editor",
    });
    suggester = await newAgent(["promotion:propose"]);
    turbo = await newAgent(["promotion:propose", "datasets:*:read"]);
    other = await newAgent(["promotion:propose"]);
    withAdmin = await newAgent(["admin"]);
    await db.delete(approvalSettings).where(eq(approvalSettings.id, "code_promotion"));
  }, 120_000);

  afterAll(async () => {
    for (const s of sessions) s.close();
    if (!dbAvailable) return;
    delete process.env.ENABLE_CODE_ACTIONS;
    await db.delete(approvalSettings).where(eq(approvalSettings.id, "code_promotion"));
    if (agents.length) {
      await db.delete(codeVersions).where(inArray(codeVersions.agentId, agents));
      await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
    }
    if (createdActions.length) {
      await db.delete(codeVersions).where(inArray(codeVersions.targetId, createdActions));
      await db.delete(actions).where(inArray(actions.id, createdActions));
    }
  });

  it("suggestion: proposal → a human approves in the inbox → it activates (and the previous snapshot is kept)", async () => {
    if (!dbAvailable) return;
    const a = await action("return { v: 1 };");
    const { version: v, duplicate } = await propose(suggester, {
      target: { actionId: a.id },
      code: SUM,
      tests: TEST_SUM,
      description: "sum a and b",
    });
    expect(duplicate).toBe(false);
    expect(v.status).toBe("awaiting_approval");
    expect(v.mode).toBe("suggestion");
    expect(v.decision.route).toBe("proposal");
    expect(v.decision.reasons).toContain("suggestion_mode");
    expect(v.testReport.passed).toBe(1);
    expect(v.scanReport.passed).toBe(true);
    expect(v.proposal?.id).toBeTruthy();
    // Nothing has changed in the action yet.
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");

    const [p] = await db.select().from(agentProposals).where(eq(agentProposals.id, v.proposal!.id));
    expect(p!.status).toBe("pending");
    expect(p!.agentId).toBe(suggester.id);
    expect(p!.path).toBe(`/api/promotion/versions/${v.id}/activate`);
    expect(p!.operationKey).toBe("kon:promotion:activate-version");

    // The agent follows its status through both routes.
    const read = await json<{ version: VersionView; proposal: { status: string } }>(
      await request({ token: suggester.token }, "GET", `/api/promotion/drafts/${v.id}`),
      200
    );
    expect(read.proposal.status).toBe("pending");

    // Approve in the usual inbox: it runs as the agent and activates.
    const ap = await json<{ proposal: { status: string } }>(
      await asAdmin("POST", `/api/approvals/proposals/${v.proposal!.id}/approve`, {
        comment: "ok",
      }),
      200
    );
    expect(ap.proposal.status).toBe("executed");
    const active = await readVersion(v.id);
    expect(active.status).toBe("active");
    expect(active.activatedBy).toBe(admin.userId);
    expect(active.watchUntil).toBeTruthy();
    const now = await codeOf(a.id);
    expect(now.code).toBe(SUM);
    expect((now.config.promotion as { versionId: string }).versionId).toBe(v.id);
    // What was running before: the `manual` version left by the admin's creation.
    const photo = await readVersion(active.previousVersionId!);
    expect(photo.origin).toBe("manual");
    expect(photo.status).toBe("superseded");
    expect(photo.code).toBe("return { v: 1 };");

    const audited = await actionsValue(v.id);
    expect(audited).toContain("promotion_submitted");
    expect(audited).toContain("promotion_activated");
    const [act] = await db
      .select()
      .from(agentAuditLogs)
      .where(
        sql`${agentAuditLogs.resourceId} = ${v.id} and ${agentAuditLogs.action} = 'promotion_activated'`
      );
    const d = act!.details as Record<string, unknown>;
    expect(d.by).toBe(admin.userId);
    expect(d.via).toBe("approval");
    expect(d.contentHash).toBe(v.contentHash);
    expect(d.previousHash).toBe(photo.contentHash);

    // And an admin rolls back by hand: the snapshot becomes the active one again.
    const round = await json<{ version: VersionView }>(
      await asAdmin("POST", `/api/approvals/promotion/versions/${v.id}/rollback`, {
        reason: "manual check",
      }),
      200
    );
    expect(round.version.status).toBe("rolled_back");
    expect(round.version.rollbackReason).toBe("manual check");
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
    expect((await readVersion(photo.id)).status).toBe("active");
    expect(await actionsValue(v.id)).toContain("promotion_rolled_back");
    // Not twice: only the active one rolls back.
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${v.id}/rollback`, {
        reason: "again",
      }),
      409
    );
  }, 120_000);

  it("an agent (not even with admin) does not approve or activate its own; an editor does not approve either", async () => {
    if (!dbAvailable) return;
    const a = await action();
    const { version: v } = await propose(suggester, {
      target: { actionId: a.id },
      code: SUM,
      tests: TEST_SUM,
    });
    const pid = v.proposal!.id;
    for (const ag of [suggester, withAdmin]) {
      expect(
        (await request({ token: ag.token }, "POST", `/api/approvals/proposals/${pid}/approve`, {}))
          .status
      ).toBe(403);
      expect(
        (
          await request(
            { token: ag.token },
            "POST",
            `/api/approvals/promotion/versions/${v.id}/approve`,
            {}
          )
        ).status
      ).toBe(403);
      expect(
        (await request({ token: ag.token }, "POST", `/api/promotion/versions/${v.id}/activate`, {}))
          .status
      ).toBe(403);
      expect(
        (
          await request(
            { token: ag.token },
            "PUT",
            `/api/approvals/promotion/agents/${ag.id}/mode`,
            { mode: "turbo" }
          )
        ).status
      ).toBe(403);
      expect(
        (
          await request({ token: ag.token }, "PUT", "/api/approvals/promotion/settings", {
            turboAllowed: true,
          })
        ).status
      ).toBe(403);
    }
    // An editor gets into the inbox but cannot approve this (admin route).
    const ed = await request(
      { cookie: editor.cookie },
      "POST",
      `/api/approvals/proposals/${pid}/approve`,
      {}
    );
    expect(ed.status).toBe(403);
    expect(
      (
        await request(
          { cookie: editor.cookie },
          "POST",
          `/api/approvals/promotion/versions/${v.id}/approve`,
          {}
        )
      ).status
    ).toBe(403);
    expect((await readVersion(v.id)).status).toBe("awaiting_approval");
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
    // Reject (admin, through the promotion route): it never activates.
    const rec = await json<{ version: VersionView }>(
      await asAdmin("POST", `/api/approvals/promotion/versions/${v.id}/reject`, { comment: "no" }),
      200
    );
    expect(rec.version.status).toBe("rejected");
    expect(await actionsValue(v.id)).toContain("promotion_rejected");
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
  }, 120_000);

  it("resubmitting the same draft does not create another (with or without Idempotency-Key)", async () => {
    if (!dbAvailable) return;
    const a = await action();
    const body = { target: { actionId: a.id }, code: SUM, tests: TEST_SUM };
    const first = await propose(suggester, body);
    const secondItem = await propose(suggester, body, 200);
    expect(secondItem.duplicate).toBe(true);
    expect(secondItem.version.id).toBe(first.version.id);
    const key = `promo-${generateTestId()}`;
    const third = await propose(suggester, body, 200, { "Idempotency-Key": key });
    expect(third.version.id).toBe(first.version.id);
    const fourth = await request(
      { token: suggester.token },
      "POST",
      "/api/promotion/drafts",
      body,
      { "Idempotency-Key": key }
    );
    expect(fourth.status).toBe(200);
    const rows = await db.select().from(codeVersions).where(eq(codeVersions.targetSlug, a.slug));
    expect(rows.filter((f) => f.origin === "agent")).toHaveLength(1);
    const proposals = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.path, `/api/promotion/versions/${first.version.id}/activate`));
    expect(proposals).toHaveLength(1);
    // Different content is indeed another version.
    const otherVersion = await propose(suggester, {
      ...body,
      description: "x",
      code: `${SUM}\n// v2`,
    });
    expect(otherVersion.version.id).not.toBe(first.version.id);
    expect(otherVersion.version.versionNumber).toBe(first.version.versionNumber + 1);
  }, 120_000);

  it("turbo with everything green: it activates by itself", async () => {
    if (!dbAvailable) return;
    await configure({ turboAllowed: true });
    await mode(turbo.id, "turbo");
    const a = await action();
    const { version: v } = await propose(turbo, {
      target: { actionId: a.id },
      code: SUM,
      tests: TEST_SUM,
    });
    expect(v.decision.route).toBe("turbo");
    expect(v.decision.reasons).toEqual([]);
    expect(v.status).toBe("active");
    expect(v.activatedBy).toBe("turbo");
    expect(v.proposal).toBeNull();
    expect((await codeOf(a.id)).code).toBe(SUM);
  }, 120_000);

  it("turbo: each fallback is a proposal with its reason", async () => {
    if (!dbAvailable) return;
    await configure({ turboAllowed: true });
    await mode(turbo.id, "turbo");
    const cases: {
      reason: string;
      body: (actionId: string) => Record<string, unknown>;
      next?: boolean;
    }[] = [
      {
        reason: "scope_escalation",
        body: (id) => ({
          target: { actionId: id },
          code: SUM,
          tests: TEST_SUM,
          scopes: ["datasets:*:read"],
        }),
      },
      {
        reason: "new_outbound_hosts",
        body: (id) => ({
          target: { actionId: id },
          code: SUM,
          tests: TEST_SUM,
          fetchAllow: ["api.example.com"],
        }),
      },
      {
        reason: "touches_users_or_roles",
        body: (id) => ({
          target: { actionId: id },
          code: "const r = await kitsuden.api.get('/api/v1/agents'); return { s: r.status };",
          tests: [
            {
              name: "lists",
              api: { "GET /api/v1/agents": { status: 200, body: [] } },
              expect: { result: { s: 200 } },
            },
          ],
        }),
      },
      {
        reason: "touches_secrets",
        body: (id) => ({
          target: { actionId: id },
          code: "return { len: String(env.API_TOKEN || '').length };",
          tests: [{ name: "reads", env: { API_TOKEN: "abc" }, expect: { result: { len: 3 } } }],
        }),
      },
      {
        reason: "touches_security_config",
        body: (id) => ({
          target: { actionId: id },
          code: "const r = await kitsuden.api.patch('/api/settings', { x: 1 }); return { s: r.status };",
          tests: [
            {
              name: "patches",
              api: { "PATCH /api/settings": { status: 200, body: {} } },
              expect: { result: { s: 200 } },
            },
          ],
        }),
      },
      {
        reason: "sensitive_operation",
        body: (id) => ({
          target: { actionId: id },
          code: "const r = await kitsuden.api.delete('/api/data-sets/00000000-0000-0000-0000-000000000000'); return { s: r.status };",
          tests: [
            {
              name: "deletes",
              api: {
                "DELETE /api/data-sets/00000000-0000-0000-0000-000000000000": {
                  status: 204,
                  body: null,
                },
              },
              expect: { result: { s: 204 } },
            },
          ],
        }),
      },
      {
        reason: "unclassifiable_api_call",
        body: (id) => ({
          target: { actionId: id },
          code: "const p = '/api/' + event.what; const r = await kitsuden.api.get(p); return { s: r.status };",
          tests: [
            {
              name: "dyn",
              event: { what: "x" },
              api: { "GET /api/x": { status: 200, body: {} } },
              expect: { result: { s: 200 } },
            },
          ],
        }),
      },
      {
        reason: "tests_failed",
        body: (id) => ({
          target: { actionId: id },
          code: SUM,
          tests: [{ name: "wrong", event: { a: 1, b: 1 }, expect: { result: { total: 3 } } }],
        }),
      },
      {
        reason: "tests_errored",
        body: (id) => ({
          target: { actionId: id },
          code: "while (true) {}",
          timeoutMs: 300,
          tests: [{ name: "loops", timeoutMs: 300, expect: { success: true } }],
        }),
      },
      {
        reason: "no_tests",
        body: (id) => ({ target: { actionId: id }, code: SUM }),
      },
      {
        reason: "scan_failed",
        body: (id) => ({
          target: { actionId: id },
          code: "return eval('1+1');",
          tests: [{ name: "x", expect: { success: false } }],
        }),
      },
      {
        reason: "limits_increased",
        body: (id) => ({ target: { actionId: id }, code: SUM, tests: TEST_SUM, timeoutMs: 20_000 }),
      },
      {
        reason: "new_target",
        next: true,
        body: () => ({
          target: {
            slug: `promo-new-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
            name: "New one",
          },
          code: SUM,
          tests: TEST_SUM,
        }),
      },
    ];
    for (const scenario of cases) {
      const a = scenario.next ? null : await action();
      const { version: v } = await propose(turbo, scenario.body(a?.id ?? ""));
      expect(v.decision.route, scenario.reason).toBe("proposal");
      expect(v.decision.reasons, scenario.reason).toContain(scenario.reason);
      expect(v.decision.reasons, scenario.reason).not.toContain("suggestion_mode");
      expect(v.status, scenario.reason).toBe("awaiting_approval");
      expect(v.proposal?.id, scenario.reason).toBeTruthy();
      if (a) expect((await codeOf(a.id)).code, scenario.reason).toBe("return { v: 1 };");
    }

    // The global cap off: not either.
    await configure({ turboAllowed: false });
    const a = await action();
    const { version: v } = await propose(turbo, {
      target: { actionId: a.id },
      code: SUM,
      tests: TEST_SUM,
    });
    expect(v.status).toBe("awaiting_approval");
    expect(v.decision.reasons).toEqual(["turbo_disabled_globally"]);
  }, 300_000);

  it("ENABLE_CODE_ACTIONS off: the tests run and the activation says why not", async () => {
    if (!dbAvailable) return;
    await configure({ turboAllowed: true });
    await mode(turbo.id, "turbo");
    const a = await action();
    process.env.ENABLE_CODE_ACTIONS = "false";
    try {
      const { version: v } = await propose(turbo, {
        target: { actionId: a.id },
        code: SUM,
        tests: TEST_SUM,
      });
      expect(v.testReport.passed).toBe(1);
      expect(v.decision.route).toBe("turbo");
      expect(v.status).toBe("approved");
      expect(v.activationError).toBe("code_actions_disabled");
      expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
      expect(await actionsValue(v.id)).toContain("promotion_activation_blocked");
      // Activating by hand still cannot while it is off.
      const r = await asAdmin("POST", `/api/approvals/promotion/versions/${v.id}/activate`);
      expect(r.status).toBe(409);
      expect(await r.text()).toContain("code_actions_disabled");

      // suggestion too: approved, not activated.
      const b = await action();
      const { version: s } = await propose(suggester, {
        target: { actionId: b.id },
        code: SUM,
        tests: TEST_SUM,
      });
      const ap = await json<{ proposal: { status: string } }>(
        await asAdmin("POST", `/api/approvals/proposals/${s.proposal!.id}/approve`, {}),
        200
      );
      expect(ap.proposal.status).toBe("failed");
      const sv = await readVersion(s.id);
      expect(sv.status).toBe("approved");
      expect(sv.activationError).toBe("code_actions_disabled");

      // On: the admin activates it.
      process.env.ENABLE_CODE_ACTIONS = "true";
      const act = await json<{ version: VersionView }>(
        await asAdmin("POST", `/api/approvals/promotion/versions/${v.id}/activate`),
        200
      );
      expect(act.version.status).toBe("active");
      expect((await codeOf(a.id)).code).toBe(SUM);
    } finally {
      delete process.env.ENABLE_CODE_ACTIONS;
    }
  }, 180_000);

  it("a base that changed underneath is not activated (stale_base)", async () => {
    if (!dbAvailable) return;
    const a = await action();
    const one = await propose(suggester, {
      target: { actionId: a.id },
      code: SUM,
      tests: TEST_SUM,
    });
    const two = await propose(suggester, {
      target: { actionId: a.id },
      code: `${SUM} // b`,
      tests: TEST_SUM,
    });
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${one.version.id}/approve`, {}),
      200
    );
    expect((await readVersion(one.version.id)).status).toBe("active");
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${two.version.id}/approve`, {}),
      200
    );
    const v2 = await readVersion(two.version.id);
    expect(v2.status).toBe("failed");
    expect(v2.activationError).toBe("stale_base");
    expect((await codeOf(a.id)).code).toBe(SUM);

    // An admin edits the action by hand: the next activation saves the snapshot
    // of what was REALLY running, and rolling back leaves that edit.
    const byHand = "return { total: 'edited by hand' };";
    await json(
      await asAdmin("PATCH", `/api/actions/${a.id}`, {
        config: { ...(await codeOf(a.id)).config, code: byHand },
      }),
      200
    );
    const three = await propose(suggester, {
      target: { actionId: a.id },
      code: `${SUM} // c`,
      tests: TEST_SUM,
    });
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${three.version.id}/approve`, {}),
      200
    );
    const v3 = await readVersion(three.version.id);
    expect(v3.status).toBe("active");
    expect((await readVersion(one.version.id)).status).toBe("superseded");
    const photo = await readVersion(v3.previousVersionId!);
    expect(photo.origin).toBe("manual");
    expect(photo.code).toBe(byHand);
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${three.version.id}/rollback`, {
        reason: "back",
      }),
      200
    );
    expect((await codeOf(a.id)).code).toBe(byHand);
  }, 120_000);

  it("watchdog: with errors above the threshold it rolls back by itself to the previous version", async () => {
    if (!dbAvailable) return;
    await configure({ turboAllowed: true, minExecutions: 3, maxErrorRate: 0.5, watchMinutes: 30 });
    await mode(turbo.id, "turbo");
    const a = await action("return { ok: 'old' };");
    // It passes its test (with `event.event`), but a manual run does not carry it: it fails.
    const bad = "if (!event.event) throw new Error('boom'); return { ok: 'new' };";
    const { version: v } = await propose(turbo, {
      target: { actionId: a.id },
      code: bad,
      tests: [
        { name: "with event", event: { event: { x: 1 } }, expect: { result: { ok: "new" } } },
      ],
    });
    expect(v.status).toBe("active");
    _forgetNegatives();
    for (let i = 0; i < 3; i++) {
      const r = await json<{ success: boolean }>(
        await asAdmin("POST", `/api/actions/${a.id}/execute`, {}),
        200
      );
      if (i === 0) expect(r.success).toBe(false);
    }
    const after = await readVersion(v.id);
    expect(after.status).toBe("rolled_back");
    expect(after.rolledBackBy).toBe("auto");
    expect(after.rollbackReason).toContain("Automatic rollback");
    expect((await codeOf(a.id)).code).toBe("return { ok: 'old' };");
    const [log] = await db
      .select()
      .from(agentAuditLogs)
      .where(
        sql`${agentAuditLogs.resourceId} = ${v.id} and ${agentAuditLogs.action} = 'promotion_rolled_back'`
      );
    expect((log!.details as { automatic: boolean }).automatic).toBe(true);
    // And it works again with the earlier code.
    const ok = await json<{ success: boolean; result: unknown }>(
      await asAdmin("POST", `/api/actions/${a.id}/execute`, {}),
      200
    );
    expect(ok.success).toBe(true);
    expect(ok.result).toEqual({ ok: "old" });
  }, 180_000);

  it("MCP: promotion_propose / promotion_list / promotion_status with the scope; activating is never a tool", async () => {
    if (!dbAvailable) return;
    const withValue = await newAgent(["mcp:connect", "promotion:propose"]);
    const without = await newAgent(["mcp:connect"]);
    const names = async (ag: Ag) =>
      (
        (
          (await rpc(await mcpSession(ag), "tools/list", {})).result as {
            tools: { name: string }[];
          }
        ).tools ?? []
      ).map((t) => t.name);
    const ofWith = await names(withValue);
    for (const t of ["promotion_propose", "promotion_list", "promotion_status"])
      expect(ofWith).toContain(t);
    expect(ofWith.some((t) => t.includes("activate"))).toBe(false);
    const ofWithout = await names(without);
    expect(ofWithout.some((t) => t.startsWith("promotion_"))).toBe(false);

    const a = await action();
    const s = await mcpSession(withValue);
    const r = (
      await rpc(s, "tools/call", {
        name: "promotion_propose",
        arguments: { body: { target: { actionId: a.id }, code: SUM, tests: TEST_SUM } },
      })
    ).result as {
      isError?: boolean;
      structuredContent?: { status: number; data: { version: VersionView } };
    };
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent!.status).toBe(201);
    const v = r.structuredContent!.data.version;
    expect(v.status).toBe("awaiting_approval");
    expect((await readVersion(v.id)).channel).toBe("mcp");
    const status = (
      await rpc(s, "tools/call", { name: "promotion_status", arguments: { id: v.id } })
    ).result as {
      structuredContent?: { data?: { version?: { id: string } } };
    };
    expect(status.structuredContent?.data?.version?.id).toBe(v.id);
  }, 120_000);

  it("decision 2: an agent (not even with admin) does not change code outside promotion", async () => {
    if (!dbAvailable) return;
    const a = await action("return { v: 1 };", { envVars: { REGION: "eu" } });
    const prohibited = async (r: Response) => {
      const text = await r.text();
      expect(r.status, text).toBe(403);
      expect(text).toContain("KITSUDEN_E_FORBIDDEN");
      expect(text).toContain("promotion_propose");
    };
    const newSlug = () => `promo-byp-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    await prohibited(
      await request({ token: withAdmin.token }, "POST", "/api/actions", {
        name: "x",
        slug: newSlug(),
        type: "code",
        trigger: "manual",
        config: { code: "return 1;" },
      })
    );
    const { config } = await codeOf(a.id);
    await prohibited(
      await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, {
        config: { ...config, code: "return 2;" },
      })
    );
    await prohibited(
      await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, {
        config: { ...config, scopes: ["admin"] },
      })
    );
    await prohibited(
      await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, { config: {} })
    );
    await prohibited(
      await request({ token: withAdmin.token }, "POST", "/api/functions", {
        name: "f",
        code: "return 1;",
        trigger: "manual",
      })
    );
    // What is not code, the same as before.
    const name = await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, {
      name: "renamed by agent",
    });
    expect(name.status).toBe(200);
    const env = await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, {
      config: { ...config, envVars: { REGION: "us" } },
    });
    expect(env.status, await env.clone().text()).toBe(200);
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
    // The generic grids do not write those tables (neither the agent nor the admin).
    for (const auth of [{ token: withAdmin.token }, { cookie: admin.cookie }]) {
      const items = await request(auth, "PATCH", `/api/items/actions/${a.id}`, {
        config: { code: "return 3;" },
      });
      const text = await items.text();
      expect(items.status, text).toBe(403);
      expect(text).toContain("KITSUDEN_E_FORBIDDEN");
      expect((await request(auth, "POST", "/api/items/codeVersions", { code: "x" })).status).toBe(
        403
      );
    }
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
    // MCP: kitsuden_define_action with code.
    const mcp = await newAgent(["mcp:connect", "mcp:admin", "admin"]);
    const s = await mcpSession(mcp);
    const r = (
      await rpc(s, "tools/call", {
        name: "kitsuden_define_action",
        arguments: {
          name: "x",
          slug: newSlug(),
          type: "code",
          trigger: "manual",
          config: { code: "return 1;" },
        },
      })
    ).result as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("KITSUDEN_E_FORBIDDEN");
    expect(JSON.stringify(r)).toContain("promotion_propose");
  }, 120_000);

  it("an agent (not even with admin) does not change WHEN a code action runs: trigger, triggerConfig, status", async () => {
    if (!dbAvailable) return;
    const a = await action("return { v: 1 };");
    const changes: Record<string, unknown>[] = [
      { trigger: "cron", triggerConfig: { cronExpression: "* * * * *" } },
      { triggerConfig: { event: "entry:created" } },
      { status: "paused" },
    ];
    for (const change of changes) {
      const r = await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, change);
      const text = await r.text();
      expect(r.status, text).toBe(403);
      expect(text).toContain("code_action_schedule_human_only");
      expect(text).toContain("promotion_propose");
    }
    const [row] = await db.select().from(actions).where(eq(actions.id, a.id)).limit(1);
    expect(row!.trigger).toBe("manual");
    expect(row!.status).toBe("active");
    // Sending the current values is not a change; a human changes them freely.
    const same = await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, {
      trigger: "manual",
      status: "active",
      name: "renamed by agent",
    });
    expect(same.status, await same.clone().text()).toBe(200);
    const human = await asAdmin("PATCH", `/api/actions/${a.id}`, { status: "paused" });
    expect(human.status, await human.clone().text()).toBe(200);
    expect((await codeOf(a.id)).status).toBe("paused");
    // A human paused it: the agent cannot turn it back on.
    const back = await request({ token: withAdmin.token }, "PATCH", `/api/actions/${a.id}`, {
      status: "active",
    });
    expect(back.status).toBe(403);
    // The legacy functions follow the same rule.
    const fn = await request({ token: withAdmin.token }, "PATCH", "/api/functions/none", {
      trigger: "cron",
      cronExpression: "* * * * *",
    });
    const fnText = await fn.text();
    expect(fn.status, fnText).toBe(403);
    expect(fnText).toContain("code_action_schedule_human_only");
  }, 120_000);

  it("decision 2: a manual admin edit is kept as a manual version (and can be rolled back)", async () => {
    if (!dbAvailable) return;
    const a = await action("return { v: 1 };");
    const activeOf = async () => {
      const [v] = await db
        .select()
        .from(codeVersions)
        .where(sql`${codeVersions.targetId} = ${a.id} and ${codeVersions.status} = 'active'`);
      return v!;
    };
    const high = await activeOf();
    expect(high.origin).toBe("manual");
    const { config } = await codeOf(a.id);
    await json(
      await asAdmin("PATCH", `/api/actions/${a.id}`, {
        config: { ...config, code: "return { v: 2 };" },
      }),
      200
    );
    const edition = await activeOf();
    expect(edition.origin).toBe("manual");
    expect(edition.code).toBe("return { v: 2 };");
    expect(edition.activatedBy).toBe(admin.userId);
    expect(edition.previousVersionId).toBe(high.id);
    expect(edition.baseHash).toBeTruthy();
    expect((await readVersion(high.id)).status).toBe("superseded");
    const [log] = await db
      .select()
      .from(agentAuditLogs)
      .where(
        sql`${agentAuditLogs.resourceId} = ${edition.id} and ${agentAuditLogs.action} = 'promotion_manual_edit'`
      );
    const d = log!.details as { by: string; previousHash: string };
    expect(d.by).toBe(admin.userId);
    expect(d.previousHash).toBe(high.contentHash);
    // Renaming is not code: it creates no version.
    expect((await asAdmin("PATCH", `/api/actions/${a.id}`, { name: "renamed" })).status).toBe(200);
    const versions = await db.select().from(codeVersions).where(eq(codeVersions.targetId, a.id));
    expect(versions).toHaveLength(2);
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${edition.id}/rollback`, {
        reason: "undo",
      }),
      200
    );
    expect((await codeOf(a.id)).code).toBe("return { v: 1 };");
    expect((await readVersion(high.id)).status).toBe("active");
  }, 120_000);

  it("decision 3: turbo only counts what is NEW compared to the active version", async () => {
    if (!dbAvailable) return;
    await configure({ turboAllowed: true });
    await mode(turbo.id, "turbo");
    const id0 = "00000000-0000-0000-0000-000000000000";
    const deletes = `const r = await kitsuden.api.delete('/api/data-sets/${id0}'); const u = await kitsuden.api.get('/api/v1/agents');`;
    const simulated = {
      [`DELETE /api/data-sets/${id0}`]: { status: 204, body: null },
      "GET /api/v1/agents": { status: 200, body: [] },
      "GET /api/q": { status: 200, body: {} },
    };
    const test = [
      { name: "deletes", event: { w: "q" }, api: simulated, expect: { result: { s: 204 } } },
    ];
    // The active one already deleted (and read agents): the draft that keeps doing so passes on its own.
    const a = await action(`${deletes} return { s: r.status };`);
    const { version: v } = await propose(turbo, {
      target: { actionId: a.id },
      code: `${deletes} /* v2 */ return { s: r.status };`,
      tests: test,
    });
    expect(v.decision.reasons).toEqual([]);
    expect(v.status).toBe("active");
    // A NEW DELETE does stop it.
    const b = await action("return { s: 204 };");
    const { version: w } = await propose(turbo, {
      target: { actionId: b.id },
      code: `const r = await kitsuden.api.delete('/api/data-sets/${id0}'); return { s: r.status };`,
      tests: test,
    });
    expect(w.status).toBe("awaiting_approval");
    expect(w.decision.reasons).toContain("sensitive_operation");
    // A computed path still stops it even if the active one already called the API.
    const { version: x } = await propose(turbo, {
      target: { actionId: a.id },
      code: `${deletes} const p = '/api/' + event.w; await kitsuden.api.get(p); return { s: r.status };`,
      tests: test,
    });
    expect(x.decision.reasons).toContain("unclassifiable_api_call");
  }, 180_000);

  it("decision 3: a new action goes through a person the first time and can then go turbo", async () => {
    if (!dbAvailable) return;
    await configure({ turboAllowed: true });
    await mode(turbo.id, "turbo");
    const slug = `promo-new-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const { version: v1 } = await propose(turbo, {
      target: { slug, name: "New" },
      code: SUM,
      tests: TEST_SUM,
    });
    expect(v1.status).toBe("awaiting_approval");
    expect(v1.decision.reasons).toEqual(["new_target"]);
    await json(
      await asAdmin("POST", `/api/approvals/promotion/versions/${v1.id}/approve`, {}),
      200
    );
    const active = await readVersion(v1.id);
    expect(active.status).toBe("active");
    createdActions.push(active.targetId!);
    const { version: v2 } = await propose(turbo, {
      target: { slug },
      code: `${SUM} // v2`,
      tests: TEST_SUM,
    });
    expect(v2.decision.reasons).toEqual([]);
    expect(v2.status).toBe("active");
    expect(v2.activatedBy).toBe("turbo");
  }, 180_000);

  it("RLS: an agent only sees its own drafts (through the API and with the policy alone)", async () => {
    if (!dbAvailable) return;
    const a = await action();
    const mine = await propose(suggester, {
      target: { actionId: a.id },
      code: SUM,
      tests: TEST_SUM,
    });
    const foreign = await propose(other, {
      target: { actionId: a.id },
      code: `${SUM} // another`,
      tests: TEST_SUM,
    });

    const list = await json<{ versions: VersionView[] }>(
      await request({ token: other.token }, "GET", "/api/promotion/drafts"),
      200
    );
    expect(list.versions.map((v) => v.id)).toContain(foreign.version.id);
    expect(list.versions.map((v) => v.id)).not.toContain(mine.version.id);
    expect(
      (await request({ token: other.token }, "GET", `/api/promotion/drafts/${mine.version.id}`))
        .status
    ).toBe(404);
    // The human admin sees both.
    const all = await json<{ versions: VersionView[] }>(
      await asAdmin("GET", "/api/approvals/promotion/versions?limit=200"),
      200
    );
    expect(all.versions.map((v) => v.id)).toEqual(
      expect.arrayContaining([mine.version.id, foreign.version.id])
    );
    // An agent without the scope, nothing.
    const withoutScope = await newAgent(["mcp:connect"]);
    expect(
      (await request({ token: withoutScope.token }, "GET", "/api/promotion/drafts")).status
    ).toBe(403);
    expect(
      (
        await request({ token: withoutScope.token }, "POST", "/api/promotion/drafts", {
          target: { actionId: a.id },
          code: SUM,
        })
      ).status
    ).toBe(403);

    // The POLICY alone (without the application's filter), with each agent's context.
    const asAgent = async (agentId: string) =>
      db.transaction(async (tx) => {
        // A superuser skips RLS: the policy is measured with the API's role.
        const su = (await tx.execute(
          sql`SELECT current_setting('is_superuser') AS su`
        )) as unknown as { rows: { su: string }[] };
        if (su.rows[0]?.su === "on") await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
        await tx.execute(
          sql`select set_config('app.current_user_id', ${agentId}, true), set_config('app.current_user_role', 'agent', true)`
        );
        const visible = (await tx.execute(sql`select agent_id from code_versions`)) as unknown as
          | { rows: { agent_id: string | null }[] }
          | { agent_id: string | null }[];
        const rows = Array.isArray(visible) ? visible : visible.rows;
        const touched = (await tx.execute(
          sql`update code_versions set description = 'pwned' where agent_id = ${agentId} returning id`
        )) as unknown as { rows?: unknown[] } | unknown[];
        return {
          rows,
          touched: Array.isArray(touched) ? touched.length : (touched.rows?.length ?? 0),
        };
      });
    const seenByOther = await asAgent(other.id);
    expect(seenByOther.rows.length).toBeGreaterThan(0);
    expect(seenByOther.rows.every((f) => f.agent_id === other.id)).toBe(true);
    // Not even its own rows: only the system writes.
    expect(seenByOther.touched).toBe(0);
    expect((await readVersion(foreign.version.id)).description).not.toBe("pwned");
  }, 120_000);
});
