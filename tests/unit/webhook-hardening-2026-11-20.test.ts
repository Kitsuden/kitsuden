/**
 * Webhooks: what the 2026-11-20 review found
 * ============================================================================
 *
 *  · webhook_in computed the HMAC over `JSON.stringify(parsedBody)`, not over the
 *    bytes that arrived: a sender's valid signature failed (key order, spacing,
 *    escapes) and two different bodies could share one serialization.
 *  · webhook_in accepted the request when no secret was configured (bearer), and
 *    an action without `authType` accepted anyone.
 *  · `core:webhook` retried by sleeping in the process: a restart lost the
 *    retries. Now one attempt inline and the rest on the durable queue, whose
 *    payload carries no secret.
 */

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAction = vi.fn();
vi.mock("../../apps/api/src/lib/actions/engine", () => ({ getAction }));

const fetchCalls: Array<{ url: string; body?: string }> = [];
let answer: () => Promise<Response> = async () => new Response("ok", { status: 200 });
vi.mock("../../apps/api/src/lib/safe-fetch", async (original) => {
  const real = (await original()) as Record<string, unknown>;
  return {
    ...real,
    pinnedFetch: vi.fn(async (url: string | URL, init: { body?: string }) => {
      fetchCalls.push({ url: String(url), body: init.body });
      return answer();
    }),
  };
});

import {
  executeWebhookInAction,
  webhookInConfigProblem,
  type WebhookInRequest,
} from "../../apps/api/src/lib/actions/handlers/webhook-in-handler";
import { retryableWebhookFailure } from "../../apps/api/src/lib/actions/handlers/webhook-out-handler";
import {
  deliverRuleWebhook,
  executeRuleAction,
  RULE_WEBHOOKS_QUEUE,
} from "../../apps/api/src/lib/actions/rules";
import type { Action, ActionContext } from "../../apps/api/src/lib/actions/types";
import { setResolverForTests } from "../../apps/api/src/lib/safe-fetch";
import { configureQueue, PermanentError } from "../../packages/engine/src/queue";

const SECRET = "a-long-enough-signing-secret";
const context = {
  actionId: "a1",
  actionName: "hook",
  actionType: "webhook_in",
  trigger: "manual",
  env: {},
  executionId: "exec-1",
  startedAt: new Date(),
} as unknown as ActionContext;
const action = (config: Record<string, unknown>) =>
  ({ id: "a1", name: "hook", type: "webhook_in", config }) as unknown as Action;
const request = (over: Partial<WebhookInRequest>): WebhookInRequest => ({
  method: "POST",
  path: "/",
  headers: {},
  body: {},
  ...over,
});
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("webhook_in: the signature covers the raw body", () => {
  // Spacing and key order a sender really uses; JSON.stringify of the parsed body differs.
  const raw = '{ "b": 2, "a": "\\u00e9" }';
  const parsed = JSON.parse(raw);

  it("a signature over the raw bytes is accepted", async () => {
    const result = await executeWebhookInAction(
      action({ authType: "hmac", secret: SECRET }),
      context,
      request({ body: parsed, rawBody: raw, headers: { "x-hub-signature-256": sign(raw) } })
    );
    expect(result.success).toBe(true);
  });

  it("a signature over a re-serialization does not stand in for the raw body", async () => {
    const result = await executeWebhookInAction(
      action({ authType: "hmac", secret: SECRET }),
      context,
      request({
        body: parsed,
        rawBody: raw,
        headers: { "x-hub-signature-256": sign(JSON.stringify(parsed)) },
      })
    );
    expect(result.success).toBe(false);
  });

  it("without the raw body, a parsed object is never re-serialized to check it", async () => {
    const result = await executeWebhookInAction(
      action({ authType: "hmac", secret: SECRET }),
      context,
      request({ body: parsed, headers: { "x-hub-signature-256": sign(JSON.stringify(parsed)) } })
    );
    expect(result.success).toBe(false);
  });
});

describe("webhook_in: no secret, no entry", () => {
  it("bearer without a secret refuses (it used to accept anyone)", async () => {
    const result = await executeWebhookInAction(
      action({ authType: "bearer" }),
      context,
      request({ headers: { authorization: "Bearer anything" } })
    );
    expect(result.success).toBe(false);
  });

  it("no authType refuses; only an explicit `none` is open", async () => {
    expect((await executeWebhookInAction(action({}), context, request({}))).success).toBe(false);
    expect(
      (await executeWebhookInAction(action({ authType: "none" }), context, request({}))).success
    ).toBe(true);
  });

  it("the config cannot be saved without them", () => {
    expect(webhookInConfigProblem({})).toMatch(/authType is required/);
    expect(webhookInConfigProblem({ authType: "hmac" })).toMatch(/secret/);
    expect(webhookInConfigProblem({ authType: "bearer", secret: "short" })).toMatch(/16/);
    expect(webhookInConfigProblem({ authType: "hmac", secret: SECRET })).toBeNull();
    expect(webhookInConfigProblem({ authType: "none" })).toBeNull();
  });
});

describe("which webhook failures are retried", () => {
  it("no answer, 5xx and 429 yes; 4xx and refusals no", () => {
    const r = (o: object) => ({ success: false, durationMs: 0, ...o });
    expect(retryableWebhookFailure(r({ unanswered: true }))).toBe(true);
    expect(retryableWebhookFailure(r({ httpResponse: { statusCode: 503 } }))).toBe(true);
    expect(retryableWebhookFailure(r({ httpResponse: { statusCode: 429 } }))).toBe(true);
    expect(retryableWebhookFailure(r({ httpResponse: { statusCode: 400 } }))).toBe(false);
    expect(retryableWebhookFailure(r({ error: "resolves to an internal address" }))).toBe(false);
  });
});

describe("core:webhook: retries on the durable queue", () => {
  const dispatched: Array<{ queue: string; name: string; payload: unknown; options: any }> = [];
  const rule = {
    id: "r1",
    name: "rule",
    type: "rule",
    status: "active",
    createdById: null,
    config: {
      steps: [
        { handler: "core:webhook", config: { url: "https://hooks.example.com/x", secret: SECRET } },
      ],
    },
  } as unknown as Action;
  const ruleContext = {
    ...context,
    actionId: "r1",
    actionType: "rule",
    trigger: "event",
    event: { name: "deal.won", data: { id: 7 }, timestamp: "2026-11-20T00:00:00Z" },
  } as unknown as ActionContext;

  beforeEach(() => {
    dispatched.length = 0;
    fetchCalls.length = 0;
    setResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    configureQueue({
      dispatch: async (queue: string, name: string, payload: unknown, options: unknown) => {
        dispatched.push({ queue, name, payload, options });
        return { id: "job-1", deduplicated: false };
      },
    } as never);
  });
  afterEach(() => {
    configureQueue(null);
    setResolverForTests(null);
    answer = async () => new Response("ok", { status: 200 });
  });

  it("one attempt inline; a 503 queues the retries, with no secret in the payload", async () => {
    answer = async () => new Response("busy", { status: 503 });
    const result = await executeRuleAction(rule, ruleContext);
    expect(fetchCalls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect((result.result as any).steps[0].result).toMatchObject({
      retrying: true,
      jobId: "job-1",
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.queue).toBe(RULE_WEBHOOKS_QUEUE);
    expect(dispatched[0]!.options.dedupeKey).toBe("exec-1:0");
    expect(JSON.stringify(dispatched[0]!.payload)).not.toContain(SECRET);
  });

  it("a 400 is final: the step fails and nothing is queued", async () => {
    answer = async () => new Response("bad", { status: 400 });
    const result = await executeRuleAction(rule, ruleContext);
    expect(result.success).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("the queued delivery re-reads the rule: signs with its current secret", async () => {
    getAction.mockResolvedValueOnce(rule);
    await deliverRuleWebhook({
      payload: {
        actionId: "r1",
        stepIndex: 0,
        executionId: "exec-1",
        event: ruleContext.event,
        trigger: "event",
      },
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("the queued delivery throws on 5xx (the queue backs off) and gives up on 4xx", async () => {
    getAction.mockResolvedValue(rule);
    const job = {
      payload: {
        actionId: "r1",
        stepIndex: 0,
        executionId: "exec-1",
        event: null,
        trigger: "event",
      },
    };
    answer = async () => new Response("busy", { status: 502 });
    await expect(deliverRuleWebhook(job)).rejects.not.toBeInstanceOf(PermanentError);
    answer = async () => new Response("gone", { status: 410 });
    await expect(deliverRuleWebhook(job)).rejects.toBeInstanceOf(PermanentError);
    getAction.mockReset();
  });

  it("a rule paused or deleted since sends nothing", async () => {
    getAction.mockResolvedValueOnce({ ...rule, status: "paused" });
    await deliverRuleWebhook({
      payload: { actionId: "r1", stepIndex: 0, executionId: "e", event: null, trigger: "event" },
    });
    getAction.mockResolvedValueOnce(null);
    await deliverRuleWebhook({
      payload: { actionId: "r1", stepIndex: 0, executionId: "e", event: null, trigger: "event" },
    });
    expect(fetchCalls).toHaveLength(0);
  });
});
