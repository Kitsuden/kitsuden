/**
 * Notify the agent when its proposal is resolved (plan B3)
 * ============================================================================
 *
 * Before, the agent received `202` with `/api/proposals/<id>` and had no
 * choice but to poll. Now, when the proposal ends up EXECUTED, FAILED,
 * REJECTED or EXPIRED:
 *
 *   1. An event on the bus (`proposal:<id>`): served by the SSE flow
 *      `GET /api/proposals/<id>/events` (routes/approvals.ts). It works without
 *      configuring anything, with or without Valkey.
 *   2. If an admin gave the agent a notification URL, a SIGNED webhook to
 *      that URL, delivered by the Postgres queue (`kitsuden-webhooks`):
 *      retries with backoff, a «dead letter» in the panel, and ATOMIC with the
 *      decision (if the approving request is rolled back, nothing goes out).
 *
 * ── THE SIGNATURE ──────────────────────────────────────────────────────────
 *
 *   X-Kitsuden-Event:     proposal.executed | proposal.failed | proposal.rejected | proposal.expired
 *   X-Kitsuden-Delivery:  job id (the same on each retry: deduplicates)
 *   X-Kitsuden-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *
 * The receiver recomputes the HMAC over the RAW body and rejects a `t` older
 * than 5 minutes (replay). The secret is per agent, stored encrypted and
 * shown only once (when configuring the URL or when rotating it).
 *
 * ── WHERE IT IS NOT SENT ───────────────────────────────────────────────────
 *
 * Only `https://` and to public addresses (the name is resolved and
 * loopback, private network, link-local… are rejected: the same filter as the OAuth
 * metadata). For development, `KITSUDEN_WEBHOOKS_ALLOW_PRIVATE=true`
 * allows `http://` and private addresses.
 *
 * ── CUSTOMER DATA ─────────────────────────────────────────────────────────
 *
 * The result of an executed proposal can carry fields marked as customer data
 * (the row it created). Unless the notification host is in
 * `KITSUDEN_CUSTOMER_DATA_HOSTS`, those values are redacted before sending
 * (lib/customer-data.ts); the block is audited.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { PermanentError, queue, type QueueJob } from "../../../../packages/engine/src/queue";
import { db } from "../db";
import { decryptSecret, encryptSecret, type EncryptedValue } from "../services/secrets";

import {
  customerDataHosts,
  datasetFromPath,
  hostAllowedForCustomerData,
  MarkedValues,
} from "./customer-data";
import { loadSensitivityCatalog, recordEgressBlock } from "./customer-data-catalog";
import { logger } from "./logger";
import { pinnedFetch, resolveTarget } from "./safe-fetch";
import { publish } from "./valkey";

export const WEBHOOKS_QUEUE = "kitsuden-webhooks";
const FINAL_STATES = new Set(["executed", "failed", "rejected", "expired"]);

/** What the agent sees of its proposal (`agentView`), the minimum used here. */
export interface ProposalView {
  id: string;
  status: string;
  [k: string]: unknown;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

/** Bus channel of a proposal (listened to by the SSE flow). */
export function proposalChannel(id: string): string {
  return `proposal:${id}`;
}

/**
 * The proposal was resolved: notifies over the bus and, if the agent has a notification
 * URL, enqueues the webhook (in the current transaction, if there is one).
 */
export async function notifyResolution(agentId: string, view: ProposalView): Promise<void> {
  if (!FINAL_STATES.has(view.status)) return;
  await publish(proposalChannel(view.id), view).catch(() => undefined);
  try {
    const [cfg] = rows(
      await db.execute(
        sql`SELECT url FROM agent_notify_settings WHERE agent_id = ${agentId} AND url IS NOT NULL`
      )
    );
    if (!cfg) return;
    await queue.dispatch(
      WEBHOOKS_QUEUE,
      `proposal.${view.status}`,
      { agentId, proposal: view },
      { attempts: 8 }
    );
  } catch (err) {
    // Without the table (unmigrated database) or without a queue: the agent can still poll.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), proposalId: view.id },
      "[notifications] could not enqueue the webhook"
    );
  }
}

// ── The signature ──────────────────────────────────────────────────────────

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** For the receiver (and tests): is the signature for this body and recent? */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceS = 300
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2) as [string, string])
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS || !parts.v1)
    return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const receivedValue = Buffer.from(parts.v1);
  return expected.length === receivedValue.length && timingSafeEqual(expected, receivedValue);
}

// ── The destination ────────────────────────────────────────────────────────

function allowedPrivate(): boolean {
  return process.env.KITSUDEN_WEBHOOKS_ALLOW_PRIVATE === "true";
}

/** Validates the notification URL (when saving it). Returns the reason if it is not valid. */
export function invalidUrlReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Not a valid URL";
  }
  if (u.username || u.password) return "The URL cannot carry credentials";
  if (u.protocol !== "https:" && !(allowedPrivate() && u.protocol === "http:")) {
    return "The notify URL must be https://";
  }
  if (url.length > 2000) return "URL too long";
  return null;
}

/** On delivery: the name is resolved and no address may be private. */
async function allowedTarget(url: URL): Promise<boolean> {
  if (allowedPrivate()) return true;
  return resolveTarget(url.hostname).then(
    () => true,
    () => false
  );
}

// ── Per-agent configuration (panel) ───────────────────────────────────────

export async function notificationSettings(
  agentId: string
): Promise<{ url: string | null; hasSecret: boolean }> {
  const [f] = rows(
    await db.execute(
      sql`SELECT url, secret IS NOT NULL AS has_secret FROM agent_notify_settings WHERE agent_id = ${agentId}`
    )
  );
  return { url: (f?.url as string | null) ?? null, hasSecret: f?.has_secret === true };
}

function newSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/**
 * Sets (or removes, with `null`) the notification URL. If there was no secret, it creates it and
 * returns it: it is the ONLY time it is seen.
 */
export async function saveNotificationUrl(
  agentId: string,
  url: string | null,
  by: string
): Promise<{ url: string | null; secret?: string }> {
  const actual = await notificationSettings(agentId);
  let secret: string | undefined;
  if (url && !actual.hasSecret) secret = newSecret();
  const encrypted = secret ? JSON.stringify(encryptSecret(secret)) : null;
  await db.execute(sql`
    INSERT INTO agent_notify_settings (agent_id, url, secret, updated_by, updated_at)
    VALUES (${agentId}, ${url}, ${encrypted}::jsonb, ${by}, now())
    ON CONFLICT (agent_id) DO UPDATE
      SET url = EXCLUDED.url,
          secret = COALESCE(EXCLUDED.secret, agent_notify_settings.secret),
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`);
  return { url, ...(secret ? { secret } : {}) };
}

/** Rotates the secret (the previous one stops being valid immediately). Seen once. */
export async function rotateNotificationSecret(agentId: string, by: string): Promise<string> {
  const secret = newSecret();
  await db.execute(sql`
    INSERT INTO agent_notify_settings (agent_id, secret, updated_by, updated_at)
    VALUES (${agentId}, ${JSON.stringify(encryptSecret(secret))}::jsonb, ${by}, now())
    ON CONFLICT (agent_id) DO UPDATE
      SET secret = EXCLUDED.secret, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  return secret;
}

// ── The delivery (the queue handler) ───────────────────────────────────────

interface NotificationJob {
  agentId: string;
  proposal: ProposalView;
}

export async function deliverNotification(job: QueueJob): Promise<void> {
  const { agentId, proposal } = (job.payload ?? {}) as NotificationJob;
  if (!agentId || !proposal?.id) throw new PermanentError("payload without agent or proposal");
  // The URL and the secret are read NOW: if the admin removed it, nothing is sent.
  const [cfg] = rows(
    await db.execute(sql`SELECT url, secret FROM agent_notify_settings WHERE agent_id = ${agentId}`)
  );
  const url = cfg?.url as string | null | undefined;
  if (!url) return;
  if (!cfg?.secret) throw new PermanentError("the agent has a notification URL but no secret");
  const target = new URL(url);
  if (invalidUrlReason(url) || !(await allowedTarget(target))) {
    throw new PermanentError("the notification URL is not public or not https");
  }
  const secret = decryptSecret(cfg.secret as EncryptedValue);
  const body = JSON.stringify({
    type: job.name,
    deliveryId: job.id,
    createdAt: new Date().toISOString(),
    agentId,
    proposal: await withoutCustomerData(proposal, target.hostname, agentId),
  });
  // Connects only to the addresses it checks (DNS rebinding: lib/safe-fetch.ts)
  const res = await pinnedFetch(target, {
    allowInternal: allowedPrivate(),
    timeoutMs: 10_000,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Kitsuden-Webhooks/1",
      "x-kitsuden-event": job.name,
      "x-kitsuden-delivery": job.id,
      "x-kitsuden-signature": sign(secret, body),
    },
    body,
  });
  // 410 Gone: the receiver no longer wants notifications. Retrying makes no sense.
  if (res.status === 410) throw new PermanentError("the receiver responded 410 Gone");
  if (res.status < 200 || res.status >= 300)
    throw new Error(`the receiver responded ${res.status}`);
}

/**
 * The proposal without customer data in its result, unless the host may receive
 * it. If the marks cannot be read, the result is dropped (fail closed): the
 * agent can still read it at `statusUrl`.
 */
export async function withoutCustomerData(
  proposal: ProposalView,
  host: string,
  agentId: string
): Promise<ProposalView> {
  const result = proposal.result as { body?: unknown } | undefined;
  if (!result || result.body === undefined || result.body === null) return proposal;
  if (hostAllowedForCustomerData(host, customerDataHosts())) return proposal;
  const block = { channel: "agent_notification" as const, host, agentId, executionId: proposal.id };
  let marked: MarkedValues;
  try {
    marked = new MarkedValues(await loadSensitivityCatalog());
  } catch {
    recordEgressBlock({ ...block, decision: "redacted", fields: [], where: "unchecked" });
    return { ...proposal, result: { ...result, body: null, redacted: true } };
  }
  const { value, redacted } = marked.redact(
    result.body,
    datasetFromPath(typeof proposal.path === "string" ? proposal.path : null)
  );
  if (!redacted.length) return proposal;
  recordEgressBlock({ ...block, decision: "redacted", fields: redacted, where: "body" });
  return { ...proposal, result: { ...result, body: value } };
}

/** Registers the notifications queue handler (called by the worker startup). */
export function registerNotificationDelivery(): void {
  queue.handle(WEBHOOKS_QUEUE, deliverNotification, { concurrency: 4 });
}
