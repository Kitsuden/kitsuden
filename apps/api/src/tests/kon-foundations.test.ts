/**
 * What the core gives kons to build on: automation rules, sealed secrets,
 * reports and entities (docs/automation.md, docs/reports.md,
 * docs/kons/secrets.md, docs/kons/entities.md)
 * ============================================================================
 *
 * Against the REAL app and the test Postgres. A fake kon ("kon-foundry")
 * contributes an event, two rule handlers, a report and an entity, the way a
 * real one does through `defineKon`.
 *
 * What has to hold, beyond "a row was written":
 *
 *   · a rule runs only when its conditions are met, and a dry run runs nothing;
 *   · a rule cannot be saved with a handler nobody declared, or a webhook to an
 *     internal address;
 *   · a kon's own rule cannot reach for another kon's or the core's handlers;
 *   · a sealed secret does not open for another kon, and every opening or
 *     refusal leaves a row that never holds the value;
 *   · a report refuses forbidden tables, undeclared tables and secret columns,
 *     and its numbers are right;
 *   · an entity write that breaks the declared fields fails, and a kon never
 *     takes over a dataset a person made.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, like, sql } from "drizzle-orm";

import { runInRequestScope, useRequest } from "../../../../packages/engine/src/request-scope";
import { db } from "../db";
import { actionExecutions, actions, dashboards, reports, secretAccessLog } from "../db/schema";
import { app } from "../index";
import { dispatchEvent } from "../lib/actions";
import { konAutomation } from "../lib/actions/kon-automation";
import { invalidateSensitivityCatalog } from "../lib/customer-data-catalog";
import { cleanDeclaredCache } from "../lib/explorable-tables";
import { forgetInstalledKons } from "../lib/installed-kons";
import { forgetKonContributions, registerKonContributions } from "../lib/kon-contributions";
import { konEntities, syncKonEntities } from "../lib/kon-entities";
import { konSecrets, registerKonSecretColumns } from "../lib/kon-secrets";
import { bindKonContext } from "../lib/kon-setup";
import { rekeySecrets } from "../lib/secrets-rekey";
import { createAgent } from "../services/agent-auth";
import { clearPackageScanCache } from "../services/scanner";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

const KON = "kon-foundry";
const id = generateTestId()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
const EVENT = `foundry:order.${id}`;
const ENTITY = `foundry-part-${id}`;
const TABLE = `zz_foundry_secret_${id}`;
/** The table the fixture kon (tests/fixtures/kon-reports-test) declares, with `email` marked personal. */
const FIXTURE_TABLE = "zz_reports_fixture";
const FIXTURE_KON_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/kon-reports-test"
);
const previousKons = process.env.KITSUDEN_KONS;

let dbAvailable = false;
let admin = "";
let adminId = "";
let member = "";

interface Call {
  handler: string;
  config: Record<string, unknown>;
  event?: string;
  actorUserId: string | null;
}
const calls: Call[] = [];

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

async function call(method: string, path: string, body?: unknown, cookie = admin) {
  const res = await app.request(
    req(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, cookie)
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** The rows of a raw `db.execute`, whatever the driver wraps them in. */
async function rows(query: ReturnType<typeof sql>): Promise<any[]> {
  const result = (await db.execute(query)) as any;
  return Array.isArray(result) ? result : (result.rows ?? []);
}

/**
 * The message a promise rejects with ("" when it resolves). Used for `ctx.entities` instead of
 * `expect().rejects`: with these errors Bun's matcher never settled and the test hung.
 */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

async function until(check: () => Promise<boolean> | boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;

  ({ cookie: admin, userId: adminId } = await enterAs(app, {
    email: `foundry-admin-${id}@example.com`,
    password: "TestPassword123!",
    name: "Foundry Admin",
    role: "admin",
  }));
  ({ cookie: member } = await enterAs(app, {
    email: `foundry-member-${id}@example.com`,
    password: "TestPassword123!",
    name: "Foundry Member",
  }));

  // The fixture kon: it declares `zz_reports_fixture` and marks `email` as personal data. The reports
  // tests need a declared table, and the CI checkout has no kons installed.
  process.env.KITSUDEN_KONS = [previousKons, `reports-test=${FIXTURE_KON_DIR}`]
    .filter(Boolean)
    .join(",");
  forgetInstalledKons();
  clearPackageScanCache();
  cleanDeclaredCache();
  invalidateSensitivityCatalog();
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(FIXTURE_TABLE)}`);
  await db.execute(sql`
    CREATE TABLE ${sql.identifier(FIXTURE_TABLE)} (
      id serial PRIMARY KEY,
      material text,
      email text,
      code text,
      amount numeric,
      born date,
      closed_at timestamptz,
      active boolean,
      password text,
      api_token text
    )`);
  await db.execute(sql`
    INSERT INTO ${sql.identifier(FIXTURE_TABLE)} (material, email, code, amount, born, closed_at, active, password, api_token) VALUES
      ('steel', 'ana@example.com',  '00123', 5.00,  '2026-01-10', '2026-03-05T10:00:00Z', true,  'x', 't1'),
      ('steel', 'luis@example.com', '00456', 7.50,  '2026-02-11', '2026-03-20T10:00:00Z', false, 'y', 't2'),
      ('brass', 'eva@example.com',  '0099',  40,    '2026-02-12', '2026-04-02T10:00:00Z', true,  'z', 't3')`);

  const problems = registerKonContributions(
    {
      id: KON,
      events: {
        emits: {
          [EVENT]: {
            description: "An order was placed.",
            payload: { amount: "number", customer: "text" },
          },
        },
        listens: ["shop:order.paid"],
      },
      actionHandlers: [
        {
          id: "note",
          label: "Write a note",
          description: "Records the call.",
          config: { text: "what to write" },
          validate: (config) => (typeof config.text === "string" ? null : "text is required"),
          run: async (input) => {
            calls.push({
              handler: "note",
              config: input.config,
              event: input.event?.name,
              actorUserId: input.actorUserId,
            });
            return { noted: true };
          },
          preview: (input) => ({ wouldWrite: input.config.text }),
        },
        {
          id: "fail",
          label: "Always fails",
          description: "For the tests.",
          run: async () => {
            calls.push({ handler: "fail", config: {}, actorUserId: null });
            throw new Error("boom");
          },
        },
        {
          id: "whoami",
          label: "Reports who the step runs as",
          description: "For the tests.",
          run: async (input) => {
            calls.push({
              handler: "whoami",
              config: { seenUser: useRequest()?.user?.id ?? null },
              actorUserId: input.actorUserId,
            });
            return null;
          },
        },
        // Malformed on purpose: reported, not registered.
        { id: "Bad Id", label: "x", description: "x", run: async () => null },
      ],
      reports: [
        {
          id: "parts-by-material",
          name: "Parts by material",
          query: {
            source: { dataset: ENTITY },
            measures: [{ fn: "count" }, { fn: "sum", field: "weight", as: "weight" }],
            groupBy: [{ field: "material" }],
            orderBy: [{ by: "material" }],
          },
          chart: { type: "bar", x: "material", y: ["weight"] },
        },
        { id: "broken", name: "Broken", query: { source: {}, measures: [] } as never },
      ],
    },
    {} as never
  );
  // The two malformed contributions, and only those.
  expect(problems).toHaveLength(2);
  expect(problems.join(" ")).toContain("Bad Id");
  expect(problems.join(" ")).toContain("broken");
});

afterAll(async () => {
  if (!dbAvailable) return;
  forgetKonContributions(KON);
  await db.delete(actions).where(like(actions.slug, `%${id}%`));
  await db.delete(reports).where(like(reports.name, `%${id}%`));
  await db.delete(dashboards).where(like(dashboards.name, `%${id}%`));
  await db.delete(secretAccessLog).where(like(secretAccessLog.subject, `%${id}%`));
  await db.delete(secretAccessLog).where(eq(secretAccessLog.konId, KON));
  await db.execute(sql`DELETE FROM kitsuden_secret_columns WHERE kon_id = ${KON}`);
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(TABLE)}`);
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(FIXTURE_TABLE)}`);
  if (previousKons === undefined) delete process.env.KITSUDEN_KONS;
  else process.env.KITSUDEN_KONS = previousKons;
  forgetInstalledKons();
  clearPackageScanCache();
  cleanDeclaredCache();
  invalidateSensitivityCatalog();
  await db.execute(sql`DELETE FROM data_sets WHERE slug LIKE ${`%${id}%`}`);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("automation rules", () => {
  let ruleId = "";

  it("the catalog lists the kon's event and handlers next to the core's", async () => {
    if (!dbAvailable) return;
    const { status, json } = await call("GET", "/api/automation/catalog");
    expect(status).toBe(200);
    const event = json.events.find((e: any) => e.name === EVENT);
    expect(event).toMatchObject({ source: KON, description: "An order was placed." });
    expect(json.events.some((e: any) => e.name === "entry.created" && e.source === "core")).toBe(
      true
    );
    const handlers = json.handlers.map((h: any) => h.id);
    expect(handlers).toEqual(
      expect.arrayContaining(["core:webhook", "core:send-mail", "core:run-agent", `${KON}:note`])
    );
    expect(handlers).not.toContain(`${KON}:Bad Id`);
    // The catalog is the administrator's, like the rest of /api/actions.
    expect((await call("GET", "/api/automation/catalog", undefined, member)).status).toBe(403);
  });

  it("refuses a rule with an undeclared handler, a rejected config or bad conditions", async () => {
    if (!dbAvailable) return;
    const rule = (steps: unknown, triggerConfig: unknown = { eventName: EVENT }) => ({
      name: `Rule ${id}`,
      slug: `rule-bad-${id}`,
      type: "rule",
      trigger: "event",
      triggerConfig,
      config: { steps },
    });

    let res = await call("POST", "/api/actions", rule([{ handler: "kon-nobody:thing" }]));
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("kon-nobody:thing");

    res = await call("POST", "/api/actions", rule([{ handler: `${KON}:note`, config: {} }]));
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("text is required");

    res = await call("POST", "/api/actions", rule([]));
    expect(res.status).toBe(400);

    res = await call(
      "POST",
      "/api/actions",
      rule([{ handler: `${KON}:note`, config: { text: "x" } }], {
        eventName: EVENT,
        conditions: [{ field: "__proto__.x", op: "eq", value: 1 }],
      })
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("triggerConfig");

    // A webhook step passes the same target check as a webhook_out action.
    res = await call(
      "POST",
      "/api/actions",
      rule([
        { handler: "core:webhook", config: { url: "http://169.254.169.254/latest/meta-data" } },
      ])
    );
    expect(res.status).toBe(400);

    res = await call(
      "POST",
      "/api/actions",
      rule([{ handler: "core:send-mail", config: { mailable: "no-such-mail" } }])
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("no-such-mail");
  });

  it("stores a rule and runs it only for events that meet its conditions", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", "/api/actions", {
      name: `Rule ${id}`,
      slug: `rule-${id}`,
      type: "rule",
      trigger: "event",
      triggerConfig: {
        eventName: EVENT,
        conditions: [
          { field: "amount", op: "gte", value: 100 },
          { field: "customer.tier", op: "in", value: ["gold", "silver"] },
        ],
      },
      config: {
        steps: [
          {
            handler: `${KON}:note`,
            config: {
              text: "Order of {{event.amount}} by {{event.customer.name}}",
              amount: "{{event.amount}}",
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    ruleId = res.json.id;

    calls.length = 0;
    // Too small, then the wrong tier: neither runs, and neither leaves an execution.
    await dispatchEvent(EVENT, { amount: 50, customer: { name: "Ana", tier: "gold" } });
    await dispatchEvent(EVENT, { amount: 500, customer: { name: "Ana", tier: "bronze" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(0);
    const none = await db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.actionId, ruleId));
    expect(none).toHaveLength(0);

    await dispatchEvent(EVENT, { amount: 500, customer: { name: "Ana", tier: "gold" } });
    expect(await until(() => calls.length === 1)).toBe(true);
    expect(calls[0]).toMatchObject({
      handler: "note",
      event: EVENT,
      actorUserId: adminId,
      // The lone placeholder kept its type; the embedded ones became text.
      config: { text: "Order of 500 by Ana", amount: 500 },
    });

    expect(
      await until(async () => {
        const rows = await db
          .select()
          .from(actionExecutions)
          .where(eq(actionExecutions.actionId, ruleId));
        return rows.length === 1 && rows[0].status === "success";
      })
    ).toBe(true);
    const [execution] = await db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.actionId, ruleId));
    expect((execution.result as any).steps[0]).toMatchObject({
      handler: `${KON}:note`,
      status: "success",
    });
  });

  it("a dry run says what would happen and does none of it", async () => {
    if (!dbAvailable) return;
    calls.length = 0;
    const before = await db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.actionId, ruleId));

    let res = await call("POST", `/api/automation/actions/${ruleId}/dry-run`, {
      payload: { amount: 250, customer: { name: "Luis", tier: "silver" } },
    });
    expect(res.status).toBe(200);
    expect(res.json.wouldRun).toBe(true);
    expect(res.json.conditions.outcomes.map((o: any) => o.passed)).toEqual([true, true]);
    expect(res.json.steps[0]).toMatchObject({
      handler: `${KON}:note`,
      config: { text: "Order of 250 by Luis", amount: 250 },
      preview: { wouldWrite: "Order of 250 by Luis" },
    });

    res = await call("POST", `/api/automation/actions/${ruleId}/dry-run`, {
      payload: { amount: 1 },
    });
    expect(res.json.wouldRun).toBe(false);
    expect(res.json.conditions.outcomes[0]).toMatchObject({ actual: 1, passed: false });

    expect(calls).toHaveLength(0);
    const after = await db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.actionId, ruleId));
    expect(after).toHaveLength(before.length);
    // A payload that is not an object fails validation.
    expect(
      (await call("POST", `/api/automation/actions/${ruleId}/dry-run`, { payload: "x" })).status
    ).toBe(422);
    expect(
      (await call("POST", `/api/automation/actions/${ruleId}/dry-run`, {}, member)).status
    ).toBe(403);
  });

  it("a dry run never shows a step's secret", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", "/api/actions", {
      name: `Signed ${id}`,
      slug: `rule-signed-${id}`,
      type: "rule",
      trigger: "manual",
      config: {
        steps: [
          {
            handler: "core:webhook",
            config: {
              url: "https://example.com/hook",
              secret: "signing-secret-do-not-show",
              headers: {
                "X-Api-Token": "t0ken",
                Authorization: "Bearer bearer-do-not-show",
                "X-Trace": "visible-too",
              },
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const dry = await call("POST", `/api/automation/actions/${res.json.id}/dry-run`, {});
    expect(dry.status).toBe(200);
    expect(dry.json.steps[0].config).toMatchObject({
      url: "https://example.com/hook",
      secret: "[hidden]",
    });
    expect(JSON.stringify(dry.json)).not.toContain("signing-secret-do-not-show");
    // Every header value is hidden, whatever the header is called.
    expect(dry.json.steps[0].config.headers).toEqual({
      "X-Api-Token": "[hidden]",
      Authorization: "[hidden]",
      "X-Trace": "[hidden]",
    });
    expect(JSON.stringify(dry.json)).not.toContain("t0ken");
    expect(JSON.stringify(dry.json)).not.toContain("bearer-do-not-show");
    await db.update(actions).set({ status: "paused" }).where(eq(actions.id, res.json.id));
  });

  it("a webhook URL may not take its host from the event", async () => {
    if (!dbAvailable) return;
    const rule = (url: string) => ({
      name: `Host ${id}`,
      slug: `rule-host-${id}-${Math.random().toString(36).slice(2, 7)}`,
      type: "rule",
      trigger: "manual",
      config: { steps: [{ handler: "core:webhook", config: { url } }] },
    });
    for (const url of [
      "https://{{event.host}}/hook",
      "https://hooks.{{event.domain}}/hook",
      "https://example.com@{{event.host}}/hook",
      "{{event.url}}",
    ]) {
      const res = await call("POST", "/api/actions", rule(url));
      expect(res.status, url).toBe(400);
      expect(res.json.error, url).toMatch(/host/);
    }
    // A placeholder in the path or the query is fine; the literal part still passes the target check.
    const fine = await call(
      "POST",
      "/api/actions",
      rule("https://example.com/hooks/{{event.id}}?o={{event.org}}")
    );
    expect(fine.status).toBe(201);
    await db.update(actions).set({ status: "paused" }).where(eq(actions.id, fine.json.id));
    const internal = await call(
      "POST",
      "/api/actions",
      rule("http://169.254.169.254/{{event.path}}")
    );
    expect(internal.status).toBe(400);
  });

  it("a kon's step runs as the rule's owner, not as whoever triggered the event", async () => {
    if (!dbAvailable) return;
    const rule = await konAutomation.upsertRule(KON, {
      slug: `whoami-${id}`,
      name: "Who am I",
      event: EVENT,
      conditions: [{ field: "probe", op: "eq", value: "whoami" }],
      steps: [{ handler: `${KON}:whoami` }],
      ownerUserId: adminId,
    });
    calls.length = 0;
    // The event is emitted in the request of someone else; the listener inherits that scope.
    await runInRequestScope({ user: { id: "someone-who-triggered-it" } }, () =>
      dispatchEvent(EVENT, { probe: "whoami" })
    );
    expect(await until(() => calls.some((c) => c.handler === "whoami"))).toBe(true);
    const seen = calls.find((c) => c.handler === "whoami");
    expect(seen?.config.seenUser).toBe(adminId);
    expect(seen?.actorUserId).toBe(adminId);
    await konAutomation.removeRule(KON, `whoami-${id}`);
    expect(rule.enabled).toBe(true);
  });

  it("a failing step stops the rule unless it says continueOnError", async () => {
    if (!dbAvailable) return;
    const make = async (slug: string, continueOnError: boolean) => {
      const res = await call("POST", "/api/actions", {
        name: `Rule ${slug} ${id}`,
        slug: `rule-${slug}-${id}`,
        type: "rule",
        trigger: "manual",
        config: {
          steps: [
            { handler: `${KON}:fail`, continueOnError },
            { handler: `${KON}:note`, config: { text: "after" } },
          ],
        },
      });
      expect(res.status).toBe(201);
      return res.json.id as string;
    };

    calls.length = 0;
    let res = await call("POST", `/api/actions/${await make("stop", false)}/execute`, {});
    expect(res.json.success).toBe(false);
    expect(res.json.error).toContain("boom");
    expect(res.json.result.steps.map((s: any) => s.status)).toEqual(["error", "skipped"]);
    expect(calls.map((c) => c.handler)).toEqual(["fail"]);

    calls.length = 0;
    res = await call("POST", `/api/actions/${await make("go", true)}/execute`, {});
    expect(res.json.success).toBe(true);
    expect(res.json.result.steps.map((s: any) => s.status)).toEqual(["error", "success"]);
    expect(calls.map((c) => c.handler)).toEqual(["fail", "note"]);
  });

  it("conditions also filter the other types of action", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", "/api/actions", {
      name: `Conditioned ${id}`,
      slug: `conditioned-${id}`,
      type: "webhook_out",
      trigger: "event",
      triggerConfig: { eventName: EVENT, conditions: [{ field: "amount", op: "gt", value: 10 }] },
      config: { url: "https://example.com/hook" },
    });
    expect(res.status).toBe(201);
    const dry = await call("POST", `/api/automation/actions/${res.json.id}/dry-run`, {
      payload: { amount: 5 },
    });
    expect(dry.json.wouldRun).toBe(false);
    expect(dry.json.steps).toEqual([]);
    expect(dry.json.note).toContain("webhook_out");
    await db.update(actions).set({ status: "paused" }).where(eq(actions.id, res.json.id));
  });

  it("a kon keeps its own rules, with its own handlers only", async () => {
    if (!dbAvailable) return;
    const rule = {
      slug: `stage-${id}`,
      name: "On enter",
      event: EVENT,
      conditions: [{ field: "stage", op: "eq" as const, value: "won" }],
      steps: [{ handler: `${KON}:note`, config: { text: "won {{event.dealId}}" } }],
      ownerUserId: adminId,
    };
    const created = await konAutomation.upsertRule(KON, rule);
    expect(created).toMatchObject({ slug: `stage-${id}`, event: EVENT, enabled: true });

    // Same slug: replaced, not duplicated.
    const again = await konAutomation.upsertRule(KON, {
      ...rule,
      name: "On enter (renamed)",
      enabled: false,
    });
    expect(again.id).toBe(created.id);
    expect(again).toMatchObject({ name: "On enter (renamed)", enabled: false });
    expect((await konAutomation.listRules(KON)).filter((r) => r.slug === rule.slug)).toHaveLength(
      1
    );
    // Another kon does not see it and cannot remove it.
    expect(await konAutomation.listRules("kon-other")).toEqual([]);
    expect(await konAutomation.removeRule("kon-other", rule.slug)).toBe(false);

    await konAutomation.upsertRule(KON, rule);
    calls.length = 0;
    await dispatchEvent(EVENT, { stage: "won", dealId: "d7", amount: 0 });
    expect(await until(() => calls.some((c) => c.config.text === "won d7"))).toBe(true);
    expect(calls.find((c) => c.config.text === "won d7")?.actorUserId).toBe(adminId);

    // It does not wire the core's handlers, another kon's, or an undeclared one.
    for (const handler of ["core:webhook", "core:run-agent", "kon-other:note", `${KON}:missing`]) {
      await expect(
        konAutomation.upsertRule(KON, {
          ...rule,
          slug: `x-${id}`,
          steps: [{ handler, config: { text: "x" } }],
        })
      ).rejects.toThrow(/automation:/);
    }
    await expect(konAutomation.upsertRule(KON, { ...rule, slug: "Bad Slug" })).rejects.toThrow(
      /slug/
    );

    expect(await konAutomation.removeRule(KON, rule.slug)).toBe(true);
    expect(await konAutomation.removeRule(KON, rule.slug)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a kon cannot act as another kon", () => {
  const shared = { secrets: konSecrets, entities: konEntities, automation: konAutomation } as never;

  /** The message a call fails with, whether it throws or rejects ("" when it works). */
  async function failed(fn: () => unknown): Promise<string> {
    try {
      await fn();
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("the context a kon receives refuses another kon's id", async () => {
    if (!dbAvailable) return;
    const bound = bindKonContext(shared, KON);
    const sealed = konSecrets.seal("kon-victim", `victim-token-${id}`);

    // Opening another kon's secret by claiming its id: refused before anything is decrypted.
    expect(
      await failed(() => bound.secrets!.open("kon-victim", sealed, { purpose: "steal" }))
    ).toMatch(/cannot act as/);
    expect(await failed(() => bound.secrets!.seal("kon-victim", "x"))).toMatch(/cannot act as/);
    expect(await failed(() => bound.automation!.listRules("kon-victim"))).toMatch(/cannot act as/);
    expect(await failed(() => bound.automation!.removeRule("kon-victim", "any"))).toMatch(
      /cannot act as/
    );
    expect(
      await failed(() =>
        bound.automation!.upsertRule("kon-victim", {
          slug: "x",
          name: "x",
          event: EVENT,
          steps: [{ handler: "kon-victim:thing" }],
        })
      )
    ).toMatch(/cannot act as/);
    expect(
      await failed(() =>
        bound.entities!.define("kon-victim", { slug: `victim-${id}`, name: "x", fields: [] })
      )
    ).toMatch(/cannot act as/);
    expect(await failed(() => bound.entities!.undefine("kon-victim", `victim-${id}`))).toMatch(
      /cannot act as/
    );
    expect(await failed(() => bound.entities!.definitions("kon-victim"))).toMatch(/cannot act as/);

    // Nothing was recorded for the refused attempts: they never reached the secrets service.
    const logged = await db
      .select()
      .from(secretAccessLog)
      .where(eq(secretAccessLog.purpose, "steal"));
    expect(logged).toHaveLength(0);

    // Its own id works.
    const mine = bound.secrets!.seal(KON, "mine");
    expect(
      await bound.secrets!.open(KON, mine, { purpose: `own-${id}`, subject: `identity:${id}` })
    ).toBe("mine");
    expect(await bound.automation!.listRules(KON)).toBeInstanceOf(Array);
  });

  it("the services that are not kon-scoped are shared as they were", () => {
    if (!dbAvailable) return;
    const base = { secrets: konSecrets, logger: { info() {} } } as never;
    const bound = bindKonContext(base, KON) as unknown as { logger: unknown; entities?: unknown };
    expect(bound.logger).toBe((base as unknown as { logger: unknown }).logger);
    expect(bound.entities).toBeUndefined();
  });
});

describe("sealed secrets", () => {
  const TOKEN = `refresh-token-${id}-do-not-log`;

  it("seals, opens for the same kon, and records the opening without the value", async () => {
    if (!dbAvailable) return;
    const sealed = konSecrets.seal(KON, TOKEN);
    expect(sealed).toMatchObject({ v: 1, kon: KON });
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    // A fresh IV each time: the same secret never gives the same ciphertext.
    expect(konSecrets.seal(KON, TOKEN).valueEncrypted).not.toBe(sealed.valueEncrypted);

    const opened = await konSecrets.open(KON, sealed, {
      purpose: "refresh-access-token",
      subject: `connection:${id}`,
      actorUserId: adminId,
    });
    expect(opened).toBe(TOKEN);

    const rows = await db
      .select()
      .from(secretAccessLog)
      .where(eq(secretAccessLog.subject, `connection:${id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      konId: KON,
      outcome: "opened",
      purpose: "refresh-access-token",
      actorUserId: adminId,
    });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("does not open for another kon, a relabelled value or a tampered one, and records each refusal", async () => {
    if (!dbAvailable) return;
    const sealed = konSecrets.seal(KON, TOKEN);
    const access = { purpose: "attack", subject: `refused:${id}` };

    await expect(konSecrets.open("kon-other", sealed, access)).rejects.toThrow(/another kon/);
    // Editing the label does not help: the kon's id is authenticated with the ciphertext.
    await expect(
      konSecrets.open("kon-other", { ...sealed, kon: "kon-other" }, access)
    ).rejects.toThrow(/does not open/);
    const flipped =
      sealed.valueEncrypted.slice(0, -1) + (sealed.valueEncrypted.endsWith("0") ? "1" : "0");
    await expect(
      konSecrets.open(KON, { ...sealed, valueEncrypted: flipped }, access)
    ).rejects.toThrow(/does not open/);
    await expect(konSecrets.open(KON, { foo: "bar" } as never, access)).rejects.toThrow(
      /not a sealed secret/
    );

    const rows = await db
      .select()
      .from(secretAccessLog)
      .where(eq(secretAccessLog.subject, `refused:${id}`));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.outcome === "refused")).toBe(true);
  });

  it("needs a kon id, something to seal and a purpose", async () => {
    if (!dbAvailable) return;
    expect(() => konSecrets.seal("", TOKEN)).toThrow();
    expect(() => konSecrets.seal(KON, "")).toThrow();
    const sealed = konSecrets.seal(KON, TOKEN);
    await expect(konSecrets.open(KON, sealed, { purpose: " " })).rejects.toThrow(/purpose/);
    await expect(konSecrets.open(KON, sealed, undefined as never)).rejects.toThrow(/purpose/);
  });

  it("the access log is the administrator's, and never carries a value", async () => {
    if (!dbAvailable) return;
    const res = await call("GET", `/api/admin/secret-access?kon=${KON}&limit=50`);
    expect(res.status).toBe(200);
    // One opening and the two refusals made in this kon's name; the other two are logged under the kon that tried.
    expect(res.json.entries.length).toBeGreaterThanOrEqual(3);
    expect(res.json.entries.every((e: any) => e.konId === KON)).toBe(true);
    expect(JSON.stringify(res.json)).not.toContain(TOKEN);
    expect(res.json.hasMore).toBe(false);
    // It had no way past the first page: `offset` and `hasMore`.
    const first = await call("GET", `/api/admin/secret-access?kon=${KON}&limit=1`);
    const second = await call("GET", `/api/admin/secret-access?kon=${KON}&limit=1&offset=1`);
    expect(first.json.entries).toHaveLength(1);
    expect(first.json.hasMore).toBe(true);
    expect(second.json.entries[0].id).toBe(res.json.entries[1].id);
    expect((await call("GET", "/api/admin/secret-access", undefined, member)).status).toBe(403);
  });

  it("a key rotation reaches the columns a kon declared", async () => {
    if (!dbAvailable) return;
    await db.execute(
      sql`CREATE TABLE ${sql.identifier(TABLE)} (id text PRIMARY KEY, refresh_token jsonb)`
    );
    await db.execute(
      sql`INSERT INTO ${sql.identifier(TABLE)} (id, refresh_token) VALUES ('one', ${JSON.stringify(konSecrets.seal(KON, TOKEN))}::jsonb)`
    );
    expect(
      await registerKonSecretColumns(KON, [
        { table: TABLE, column: "refresh_token" },
        { table: "bad table", column: "x" },
      ])
    ).toHaveLength(1);

    const oldRaw = process.env.KITSUDEN_SECRETS_KEY || process.env.BETTER_AUTH_SECRET || "";
    // A dry run: it decrypts every stored secret with the old key (so a store it cannot read would
    // fail here) and reports what it WOULD re-encrypt, without changing the database.
    const report = await rekeySecrets(db as never, {
      oldRaw,
      newRaw: `rekey-${id}-${"y".repeat(32)}`,
      dryRun: true,
    });
    expect(report.stores[`${TABLE}.refresh_token`]).toEqual({ rekeyed: 1, alreadyNew: 0 });
    // The store this list used to miss.
    expect(report.stores).toHaveProperty(["external_mcp_servers.auth_header_value"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("kon entities", () => {
  const definition = {
    slug: ENTITY,
    name: "Part",
    fields: [
      { key: "material", type: "select", required: true, options: ["steel", "brass"] },
      { key: "weight", type: "number" },
      { key: "made_on", type: "date" },
    ],
  };

  it("creates the dataset at load with no migration, and updates it on the next", async () => {
    if (!dbAvailable) return;
    expect(await syncKonEntities(KON, [definition])).toEqual([]);
    const [row] = await rows(
      sql`SELECT kon_id, name, schema FROM data_sets WHERE slug = ${ENTITY}`
    );
    expect(row.kon_id).toBe(KON);
    expect(row.schema).toHaveLength(3);

    expect(await syncKonEntities(KON, [{ ...definition, name: "Machined part" }])).toEqual([]);
    const described = await konEntities.describe(ENTITY);
    expect(described?.name).toBe("Machined part");
    expect(described?.access).toEqual({ read: "admin", write: "admin" });
    expect(await konEntities.describe(`nope-${id}`)).toBeNull();
  });

  it("refuses a malformed entity, an unknown field type and a slug it does not own", async () => {
    if (!dbAvailable) return;
    await db.execute(
      sql`INSERT INTO data_sets (name, slug, schema) VALUES ('A person made this', ${`person-${id}`}, '[]'::jsonb)`
    );
    const problems = await syncKonEntities(KON, [
      { slug: "Bad Slug", name: "x", fields: [] },
      { slug: `typed-${id}`, name: "x", fields: [{ key: "a", type: "hologram" }] },
      { slug: `person-${id}`, name: "Mine now", fields: [] },
      definition,
    ]);
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).toContain("hologram");
    expect(problems.join(" ")).toContain("no kon owns");
    const taken = await rows(
      sql`SELECT name, kon_id FROM data_sets WHERE slug = ${`person-${id}`}`
    );
    expect(taken[0]).toMatchObject({ name: "A person made this", kon_id: null });
    // Another kon cannot take this one's entity either.
    expect((await syncKonEntities("kon-other", [definition]))[0]).toContain(KON);
    // And a person's dataset is not an entity: ctx.entities does not reach it.
    expect(await failure(konEntities.list(`person-${id}`))).toMatch(/no kon owns an entity/);
  });

  it("a kon defines entity types at runtime, with its own settings", async () => {
    if (!dbAvailable) return;
    const slug = `foundry-case-${id}`;
    const defined = await konEntities.define(KON, {
      slug,
      name: "Case",
      fields: [
        { key: "reference", type: "text", required: true, maxLength: 8, mask: "AAA-0000" },
        { key: "amount", type: "number", minValue: 0 },
      ],
      settings: { numbering: { prefix: "C-", next: 1 }, requiresContact: true },
    });
    // The limits the compiler reads and the keys the kon keeps for itself are both stored.
    expect(defined.fields[0]).toMatchObject({ key: "reference", maxLength: 8, mask: "AAA-0000" });
    expect(defined.settings).toEqual({
      numbering: { prefix: "C-", next: 1 },
      requiresContact: true,
    });

    // Values the kon keeps in its own table are checked without being stored.
    expect(await konEntities.validate(slug, { reference: "ABC-1", amount: 5 })).toMatchObject({
      reference: "ABC-1",
      amount: 5,
    });
    expect(await failure(konEntities.validate(slug, { amount: 5 }))).toMatch(/reference/);
    expect(await failure(konEntities.validate(slug, { reference: "WAY-TOO-LONG-1" }))).toMatch(
      /reference/
    );
    expect(await failure(konEntities.validate(slug, { reference: "A", amount: -1 }))).toMatch(
      /amount/
    );
    expect(await konEntities.list(slug)).toEqual([]);

    // Redefining replaces the definition; a restart with no declaration leaves it alone.
    const redefined = await konEntities.define(KON, {
      slug,
      name: "Legal case",
      fields: [{ key: "reference", type: "text" }],
      settings: { numbering: { prefix: "LC-", next: 7 } },
    });
    expect(redefined.name).toBe("Legal case");
    expect(redefined.settings).toEqual({ numbering: { prefix: "LC-", next: 7 } });
    expect(await syncKonEntities(KON, [definition])).toEqual([]);
    expect((await konEntities.describe(slug))?.name).toBe("Legal case");
    expect((await konEntities.definitions(KON)).map((d) => d.slug).sort()).toEqual(
      [ENTITY, slug].sort()
    );
    expect(await konEntities.definitions("kon-other")).toEqual([]);

    // It cannot take a slug it does not own, nor store a malformed definition.
    expect(
      await failure(konEntities.define("kon-other", { slug, name: "Mine", fields: [] }))
    ).toMatch(KON);
    expect(
      await failure(konEntities.define(KON, { slug: `person-${id}`, name: "x", fields: [] }))
    ).toMatch(/no kon owns/);
    expect(
      await failure(
        konEntities.define(KON, { slug, name: "x", fields: [{ key: "a", type: "hologram" }] })
      )
    ).toMatch(/hologram/);
    expect(
      await failure(konEntities.define(KON, { slug, name: "x", fields: [], settings: [] as never }))
    ).toMatch(/settings/);

    // Removing: not another kon, and not while it has records unless asked to.
    expect(await konEntities.undefine("kon-other", slug)).toBe(false);
    await konEntities.create(slug, { title: "One", data: { reference: "R1" } });
    expect(await failure(konEntities.undefine(KON, slug))).toMatch(/still has 1 record/);
    expect(await konEntities.undefine(KON, slug, { withRecords: true })).toBe(true);
    expect(await konEntities.describe(slug)).toBeNull();
    expect(await konEntities.undefine(KON, slug)).toBe(false);
  });

  it("validates every write against the declared fields", async () => {
    if (!dbAvailable) return;
    expect(
      await failure(konEntities.create(ENTITY, { title: "No material", data: { weight: 3 } }))
    ).toMatch(/material/);
    expect(
      await failure(
        konEntities.create(ENTITY, {
          title: "Bad weight",
          data: { material: "steel", weight: "heavy" },
        })
      )
    ).toMatch(/weight/);
    expect(
      await failure(konEntities.create(ENTITY, { title: "", data: { material: "steel" } }))
    ).toMatch(/title/);

    const bolt = await konEntities.create(ENTITY, {
      title: "Bolt",
      data: {
        material: "steel",
        weight: 12,
        made_on: "2026-03-10",
        note: "undeclared keys are kept",
      },
    });
    expect(bolt.data).toMatchObject({
      material: "steel",
      weight: 12,
      note: "undeclared keys are kept",
    });
    await konEntities.create(ENTITY, {
      title: "Nut",
      data: { material: "steel", weight: 8, made_on: "2026-03-22" },
    });
    await konEntities.create(ENTITY, {
      title: "Gear",
      data: { material: "brass", weight: 40, made_on: "2026-04-02" },
    });

    // A patch is merged, then the WHOLE record is validated.
    const heavier = await konEntities.update(ENTITY, bolt.id, { data: { weight: 15 } });
    expect(heavier?.data).toMatchObject({ material: "steel", weight: 15 });
    expect(
      await failure(konEntities.update(ENTITY, bolt.id, { data: { material: null } }))
    ).toMatch(/material/);
    expect((await konEntities.get(ENTITY, bolt.id))?.data.material).toBe("steel");

    expect(await konEntities.list(ENTITY, { where: { material: "steel" } })).toHaveLength(2);
    expect(await konEntities.list(ENTITY)).toHaveLength(3);
    expect(await failure(konEntities.list(ENTITY, { where: { "a'; --": "x" } }))).toMatch(
      /field name/
    );
    expect(await konEntities.get(ENTITY, "not-a-uuid")).toBeNull();

    // The same history as any dataset entry.
    const history = await rows(
      sql`SELECT action FROM record_changes WHERE entity = 'dataset_entry' AND row_id = ${bolt.id} ORDER BY created_at`
    );
    expect(history.map((r: any) => r.action)).toEqual(["create", "update"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("reports", () => {
  const aggregate = (query: unknown, cookie = admin) =>
    call("POST", "/api/reports/aggregate", { query }, cookie);

  it("counts and sums a dataset, grouped and filtered", async () => {
    if (!dbAvailable) return;
    let res = await aggregate({
      source: { dataset: ENTITY },
      measures: [
        { fn: "count" },
        { fn: "sum", field: "weight", as: "weight" },
        { fn: "max", field: "weight", as: "heaviest" },
      ],
      groupBy: [{ field: "material" }],
      orderBy: [{ by: "material", dir: "asc" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.columns.map((c: any) => `${c.role}:${c.name}`)).toEqual([
      "dimension:material",
      "measure:count",
      "measure:weight",
      "measure:heaviest",
    ]);
    expect(res.json.rows).toEqual([
      { material: "brass", count: 1, weight: 40, heaviest: 40 },
      { material: "steel", count: 2, weight: 23, heaviest: 15 },
    ]);
    expect(res.json.truncated).toBe(false);

    res = await aggregate({
      source: { dataset: ENTITY },
      measures: [{ fn: "count" }, { fn: "avg", field: "weight", as: "average" }],
      groupBy: [{ field: "made_on", bucket: "month", as: "month" }],
      filters: [{ field: "weight", op: "gt", value: 9 }],
      orderBy: [{ by: "month" }],
    });
    expect(res.status).toBe(200);
    expect(
      res.json.rows.map((r: any) => [String(r.month).slice(0, 7), r.count, r.average])
    ).toEqual([
      ["2026-03", 1, 15],
      ["2026-04", 1, 40],
    ]);

    res = await aggregate({
      source: { dataset: ENTITY },
      measures: [{ fn: "count" }],
      groupBy: [{ field: "material" }],
      orderBy: [{ by: "count", dir: "desc" }],
      limit: 1,
    });
    expect(res.json.rows).toEqual([{ material: "steel", count: 2 }]);
    expect(res.json.truncated).toBe(true);
  });

  it("a value that is not a number in a numeric field gives no failure", async () => {
    if (!dbAvailable) return;
    const [{ id: datasetId }] = await rows(sql`SELECT id FROM data_sets WHERE slug = ${ENTITY}`);
    // Written past the validator, the way an import or an old row can be.
    await db.execute(
      sql`INSERT INTO data_entries (title, data_set_id, data) VALUES ('Odd', ${datasetId}, '{"material":"brass","weight":"n/a","made_on":"soon"}'::jsonb)`
    );
    const res = await aggregate({
      source: { dataset: ENTITY },
      measures: [{ fn: "sum", field: "weight", as: "weight" }, { fn: "count" }],
      groupBy: [{ field: "made_on", bucket: "year", as: "year" }],
      orderBy: [{ by: "year" }],
    });
    expect(res.status).toBe(200);
    const total = res.json.rows.reduce((sum: number, r: any) => sum + (r.weight ?? 0), 0);
    expect(total).toBe(63);
    expect(res.json.rows.reduce((n: number, r: any) => n + r.count, 0)).toBe(4);
    await db.execute(
      sql`DELETE FROM data_entries WHERE title = 'Odd' AND data_set_id = ${datasetId}`
    );
  });

  it("refuses forbidden tables, undeclared tables, secret columns and unknown columns", async () => {
    if (!dbAvailable) return;
    const count = [{ fn: "count" }];
    for (const table of [
      "kitsuden_secrets",
      "auth_accounts",
      "auth_users",
      "api_keys",
      "actions",
      "secret_access_log",
      "pg_catalog",
    ]) {
      const res = await aggregate({ source: { table }, measures: count });
      expect([403, 400]).toContain(res.status);
      expect(res.json.rows).toBeUndefined();
    }
    // A table a kon declares can be counted...
    let res = await aggregate({ source: { table: FIXTURE_TABLE }, measures: count });
    expect(res.status).toBe(200);
    expect(res.json.rows).toEqual([{ count: 3 }]);
    // ...but not through a column that does not exist, nor one named like a secret.
    res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "max", field: "no_such_column" }],
    });
    expect(res.status).toBe(400);
    for (const field of ["password", "api_token", "password_hash"]) {
      res = await aggregate({ source: { table: FIXTURE_TABLE }, measures: [{ fn: "min", field }] });
      expect(res.status).toBe(403);
      res = await aggregate({
        source: { table: FIXTURE_TABLE },
        measures: count,
        groupBy: [{ field }],
      });
      expect(res.status).toBe(403);
      res = await aggregate({
        source: { dataset: ENTITY },
        measures: count,
        filters: [{ field, op: "contains", value: "a" }],
      });
      expect(res.status).toBe(403);
    }
    res = await aggregate({ source: { dataset: `nope-${id}` }, measures: count });
    expect(res.status).toBe(404);
    res = await aggregate({
      source: { dataset: ENTITY },
      measures: [{ fn: "sum", field: "material" }],
    });
    expect(res.status).toBe(400);
    res = await aggregate({
      source: { dataset: ENTITY },
      measures: count,
      groupBy: [{ field: "material", bucket: "month" }],
    });
    expect(res.status).toBe(400);
    res = await aggregate({
      source: { dataset: ENTITY },
      measures: [{ fn: "sum", field: "weight; DROP TABLE data_sets" }],
    });
    expect(res.status).toBe(400);
  });

  it("a declared table: sums, buckets and `in` compare as the column's own type", async () => {
    if (!dbAvailable) return;
    let res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "sum", field: "amount", as: "total" }, { fn: "count" }],
      groupBy: [{ field: "material" }],
      orderBy: [{ by: "material" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.rows).toEqual([
      { material: "brass", total: 40, count: 1 },
      { material: "steel", total: 12.5, count: 2 },
    ]);

    res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "count" }],
      groupBy: [{ field: "closed_at", bucket: "month", as: "month" }],
      orderBy: [{ by: "month" }],
    });
    expect(res.json.rows.map((r: any) => [String(r.month).slice(0, 7), r.count])).toEqual([
      ["2026-03", 2],
      ["2026-04", 1],
    ]);

    // `5` finds `5.00`, and a timestamp finds the same instant however Postgres prints it.
    res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "count" }],
      filters: [{ field: "amount", op: "in", value: [5, 99] }],
    });
    expect(res.json.rows).toEqual([{ count: 1 }]);
    res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "count" }],
      filters: [{ field: "closed_at", op: "in", value: ["2026-03-05T10:00:00Z"] }],
    });
    expect(res.json.rows).toEqual([{ count: 1 }]);
    res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "count" }],
      filters: [{ field: "born", op: "in", value: ["2026-02-11", "2026-02-12"] }],
    });
    expect(res.json.rows).toEqual([{ count: 2 }]);

    // `contains` looks for text inside text; on anything else it says so instead of matching nothing.
    res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [{ fn: "count" }],
      filters: [{ field: "amount", op: "contains", value: "5" }],
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.message ?? res.json.message ?? JSON.stringify(res.json)).toMatch(
      /contains/
    );
  });

  it("min and max of text stay text, even when it looks like a number", async () => {
    if (!dbAvailable) return;
    const res = await aggregate({
      source: { table: FIXTURE_TABLE },
      measures: [
        { fn: "min", field: "code", as: "first_code" },
        { fn: "max", field: "code", as: "last_code" },
        { fn: "max", field: "amount", as: "biggest" },
      ],
    });
    expect(res.status).toBe(200);
    // `00123` is a code, not the number 123; a numeric column still gives a number.
    expect(res.json.rows).toEqual([{ first_code: "00123", last_code: "0099", biggest: 40 }]);
  });

  it("an impossible date in a dataset counts as no date and does not fail the report", async () => {
    if (!dbAvailable) return;
    const [{ id: datasetId }] = await rows(sql`SELECT id FROM data_sets WHERE slug = ${ENTITY}`);
    await db.execute(
      sql`INSERT INTO data_entries (title, data_set_id, data) VALUES ('Impossible', ${datasetId}, '{"material":"brass","weight":1,"made_on":"2026-02-31"}'::jsonb)`
    );
    try {
      const res = await aggregate({
        source: { dataset: ENTITY },
        measures: [{ fn: "count" }],
        groupBy: [{ field: "made_on", bucket: "month", as: "month" }],
        orderBy: [{ by: "month" }],
      });
      expect(res.status).toBe(200);
      // The impossible date sorts last (NULLS LAST) and is counted with the other rows without one.
      expect(res.json.rows.at(-1)).toMatchObject({ month: null });
      expect(res.json.rows.reduce((n: number, r: any) => n + r.count, 0)).toBe(
        (await konEntities.list(ENTITY)).length + 0
      );
    } finally {
      await db.execute(
        sql`DELETE FROM data_entries WHERE title = 'Impossible' AND data_set_id = ${datasetId}`
      );
    }
  });

  describe("for an agent", () => {
    let token = "";

    const asAgent = (query: unknown) =>
      app.request(
        new Request("http://localhost:3000/api/reports/aggregate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ query }),
        })
      );

    it("needs the reports scope, and the scope opens aggregate", async () => {
      if (!dbAvailable) return;
      const query = { source: { table: FIXTURE_TABLE }, measures: [{ fn: "count" }] };
      const bare = await createAgent({
        name: `Reports bare ${id}`,
        scopes: ["blog:read"],
        rateLimit: 100_000,
      });
      const denied = await app.request(
        new Request("http://localhost:3000/api/reports/aggregate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bare.plainApiKey}`,
          },
          body: JSON.stringify({ query }),
        })
      );
      expect([401, 403]).toContain(denied.status);

      const reader = await createAgent({
        name: `Reports reader ${id}`,
        scopes: ["reports:read"],
        rateLimit: 100_000,
      });
      token = reader.plainApiKey;
      const res = await asAgent(query);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { rows: unknown }).rows).toEqual([{ count: 3 }]);
    });

    it("cannot read the values of a column marked as personal data", async () => {
      if (!dbAvailable) return;
      const base = { source: { table: FIXTURE_TABLE }, measures: [{ fn: "count" }] };
      // The dump this closes: one group per distinct value.
      let res = await asAgent({ ...base, groupBy: [{ field: "email" }] });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("ana@example.com");
      res = await asAgent({ ...base, measures: [{ fn: "min", field: "email" }] });
      expect(res.status).toBe(403);
      res = await asAgent({ ...base, filters: [{ field: "email", op: "contains", value: "ana" }] });
      expect(res.status).toBe(403);
      // Counting rows and checking for empty values reveal nothing, and stay allowed.
      res = await asAgent({ ...base, filters: [{ field: "email", op: "is_null", value: false }] });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { rows: unknown }).rows).toEqual([{ count: 3 }]);
      res = await asAgent({
        source: { table: FIXTURE_TABLE },
        measures: [{ fn: "count_distinct", field: "email" }],
      });
      expect(res.status).toBe(200);
      // Columns that are not marked still work.
      res = await asAgent({ ...base, groupBy: [{ field: "material" }] });
      expect(res.status).toBe(200);
    });

    it("a person with the administrator role is not restricted", async () => {
      if (!dbAvailable) return;
      const res = await aggregate({
        source: { table: FIXTURE_TABLE },
        measures: [{ fn: "count" }],
        groupBy: [{ field: "email" }],
      });
      expect(res.status).toBe(200);
      expect(res.json.rows).toHaveLength(3);
    });
  });

  it("is for administrators", async () => {
    if (!dbAvailable) return;
    const query = { source: { dataset: ENTITY }, measures: [{ fn: "count" }] };
    expect((await aggregate(query, member)).status).toBe(403);
    expect((await call("GET", "/api/reports", undefined, member)).status).toBe(403);
    expect(
      (
        await app.request(
          req("/api/reports/aggregate", { method: "POST", body: JSON.stringify({ query }) })
        )
      ).status
    ).toBe(401);
  });

  it("values in a filter are data, never SQL", async () => {
    if (!dbAvailable) return;
    const res = await aggregate({
      source: { dataset: ENTITY },
      measures: [{ fn: "count" }],
      filters: [
        { field: "material", op: "eq", value: "steel' OR '1'='1" },
        { field: "material", op: "in", value: ["x'); DROP TABLE data_entries; --"] },
        { field: "material", op: "contains", value: "%" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.rows).toEqual([{ count: 0 }]);
    expect((await konEntities.list(ENTITY)).length).toBe(3);
  });

  let reportId = "";

  it("saves a report only if it could run, and runs it", async () => {
    if (!dbAvailable) return;
    const query = {
      source: { dataset: ENTITY },
      measures: [{ fn: "sum", field: "weight", as: "weight" }],
      groupBy: [{ field: "material" }],
      orderBy: [{ by: "material" }],
    };
    let res = await call("POST", "/api/reports", {
      name: `Bad ${id}`,
      query: { ...query, source: { table: "kitsuden_secrets" } },
    });
    expect(res.status).toBe(400);
    res = await call("POST", "/api/reports", { name: `Bad ${id}`, query, chart: { type: "pie" } });
    expect(res.status).toBe(400);

    res = await call("POST", "/api/reports", {
      name: `Weight ${id}`,
      query,
      chart: { type: "donut", x: "material", y: ["weight"] },
    });
    expect(res.status).toBe(201);
    reportId = res.json.report.id;
    expect(res.json.report).toMatchObject({ source: "saved", konId: null });

    res = await call("POST", "/api/reports/run", { report: reportId });
    expect(res.status).toBe(200);
    expect(res.json.result.rows).toEqual([
      { material: "brass", weight: 40 },
      { material: "steel", weight: 23 },
    ]);
    expect(res.json.report.chart).toMatchObject({ type: "donut" });

    res = await call("PATCH", `/api/reports/${reportId}`, { name: `Weight by material ${id}` });
    expect(res.json.report.name).toBe(`Weight by material ${id}`);
    res = await call("PATCH", `/api/reports/${reportId}`, {
      query: { source: { dataset: ENTITY }, measures: [] },
    });
    expect(res.status).toBe(400);
    expect((await call("GET", `/api/reports/${reportId}`)).json.report.query).toEqual(query);
  });

  it("lists and runs the reports a kon ships, which are read-only", async () => {
    if (!dbAvailable) return;
    const konReportId = `kon:${KON}/parts-by-material`;
    const list = await call("GET", "/api/reports");
    expect(list.status).toBe(200);
    const shipped = list.json.reports.find((r: any) => r.id === konReportId);
    expect(shipped).toMatchObject({ source: "kon", konId: KON, name: "Parts by material" });
    expect(list.json.reports.some((r: any) => r.id === reportId)).toBe(true);
    // The malformed one was never registered.
    expect(list.json.reports.some((r: any) => r.id === `kon:${KON}/broken`)).toBe(false);

    const run = await call("POST", "/api/reports/run", { report: konReportId });
    expect(run.status).toBe(200);
    expect(run.json.result.rows).toEqual([
      { material: "brass", count: 1, weight: 40 },
      { material: "steel", count: 2, weight: 23 },
    ]);
    expect((await call("POST", "/api/reports/run", { report: `kon:${KON}/nope` })).status).toBe(
      404
    );
    expect((await call("POST", "/api/reports/run", { report: "not an id" })).status).toBe(404);
  });

  it("a dashboard runs its tiles and survives one that is gone", async () => {
    if (!dbAvailable) return;
    const missing = "00000000-0000-4000-8000-000000000000";
    let res = await call("POST", "/api/reports/dashboards", {
      name: `Board ${id}`,
      tiles: [{ report: "whatever" }],
    });
    expect(res.status).toBe(400);

    res = await call("POST", "/api/reports/dashboards", {
      name: `Board ${id}`,
      tiles: [
        { report: reportId, title: "Weight", width: 6 },
        { report: `kon:${KON}/parts-by-material`, width: 6 },
        { report: missing },
      ],
    });
    expect(res.status).toBe(201);
    const boardId = res.json.dashboard.id;

    res = await call("POST", `/api/reports/dashboards/${boardId}/run`);
    expect(res.status).toBe(200);
    expect(res.json.tiles).toHaveLength(3);
    expect(res.json.tiles[0]).toMatchObject({ title: "Weight", width: 6, error: null });
    expect(res.json.tiles[0].result.rows).toHaveLength(2);
    expect(res.json.tiles[1]).toMatchObject({ title: "Parts by material", error: null });
    expect(res.json.tiles[2]).toMatchObject({
      result: null,
      error: "The report no longer exists.",
    });

    res = await call("PATCH", `/api/reports/dashboards/${boardId}`, {
      tiles: [{ report: reportId }],
    });
    expect(res.json.dashboard.tiles).toHaveLength(1);
    expect(
      (await call("GET", "/api/reports/dashboards")).json.dashboards.some(
        (d: any) => d.id === boardId
      )
    ).toBe(true);
    expect((await call("DELETE", `/api/reports/dashboards/${boardId}`)).status).toBe(200);
    expect((await call("GET", `/api/reports/dashboards/${boardId}`)).status).toBe(404);
    expect((await call("DELETE", `/api/reports/${reportId}`)).status).toBe(200);
    expect((await call("POST", "/api/reports/run", { report: reportId })).status).toBe(404);
  });

  it("removing records shows in the next report", async () => {
    if (!dbAvailable) return;
    const [gear] = await konEntities.list(ENTITY, { where: { material: "brass" } });
    expect(await konEntities.remove(ENTITY, gear.id)).toBe(true);
    expect(await konEntities.remove(ENTITY, gear.id)).toBe(false);
    const res = await aggregate({ source: { dataset: ENTITY }, measures: [{ fn: "count" }] });
    expect(res.json.rows).toEqual([{ count: 2 }]);
  });
});
