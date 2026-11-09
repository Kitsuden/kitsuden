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
}

interface WebhookInConfig {
  authType?: "none" | "hmac" | "bearer";
  secret?: string;
}

export async function executeWebhookInAction(
  action: Action,
  context: ActionContext,

  _webhookRequest: WebhookInRequest
): Promise<ActionResult> {
  const startTime = Date.now();

  const config = action.config as WebhookInConfig;

  // Validate authentication if configured
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

  const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);

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
  if (!config.secret) return true;

  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();

  // In constant time, like the HMAC signature above: `===` stops at the
  // first differing character and the response time gives away the prefix.
  // The HASHES are compared so that the length does not leak either.
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(config.secret).digest();
  return timingSafeEqual(a, b);
}
