/**
 * Webhook In Action Handler
 *
 * Handles incoming webhook requests.
 * Validates signatures, parses requests, and executes associated actions.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

import type { Action, ActionContext, ActionResult } from "../types";

export interface WebhookInRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /**
   * The body exactly as it arrived. The HMAC is computed over these bytes: re-serializing a parsed body
   * changes key order, spacing and escapes, so a sender's valid signature failed, and two different
   * bodies could share one serialization.
   */
  rawBody?: string;
}

interface WebhookInConfig {
  authType?: "none" | "hmac" | "bearer";
  secret?: string;
}

/**
 * `config` of a `webhook_in` action: the authentication is chosen on purpose, and a signature or a token
 * has something to be checked against. Without this an action could be saved that accepts anyone.
 */
export function webhookInConfigProblem(config: unknown): string | null {
  const c = (config ?? {}) as { authType?: unknown; secret?: unknown };
  if (c.authType !== "none" && c.authType !== "hmac" && c.authType !== "bearer") {
    return 'config.authType is required for webhook_in actions: "hmac", "bearer" or "none"';
  }
  if (c.authType !== "none" && (typeof c.secret !== "string" || c.secret.length < 16)) {
    return `config.secret (16 characters or more) is required with authType "${c.authType}"`;
  }
  return null;
}

export async function executeWebhookInAction(
  action: Action,
  context: ActionContext,

  _webhookRequest: WebhookInRequest
): Promise<ActionResult> {
  const startTime = Date.now();

  const config = action.config as WebhookInConfig;

  // Authentication is not optional by omission: an action without `authType` used to accept any
  // request. Only an explicit `authType: "none"` takes unauthenticated requests.
  if (config.authType !== "none" && config.authType !== "hmac" && config.authType !== "bearer") {
    return {
      success: false,
      error:
        'The webhook has no authentication: set authType to "hmac" or "bearer" (or "none" on purpose)',
      durationMs: Date.now() - startTime,
    };
  }

  if (config.authType === "hmac") {
    const isValid = validateHmacSignature(_webhookRequest, { secret: config.secret });
    if (!isValid) {
      return {
        success: false,
        error: "Invalid signature",
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (config.authType === "bearer") {
    const isValid = validateBearerToken(_webhookRequest, { secret: config.secret });
    if (!isValid) {
      return {
        success: false,
        error: "Invalid authorization",
        durationMs: Date.now() - startTime,
      };
    }
  }

  // For incoming webhooks, we just validate and store the request
  // The actual processing is done by the event system or can trigger other actions
  return {
    success: true,
    result: {
      received: true,
      event: context.event,
      timestamp: new Date().toISOString(),
    },
    durationMs: Date.now() - startTime,
  };
}

function validateHmacSignature(request: WebhookInRequest, config: { secret?: string }): boolean {
  // `authType: "hmac"` with no secret used to accept any request: an action
  // that asks for a signature and has nothing to check it against refuses
  // (security review 2026-11-03).
  if (!config.secret) return false;

  const signatureHeader =
    request.headers["x-signature"] ||
    request.headers["x-hub-signature-256"] ||
    request.headers["x-kitsuden-signature"];

  if (!signatureHeader) return false;

  // The raw bytes, never a re-serialization of the parsed body (see `rawBody`).
  const body =
    typeof request.rawBody === "string"
      ? request.rawBody
      : typeof request.body === "string"
        ? request.body
        : null;
  if (body === null) return false;

  const expectedSignature = createHmac("sha256", config.secret).update(body).digest("hex");

  // Extract signature from header (format: "sha256=abc123" or just "abc123")
  const providedSignature = signatureHeader.includes("=")
    ? signatureHeader.split("=")[1]
    : signatureHeader;

  try {
    const providedBuffer = Buffer.from(providedSignature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function validateBearerToken(
  request: WebhookInRequest,
  config: { secret?: string }
): boolean {
  // No secret to compare against: refused, like an HMAC action without one (it used to accept anyone).
  if (!config.secret) return false;

  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();

  // In constant time, like the HMAC signature above: `===` stops at the
  // first differing character and the response time gives away the prefix.
  // The HASHES are compared so that the length does not leak either.
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(config.secret).digest();
  return timingSafeEqual(a, b);
}
