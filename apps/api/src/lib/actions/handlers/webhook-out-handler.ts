/**
 * Webhook Out Action Handler
 *
 * Sends HTTP requests to external services.
 * Handles retries, signatures, and response tracking.
 */

import { createHmac } from "crypto";

import { customerDataHosts, hostAllowedForCustomerData, MarkedValues } from "../../customer-data";
import { pinnedFetch, resolveTarget, UnsafeTargetError } from "../../safe-fetch";
import type { Action, ActionContext, ActionResult } from "../types";

interface WebhookOutConfig {
  url: string;
  headers?: Record<string, string>;
  secret?: string;
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
  };
  /** Hosts that may receive customer data (set by a person; docs/agents/egress.md). */
  customerDataHosts?: string[];
  /** For any other host: `redact` marked values (default) or `refuse` to send. */
  customerData?: "redact" | "refuse";
}

/**
 * Customer data in the event (lib/customer-data.ts). For a host not allowed
 * for it, marked values are replaced by `[redacted: customer data]`, or the
 * webhook is not sent if the action says `customerData: "refuse"`.
 * If the marks cannot be read, the data is not sent (fail closed).
 */
async function dataToSend(
  config: WebhookOutConfig,
  context: ActionContext
): Promise<{ data: unknown } | { error: string }> {
  const data = context.event?.data;
  if (data === undefined || data === null) return { data };
  const host = new URL(config.url).hostname;
  if (hostAllowedForCustomerData(host, customerDataHosts(config.customerDataHosts)))
    return { data };

  // Deferred: the catalog reads the database; a webhook without data never needs it.
  const { loadSensitivityCatalog, recordEgressBlock } = await import("../../customer-data-catalog");
  const agentId = context.executor?.type === "agent" ? context.executor.agent.agentId : null;
  let marked: MarkedValues;
  try {
    marked = new MarkedValues(await loadSensitivityCatalog());
  } catch {
    recordEgressBlock({
      channel: "webhook_out",
      decision: "refused",
      host,
      fields: [],
      where: "unchecked",
      actionId: context.actionId,
      executionId: context.executionId,
      agentId,
    });
    return { error: `Customer data check unavailable: the webhook to ${host} was not sent` };
  }
  const { value, redacted } = marked.redact(data);
  if (!redacted.length) return { data };
  const refuse = config.customerData === "refuse";
  recordEgressBlock({
    channel: "webhook_out",
    decision: refuse ? "refused" : "redacted",
    host,
    fields: redacted,
    where: "body",
    actionId: context.actionId,
    executionId: context.executionId,
    agentId,
  });
  if (refuse) {
    return {
      error: `Customer data cannot be sent to ${host} (${redacted.join(", ")}): allow the host in customerDataHosts or KITSUDEN_CUSTOMER_DATA_HOSTS`,
    };
  }
  return { data: value };
}

/** Limits that keep one action from holding a worker or the memory. */
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Headers the configuration may not set: they would change where or how it is sent. */
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);

/**
 * The opt-in for internal receivers, `KITSUDEN_WEBHOOK_ALLOW_INTERNAL`:
 * `true` lets a webhook reach any internal address; a comma-separated list
 * (`n8n,*.internal.lan,10.0.0.5`) lets it reach only those hosts, and every
 * other webhook still has to go to a public address. Unset: public only.
 */
export function webhookMayReachInternal(hostname: string): boolean {
  const raw = (process.env.KITSUDEN_WEBHOOK_ALLOW_INTERNAL ?? "").trim();
  if (!raw) return false;
  if (raw === "true") return true;
  const list = raw
    .split(",")
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
    )
    .filter((h) => h && h !== "true");
  return hostAllowedForCustomerData(hostname, list);
}

/**
 * Where a webhook may go. An internal address (the cloud metadata service,
 * another container, the API itself) would hand its response back to whoever
 * defined the action, so only public hosts are allowed, unless the host is
 * covered by `KITSUDEN_WEBHOOK_ALLOW_INTERNAL` (`webhookMayReachInternal`).
 *
 * `allowUnresolvable`: when the action is saved, a name that does not resolve
 * yet is accepted (the check runs again, and decides, when it is sent).
 */
export async function webhookTargetProblem(
  raw: string,
  options: { allowUnresolvable?: boolean } = {}
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid webhook URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `Protocol not allowed: ${url.protocol}`;
  }
  if (url.username || url.password) return "Credentials in the webhook URL are not allowed";
  if (webhookMayReachInternal(url.hostname)) return null;
  try {
    await resolveTarget(url.hostname);
  } catch (err) {
    if (!(err instanceof UnsafeTargetError)) throw err;
    if (err.reason === "unresolvable") {
      return options.allowUnresolvable
        ? null
        : `Webhook host could not be resolved: ${url.hostname}`;
    }
    return `Webhook host resolves to a non-public address: ${url.hostname} (internal receivers must be listed in KITSUDEN_WEBHOOK_ALLOW_INTERNAL)`;
  }
  return null;
}

/**
 * `config.url` of a `webhook_out` action when it is created or edited (REST
 * and MCP), so an internal target is refused up front and not only when the
 * action fires. `null` means it is acceptable.
 */
export async function webhookConfigUrlProblem(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !value.trim()) {
    return "config.url is required for webhook_out actions";
  }
  const problem = await webhookTargetProblem(value.trim(), { allowUnresolvable: true });
  return problem ? `config.url: ${problem}` : null;
}

async function readBounded(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      chunks.push(value.subarray(0, value.byteLength - (total - max)));
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function executeWebhookOutAction(
  action: Action,
  context: ActionContext
): Promise<ActionResult> {
  const startTime = Date.now();

  const config = action.config as WebhookOutConfig;

  if (!config.url) {
    return {
      success: false,
      error: "No URL configured for webhook",
      durationMs: Date.now() - startTime,
    };
  }

  const problem = await webhookTargetProblem(config.url);
  if (problem) {
    return { success: false, error: problem, durationMs: Date.now() - startTime };
  }

  const outgoing = await dataToSend(config, context);
  if ("error" in outgoing) {
    return { success: false, error: outgoing.error, durationMs: Date.now() - startTime };
  }

  // Build payload
  const payload = {
    event: context.event?.name,
    data: outgoing.data,
    timestamp: new Date().toISOString(),
    action: {
      id: context.actionId,
      name: context.actionName,
    },
  };

  const body = JSON.stringify(payload);

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Kitsuden-Actions/1.0",
    "X-Kitsuden-Action-ID": context.actionId,
    "X-Kitsuden-Execution-ID": context.executionId,
    // The same on every retry below: a receiver that honors it applies the request once.
    "Idempotency-Key": context.executionId,
    "X-Kitsuden-Timestamp": payload.timestamp,
  };
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (
      typeof value === "string" &&
      /^[A-Za-z0-9-]{1,64}$/.test(name) &&
      !RESERVED_HEADERS.has(name.toLowerCase()) &&
      value.length < 8192 &&
      !/[\r\n]/.test(value)
    ) {
      headers[name] = value;
    }
  }

  // Add signature if secret is configured
  if (config.secret) {
    const signature = createHmac("sha256", config.secret).update(body).digest("hex");
    headers["X-Kitsuden-Signature"] = `sha256=${signature}`;
  }

  // Execute request with retry logic
  const maxRetries = Math.min(
    Math.max(Number(config.retryPolicy?.maxRetries ?? 3) || 0, 0),
    MAX_RETRIES
  );
  const backoffMs = Math.min(
    Math.max(Number(config.retryPolicy?.backoffMs ?? 1000) || 0, 0),
    MAX_BACKOFF_MS
  );

  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      // The check above resolved the name; this resolves and checks it again
      // and connects ONLY to what it checked (DNS rebinding, lib/safe-fetch.ts).
      // Redirects are returned as is: one could lead to an internal address.
      const response = await pinnedFetch(config.url, {
        method: "POST",
        headers,
        body,
        timeoutMs: 30_000,
        allowInternal: webhookMayReachInternal(new URL(config.url).hostname),
      });

      const responseBody = await readBounded(response, MAX_RESPONSE_BYTES);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        parsedBody = responseBody;
      }

      const result: ActionResult = {
        success: response.ok,
        durationMs: Date.now() - startTime,
        httpResponse: {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: parsedBody,
        },
      };

      if (!response.ok) {
        result.error = `HTTP ${response.status}: ${responseBody}`;
      }

      return result;
    } catch (error) {
      // A target that resolves to an internal address (it rebound after the
      // check above): no retry changes that.
      if (error instanceof UnsafeTargetError && error.reason === "non_public") {
        return { success: false, error: error.message, durationMs: Date.now() - startTime };
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      attempt++;

      if (attempt <= maxRetries) {
        // Exponential backoff
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  return {
    success: false,
    error: `Failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
    durationMs: Date.now() - startTime,
  };
}
