/**
 * kon-notes — a kon made only of models (test-only demo, docs/agents/models.md).
 *
 * `defineModelsKon` is `defineKonSdk` with the operations of its models:
 * the module-loader would mount it like any SDK kon (RLS transaction per
 * request, idempotency, problem+json, OpenAPI, MCP tools).
 */
import { defineModelsKon } from "@kitsuden/engine";

import { category, note } from "./notes.model";

export const kon = defineModelsKon({
  id: "kon-notes",
  name: "Notes (defineModel demo)",
  version: "0.1.0",
  description: "Two models declared once: personal notes and shared categories.",
  mountPath: "/api/notes",
  models: [note, category],
});

export default kon;
