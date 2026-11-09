/**
 * Notify the agent when its proposal is resolved, against
 * real Postgres and a local HTTP receiver:
 *   · the `t=…,v1=…` signature is verified with the secret and expires;
 *   · the secret is shown ONCE (when setting the URL or rotating it);
 *   · the webhook goes out through the queue: headers, signed body, retry if the
 *     receiver fails and «dead letter» if it responds 410;
 *   · the bus carries the resolution to the SSE stream (`proposal:<id>`);
 *   · the SSE operation is published in OpenAPI as a stream and kept out of MCP.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { openApiOperation } from "../lib/operations-openapi";
import {
  notificationSettings,
  notifyResolution,
  proposalChannel,
  sign,
  saveNotificationUrl,
  invalidUrlReason,
  rotateNotificationSecret,
  verifySignature,
} from "../lib/proposal-notifications";
import { pauseWorker, processPending, setupWorkers, shutdownQueues } from "../lib/queue";
import { subscribe } from "../lib/valkey";
import { proposalOperations } from "../routes/approvals";

import { isDatabaseAvailable } from "./setup";

const AGENT = `agent-notices-${crypto.randomUUID().slice(0, 8)}`;
let available = false;
let server: ReturnType<typeof Bun.serve> | null = null;
let response = 200;
const receivedValues: Array<{ headers: Headers; body: string }> = [];

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

async function agentJobs() {
  return rows(
    await db.execute(sql`SELECT status, attempts, last_error FROM kitsuden_outbox
      WHERE queue = 'kitsuden-webhooks' AND payload->>'agentId' = ${AGENT} ORDER BY created_at`)
  );
}

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE = "true";
  process.env.KITSUDEN_SECRETS_KEY ??= "test-suite-secrets-key-0123456789abcdef-0123456789";
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      receivedValues.push({ headers: req.headers, body: await req.text() });
      return new Response(null, { status: response });
    },
  });
  await db.execute(
    sql`INSERT INTO agent_identities (id, name) VALUES (${AGENT}, 'notices') ON CONFLICT DO NOTHING`
  );
  await setupWorkers();
  pauseWorker(true);
});

beforeEach(async () => {
  if (!available) return;
  receivedValues.length = 0;
  response = 200;
  await db.execute(
    sql`DELETE FROM kitsuden_outbox WHERE queue = 'kitsuden-webhooks' AND payload->>'agentId' = ${AGENT}`
  );
});

afterAll(async () => {
  if (!available) return;
  server?.stop(true);
  await db.execute(
    sql`DELETE FROM kitsuden_outbox WHERE queue = 'kitsuden-webhooks' AND payload->>'agentId' = ${AGENT}`
  );
  await db.execute(sql`DELETE FROM agent_identities WHERE id = ${AGENT}`);
  await shutdownQueues();
  delete process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE;
});

describe("signature", () => {
  it("verifies with the secret, fails with another secret, another body or an old t", () => {
    const s = "whsec_test";
    const header = sign(s, '{"a":1}');
    expect(verifySignature(s, '{"a":1}', header)).toBe(true);
    expect(verifySignature("other", '{"a":1}', header)).toBe(false);
    expect(verifySignature(s, '{"a":2}', header)).toBe(false);
    expect(
      verifySignature(s, '{"a":1}', sign(s, '{"a":1}', Math.floor(Date.now() / 1000) - 3600))
    ).toBe(false);
  });

  it("the notification URL: https, no credentials", () => {
    delete process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE;
    expect(invalidUrlReason("http://example.com/h")).toMatch(/https/);
    expect(invalidUrlReason("https://u:p@example.com/h")).toMatch(/credentials/);
    expect(invalidUrlReason("https://example.com/h")).toBeNull();
    process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE = "true";
  });
});

describe("webhook notifications (Postgres queue)", () => {
  it("the secret is shown once: when setting the URL; rotating it gives another", async () => {
    if (!available) return;
    const first = await saveNotificationUrl(
      AGENT,
      `http://127.0.0.1:${server!.port}/hook`,
      "admin-1"
    );
    expect(first.secret).toMatch(/^whsec_/);
    const other = await saveNotificationUrl(
      AGENT,
      `http://127.0.0.1:${server!.port}/hook`,
      "admin-1"
    );
    expect(other.secret).toBeUndefined();
    expect(await notificationSettings(AGENT)).toEqual({
      url: `http://127.0.0.1:${server!.port}/hook`,
      hasSecret: true,
    });
    const rotated = await rotateNotificationSecret(AGENT, "admin-1");
    expect(rotated).not.toBe(first.secret);
  });

  it("an executed proposal sends a signed POST with its event and its delivery id", async () => {
    if (!available) return;
    const secret = await rotateNotificationSecret(AGENT, "admin-1");
    await notifyResolution(AGENT, {
      id: "11111111-2222-4333-8444-555555555555",
      status: "executed",
    });
    await processPending();
    expect(receivedValues).toHaveLength(1);
    const r = receivedValues[0]!;
    expect(r.headers.get("x-kitsuden-event")).toBe("proposal.executed");
    expect(r.headers.get("x-kitsuden-delivery")).toMatch(/^[0-9a-f-]{36}$/);
    expect(verifySignature(secret, r.body, r.headers.get("x-kitsuden-signature") ?? "")).toBe(true);
    expect(JSON.parse(r.body)).toMatchObject({
      type: "proposal.executed",
      agentId: AGENT,
      proposal: { status: "executed" },
    });
    expect((await agentJobs())[0]?.status).toBe("done");
  });

  it("a status that is not final does not notify", async () => {
    if (!available) return;
    await notifyResolution(AGENT, {
      id: "11111111-2222-4333-8444-555555555556",
      status: "pending",
    });
    expect(await agentJobs()).toHaveLength(0);
  });

  it("if the receiver fails it is retried; if it responds 410, to the dead letter", async () => {
    if (!available) return;
    response = 503;
    await notifyResolution(AGENT, {
      id: "11111111-2222-4333-8444-555555555557",
      status: "rejected",
    });
    await processPending();
    let [t] = await agentJobs();
    expect(t?.status).toBe("pending");
    expect(String(t?.last_error)).toContain("503");

    response = 410;
    await db.execute(
      sql`UPDATE kitsuden_outbox SET run_at = now() WHERE queue = 'kitsuden-webhooks' AND payload->>'agentId' = ${AGENT}`
    );
    await processPending();
    [t] = await agentJobs();
    expect(t?.status).toBe("dead");
  });

  it("without a notification URL nothing is enqueued (the agent still has the SSE)", async () => {
    if (!available) return;
    await saveNotificationUrl(AGENT, null, "admin-1");
    await notifyResolution(AGENT, {
      id: "11111111-2222-4333-8444-555555555558",
      status: "expired",
    });
    expect(await agentJobs()).toHaveLength(0);
  });
});

describe("SSE notifications", () => {
  it("the resolution reaches the proposal's channel through the bus", async () => {
    if (!available) return;
    const id = "11111111-2222-4333-8444-555555555559";
    const received: unknown[] = [];
    const leaveNow = await subscribe(proposalChannel(id), (_c, m) => received.push(JSON.parse(m)));
    await notifyResolution(AGENT, { id, status: "failed" });
    await new Promise((r) => setTimeout(r, 20));
    await leaveNow();
    expect(received).toEqual([{ id, status: "failed" }]);
  });

  it("the events operation is a stream in OpenAPI and is kept out of MCP", () => {
    const op = proposalOperations.find((o) => o.id === "proposal-events")!;
    expect(op).toBeDefined();
    const { path, operation: operation } = openApiOperation("kon-proposals", "/api/proposals", op);
    expect(path).toBe("/proposals/{id}/events");
    const x = operation["x-kitsuden-operation"] as {
      stream?: boolean;
      mcp?: { excluded?: string };
    };
    expect(x.stream).toBe(true);
    expect(x.mcp?.excluded).toBeTruthy();
  });
});
