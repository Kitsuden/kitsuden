/**
 * Limit on what leaves, against the real app (test Postgres)
 * ============================================================================
 *
 * A dataset marks `email` as customer data. Then:
 *
 *   · a code action reads it through `kitsuden.api` and tries to `fetch` it to a
 *     local server: refused, the server receives nothing, the block is audited;
 *     with the host in the action's `customerDataHosts` (set by a person) it goes;
 *   · a `webhook_out` action fired with an entry event sends the marked value
 *     redacted, or nothing with `customerData: "refuse"`, or the value when the
 *     host is allowed;
 *   · an agent notification carries the proposal result redacted;
 *   · an `agent` action whose run read the value (trigger event, tool result)
 *     sends its model provider the prompt redacted, unless the provider's host
 *     is allowed; the email tool refuses a third-party recipient and writes to
 *     the customer's own address;
 *   · a realtime subscriber without read access to the dataset receives none of
 *     its change events;
 *   · an agent (even with `admin`) cannot set `customerDataHosts`, nor remove
 *     the mark from the field; a person can.
 *
 * Only local servers on 127.0.0.1, with the internal-address opt-ins. The model
 * provider is a fake: `fetch` to `llm.fake-provider.test` is answered in process.
 */

import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { actions, agentTraceSteps, dataEntries, dataSets } from "../db/schema";
import { app } from "../index";
import { executeActionById } from "../lib/actions";
import { executeWebhookOutAction } from "../lib/actions/handlers/webhook-out-handler";
import { invalidateSensitivityCatalog } from "../lib/customer-data-catalog";
import { withoutCustomerData } from "../lib/proposal-notifications";
import { realtimeManager, setSessionValidator } from "../lib/realtime";
import { readCurrentSession } from "../lib/realtime-wiring";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

setDefaultTimeout(90_000);

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let cookie = "";
let agentToken = "";
let agentId = "";
let dataset: { id: string; slug: string };
const EMAIL = `customer.${Math.random().toString(36).slice(2, 8)}@example.com`;
const createdActions: string[] = [];

let server: Server;
let port = 0;
const received: string[] = [];

async function request(
  auth: { cookie?: string; token?: string },
  method: string,
  path: string,
  body?: unknown
) {
  const headers: Record<string, string> = { origin: ORIGIN, "Content-Type": "application/json" };
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function createAction(config: Record<string, unknown>, type = "code") {
  const slug = `cd-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const r = await request({ cookie }, "POST", "/api/actions", {
    name: slug,
    slug,
    type,
    trigger: "manual",
    config,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const { id } = (await r.json()) as { id: string };
  createdActions.push(id);
  return id;
}

const waitFor = async (check: () => Promise<boolean>, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe("customer data does not leave (real app)", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH = "true";
    process.env.KITSUDEN_WEBHOOK_ALLOW_INTERNAL = "true";
    process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE = "true";
    ({ cookie } = await enterAs(app, {
      email: `cd-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Customer Data Admin",
      role: "admin",
    }));
    const slug = `cd-clients-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const r = await request({ cookie }, "POST", "/api/datasets", {
      name: slug,
      slug,
      schema: [
        { id: "f1", key: "email", label: "Email", type: "text", sensitivity: "customer" },
        { id: "f2", key: "plan", label: "Plan", type: "text" },
      ],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    dataset = (await r.json()) as { id: string; slug: string };
    await db.insert(dataEntries).values({
      dataSetId: dataset.id,
      title: "row",
      data: { email: EMAIL, plan: "gold-plan" },
    } as never);
    invalidateSensitivityCatalog();

    const created = await createAgent({
      name: `cd-agent-${generateTestId()}`,
      scopes: ["admin"],
      rateLimit: 100_000,
    });
    agentToken = created.plainApiKey;
    agentId = created.agent.id;

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(`${req.method} ${req.url} ${body}`);
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  }, 90_000);

  afterAll(async () => {
    server?.close();
    delete process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH;
    delete process.env.KITSUDEN_WEBHOOK_ALLOW_INTERNAL;
    delete process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE;
    if (!dbAvailable) return;
    for (const id of createdActions) await db.delete(actions).where(eq(actions.id, id));
    if (dataset) await db.delete(dataSets).where(eq(dataSets.id, dataset.id));
  });

  const exfiltrate = () => `
    const rows = (await (await kitsuden.api.get('/api/datasets/${dataset.id}/entries')).json()).docs;
    try {
      const r = await fetch('http://127.0.0.1:${port}/collect', { method: 'POST', body: JSON.stringify(rows.map((x) => x.data)) });
      return 'sent ' + r.status;
    } catch (e) { return String(e.message || e); }`;

  it("a code action cannot fetch a marked value to a host not allowed, and the block is audited", async () => {
    if (!dbAvailable) return;
    received.length = 0;
    const id = await createAction({
      code: exfiltrate(),
      scopes: [`datasets:${dataset.slug}:read`],
      fetchAllow: ["127.0.0.1"],
      timeoutMs: 30_000,
    });
    const r = await executeActionById(id, {});
    expect(r.success, r.error).toBe(true);
    expect(String(r.result)).toMatch(/Customer data cannot be sent to 127\.0\.0\.1/);
    expect(String(r.result)).toContain(`dataset:${dataset.slug}.email`);
    expect(received).toEqual([]);

    const audited = await waitFor(async () => {
      const rows = (await db.execute(sql`
        SELECT details FROM agent_audit_logs
         WHERE action = 'customer_data_blocked' AND resource_id = ${id}`)) as unknown as {
        rows: Array<{ details: unknown }>;
      };
      return rows.rows.length > 0 && !JSON.stringify(rows.rows).includes(EMAIL);
    });
    expect(audited).toBe(true);
  });

  it("with the host in customerDataHosts (set by a person) it goes", async () => {
    if (!dbAvailable) return;
    received.length = 0;
    const id = await createAction({
      code: exfiltrate(),
      scopes: [`datasets:${dataset.slug}:read`],
      fetchAllow: ["127.0.0.1"],
      customerDataHosts: ["127.0.0.1"],
      timeoutMs: 30_000,
    });
    const r = await executeActionById(id, {});
    expect(String(r.result)).toBe("sent 200");
    expect(received.join("\n")).toContain(EMAIL);
  });

  const entryEvent = () => ({
    name: "entry.created",
    timestamp: new Date().toISOString(),
    data: {
      datasetId: dataset.id,
      entries: [
        {
          id: "e1",
          dataSetId: dataset.id,
          title: "row",
          data: { email: EMAIL, plan: "gold-plan" },
        },
      ],
    },
  });

  const webhook = (config: Record<string, unknown>) =>
    executeWebhookOutAction(
      {
        id: "a",
        config: {
          url: `http://127.0.0.1:${port}/hook`,
          retryPolicy: { maxRetries: 0, backoffMs: 0 },
          ...config,
        },
      } as never,
      {
        actionId: "a",
        actionName: "n",
        executionId: `x-${generateTestId()}`,
        event: entryEvent(),
      } as never
    );

  it("webhook_out redacts marked values for a host not allowed", async () => {
    if (!dbAvailable) return;
    received.length = 0;
    const r = await webhook({});
    expect(r.success, r.error).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).not.toContain(EMAIL);
    expect(received[0]).toContain("[redacted: customer data]");
    expect(received[0]).toContain("gold-plan");
  });

  it("webhook_out with customerData: refuse sends nothing", async () => {
    if (!dbAvailable) return;
    received.length = 0;
    const r = await webhook({ customerData: "refuse" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Customer data cannot be sent/);
    expect(received).toEqual([]);
  });

  it("webhook_out to a host allowed for customer data sends the value", async () => {
    if (!dbAvailable) return;
    received.length = 0;
    const r = await webhook({ customerDataHosts: ["127.0.0.1"] });
    expect(r.success).toBe(true);
    expect(received[0]).toContain(EMAIL);
  });

  it("an agent notification carries the proposal result redacted", async () => {
    if (!dbAvailable) return;
    const view = await withoutCustomerData(
      {
        id: "p1",
        status: "executed",
        path: `/api/datasets/${dataset.id}/entries`,
        result: {
          status: 201,
          body: { id: "e2", dataSetId: dataset.id, data: { email: EMAIL, plan: "x-plan" } },
        },
      },
      "hooks.example.com",
      agentId
    );
    expect(JSON.stringify(view)).not.toContain(EMAIL);
    expect(JSON.stringify(view)).toContain("x-plan");
  });

  // ── agent actions: the prompt to the model provider, and the email tool ──

  describe("agent runs", () => {
    const LLM_HOST = "llm.fake-provider.test";
    const realFetch = globalThis.fetch;
    const bodies: string[] = [];
    type Step = { content: string } | { tool: string; args: Record<string, unknown> };
    let script: Step[] = [];
    const saved: Record<string, string | undefined> = {};
    const ENV = [
      "KITSUDEN_LLM_PROVIDER",
      "KITSUDEN_LLM_MODEL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ];

    const completion = (step: Step) => ({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "fake-model",
      choices: [
        "tool" in step
          ? {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
            }
          : {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: step.content },
            },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    beforeAll(() => {
      for (const k of ENV) saved[k] = process.env[k];
      process.env.KITSUDEN_LLM_PROVIDER = "openai";
      process.env.KITSUDEN_LLM_MODEL = "fake-model";
      process.env.OPENAI_API_KEY = "sk-test-fake-provider";
      process.env.OPENAI_BASE_URL = `http://${LLM_HOST}/v1`;
      // The fake model provider: only its host is answered here.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes(LLM_HOST)) return realFetch(input as never, init);
        if (!url.endsWith("/chat/completions")) {
          return new Response(JSON.stringify({ error: { message: "not here" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return new Response(JSON.stringify(completion(script.shift() ?? { content: "done" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (!dbAvailable) return;
      try {
        await db.execute(sql`DELETE FROM kitsuden_outbox WHERE payload->>'to' = ${EMAIL}`);
      } catch {
        /* best effort */
      }
    });

    async function runAction(config: Record<string, unknown>, steps: Step[], withEvent = true) {
      bodies.length = 0;
      script = [...steps];
      const id = await createAction(
        { agentId, enableMemory: false, enableBrainSearch: false, ...config },
        "agent"
      );
      const r = await executeActionById(id, withEvent ? { event: entryEvent() } : {});
      expect(r.success, r.error).toBe(true);
      const traceId = (r.result as { traceId: string }).traceId;
      const steps_ = await db
        .select()
        .from(agentTraceSteps)
        .where(eq(agentTraceSteps.traceId, traceId));
      const toolResults = steps_
        .filter((s) => s.stepType === "tool_call")
        .map((s) => s.content ?? "");
      return { id, sent: bodies.join("\n"), calls: bodies.length, toolResults };
    }

    const auditedFor = (id: string, channel: string) =>
      waitFor(async () => {
        const rows = (await db.execute(sql`
          SELECT details FROM agent_audit_logs
           WHERE action = 'customer_data_blocked' AND resource = ${channel} AND resource_id = ${id}`)) as unknown as {
          rows: Array<{ details: unknown }>;
        };
        return rows.rows.length > 0 && !JSON.stringify(rows.rows).includes(EMAIL);
      });

    it("a marked value templated from the trigger event reaches the provider redacted, and it is audited", async () => {
      if (!dbAvailable) return;
      const run = generateTestId();
      const { id, sent, calls } = await runAction(
        { promptTemplate: `Welcome {{entries.0.data.email}} (run ${run})` },
        [{ content: "done" }]
      );
      expect(calls).toBe(1);
      expect(sent).toContain(run);
      expect(sent).not.toContain(EMAIL);
      expect(sent).toContain("[redacted: customer data]");
      expect(await auditedFor(id, "model_prompt")).toBe(true);
    });

    it("a marked value in a tool result does not reach the provider on the next call", async () => {
      if (!dbAvailable) return;
      const run = generateTestId();
      const { sent, calls, toolResults } = await runAction(
        { promptTemplate: `List the clients (run ${run})` },
        [
          { tool: "kitsuden_query_dataset", args: { datasetId: dataset.id, format: "json" } },
          { content: "done" },
        ],
        false
      );
      expect(calls).toBe(2);
      // The tool did read it (the trace keeps what the run received)…
      expect(toolResults.join("\n")).toContain(EMAIL);
      // …and the provider never saw it.
      expect(sent).not.toContain(EMAIL);
      expect(sent).toContain("gold-plan");
    });

    it("with the provider's host allowed for customer data (by a person), the prompt goes as written", async () => {
      if (!dbAvailable) return;
      const run = generateTestId();
      const { sent } = await runAction(
        {
          promptTemplate: `Welcome {{entries.0.data.email}} (run ${run})`,
          customerDataHosts: [LLM_HOST],
        },
        [{ content: "done" }]
      );
      expect(sent).toContain(EMAIL);
    });

    it("the email tool refuses to send a marked value to a third party", async () => {
      if (!dbAvailable) return;
      const run = generateTestId();
      const { id, toolResults } = await runAction(
        { promptTemplate: `Tell our partner (run ${run})` },
        [
          {
            tool: "kitsuden_dispatch_worker",
            args: {
              queueName: "email",
              jobName: "lead",
              payload: {
                to: "partner@thirdparty.test",
                subject: "New lead",
                html: `<p>${EMAIL}</p>`,
              },
            },
          },
          { content: "done" },
        ]
      );
      expect(toolResults.join("\n")).toMatch(/Customer data cannot be emailed to thirdparty\.test/);
      expect(await auditedFor(id, "email")).toBe(true);
    });

    it("the email tool writes to the customer whose address was read", async () => {
      if (!dbAvailable) return;
      const run = generateTestId();
      const { toolResults } = await runAction({ promptTemplate: `Welcome them (run ${run})` }, [
        {
          tool: "kitsuden_dispatch_worker",
          args: {
            queueName: "email",
            jobName: "welcome",
            payload: { to: EMAIL, subject: "Welcome", html: `<p>Hello ${EMAIL}</p>` },
          },
        },
        { content: "done" },
      ]);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).not.toMatch(/Customer data/);
      expect(toolResults[0]).toMatch(/Job dispatched/);
    });
  });

  // ── realtime: a read path with the subscriber's own permissions ──

  it("a realtime subscriber without read access to the dataset receives none of its change events", async () => {
    if (!dbAvailable) return;
    const channel = `table:${dataset.slug}`;
    const got: Record<string, string[]> = { user: [], admin: [] };
    const socket = (who: string) => ({ send: (s: string) => got[who]!.push(s) }) as never;
    const event = () =>
      JSON.stringify({
        type: "INSERT",
        resource: dataset.slug,
        row: {
          id: generateTestId(),
          dataSetId: dataset.id,
          status: "published",
          data: { email: EMAIL },
        },
        at: new Date().toISOString(),
      });
    // Delivered in this process only (the private local fan-out; no Valkey).
    const deliver = (data: string) =>
      (
        realtimeManager as unknown as { broadcastToChannel(c: string, m: string): void }
      ).broadcastToChannel(channel, data);
    const setPolicy = async (readAccess: string) => {
      const r = await request({ cookie }, "PATCH", `/api/datasets/${dataset.id}`, {
        policyJson: { readAccess, writeAccess: "admin" },
      });
      expect(r.status, await r.clone().text()).toBe(200);
    };

    // Sockets are revalidated against their session on every subscribe: these fake
    // clients carry a session that only this test's validator knows.
    const roles: Record<string, string> = {
      "cd-rt-user-id": "user",
      "cd-rt-admin-id": "admin",
      "cd-rt-other-id": "user",
    };
    setSessionValidator(async (sessionId) => {
      const userId = sessionId.replace(/^session-/, "");
      return roles[userId]
        ? { userId, role: roles[userId]!, expiresAt: Date.now() + 3_600_000 }
        : null;
    });
    const session = (userId: string) => ({
      id: `session-${userId}`,
      expiresAt: Date.now() + 3_600_000,
    });

    try {
      // Readable by any signed-in user: both subscribe and receive it.
      await setPolicy("authenticated");
      realtimeManager.addClient(
        "cd-rt-user",
        socket("user"),
        "cd-rt-user-id",
        "user",
        session("cd-rt-user-id")
      );
      realtimeManager.addClient(
        "cd-rt-admin",
        socket("admin"),
        "cd-rt-admin-id",
        "admin",
        session("cd-rt-admin-id")
      );
      await realtimeManager.subscribeToChannel("cd-rt-user", channel);
      await realtimeManager.subscribeToChannel("cd-rt-admin", channel);
      deliver(event());
      expect(await waitFor(async () => got.user!.some((s) => s.includes(EMAIL)))).toBe(true);

      // Tightened to admins (through the API): the next event reaches only the admin.
      await setPolicy("admin");
      got.user!.length = 0;
      got.admin!.length = 0;
      deliver(event());
      expect(await waitFor(async () => got.admin!.some((s) => s.includes(EMAIL)))).toBe(true);
      expect(got.user!.some((s) => s.includes(EMAIL))).toBe(false);

      // A new subscriber without read access is not even subscribed.
      realtimeManager.addClient(
        "cd-rt-other",
        socket("user"),
        "cd-rt-other-id",
        "user",
        session("cd-rt-other-id")
      );
      got.user!.length = 0;
      await realtimeManager.subscribeToChannel("cd-rt-other", channel);
      expect(got.user!.join("\n")).toMatch(/Not authorized/);
      deliver(event());
      await waitFor(async () => got.admin!.length >= 2);
      expect(got.user!.some((s) => s.includes(EMAIL))).toBe(false);
    } finally {
      for (const c of ["cd-rt-user", "cd-rt-admin", "cd-rt-other"]) realtimeManager.removeClient(c);
      setSessionValidator(readCurrentSession);
    }
  });

  it("an agent cannot set customerDataHosts on an action", async () => {
    if (!dbAvailable) return;
    const slug = `cd-agent-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const r = await request({ token: agentToken }, "POST", "/api/actions", {
      name: slug,
      slug,
      type: "webhook_out",
      trigger: "manual",
      config: { url: "https://hooks.example.com/x", customerDataHosts: ["hooks.example.com"] },
    });
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/customer data/i);

    const id = await createAction({ url: "https://hooks.example.com/x" }, "webhook_out");
    const patch = await request({ token: agentToken }, "PATCH", `/api/actions/${id}`, {
      config: { url: "https://hooks.example.com/x", customerDataHosts: ["hooks.example.com"] },
    });
    expect(patch.status).toBe(403);
    // A person can.
    const human = await request({ cookie }, "PATCH", `/api/actions/${id}`, {
      config: { url: "https://hooks.example.com/x", customerDataHosts: ["hooks.example.com"] },
    });
    expect(human.status).toBe(200);
  });

  it("an agent cannot remove the mark from a field; a person can", async () => {
    if (!dbAvailable) return;
    const unmarked = [
      { id: "f1", key: "email", label: "Email", type: "text" },
      { id: "f2", key: "plan", label: "Plan", type: "text" },
    ];
    const byAgent = await request({ token: agentToken }, "PATCH", `/api/datasets/${dataset.id}`, {
      schema: unmarked,
    });
    expect(byAgent.status, await byAgent.clone().text()).toBe(403);
    // Adding marks is fine for an agent.
    const adds = await request({ token: agentToken }, "PATCH", `/api/datasets/${dataset.id}`, {
      schema: [
        { id: "f1", key: "email", label: "Email", type: "text", sensitivity: "customer" },
        { id: "f2", key: "plan", label: "Plan", type: "text", sensitivity: "personal" },
      ],
    });
    expect(adds.status, await adds.clone().text()).toBe(200);
    const byHuman = await request({ cookie }, "PATCH", `/api/datasets/${dataset.id}`, {
      schema: unmarked,
    });
    expect(byHuman.status).toBe(200);
  });
});
