/**
 * Kitsuden — Function Dispatcher (Legacy Wrapper)
 *
 * ⚠️ DEPRECATED: This module is kept for backward compatibility.
 * New code should use the ActionEngine directly from `./actions`.
 *
 * This wrapper bridges the old function-based API to the new unified
 * ActionEngine. It will be removed.
 *
 * Delegates all execution to ActionEngine.
 */

// import { eq } from "drizzle-orm"; // Not used in legacy wrapper
import { db } from "../db";
import { kitsudenFunctions } from "../db/schema";

import { dispatchEvent, executeActionById } from "./actions";
import { events } from "./events";
import type { ActionExecutor } from "./sandbox/identity";
import type { SandboxResult } from "./worker-sandbox";

// ═══════════════════════════════════════════════════════════════════════════
// Legacy Event Mapping
// ═══════════════════════════════════════════════════════════════════════════

/** Map EventEmitter names → new unified event names */
const EVENT_MAP: Record<string, string> = {
  "entry:created": "entry.created",
  "entry:updated": "entry.updated",
  "entry:deleted": "entry.deleted",
  "post:published": "post.published",
};

// ═══════════════════════════════════════════════════════════════════════════
// Legacy API (Delegates to ActionEngine)
// ════════════════════════════════════════════════════════════════

/**
 * @deprecated Use executeActionById from `./actions` instead
 */
export async function executeFunction(
  fn: typeof kitsudenFunctions.$inferSelect,
  triggerEvent: string,
  payload: Record<string, unknown>
): Promise<SandboxResult> {
  console.warn("[DEPRECATED] executeFunction called, migrate to ActionEngine");

  // Check if this function has been migrated to actions
  const { actions } = await import("../db/schema");
  const { eq, and } = await import("drizzle-orm");

  const [migratedAction] = await db
    .select()
    .from(actions)
    .where(and(eq(actions.legacyId, fn.id), eq(actions.legacyType, "function")))
    .limit(1);

  if (migratedAction) {
    // Execute via ActionEngine
    const result = await executeActionById(migratedAction.id, {
      trigger: triggerEvent === "cron" ? "cron" : "event",
      triggerEvent,
      event: {
        name: triggerEvent,
        data: payload,
        timestamp: new Date().toISOString(),
      },
    });

    return {
      success: result.success,
      result: result.result ?? null,
      logs: result.logs ?? "",
      error: result.error ?? null,
      durationMs: result.durationMs ?? 0,
      memoryUsedBytes: result.memoryUsedBytes ?? 0,
      exitReason: result.success
        ? "success"
        : result.error?.includes("timeout")
          ? "timeout"
          : "error",
    };
  }

  // Fallback: Function not migrated yet
  return {
    success: false,
    error: `Function ${fn.id} not found in actions table. Run migration first.`,
    durationMs: 0,
    memoryUsedBytes: 0,
    exitReason: "error",
    logs: "",
    result: null,
  };
}

/**
 * @deprecated Use executeActionById from `./actions` instead
 */
export async function executeManually(
  functionId: string,
  customPayload?: Record<string, unknown>,
  executor?: ActionExecutor
): Promise<SandboxResult> {
  console.warn("[DEPRECATED] executeManually called, migrate to ActionEngine");

  const { actions } = await import("../db/schema");
  const { eq, and } = await import("drizzle-orm");

  // Try to find by legacy ID first
  const [migratedAction] = await db
    .select()
    .from(actions)
    .where(and(eq(actions.legacyId, functionId), eq(actions.legacyType, "function")))
    .limit(1);

  const actionId = migratedAction?.id || functionId;

  const result = await executeActionById(actionId, {
    trigger: "manual",
    executor,
    event: customPayload
      ? {
          name: "manual",
          data: customPayload,
          timestamp: new Date().toISOString(),
        }
      : undefined,
  });

  return {
    success: result.success,
    result: result.result ?? null,
    logs: result.logs ?? "",
    error: result.error ?? null,
    durationMs: result.durationMs ?? 0,
    memoryUsedBytes: result.memoryUsedBytes ?? 0,
    exitReason: result.success
      ? "success"
      : result.error?.includes("timeout")
        ? "timeout"
        : "error",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Dispatch (Delegates to ActionEngine)
// ═══════════════════════════════════════════════════════════════════════════

async function dispatchToActions(
  eventName: string,
  data: { datasetId?: string; entry?: Record<string, unknown>; [key: string]: unknown }
) {
  const unifiedEventName = EVENT_MAP[eventName];
  if (!unifiedEventName) return;

  // Delegate to ActionEngine
  await dispatchEvent(eventName, {
    ...data,
    eventName: unifiedEventName,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated ActionEngine handles its own initialization
 */
export function initFunctionDispatcher() {
  console.warn("[DEPRECATED] initFunctionDispatcher called, events now handled by ActionEngine");

  // Keep event listeners for backward compatibility during transition
  // These will be removed
  for (const eventName of Object.keys(EVENT_MAP)) {
    events.on(eventName, (data) => {
      dispatchToActions(eventName, data).catch((err) => {
        console.error(`[FunctionDispatcher] Error dispatching ${eventName}:`, err);
      });
    });
  }

  console.log("  ⚡ Function Dispatcher (legacy) - events delegated to ActionEngine");
}
