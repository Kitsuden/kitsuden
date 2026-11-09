/**
 * Actions Engine
 *
 * Unified action system that replaces workers and webhooks.
 *
 * Usage:
 *   import { executeAction, listActions, createAction } from "./lib/actions";
 *
 *   // Execute an action
 *   const result = await executeActionById("action-id", {
 *     trigger: "manual",
 *   });
 *
 *   // List all actions
 *   const actions = await listActions({ type: "code" });
 */

export {
  // Execution
  executeAction,
  executeActionById,

  // CRUD
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,

  // Events
  dispatchEvent,

  // Init
  initActionsEngine,
} from "./engine";

export type {
  Action,
  ActionExecution,
  ActionType,
  ActionTrigger,
  ActionStatus,
  ActionContext,
  ActionResult,
  ActionListItem,
  CreateActionInput,
  UpdateActionInput,
  TriggerConfig,
  ActionConfig,
  CodeActionConfig,
  WebhookOutConfig,
  WebhookInConfig,
  AgentActionConfig,
} from "./types";

export {
  executeCodeAction,
  executeWebhookOutAction,
  executeWebhookInAction,
  executeAgentAction,
} from "./handlers";
