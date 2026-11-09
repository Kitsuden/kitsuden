/**
 * Agent Webhook Service
 *
 * Sends webhook notifications when agent events occur:
 * - Successful/failed authentication
 * - Rate limiting
 * - Denied accesses
 * - Suspicious activity
 *
 * Configuration via kitsuden.config.ts:
 *   agentWebhooks: {
 *     url: "https://hooks.slack.com/...",
 *     events: ["auth_failure", "rate_limited"],
 *     secret: "webhook-signing-secret"
 *   }
 */

import { logger } from "../lib/logger";

import type { AuditAction } from "./agent-audit";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

interface WebhookConfig {
  url: string;
  events: string[]; // AuditAction[] or ["all"]
  secret?: string; // To sign payloads
  headers?: Record<string, string>;
}

// Read configuration from the config
function getWebhookConfig(): WebhookConfig | null {
  try {
    // This could come from the DB or from the config file
    const config = process.env.AGENT_WEBHOOK_URL
      ? {
          url: process.env.AGENT_WEBHOOK_URL,
          events: (process.env.AGENT_WEBHOOK_EVENTS?.split(",") as AuditAction[]) || ["all"],
          secret: process.env.AGENT_WEBHOOK_SECRET,
        }
      : null;
    return config;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentWebhookEvent {
  id: string;
  type: AuditAction;
  timestamp: string;
  agent: {
    id: string;
    name: string;
  };
  details: {
    ipAddress?: string;
    userAgent?: string;
    resource?: string;
    errorMessage?: string;
    [key: string]: any;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SENDING WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sends an agent event webhook
 */
export async function sendAgentWebhook(event: AgentWebhookEvent): Promise<void> {
  const config = getWebhookConfig();
  if (!config) return; // Webhooks not configured

  // Check whether this event should be sent
  const shouldSend = config.events.includes("all") || config.events.includes(event.type);
  if (!shouldSend) return;

  // Build payload
  const payload = {
    ...event,
    kitsuden: {
      version: "0.7.0-beta",
      source: "agent-webhook",
    },
  };

  // Send in the background (do not block)
  Promise.resolve().then(async () => {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Kitsuden-Event": event.type,
        "X-Kitsuden-Timestamp": event.timestamp,
        ...config.headers,
      };

      // Sign payload if there is a secret
      if (config.secret) {
        const { createHmac } = await import("crypto");
        const signature = createHmac("sha256", config.secret)
          .update(JSON.stringify(payload))
          .digest("hex");
        headers["X-Kitsuden-Signature"] = `sha256=${signature}`;
      }

      const response = await fetch(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        logger.warn(
          {
            event: event.type,
            agentId: event.agent.id,
            status: response.status,
          },
          "Agent webhook delivery failed"
        );
      } else {
        logger.debug(
          {
            event: event.type,
            agentId: event.agent.id,
          },
          "Agent webhook delivered"
        );
      }
    } catch (error) {
      logger.error(
        {
          error,
          event: event.type,
          agentId: event.agent.id,
        },
        "Agent webhook delivery error"
      );
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS FOR SPECIFIC EVENTS
// ═══════════════════════════════════════════════════════════════════════════

let eventCounter = 0;
function generateEventId(): string {
  eventCounter = (eventCounter + 1) % 1000000;
  return `evt_${Date.now()}_${eventCounter.toString(36).padStart(6, "0")}`;
}

/**
 * Notifies successful authentication
 */
export function notifyAuthSuccess(
  agentId: string,
  agentName: string,
  metadata?: { ipAddress?: string; userAgent?: string }
): void {
  sendAgentWebhook({
    id: generateEventId(),
    type: "auth_success",
    timestamp: new Date().toISOString(),
    agent: { id: agentId, name: agentName },
    details: {
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    },
  });
}

/**
 * Notifies failed authentication
 */
export function notifyAuthFailure(
  agentId: string,
  agentName: string,
  error: string,
  metadata?: { ipAddress?: string; userAgent?: string }
): void {
  sendAgentWebhook({
    id: generateEventId(),
    type: "auth_failure",
    timestamp: new Date().toISOString(),
    agent: { id: agentId, name: agentName },
    details: {
      errorMessage: error,
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    },
  });
}

/**
 * Notifies rate limiting
 */
export function notifyRateLimited(
  agentId: string,
  agentName: string,
  limit: number,
  metadata?: { ipAddress?: string }
): void {
  sendAgentWebhook({
    id: generateEventId(),
    type: "rate_limited",
    timestamp: new Date().toISOString(),
    agent: { id: agentId, name: agentName },
    details: {
      limit,
      window: "1m",
      ipAddress: metadata?.ipAddress,
    },
  });
}

/**
 * Notifies denied access
 */
export function notifyPermissionDenied(
  agentId: string,
  agentName: string,
  resource: string,
  requiredScope: string,
  metadata?: { ipAddress?: string }
): void {
  sendAgentWebhook({
    id: generateEventId(),
    type: "permission_denied",
    timestamp: new Date().toISOString(),
    agent: { id: agentId, name: agentName },
    details: {
      resource,
      requiredScope,
      ipAddress: metadata?.ipAddress,
    },
  });
}

/**
 * Notifies detected suspicious activity
 */
export function notifySuspiciousActivity(
  agentId: string,
  agentName: string,
  alertType: "auth_failures" | "rate_limits" | "permission_denials",
  count: number,
  severity: "low" | "medium" | "high"
): void {
  sendAgentWebhook({
    id: generateEventId(),
    type: "auth_failure", // We reuse it, but with a suspicious flag
    timestamp: new Date().toISOString(),
    agent: { id: agentId, name: agentName },
    details: {
      alertType,
      count,
      severity,
      message: `Suspicious activity detected: ${count} ${alertType} in the last 24h`,
      actionRequired: severity === "high",
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT SERVICE INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hook that runs when suspicious activity is detected
 * Calls the configured webhooks
 */
export async function onSuspiciousActivityDetected(
  agentId: string,
  agentName: string,
  alertType: "auth_failures" | "rate_limits" | "permission_denials",
  count: number,
  severity: "low" | "medium" | "high"
): Promise<void> {
  // Only notify if medium or high
  if (severity === "low") return;

  notifySuspiciousActivity(agentId, agentName, alertType, count, severity);
}
